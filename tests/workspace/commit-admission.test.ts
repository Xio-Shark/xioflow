import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../../src/domain.js';
import { ResourceConflictError } from '../../src/types.js';
import { GitShadowSnapshotDriver } from '../../src/snapshot/git-shadow.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';

class ValidationGate extends GitShadowSnapshotDriver {
  private target?: string;
  private removing = false;
  private held = false;
  private ready!: () => void;
  readonly reached = new Promise<void>((resolve) => { this.ready = resolve; });
  private resume!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.resume = resolve; });
  arm(root: string): void { this.target = root; }
  armRemoval(): void { this.removing = true; }
  release(): void { this.resume(); }
  override async diffTrees(cwd: string, from: string, to: string, paths: string[] = []) {
    const changes = await super.diffTrees(cwd, from, to, paths);
    if (cwd === this.target && !this.held) {
      this.held = true;
      this.ready();
      await this.gate;
    }
    return changes;
  }
  override async dematerialize(root: string, options?: { force?: boolean }) {
    if (this.removing) {
      this.ready();
      await this.gate;
    }
    return super.dematerialize(root, options);
  }
}

describe('workspace commit admission and durable isolation', () => {
  let temporary: string;
  let root: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  let driver: ValidationGate;

  beforeEach(() => {
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-commit-admission-')));
    root = path.join(temporary, 'repo');
    fs.mkdirSync(root);
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Tester'], ['config', 'user.email', 'tester@test.local']]) {
      execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    }
    for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(root, name), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'pipe' });
    domain = ExecutionDomain.acquire(path.join(temporary, 'domain'), 'domain');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: 'domain', name: 'test', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: 'domain', owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    driver = new ValidationGate();
    supervisor = new ProcessSupervisor(domain, undefined, driver);
  });

  afterEach(() => {
    driver.release();
    vi.restoreAllMocks();
    domain.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  async function begin() {
    const tx = await supervisor.beginWorkspaceTransaction({ txId: 'tx', runId: 'run', root, forkPath: path.join(temporary, 'fork') });
    for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(tx.forkRoot, name), 'transaction\n');
    return tx;
  }

  function write(opId: string, cwd: string) {
    return supervisor.executeProcess({
      runId: 'run', opId, name: 'competing write',
      requiredResources: [`workspace:write:${cwd}`],
      command: { execPath: process.execPath, args: ['-e', "require('fs').writeFileSync('a.txt', 'other writer\\n')"], cwd },
    });
  }

  it.each(['target', 'source'] as const)('blocks a managed %s writer while commit evidence is being computed', async (side) => {
    const tx = await begin();
    const cwd = side === 'target' ? root : tx.forkRoot;
    driver.arm(cwd);
    const commit = supervisor.commitWorkspaceTransaction(tx.txId);
    await driver.reached;
    let rejection: unknown;
    try { await write('competitor', cwd); }
    catch (error) { rejection = error; }
    finally { driver.release(); }
    expect((await commit).status).toBe('committed');
    expect(rejection).toBeInstanceOf(ResourceConflictError);
    expect(domain.getStore().getOperation('competitor')).toBeNull();
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('transaction\n');
  });

  it.each([false, true])('retains target and source isolation after partial apply (restart=%s)', async (restart) => {
    const tx = await begin();
    const copy = fs.copyFileSync;
    const failure = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
      if (destination === path.join(root, 'b.txt')) throw new Error('injected partial apply');
      return copy(source, destination, flags);
    });
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow('injected partial apply');
    failure.mockRestore();
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('transaction\n');
    if (restart) {
      domain.close();
      domain = ExecutionDomain.acquire(path.join(temporary, 'domain'), 'domain');
      supervisor = new ProcessSupervisor(domain);
    }
    for (const cwd of [root, tx.forkRoot]) {
      expect(domain.getResourceOwner(`workspace:write:${cwd}`)).toBe('tx:apply');
      await expect(write(`competitor-${cwd === root ? 'main' : 'fork'}`, cwd)).rejects.toBeInstanceOf(ResourceConflictError);
    }
    expect(() => domain.assertOperationIdAvailable('tx:apply')).toThrow();
    expect((await supervisor.commitWorkspaceTransaction(tx.txId)).status).toBe('committed');
    for (const name of ['a.txt', 'b.txt']) expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe('transaction\n');
    expect(domain.isResourceLocked(`workspace:write:${root}`)).toBe(false);
  });

  it('does not reapply an already committed transaction if releasing its isolation fails', async () => {
    const tx = await begin();
    const release = domain.internalReleaseResources.bind(domain);
    const failure = vi.spyOn(domain, 'internalReleaseResources').mockImplementation((owner, resources) => {
      if (owner === 'tx:apply') throw new Error('injected release failure');
      release(owner, resources);
    });
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow('injected release failure');
    expect(domain.getStore().getJournalEvents('domain').some((event) => event.type === 'TX_COMMITTED')).toBe(true);
    failure.mockRestore();
    domain.internalReleaseResources('tx:apply');
    await write('later-writer', root);
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow('already closed');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('other writer\n');
  });

  it('rejects a public operation ID collision before collecting evidence or applying writes', async () => {
    const tx = await begin();
    await write('tx:apply', root);
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow(/already|registered|exists/);
    expect(domain.getStore().getJournalEvents('domain').filter((event) => event.type === 'TX_COMMITTING')).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('other writer\n');
  });

  it('protects inspect read tracking against a managed fork writer', async () => {
    const tx = await begin();
    driver.arm(tx.forkRoot);
    const inspect = supervisor.inspectWorkspaceTransaction(tx.txId);
    await driver.reached;
    let rejection: unknown;
    try { await write('inspection-competitor', tx.forkRoot); }
    catch (error) { rejection = error; }
    finally { driver.release(); }
    expect((await inspect).writeSet).toHaveLength(2);
    expect(rejection).toBeInstanceOf(ResourceConflictError);
    expect(domain.isResourceLocked(`workspace:write:${tx.forkRoot}`)).toBe(false);
  });

  it('releases temporary isolation and remains abortable when TX_COMMITTING cannot be recorded', async () => {
    const tx = await begin();
    const store = domain.getStore();
    const record = store.recordJournalEvent.bind(store);
    const failure = vi.spyOn(store, 'recordJournalEvent').mockImplementation((event) => {
      if (event.type === 'TX_COMMITTING') throw new Error('injected commit journal failure');
      return record(event);
    });
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow('injected commit journal failure');
    failure.mockRestore();
    for (const cwd of [root, tx.forkRoot]) expect(domain.isResourceLocked(`workspace:write:${cwd}`)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('base\n');
    await supervisor.abortWorkspaceTransaction(tx.txId);
    expect(fs.existsSync(tx.forkRoot)).toBe(false);
  });

  it('rejects a commit owner ID already reserved by a queued public operation', async () => {
    const tx = await begin();
    domain.allocateResources('queue-blocker', ['queue-lock']);
    const queued = supervisor.executeProcess({
      runId: 'run', opId: 'tx:apply', name: 'queued operation', requiredResources: ['queue-lock'], waitTimeoutMs: 5000,
      command: { execPath: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    });
    try {
      await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow();
      expect(domain.getStore().getJournalEvents('domain').some((event) => event.type === 'TX_COMMITTING')).toBe(false);
    } finally {
      domain.internalReleaseResources('queue-blocker');
      await queued;
    }
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('base\n');
  });

  it('serializes abort behind an in-flight commit instead of destroying its redo source', async () => {
    const tx = await begin();
    driver.arm(root);
    const commit = supervisor.commitWorkspaceTransaction(tx.txId);
    await driver.reached;
    const aborted = supervisor.abortWorkspaceTransaction(tx.txId).then(() => undefined, (error: unknown) => error);
    driver.release();
    expect((await commit).status).toBe('committed');
    expect(await aborted).toBeInstanceOf(Error);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('transaction\n');
  });

  it.each(['abort', 'dematerialize'] as const)('refuses %s while inspect holds the source', async (action) => {
    const tx = await begin();
    driver.arm(tx.forkRoot);
    const inspect = supervisor.inspectWorkspaceTransaction(tx.txId);
    await driver.reached;
    let rejection: unknown;
    try {
      if (action === 'abort') await supervisor.abortWorkspaceTransaction(tx.txId);
      else await supervisor.dematerialize(tx.forkRoot, { force: true });
    } catch (error) { rejection = error; }
    finally { driver.release(); }
    await inspect;
    expect(rejection).toBeInstanceOf(ResourceConflictError);
    expect(fs.existsSync(tx.forkRoot)).toBe(true);
    await supervisor.abortWorkspaceTransaction(tx.txId);
  });

  it('holds the source throughout asynchronous public worktree removal', async () => {
    const tx = await begin();
    driver.armRemoval();
    const removal = supervisor.dematerialize(tx.forkRoot, { force: true });
    await driver.reached;
    try {
      await expect(supervisor.inspectWorkspaceTransaction(tx.txId)).rejects.toBeInstanceOf(ResourceConflictError);
      expect(domain.isResourceLocked(`workspace:write:${tx.forkRoot}`)).toBe(true);
    } finally { driver.release(); }
    await removal;
    expect(domain.isResourceLocked(`workspace:write:${tx.forkRoot}`)).toBe(false);
  });

  it('consumes a materialization lease once so concurrent removal cannot reenter its owner', async () => {
    const captured = await supervisor.captureSnapshot({ runId: 'run', opId: 'standalone-base', roots: [root] });
    if (captured.status !== 'succeeded' || !captured.snapshot) throw new Error('fixture snapshot failed');
    const fork = path.join(temporary, 'standalone-fork');
    await supervisor.materialize(captured.snapshot.id, fork);
    driver.armRemoval();
    const removal = supervisor.dematerialize(fork);
    await driver.reached;
    try {
      await expect(supervisor.dematerialize(fork)).rejects.toBeInstanceOf(ResourceConflictError);
      expect(domain.isResourceLocked(`workspace:write:${fork}`)).toBe(true);
    } finally { driver.release(); }
    await removal;
    expect(domain.isResourceLocked(`workspace:write:${fork}`)).toBe(false);
  });

  it('does not treat a public mat-prefixed owner before intent registration as a materialization', async () => {
    const tx = await begin();
    const writing = write('mat-public', tx.forkRoot);
    // allocateResourcesWithWait has acquired the key, but intent registration resumes in a microtask.
    expect(domain.getStore().getOperation('mat-public')).toBeNull();
    await expect(supervisor.dematerialize(tx.forkRoot, { force: true })).rejects.toBeInstanceOf(ResourceConflictError);
    await writing;
    expect(fs.existsSync(tx.forkRoot)).toBe(true);
  });

  it('keeps other held resources and the internal identity reserved after a partial release', () => {
    domain.allocateResources('internal-owner', ['first', 'second']);
    domain.internalReleaseResources('internal-owner', ['first']);
    expect(domain.isResourceLocked('first')).toBe(false);
    expect(domain.getResourceOwner('second')).toBe('internal-owner');
    expect(() => domain.assertOperationIdAvailable('internal-owner')).toThrow();
    domain.internalReleaseResources('internal-owner', ['second']);
    expect(() => domain.assertOperationIdAvailable('internal-owner')).not.toThrow();
  });

  it('refuses automatic replay of legacy pending commits without continuous isolation evidence', async () => {
    const tx = await begin();
    const effects = await supervisor.inspectWorkspaceTransaction(tx.txId);
    // Legacy commits released their isolation on failure. A later managed writer can legitimately exist.
    domain.getStore().recordJournalEvent({
      domainId: 'domain', runId: 'run', type: 'TX_COMMITTING',
      payload: { txId: tx.txId, effects }, timestamp: new Date().toISOString(),
    });
    await write('legacy-later-writer', root);
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temporary, 'domain'), 'domain');
    supervisor = new ProcessSupervisor(domain);
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toThrow('lacks continuous commit isolation evidence');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('other writer\n');
    for (const cwd of [root, tx.forkRoot]) expect(domain.getResourceOwner(`workspace:write:${cwd}`)).toBe('tx:apply');
  });
});
