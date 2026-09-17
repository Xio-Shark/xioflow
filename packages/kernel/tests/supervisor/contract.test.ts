import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain, ResourceConflictError } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';
import { PlatformDriver, ProcessIdentity, StopProcessResult } from '../../src/driver/types.js';

describe('Task 02: Real Platform Driver, Stopping Pipeline & Headless Contract Tests', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-driver-test-'));
    domain = ExecutionDomain.acquire(tempDir, 'driver-domain');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);

    // 创建初始 Task 和 Run
    domain.getStore().saveTask({
      id: 'task-drv',
      domainId: 'driver-domain',
      name: 'Driver Task',
      createdAt: new Date().toISOString(),
    });
    domain.getStore().saveRun({
      id: 'run-drv',
      taskId: 'task-drv',
      domainId: 'driver-domain',
      owner: 'test-runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    domain.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. 错误命令启动立即失败：绝不产生假 running 状态 (No Fake Running)', async () => {
    const result = await supervisor.executeProcess({
      runId: 'run-drv',
      opId: 'op-nonexistent',
      name: 'run-bogus-cmd',
      command: {
        execPath: '/path/to/definitely/nonexistent/binary_xyz',
        args: [],
        cwd: tempDir,
      },
      requiredResources: ['res:dummy'],
    });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(127);
    expect(result.identityVerification).toBe('not_original_process');

    // 验证资源已立即释放，没有假挂起
    expect(domain.isResourceLocked('res:dummy')).toBe(false);

    // 检查领域事件中不存在 'OPERATION_STATUS_TRANSITION' 为 active
    const events = domain.getStore().getJournalEvents('driver-domain');
    const activeTransitions = events.filter(
      (e) => e.type === 'OPERATION_STATUS_TRANSITION' && (e.payload as any).status === 'active'
    );
    expect(activeTransitions.length).toBe(0);
  });

  it('2. 大输出有界排空与截断：超限顺畅退出并标记 isTruncated: true', async () => {
    // 快速生成约 12MB stdout 输出（超出 10MB 上限）
    const printScript = `process.stdout.write('A'.repeat(1024 * 1024 * 12));`;

    const result = await supervisor.executeProcess({
      runId: 'run-drv',
      opId: 'op-heavy-output',
      name: 'heavy-output-op',
      command: {
        execPath: process.execPath,
        args: ['-e', printScript],
        cwd: tempDir,
      },
      requiredResources: ['res:output'],
      maxOutputBytes: 10 * 1024 * 1024, // 10MB
    });

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.isTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(domain.isResourceLocked('res:output')).toBe(false);
  });

  it('3. 停止确认流水线：超时/取消进入 stopping，确认退出后才释放锁', async () => {
    // 启动一个休眠 10 秒的子进程
    const sleepScript = `setTimeout(() => {}, 10000);`;

    const runPromise = supervisor.executeProcess({
      runId: 'run-drv',
      opId: 'op-sleep',
      name: 'sleep-op',
      command: {
        execPath: process.execPath,
        args: ['-e', sleepScript],
        cwd: tempDir,
      },
      requiredResources: ['res:exclusive-lock'],
      timeoutMs: 300, // 300ms 超时
    });

    // 等待子进程启动并进入 active
    await new Promise((r) => setTimeout(r, 100));
    expect(domain.isResourceLocked('res:exclusive-lock')).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe('failed'); // timed out
    // 经驱动确认停止后，锁已被释放
    expect(domain.isResourceLocked('res:exclusive-lock')).toBe(false);
  });

  it('4. 未确认停止保留锁：模拟驱动无法确认停止时转入 indeterminate 且保留隔离', async () => {
    // 创建一个 Mock 驱动，terminate 返回 stopped = false
    const mockStubbornDriver: PlatformDriver = {
      name: 'stubborn-driver',
      capabilities: { processGroupKill: false, accurateStartTime: false },
      async spawn(cmd) {
        return driver.spawn(cmd);
      },
      async verifyIdentity() {
        return 'cannot_determine';
      },
      async terminate(): Promise<StopProcessResult> {
        return {
          stopped: false,
          scope: 'unknown',
          residualPids: [99999],
          errorDetails: 'Process refused to die',
        };
      },
    };

    const mockSupervisor = new ProcessSupervisor(domain, mockStubbornDriver);
    const runPromise = mockSupervisor.executeProcess({
      runId: 'run-drv',
      opId: 'op-stubborn',
      name: 'stubborn-op',
      command: {
        execPath: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000);'],
        cwd: tempDir,
      },
      requiredResources: ['res:stubborn-resource'],
    });

    await new Promise((r) => setTimeout(r, 100));
    // 手动取消
    const cancelRes = await mockSupervisor.cancelOperation('op-stubborn');
    expect(cancelRes.stopped).toBe(false);

    // 关键架构红线断言：未确认停止时，资源锁绝对不能被释放！
    expect(domain.isResourceLocked('res:stubborn-resource')).toBe(true);

    const opRecord = domain.getStore().getOperation('op-stubborn');
    expect(opRecord?.result?.status).toBe('indeterminate');

    // 清理测试用的后台子进程并等待结束
    const active = (mockSupervisor as any).activeOperations.get('op-stubborn');
    if (active?.handle?.rawProcess) {
      active.handle.rawProcess.kill('SIGKILL');
    }
    await runPromise;
  });

  it('5. 崩溃恢复故障注入：意图登记后崩溃，重启时安全清理', async () => {
    // 在 SQLite 中手动登记未启动的意图
    domain.registerOperationIntent({
      id: 'op-crashed-before-spawn',
      runId: 'run-drv',
      kind: 'process',
      name: 'crashed-op',
      inputFingerprint: 'fp-crash',
      requiredResources: ['res:crash-lock'],
      status: 'pending',
    });

    expect(domain.isResourceLocked('res:crash-lock')).toBe(true);

    // 模拟内核崩溃重启
    domain.close();
    const restartedDomain = ExecutionDomain.acquire(tempDir, 'driver-domain');
    expect(restartedDomain.isResourceLocked('res:crash-lock')).toBe(true);

    // 运行恢复引擎
    const recoveryEngine = new RecoveryEngine(restartedDomain, driver);
    const report = await recoveryEngine.recover();

    expect(report.recoveredOperations).toHaveLength(1);
    expect(report.recoveredOperations[0].action).toBe('cleaned_unspawned');
    expect(report.recoveredOperations[0].resourcesReleased).toBe(true);

    // 隔离屏障解除
    expect(restartedDomain.isResourceLocked('res:crash-lock')).toBe(false);
    restartedDomain.close();
  });

  it('6. 独立运行继续：冲突资源被 indeterminate 隔离后，已证明独立的运行继续', async () => {
    // 模拟存在一个未解决的 indeterminate 故障操作占用 res:db
    domain.registerOperationIntent({
      id: 'op-failed-db',
      runId: 'run-drv',
      kind: 'process',
      name: 'failed-db-op',
      inputFingerprint: 'fp-db',
      requiredResources: ['res:db'],
      status: 'pending',
    });
    // 标记为 indeterminate 且保留锁定
    domain.getStore().recordOperationResult(
      'op-failed-db',
      {
        kind: 'indeterminate',
        status: 'indeterminate',
        reason: 'Uncertain DB state',
        recoveryGuidance: 'Check DB cluster manually',
        durationMs: 0,
        completedAt: new Date().toISOString(),
      },
      false
    );

    expect(domain.isResourceLocked('res:db')).toBe(true);

    // 尝试申请冲突资源 res:db 必须报错
    expect(() => {
      domain.allocateResources('op-new-db', ['res:db']);
    }).toThrowError(ResourceConflictError);

    // 独立操作申请非冲突资源，受监督执行顺畅无阻
    const independentResult = await supervisor.executeProcess({
      runId: 'run-drv',
      opId: 'op-independent-worker',
      name: 'worker-op',
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("Independent worker finished");'],
        cwd: tempDir,
      },
      requiredResources: ['res:independent-worker'],
    });

    expect(independentResult.status).toBe('succeeded');
    expect(independentResult.stdout.trim()).toBe('Independent worker finished');
  });
});
