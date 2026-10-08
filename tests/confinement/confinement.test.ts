import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import { execFile } from 'node:child_process';
import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { SandboxExecConfinementDriver } from '../../src/confinement/sandbox-exec.js';
import { BubblewrapConfinementDriver } from '../../src/confinement/bubblewrap.js';
import { SrtConfinementDriver } from '../../src/confinement/srt.js';
import { ConfinementDriver } from '../../src/types.js';
import { StructuredCommand } from '../../src/driver/types.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';
import { normalizeAccessTimes } from '../../src/workspace/read-tracking.js';

const execFileAsync = util.promisify(execFile);

describe('ConfinementDriver & Coverage Deduction (Steps 4 & 5)', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  let platformDriver: NodePlatformDriver;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-confinement-test-'));
    const domainPath = path.join(tempDir, 'domain');
    domain = ExecutionDomain.acquire(domainPath, 'confine-domain');
    platformDriver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, platformDriver);
  });

  afterEach(async () => {
    try {
      domain.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function ensureTaskAndRun(runId: string = 'run-confine') {
    const store = domain.getStore();
    store.saveTask({
      id: 'task-confine',
      domainId: domain.domainId,
      name: 'Confinement Test Task',
      createdAt: new Date().toISOString(),
    });
    store.saveRun({
      id: runId,
      taskId: 'task-confine',
      domainId: domain.domainId,
      owner: 'tester',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }

  async function makeGitRepo(dir: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'tester@test.local'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Initial\n');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
  }

  it('4.1 能力探测：PlatformCapabilities.confinement 如实反映平台驱动', () => {
    expect(Array.isArray(platformDriver.capabilities.confinement)).toBe(true);
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
      expect(platformDriver.capabilities.confinement).toContain('sandbox-exec');
    }
  });

  it('4.2 驱动不可用时抛错，从不返回未受限命令', () => {
    if (process.platform === 'darwin') {
      const bwrap = new BubblewrapConfinementDriver();
      expect(() =>
        bwrap.wrap(
          { execPath: '/bin/echo', args: ['hi'], cwd: tempDir },
          [tempDir]
        )
      ).toThrow(/not available on this platform/);
    }

    const srt = new SrtConfinementDriver();
    if (!SrtConfinementDriver.isAvailable()) {
      expect(() =>
        srt.wrap(
          { execPath: '/bin/echo', args: ['hi'], cwd: tempDir },
          [tempDir]
        )
      ).toThrow(/not available on this system/);
    }
  });

  it('4.3 macOS sandbox-exec: 写入 scope 内部成功，写入 scope 外部失败 (Operation not permitted)', async () => {
    if (process.platform !== 'darwin' || !SandboxExecConfinementDriver.isAvailable()) {
      return;
    }

    ensureTaskAndRun('run-sandbox-exec');

    const allowedDir = path.join(tempDir, 'allowed_dir');
    const deniedDir = path.join(tempDir, 'denied_dir');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(deniedDir, { recursive: true });

    const cap = domain.issueCapability(
      {
        write: [allowedDir],
        exclusive: ['res:allowed'],
      },
      'tester',
      60000
    );

    // 1. 尝试写 scope 外目录 -> 应该失败 (EPERM / Operation not permitted)
    const outsideFile = path.join(deniedDir, 'leak.txt');
    const writeOutsideScript = `
      const fs = require('fs');
      try {
        fs.writeFileSync(${JSON.stringify(outsideFile)}, 'leak');
        console.log('WRITE_SUCCESS');
      } catch (err) {
        console.error('BLOCKED:' + err.code);
        process.exit(1);
      }
    `;

    const failOp = await supervisor.executeProcess({
      runId: 'run-sandbox-exec',
      opId: 'op-write-outside',
      name: 'test-write-outside',
      capabilityId: cap.id,
      confinement: 'sandbox-exec',
      command: {
        execPath: process.execPath,
        args: ['-e', writeOutsideScript],
        cwd: allowedDir,
      },
    });

    expect(failOp.status).toBe('failed');
    expect(failOp.confined).toBe(true);
    expect(failOp.confinementDriver).toBe('sandbox-exec');
    expect(failOp.stderr).toContain('BLOCKED:EPERM');
    expect(fs.existsSync(outsideFile)).toBe(false);

    // 2. 尝试写 scope 内目录 -> 应该成功
    const insideFile = path.join(allowedDir, 'ok.txt');
    const writeInsideScript = `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(insideFile)}, 'ok content');
      console.log('WRITE_OK');
    `;

    const successOp = await supervisor.executeProcess({
      runId: 'run-sandbox-exec',
      opId: 'op-write-inside',
      name: 'test-write-inside',
      capabilityId: cap.id,
      confinement: 'sandbox-exec',
      command: {
        execPath: process.execPath,
        args: ['-e', writeInsideScript],
        cwd: allowedDir,
      },
    });

    expect(successOp.status).toBe('succeeded');
    expect(successOp.confined).toBe(true);
    expect(successOp.stdout).toContain('WRITE_OK');
    expect(fs.existsSync(insideFile)).toBe(true);
  });

  it('4.4 包装器进程被停止后目标进程无残留', async () => {
    if (process.platform !== 'darwin' || !SandboxExecConfinementDriver.isAvailable()) {
      return;
    }

    ensureTaskAndRun('run-cancel-confinement');
    const workDir = path.join(tempDir, 'work-cancel');
    fs.mkdirSync(workDir, { recursive: true });

    const cap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['res:cancel'],
      },
      'tester',
      60000
    );

    const execPromise = supervisor.executeProcess({
      runId: 'run-cancel-confinement',
      opId: 'op-cancel-confined',
      name: 'test-cancel-confined',
      capabilityId: cap.id,
      confinement: 'sandbox-exec',
      command: {
        execPath: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: workDir,
      },
    });

    // 等待 100ms 进程启动后取消
    await new Promise((resolve) => setTimeout(resolve, 100));
    await supervisor.cancelOperation('op-cancel-confined');

    const result = await execPromise;
    expect(result.status).toBe('cancelled');
    expect(result.confined).toBe(true);
  });

  it('5.1 & 5.2 契约 56: 自快照以来全部受管 op 受限执行 ⇒ 根外无副作用（默认快照为 non_ignored）; 混入不受限 op ⇒ declared_roots', async () => {
    const repoDir = path.join(tempDir, 'repo-c56');
    await makeGitRepo(repoDir);

    ensureTaskAndRun('run-c56');

    // 模拟测试用的 ConfinementDriver
    const mockDriver: ConfinementDriver = {
      name: 'mock-confinement',
      wrap(command: StructuredCommand, _roots: string[]) {
        return command;
      },
    };

    const cap = domain.issueCapability(
      {
        write: [repoDir],
        exclusive: [`workspace:write:${path.resolve(repoDir)}`],
      },
      'tester',
      60000
    );

    // 1. 捕获初始快照
    const snap1 = await supervisor.captureSnapshot({
      runId: 'run-c56',
      opId: 'snap-c56-1',
      capabilityId: cap.id,
    });
    expect(snap1.status).toBe('succeeded');

    // 2. 执行受限 op
    fs.writeFileSync(path.join(repoDir, 'file1.txt'), 'version 1\n');
    const op1 = await supervisor.executeProcess({
      runId: 'run-c56',
      opId: 'op-confined-1',
      name: 'confined-write-1',
      capabilityId: cap.id,
      confinementDriver: mockDriver,
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("op1")'],
        cwd: repoDir,
      },
    });
    expect(op1.status).toBe('succeeded');
    expect(op1.confined).toBe(true);

    // 3. 执行受限 op 2
    fs.writeFileSync(path.join(repoDir, 'file2.txt'), 'version 2\n');
    const op2 = await supervisor.executeProcess({
      runId: 'run-c56',
      opId: 'op-confined-2',
      name: 'confined-write-2',
      capabilityId: cap.id,
      confinementDriver: mockDriver,
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("op2")'],
        cwd: repoDir,
      },
    });
    expect(op2.status).toBe('succeeded');
    expect(op2.confined).toBe(true);

    // 4. 回滚：快照之后的所有 op 都是受限执行，且其 mutationRoots 都在快照根内
    //    ⇒ outOfScopeEffects: 'none_possible'；默认快照不含被忽略文件，所以 coverage 是 'non_ignored' 而不是 'complete'
    const rollback1 = await supervisor.rollback({
      runId: 'run-c56',
      opId: 'rollback-complete',
      snapshotId: 'snap-c56-1',
      capabilityId: cap.id,
    });

    expect(rollback1.status).toBe('restored');
    expect(rollback1.coverage).toBe('non_ignored');
    expect(rollback1.outOfScopeEffects).toBe('none_possible');
    expect(rollback1.capabilityId).toBe(cap.id);

    // 5. 混入一个不受限的 op
    ensureTaskAndRun('run-c56-unconfined');
    const snap2 = await supervisor.captureSnapshot({
      runId: 'run-c56-unconfined',
      opId: 'snap-c56-2',
      roots: [repoDir],
    });

    fs.writeFileSync(path.join(repoDir, 'file3.txt'), 'unconfined mod\n');
    const opUnconfined = await supervisor.executeProcess({
      runId: 'run-c56-unconfined',
      opId: 'op-unconfined',
      name: 'unconfined-op',
      requiredResources: [`workspace:write:${path.resolve(repoDir)}`],
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("unconfined")'],
        cwd: repoDir,
      },
    });
    expect(opUnconfined.status).toBe('succeeded');
    expect(opUnconfined.confined).toBeFalsy();

    // 6. 再次回滚：因混入了不受限 op，回滚 coverage 退化为 'declared_roots'，outOfScopeEffects: 'possible'
    const rollback2 = await supervisor.rollback({
      runId: 'run-c56-unconfined',
      opId: 'rollback-declared-roots',
      snapshotId: 'snap-c56-2',
    });

    expect(rollback2.status).toBe('restored');
    expect(rollback2.coverage).toBe('declared_roots');
    expect(rollback2.outOfScopeEffects).toBe('possible');
  });

  it('5.3 回滚时仍在运行的不受限 op（尚无结果记录）也会让 coverage 退化为 declared_roots', async () => {
    const repoDir = path.join(tempDir, 'repo-running');
    await makeGitRepo(repoDir);
    ensureTaskAndRun('run-running');
    const mockDriver: ConfinementDriver = { name: 'mock-confinement', wrap: (command) => command };
    const cap = domain.issueCapability(
      { write: [repoDir], exclusive: [`workspace:write:${path.resolve(repoDir)}`] },
      'tester',
      60000
    );
    const snap = await supervisor.captureSnapshot({ runId: 'run-running', opId: 'snap-running', capabilityId: cap.id });
    expect(snap.status).toBe('succeeded');

    // Unconfined, no lease, still running at rollback time: it could write anywhere.
    const started = path.join(tempDir, 'bg-started');
    const background = supervisor.executeProcess({
      runId: 'run-running',
      opId: 'op-background',
      name: 'unconfined-background',
      command: {
        execPath: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(started)}, '1'); setTimeout(() => {}, 60000)`],
        cwd: tempDir,
      },
    });
    while (!fs.existsSync(started)) await new Promise((r) => setTimeout(r, 10));

    fs.writeFileSync(path.join(repoDir, 'file1.txt'), 'confined change\n');
    const confined = await supervisor.executeProcess({
      runId: 'run-running',
      opId: 'op-confined-running',
      name: 'confined',
      capabilityId: cap.id,
      confinementDriver: mockDriver,
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: repoDir },
    });
    expect(confined.confined).toBe(true);

    const rollback = await supervisor.rollback({
      runId: 'run-running',
      opId: 'rollback-running',
      snapshotId: 'snap-running',
      capabilityId: cap.id,
    });
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('declared_roots');
    expect(rollback.outOfScopeEffects).toBe('possible');

    await supervisor.cancelOperation('op-background', 200);
    await background;
  });

  // 5.4–5.9：被忽略文件的六个变体。每个变体：签发只覆盖仓库的 capability → 拍快照 → 受限跑一条命令 → 回滚。
  async function runIgnoredVariant(name: string, includeIgnored: boolean, script: string) {
    const repoDir = path.join(tempDir, `repo-${name}`);
    await makeGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.env\n*.tmp\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'ignore rules'], { cwd: repoDir });
    const realRepo = fs.realpathSync(repoDir);

    const runId = `run-${name}`;
    ensureTaskAndRun(runId);
    const mockDriver: ConfinementDriver = { name: 'mock-confinement', wrap: (command) => command };
    const cap = domain.issueCapability(
      { write: [repoDir], exclusive: [`workspace:write:${path.resolve(repoDir)}`] },
      'tester',
      60000
    );
    const snap = await supervisor.captureSnapshot({ runId, opId: `snap-${name}`, capabilityId: cap.id, includeIgnored });
    expect(snap.status).toBe('succeeded');
    const op = await supervisor.executeProcess({
      runId,
      opId: `op-${name}`,
      name: 'edit',
      capabilityId: cap.id,
      confinementDriver: mockDriver,
      command: { execPath: '/bin/sh', args: ['-c', script], cwd: repoDir },
    });
    expect(op.status).toBe('succeeded');
    expect(op.confined).toBe(true);
    const rollback = await supervisor.rollback({ runId, opId: `rb-${name}`, snapshotId: `snap-${name}`, capabilityId: cap.id });
    const env = fs.existsSync(path.join(repoDir, '.env')) ? fs.readFileSync(path.join(repoDir, '.env'), 'utf8') : null;
    return { rollback, env, realRepo, tmpExists: fs.existsSync(path.join(repoDir, 'cache.tmp')) };
  }

  it('5.4 变体 A：默认快照，受限命令删除被忽略文件 ⇒ 不得声称 complete', async () => {
    const { rollback, env } = await runIgnoredVariant('ign-a', false, 'rm -f .env; echo changed > README.md');
    expect(env).toBeNull(); // 默认快照不含 .env，回滚恢复不了它
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.outOfScopeEffects).toBe('none_possible');
    expect(rollback.ignoredFiles).toBe('not_captured');
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'ignored_not_captured']);
  });

  it('5.5 变体 B：默认快照，受限命令修改被忽略文件 ⇒ 不得声称 complete', async () => {
    const { rollback, env } = await runIgnoredVariant('ign-b', false, 'echo SECRET=2 > .env');
    expect(env).toBe('SECRET=2\n');
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.ignoredFiles).toBe('not_captured');
  });

  it('5.6 变体 C：默认快照，受限命令新建被忽略文件 ⇒ 不得声称 complete', async () => {
    const { rollback, tmpExists } = await runIgnoredVariant('ign-c', false, 'echo junk > cache.tmp');
    expect(tmpExists).toBe(true);
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.ignoredFiles).toBe('not_captured');
  });

  it('5.7 变体 D：full_tree 快照，删除被忽略文件 ⇒ 恢复且 complete', async () => {
    const { rollback, env } = await runIgnoredVariant('ign-d', true, 'rm -f .env; echo changed > README.md');
    expect(env).toBe('SECRET=1\n');
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('complete');
    expect(rollback.outOfScopeEffects).toBe('none_possible');
    expect(rollback.ignoredFiles).toBe('restored');
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'snapshot_full_tree']);
  });

  it('5.8 变体 E：full_tree 快照，修改被忽略文件 ⇒ 恢复且 complete', async () => {
    const { rollback, env } = await runIgnoredVariant('ign-e', true, 'echo SECRET=2 > .env');
    expect(env).toBe('SECRET=1\n');
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('complete');
    expect(rollback.ignoredFiles).toBe('restored');
  });

  it('5.9 变体 F：full_tree 快照之后新建的被忽略文件 ⇒ partial 并列出，不报 failed，也不擅自删除', async () => {
    const { rollback, env, tmpExists, realRepo } = await runIgnoredVariant('ign-f', true, 'echo junk > cache.tmp');
    expect(env).toBe('SECRET=1\n');
    expect(tmpExists).toBe(true);
    expect(rollback.status).toBe('partial');
    expect(rollback.unrestoredPaths).toEqual([path.join(realRepo, 'cache.tmp')]);
    expect(rollback.coverage).toBe('declared_roots');
    expect(rollback.outOfScopeEffects).toBe('possible');
    expect(rollback.ignoredFiles).toBe('restored');
  });

  // 5.10–5.13：被忽略文件清单（trackIgnored: 'manifest'）与 removeNewIgnored
  async function makeIgnoredRepo(name: string) {
    const repoDir = path.join(tempDir, `repo-${name}`);
    await makeGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.env\n*.tmp\nbuild/\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(repoDir, 'build'));
    fs.writeFileSync(path.join(repoDir, 'build/out.js'), 'built\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'ignore rules'], { cwd: repoDir });
    const runId = `run-${name}`;
    ensureTaskAndRun(runId);
    const cap = domain.issueCapability(
      { write: [repoDir], exclusive: [`workspace:write:${path.resolve(repoDir)}`] },
      'tester',
      60000
    );
    const mockDriver: ConfinementDriver = { name: 'mock-confinement', wrap: (command) => command };
    const confined = (opId: string, script: string) =>
      supervisor.executeProcess({
        runId,
        opId,
        name: 'edit',
        capabilityId: cap.id,
        confinementDriver: mockDriver,
        command: { execPath: '/bin/sh', args: ['-c', script], cwd: repoDir },
      });
    return { repoDir, realRepo: fs.realpathSync(repoDir), runId, cap, confined };
  }

  it('5.10 清单：被忽略文件确实没变 ⇒ 默认快照也能证明 complete（unchanged_verified）', async () => {
    const { runId, cap, confined } = await makeIgnoredRepo('man-same');
    const snap = await supervisor.captureSnapshot({ runId, opId: 'snap-man-same', capabilityId: cap.id, trackIgnored: 'manifest' });
    expect(snap.snapshot?.coverage).toBe('worktree_non_ignored');
    expect(snap.snapshot?.ignoredManifestDigest).toMatch(/^[0-9a-f]{64}$/);
    // 清单里的路径名不进 journal，只记摘要与条目数
    const captured = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'SNAPSHOT_CAPTURED');
    expect((captured?.payload as any).ignoredManifest).toEqual({ digest: snap.snapshot?.ignoredManifestDigest, entries: 2 });

    // 读被忽略文件、改未被忽略文件：清单不受影响
    expect((await confined('op-man-same', 'cat .env build/out.js > /dev/null; echo changed > README.md')).confined).toBe(true);
    const rollback = await supervisor.rollback({ runId, opId: 'rb-man-same', snapshotId: 'snap-man-same', capabilityId: cap.id });
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('complete');
    expect(rollback.outOfScopeEffects).toBe('none_possible');
    expect(rollback.ignoredFiles).toBe('unchanged_verified');
    expect(rollback.ignoredChanges).toBeUndefined();
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'ignored_manifest_unchanged']);
  });

  it('5.11 清单：被忽略文件删 / 改 / 增 ⇒ non_ignored，并在 ignoredChanges 里逐类列出', async () => {
    const { runId, cap, confined, realRepo } = await makeIgnoredRepo('man-diff');
    await supervisor.captureSnapshot({ runId, opId: 'snap-man-diff', capabilityId: cap.id, trackIgnored: 'manifest' });
    await confined('op-man-diff', 'rm -f .env; echo rebuilt-longer > build/out.js; echo junk > cache.tmp');
    const rollback = await supervisor.rollback({ runId, opId: 'rb-man-diff', snapshotId: 'snap-man-diff', capabilityId: cap.id });
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.ignoredFiles).toBe('not_captured');
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'ignored_manifest_changed']);
    expect(rollback.ignoredChanges).toEqual({
      added: [path.join(realRepo, 'cache.tmp')],
      removed: [path.join(realRepo, '.env')],
      modified: [path.join(realRepo, 'build/out.js')],
      metadataOnly: [],
      truncated: false,
      counts: { added: 1, removed: 1, modified: 1, metadataOnly: 0 },
    });
  });

  it('5.12 清单：内容改写后把大小与 mtime 还原 ⇒ 仍不给 complete（只有 ctime 变了，无法证明未变）', async () => {
    const { runId, cap, confined, realRepo, repoDir } = await makeIgnoredRepo('man-ctime');
    // 整秒的 mtime 才能用 utimes 原样还原（Date 只有毫秒精度，清单比较到纳秒）
    const stamp = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(path.join(repoDir, '.env'), stamp, stamp);
    await supervisor.captureSnapshot({ runId, opId: 'snap-man-ctime', capabilityId: cap.id, trackIgnored: 'manifest' });
    await confined('op-man-ctime', 'printf "SECRET=9\\n" > .env');
    fs.utimesSync(path.join(repoDir, '.env'), stamp, stamp);
    expect(fs.readFileSync(path.join(repoDir, '.env'), 'utf8')).toBe('SECRET=9\n');
    const rollback = await supervisor.rollback({ runId, opId: 'rb-man-ctime', snapshotId: 'snap-man-ctime', capabilityId: cap.id });
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.ignoredFiles).toBe('not_captured');
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'ignored_manifest_ctime_only']);
    expect(rollback.ignoredChanges?.metadataOnly).toEqual([path.join(realRepo, '.env')]);
    expect(rollback.ignoredChanges?.modified).toEqual([]);
  });

  it('5.13 清单文件丢失 ⇒ 不给 complete，依据写明 unreadable；pruneSnapshots 会删除清单', async () => {
    const { runId, cap } = await makeIgnoredRepo('man-lost');
    await supervisor.captureSnapshot({ runId, opId: 'snap-man-lost', capabilityId: cap.id, trackIgnored: 'manifest' });
    await supervisor.captureSnapshot({ runId, opId: 'snap-man-kept', capabilityId: cap.id, trackIgnored: 'manifest' });
    const manifest = (id: string) => path.join(domain.domainPath, 'artifacts', `${id}-ignored.manifest`);
    expect(fs.existsSync(manifest('snap-man-lost'))).toBe(true);
    expect(fs.statSync(manifest('snap-man-lost')).mode & 0o777).toBe(0o600);

    // 产物回收不动仍在的快照的清单
    domain.pruneArtifacts();
    expect(fs.existsSync(manifest('snap-man-kept'))).toBe(true);

    fs.rmSync(manifest('snap-man-lost'));
    const rollback = await supervisor.rollback({ runId, opId: 'rb-man-lost', snapshotId: 'snap-man-lost', capabilityId: cap.id });
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'ignored_manifest_unreadable']);

    await supervisor.pruneSnapshots(['snap-man-kept']);
    expect(fs.existsSync(manifest('snap-man-kept'))).toBe(false);
  });

  it('5.14 removeNewIgnored: true ⇒ full_tree 快照之后新出现的被忽略文件被删除，状态 restored / complete', async () => {
    const { runId, cap, confined, repoDir } = await makeIgnoredRepo('rm-new');
    await supervisor.captureSnapshot({ runId, opId: 'snap-rm-new', capabilityId: cap.id, includeIgnored: true });
    await confined('op-rm-new', 'echo junk > cache.tmp; mkdir -p deps/pkg && echo x > deps/pkg/a.tmp; echo more > build/extra.js');
    const rollback = await supervisor.rollback({
      runId,
      opId: 'rb-rm-new',
      snapshotId: 'snap-rm-new',
      capabilityId: cap.id,
      removeNewIgnored: true,
    });
    expect(rollback.status).toBe('restored');
    expect(rollback.coverage).toBe('complete');
    expect(rollback.unrestoredPaths).toBeUndefined();
    expect(fs.existsSync(path.join(repoDir, 'cache.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'deps'))).toBe(false); // 因此变空的新目录一并清掉
    expect(fs.existsSync(path.join(repoDir, 'build/extra.js'))).toBe(false);
    expect(fs.readFileSync(path.join(repoDir, 'build/out.js'), 'utf8')).toBe('built\n'); // 快照里已有的被忽略文件原样
  });

  it('5.15 默认保留新出现的被忽略文件：整个新目录折叠成一项，快照里已有目录下的新文件逐个列出', async () => {
    const { runId, cap, confined, repoDir, realRepo } = await makeIgnoredRepo('keep-new');
    await supervisor.captureSnapshot({ runId, opId: 'snap-keep-new', capabilityId: cap.id, includeIgnored: true });
    await confined('op-keep-new', 'mkdir -p deps/pkg && echo x > deps/pkg/a.tmp && echo y > deps/pkg/b.tmp; echo more > build/extra.js; echo SECRET=2 > .env');
    const rollback = await supervisor.rollback({ runId, opId: 'rb-keep-new', snapshotId: 'snap-keep-new', capabilityId: cap.id });
    expect(rollback.status).toBe('partial');
    expect(rollback.unrestoredPaths).toEqual([path.join(realRepo, 'build/extra.js'), path.join(realRepo, 'deps') + path.sep]);
    expect(fs.readFileSync(path.join(repoDir, '.env'), 'utf8')).toBe('SECRET=1\n'); // 已捕获的内容照常恢复
    expect(fs.existsSync(path.join(repoDir, 'deps/pkg/a.tmp'))).toBe(true);
  });

  it('5.16 读集归一（utimes）会推进被忽略文件的 ctime：清单不把它们报成已修改，但也不再给 complete', async () => {
    const { runId, cap, repoDir } = await makeIgnoredRepo('man-atime');
    // Isolate ctime changes: utimes' floating-point seconds can round a fresh
    // nanosecond mtime across the manifest's one-microsecond tolerance.
    for (const name of ['.env', 'build/out.js']) fs.utimesSync(path.join(repoDir, name), 1_700_000_000, 1_700_000_000);
    await supervisor.captureSnapshot({ runId, opId: 'snap-man-atime', capabilityId: cap.id, trackIgnored: 'manifest' });
    normalizeAccessTimes(repoDir);
    const rollback = await supervisor.rollback({ runId, opId: 'rb-man-atime', snapshotId: 'snap-man-atime', capabilityId: cap.id });
    expect(rollback.coverage).toBe('non_ignored');
    expect(rollback.coverageBasis).toEqual(['all_ops_confined', 'ignored_manifest_ctime_only']);
    expect(rollback.ignoredChanges?.counts).toEqual({ added: 0, removed: 0, modified: 0, metadataOnly: 2 });
  });

  it('5.17 回滚被崩溃打断后的恢复结果走同一推导：指纹一致也只到 declared_roots，依据写明未核验', async () => {
    const { runId, repoDir } = await makeIgnoredRepo('rb-crash');
    await supervisor.captureSnapshot({ runId, opId: 'snap-rb-crash', roots: [repoDir], includeIgnored: true });
    // 回滚意图已登记、结果未落盘时宿主崩溃
    domain.registerOperationIntent({
      id: 'rb-crashed',
      runId,
      kind: 'rollback',
      name: 'rollback:snap-rb-crash',
      inputFingerprint: 'rb-crashed',
      requiredResources: [`workspace:write:${path.resolve(repoDir)}`],
      mutationRoots: [path.resolve(repoDir)],
      outputRef: 'snap-rb-crash',
      status: 'intent_registered',
    });
    domain.getStore().updateOperationStatus('rb-crashed', 'active');
    domain.close();

    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'confine-domain');
    await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(domain.getStore().getOperation('rb-crashed')?.result).toMatchObject({
      kind: 'rollback',
      status: 'restored',
      coverage: 'declared_roots',
      outOfScopeEffects: 'possible',
      ignoredFiles: 'restored',
      coverageBasis: ['effects_unverified', 'snapshot_full_tree'],
    });
  });
});
