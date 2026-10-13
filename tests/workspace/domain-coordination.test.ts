import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../../src/domain.js';
import { GitShadowSnapshotDriver } from '../../src/snapshot/git-shadow.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';

/** 在真实主工作区 diff 已完成后暂停第一次校验，暴露跨管理器的检查与应用竞争。 */
class ValidationGateDriver extends GitShadowSnapshotDriver {
  private mainRoot?: string;
  private held = false;
  private ready!: () => void;
  readonly validationHeld = new Promise<void>((resolve) => { this.ready = resolve; });
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  arm(root: string): void { this.mainRoot = root; }
  releaseValidation(): void { this.release(); }

  override async diffTrees(cwd: string, fromTree: string, toTree: string, pathspecs: string[] = []) {
    const changes = await super.diffTrees(cwd, fromTree, toTree, pathspecs);
    if (cwd === this.mainRoot && !this.held) {
      this.held = true;
      this.ready();
      await this.gate;
    }
    return changes;
  }
}

describe('同一域的工作区事务协调', () => {
  let tempDir: string;
  let root: string;
  let domain: ExecutionDomain;
  const domains: ExecutionDomain[] = [];

  function repository(name: string): string {
    const root = path.join(tempDir, name);
    fs.mkdirSync(root);
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Tester']);
    git(['config', 'user.email', 'tester@test.local']);
    fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'fixture']);
    return root;
  }

  function open(name: string): ExecutionDomain {
    const domain = ExecutionDomain.acquire(path.join(tempDir, name), name);
    domains.push(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: name, name: 'Task', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: name, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    return domain;
  }

  function begin(supervisor: ProcessSupervisor, txId: string, transactionRoot = root) {
    return supervisor.beginWorkspaceTransaction({
      txId, runId: 'run', root: transactionRoot,
      forkPath: path.join(tempDir, `${supervisor.getDomain().domainId}-${txId}-fork`),
    });
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-tx-coordination-')));
    root = repository('repo');
    domain = open('domain');
  });

  afterEach(() => {
    for (const domain of domains.splice(0)) domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['commit', 'abort'] as const)('跨入口 inspect 和 %s 后，所有入口都看到事务已关闭', async (action) => {
    const first = new ProcessSupervisor(domain);
    const second = new ProcessSupervisor(domain);
    const tx = await begin(first, 'shared');
    fs.writeFileSync(path.join(tx.forkRoot, 'shared.txt'), 'updated\n');
    expect((await second.inspectWorkspaceTransaction(tx.txId)).writeSet).toEqual([{ status: 'M', path: 'shared.txt' }]);

    if (action === 'commit') {
      expect((await second.commitWorkspaceTransaction(tx.txId)).status).toBe('committed');
    } else {
      await second.abortWorkspaceTransaction(tx.txId);
    }
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(action === 'commit' ? 'updated\n' : 'base\n');
    expect(fs.existsSync(tx.forkRoot)).toBe(false);
    await expect(first.inspectWorkspaceTransaction(tx.txId)).rejects.toThrow('already closed');
    await expect(second.inspectWorkspaceTransaction(tx.txId)).rejects.toThrow('already closed');
  });

  it('跨入口并发提交冲突写集时，校验与应用串行化，只有一个提交成功', async () => {
    const driver = new ValidationGateDriver();
    const first = new ProcessSupervisor(domain, undefined, driver);
    const second = new ProcessSupervisor(domain);
    const a = await begin(first, 'writer-a');
    const b = await begin(second, 'writer-b');
    fs.writeFileSync(path.join(a.forkRoot, 'shared.txt'), 'from a\n');
    fs.writeFileSync(path.join(b.forkRoot, 'shared.txt'), 'from b\n');
    driver.arm(root);

    const commitA = first.commitWorkspaceTransaction(a.txId);
    await driver.validationHeld;
    const commitB = second.commitWorkspaceTransaction(b.txId);
    const settled = Promise.all([commitA, commitB]);
    let deadline: NodeJS.Timeout | undefined;
    try {
      // 旧实现中 B 会在 A 的已完成校验之后提交；共享队列中 B 必须等待 A 放行。
      await Promise.race([
        commitB,
        new Promise<void>((resolve) => { deadline = setTimeout(resolve, 500); }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
      driver.releaseValidation();
    }
    const results = await settled;
    expect(results.map((result) => result.status)).toEqual(['committed', 'conflict']);
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('from a\n');
    const committed = domain.getStore().getJournalEvents(domain.domainId).filter((event) => event.type === 'TX_COMMITTED');
    expect(committed.map((event) => event.payload.txId)).toEqual([a.txId]);
    await first.abortWorkspaceTransaction(b.txId);
  });

  it('已绑定事务管理器后，另一个显式快照驱动入口必须拒绝访问', async () => {
    const first = new ProcessSupervisor(domain);
    const tx = await begin(first, 'bound');
    const second = new ProcessSupervisor(domain, undefined, new GitShadowSnapshotDriver());
    await expect(second.inspectWorkspaceTransaction(tx.txId)).rejects.toThrow(/different snapshot driver/);
    await expect(second.commitWorkspaceTransaction(tx.txId)).rejects.toThrow(/different snapshot driver/);
    await expect(second.abortWorkspaceTransaction(tx.txId)).rejects.toThrow(/different snapshot driver/);
    expect(domain.getSnapshotDriver()).toBe(first.getSnapshotDriver());
    const third = new ProcessSupervisor(domain);
    expect((await third.inspectWorkspaceTransaction(tx.txId)).writeSet).toEqual([]);
    expect(fs.existsSync(tx.forkRoot)).toBe(true);
    await first.abortWorkspaceTransaction(tx.txId);
  });

  it('不同域的同 ID 事务与快照驱动互相独立', async () => {
    const otherRoot = repository('other-repo');
    const otherDomain = open('other-domain');
    const first = new ProcessSupervisor(domain);
    const second = new ProcessSupervisor(otherDomain);
    const a = await begin(first, 'same-id');
    const b = await begin(second, 'same-id', otherRoot);
    fs.writeFileSync(path.join(a.forkRoot, 'shared.txt'), 'first\n');
    fs.writeFileSync(path.join(b.forkRoot, 'shared.txt'), 'second\n');
    const results = await Promise.all([first.commitWorkspaceTransaction(a.txId), second.commitWorkspaceTransaction(b.txId)]);
    expect(results.map((result) => result.status)).toEqual(['committed', 'committed']);
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('first\n');
    expect(fs.readFileSync(path.join(otherRoot, 'shared.txt'), 'utf8')).toBe('second\n');
  });
});
