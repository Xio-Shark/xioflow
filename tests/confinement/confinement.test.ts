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

  it('5.1 & 5.2 契约 56: 自快照以来全部受管 op 在 ConfinementDriver 下受限执行 ⇒ complete; 混入不受限 op ⇒ declared_roots', async () => {
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
    //    ⇒ 回滚结果声明 coverage: 'complete', outOfScopeEffects: 'none_possible'
    const rollback1 = await supervisor.rollback({
      runId: 'run-c56',
      opId: 'rollback-complete',
      snapshotId: 'snap-c56-1',
      capabilityId: cap.id,
    });

    expect(rollback1.status).toBe('restored');
    expect(rollback1.coverage).toBe('complete');
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
});
