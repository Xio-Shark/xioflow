import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';
import { ProcessOperationResult, OperationNotActiveError } from '../../src/types.js';

describe('内核 0.2.0 批次 1 (B1): 终态单一写入者与诚实性契约测试 [P0-2, P0-4, N1, N3]', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-b1-test-'));
    domain = ExecutionDomain.acquire(tempDir, 'test-b1-domain');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);

    domain.getStore().saveTask({
      id: 'task-b1',
      domainId: 'test-b1-domain',
      name: 'B1 Task',
      createdAt: new Date().toISOString(),
    });

    domain.getStore().saveRun({
      id: 'run-b1',
      taskId: 'task-b1',
      domainId: 'test-b1-domain',
      owner: 'test-runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    try {
      const subPidFile = path.join(tempDir, 'sub.pid');
      if (fs.existsSync(subPidFile)) {
        const pid = parseInt(fs.readFileSync(subPidFile, 'utf8').trim(), 10);
        if (!isNaN(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }
    } catch {}
    if (!domain.isClosed()) {
      domain.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // --------------------------------------------------------------------------
  // 用例 1 (N1): 取消/超时操作的事实唯一性与信号诚实性
  // --------------------------------------------------------------------------
  it('1.1 [N1] 取消操作事实唯一且诚实：journal 仅有 1 条结果事件，且 signal 为真实终止信号而非编造的 SIGKILL', async () => {
    const opId = 'op-n1-cancel-honesty';
    const execPromise = supervisor.executeProcess({
      runId: 'run-b1',
      opId,
      name: 'cancel-honesty-op',
      command: {
        execPath: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000);'],
        cwd: tempDir,
      },
      requiredResources: ['res:n1-cancel'],
    });

    // 稍作等待确保进程启动进入 active
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 发起优雅取消（SIGINT 即可停止 Node 进程）
    const cancelResult = await supervisor.cancelOperation(opId, 1500);
    expect(cancelResult.stopped).toBe(true);

    const result = await execPromise;
    expect(result.status).toBe('cancelled');

    // 检查数据库 journal 事件日志
    const events = domain.getStore().getJournalEvents('test-b1-domain');
    const resultEvents = events.filter(
      (e) => e.operationId === opId && e.type === 'OPERATION_RESULT_RECORDED'
    );

    // 关键断言 1: 事实只写一次，绝不产生先写粗糙结果再覆盖的两条记录
    expect(
      resultEvents.length,
      `Expected exactly 1 OPERATION_RESULT_RECORDED for ${opId}, found ${resultEvents.length}`
    ).toBe(1);

    // 关键断言 2: 第一条也是唯一一条结果，其信号必须是真实信号（SIGINT），禁止编造成 SIGKILL
    const recordedResult = (resultEvents[0].payload as any).result as ProcessOperationResult;
    expect(recordedResult.signal).toBe('SIGINT');
  });

  // --------------------------------------------------------------------------
  // 用例 2 (N1): 崩溃恢复对未知死因进程的诚实性
  // --------------------------------------------------------------------------
  it('1.2 [N1] 恢复未知死因进程：exitCode 与 signal 必须记为 null，严禁编造 137 / SIGKILL', async () => {
    const opId = 'op-n1-recovery-honesty';
    const nonExistentPid = 999999; // 绝不可能存活的 PID

    // 模拟写入一个因为宿主崩溃残留的 active 操作
    domain.getStore().registerOperationIntent(
      {
        id: opId,
        runId: 'run-b1',
        kind: 'process',
        name: 'crashed-op',
        status: 'intent_registered',
        inputFingerprint: 'dummy',
        requiredResources: ['res:crashed-res'],
      },
      'test-b1-domain'
    );
    domain.getStore().updateOperationStatus(opId, 'active', {
      pid: nonExistentPid,
      spawnTime: new Date().toISOString(),
      commandFingerprint: 'dummy',
    });

    // 创建恢复引擎接管
    const recoveryEngine = new RecoveryEngine(domain, driver);
    const report = await recoveryEngine.recover();

    expect(report.recoveredOperations.some((r) => r.opId === opId)).toBe(true);

    const recoveredOp = domain.getStore().getOperation(opId);
    expect(recoveredOp).toBeDefined();
    expect(recoveredOp?.status).toBe('done');

    const result = recoveredOp?.result as ProcessOperationResult;
    expect(result).toBeDefined();
    expect(result.status).toBe('failed');

    // 关键断言: 对死因未知的进程，退出码与信号未被实时观测，必须记为 null，绝对不能编造 137 / SIGKILL
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 用例 3 (P0-4 / 契约 #12): 取消非活跃操作规范化
  // --------------------------------------------------------------------------
  it('1.3 [P0-4] 取消不存在、已完成、或域已关闭的操作必须抛出显式错误，禁止返回 stopped: true', async () => {
    // 3a. 不存在的操作 -> 抛出 OperationNotActiveError 且 reason 为 not_found
    await expect(
      supervisor.cancelOperation('op-nonexistent-xyz')
    ).rejects.toSatisfy((err: any) => {
      expect(err).toBeInstanceOf(OperationNotActiveError);
      expect(err.reason).toBe('not_found');
      return true;
    });

    // 3b. 已正常终结的操作 -> 抛出 OperationNotActiveError 且 reason 为 already_completed
    const opCompletedId = 'op-already-completed';
    await supervisor.executeProcess({
      runId: 'run-b1',
      opId: opCompletedId,
      name: 'completed-op',
      command: {
        execPath: process.execPath,
        args: ['-e', 'process.exit(0);'],
        cwd: tempDir,
      },
      requiredResources: [],
    });

    await expect(
      supervisor.cancelOperation(opCompletedId)
    ).rejects.toSatisfy((err: any) => {
      expect(err).toBeInstanceOf(OperationNotActiveError);
      expect(err.reason).toBe('already_completed');
      return true;
    });

    // 3c. 域已关闭时调用 cancelOperation -> 抛出 OperationNotActiveError 且 reason 为 domain_closed
    domain.close();
    await expect(
      supervisor.cancelOperation('op-any-id')
    ).rejects.toSatisfy((err: any) => {
      expect(err).toBeInstanceOf(OperationNotActiveError);
      expect(err.reason).toBe('domain_closed');
      return true;
    });
  });

  // --------------------------------------------------------------------------
  // 用例 3b: 在等资源/启动途中取消操作（防止取消丢失）
  // --------------------------------------------------------------------------
  it('1.3b [P0-4/生命周期] 在资源等待或启动途中取消操作：不抛 not_found 异常，返回 stopped: true，结果收敛为 cancelled', async () => {
    // 先占用一个独占资源
    domain.allocateResources('op-holder', ['res:busy-port']);

    // 启动一个需要该资源的操作，并设置等待时间，让它处于 waiting_resources 阶段
    const opWaitingId = 'op-waiting-cancel';
    const execPromise = supervisor.executeProcess({
      runId: 'run-b1',
      opId: opWaitingId,
      name: 'waiting-cancel-op',
      command: {
        execPath: process.execPath,
        args: ['-e', 'process.exit(0);'],
        cwd: tempDir,
      },
      requiredResources: ['res:busy-port'],
      waitTimeoutMs: 5000,
    });

    // 稍等让其进入 waiting_resources
    await new Promise((r) => setTimeout(r, 20));

    // 调用 cancelOperation 取消处于 waiting_resources 的操作
    const cancelRes = await supervisor.cancelOperation(opWaitingId);
    expect(cancelRes.stopped).toBe(true);

    const execResult = await execPromise;
    expect(execResult.status).toBe('cancelled');
    expect(execResult.terminationReason).toBe('user_cancelled');
    expect(execResult.evidence).toBe('unobserved');

    // 检查 store 中的操作状态已为 done 且结果为 cancelled
    const opInStore = domain.getStore().getOperation(opWaitingId);
    expect(opInStore?.status).toBe('done');
    expect(opInStore?.result?.status).toBe('cancelled');

    // 释放占位资源
    domain.releaseResources('op-holder', ['res:busy-port']);
  });

  // --------------------------------------------------------------------------
  // 用例 4 (P0-2 / 契约 #11): 超时 + setsid 逃逸后代持有管道时有界返回
  // --------------------------------------------------------------------------
  it('1.4 [P0-2] 超时 + 逃逸后代持有管道：操作在有界时间内返回，绝不挂到逃逸后代自行退出', async () => {
    // 构造一个脚本：
    // 主进程派生一个 detached 孙进程，孙进程保持 stdout 管道打开并 sleep 8 秒；
    // 孙进程将 pid 写入 tempDir/sub.pid 供 afterEach 兜底杀死，避免孤儿逃逸。
    const subPidFile = path.join(tempDir, 'sub.pid');
    const runnerScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const sub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000);'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit']
      });
      fs.writeFileSync(${JSON.stringify(subPidFile)}, String(sub.pid));
      setInterval(() => {}, 1000);
    `;

    const startedAt = Date.now();
    const timeoutMs = 600;
    const drainTimeoutMs = 300;

    const result = await supervisor.executeProcess({
      runId: 'run-b1',
      opId: 'op-p02-timeout-bounded',
      name: 'timeout-bounded-op',
      command: {
        execPath: process.execPath,
        args: ['-e', runnerScript],
        cwd: tempDir,
      },
      requiredResources: ['res:p02'],
      timeoutMs,
      drainTimeoutMs,
    });

    const duration = Date.now() - startedAt;

    // 契约 #11 上界说明：
    // 对于响应 SIGINT 的常规进程：timeoutMs(600) + 停止宽限(1500) + drainTimeoutMs(300) = 2400ms。
    // 注：若根进程忽略 SIGINT，驱动的升级梯子为 grace(1500ms) -> SIGTERM(1000ms) -> SIGKILL(1000ms)，额外增加 2000ms。
    // 本用例中根进程正常响应 SIGINT，耗时上界控制在 3000ms 内。若存在 P0-2 缺陷，将会挂死等待逃逸后代退出（耗时 > 7500ms）。
    expect(
      duration,
      `executeProcess took ${duration}ms, which exceeded bounded limit (expected < 3000ms)`
    ).toBeLessThan(3000);

    // 契约 #11: 超时 + 逃逸后代：操作在有界时间内返回 indeterminate，不挂到逃逸进程退出
    expect(result.status).toBe('indeterminate');
  }, 12_000);

  // --------------------------------------------------------------------------
  // 用例 5 (N3): Run 语义对齐与终态保护
  // --------------------------------------------------------------------------
  it('1.5 [N3] 单个 op 超时/失败不改写所属 Run 状态；已终结的 Run 拒绝登记新操作', async () => {
    const opId = 'op-n3-run-isolation';

    // 5a. 执行一个超时的操作
    await supervisor.executeProcess({
      runId: 'run-b1',
      opId,
      name: 'timeout-op',
      command: {
        execPath: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000);'],
        cwd: tempDir,
      },
      requiredResources: [],
      timeoutMs: 400,
    });

    // 验证 Run 状态：单个 op 失败绝不能把整个 Run 标死为 failed
    const runAfterTimeout = domain.getStore().getRun('run-b1');
    expect(
      runAfterTimeout?.status,
      `Expected Run status to remain "running" after single op failure, but found "${runAfterTimeout?.status}"`
    ).toBe('running');

    // 5b. 显式完成 Run 成为终态
    domain.getStore().reportRunSucceeded('run-b1');
    const finalRun = domain.getStore().getRun('run-b1');
    expect(finalRun?.status).toBe('succeeded');

    // 5c. 向已经终结的 Run 登记新操作，必须被显式拒绝
    expect(() => {
      domain.getStore().registerOperationIntent(
        {
          id: 'op-new-after-run-done',
          runId: 'run-b1',
          kind: 'process',
          name: 'late-op',
          status: 'intent_registered',
          inputFingerprint: 'dummy',
          requiredResources: [],
        },
        'test-b1-domain'
      );
    }).toThrow(/already finalized|succeeded|not allowed/i);
  });

  // --------------------------------------------------------------------------
  // 用例 5b (N3 深度防线): Run 终态不可翻转
  // --------------------------------------------------------------------------
  it('1.5b [N3] Run 终态不可翻转防线：已处于 failed 的 Run 拒绝被 reportRunSucceeded 或 updateRunStatus 翻转', async () => {
    const runId = 'run-immutable-test';
    domain.getStore().saveRun({
      id: runId,
      taskId: 'task-b1',
      domainId: 'test-b1-domain',
      owner: 'test-runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    // 终结该 Run 为 failed
    domain.getStore().reportRunFailed(runId, 'timed_out');
    const runFailed = domain.getStore().getRun(runId);
    expect(runFailed?.status).toBe('failed');

    // 1. 尝试使用 reportRunSucceeded 翻转为 succeeded，必须被拒绝抛错
    expect(() => {
      domain.getStore().reportRunSucceeded(runId);
    }).toThrow(/already finalized with status 'failed'/i);

    // 2. 尝试使用 updateRunStatus 直接改写状态为 succeeded，必须被拒绝抛错
    expect(() => {
      domain.getStore().updateRunStatus(runId, 'succeeded');
    }).toThrow(/Cannot transition Run "run-immutable-test" from terminal status "failed" to "succeeded"/i);

    // 3. 尝试使用 saveRun 覆盖状态为 running，必须被拒绝抛错
    expect(() => {
      domain.getStore().saveRun({
        id: runId,
        taskId: 'task-b1',
        domainId: 'test-b1-domain',
        owner: 'test-runner',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }).toThrow(/Cannot transition Run "run-immutable-test" from terminal status "failed" to "running"/i);

    // 验证状态依旧保持 failed，未被污染
    expect(domain.getStore().getRun(runId)?.status).toBe('failed');
  });

  // --------------------------------------------------------------------------
  // 用例 6 (I2/I3 不变量守卫): 校验持久化层零违例
  // --------------------------------------------------------------------------
  it('1.6 [I2/I3 不变量守卫] 验证数据库无残留无主租约 (I2) 且结果事实只写一次 (I3)', () => {
    const rawDb = (domain.getStore() as any).db;

    // I3 守卫: 每一个 operation_id 最多只能有 1 条 OPERATION_RESULT_RECORDED 事件
    const multiResultStmt = rawDb.prepare(`
      SELECT operation_id, COUNT(*) AS c 
      FROM journal_events 
      WHERE type = 'OPERATION_RESULT_RECORDED' 
      GROUP BY operation_id 
      HAVING c > 1;
    `);
    const multiResults = multiResultStmt.all();
    expect(multiResults, 'Found duplicate OPERATION_RESULT_RECORDED events').toHaveLength(0);

    // I2 守卫: done 的操作不得在 resource_leases 表中残留排他租约
    const orphanedLeasesStmt = rawDb.prepare(`
      SELECT l.resource_id, l.operation_id, o.status
      FROM resource_leases l
      JOIN operations o ON l.operation_id = o.id
      WHERE o.status = 'done' AND json_extract(o.result, '$.status') != 'indeterminate';
    `);
    const orphanedLeases = orphanedLeasesStmt.all();
    expect(orphanedLeases, 'Found orphaned resource leases for completed operations').toHaveLength(0);

    // 守卫: 绝无编造的 137/SIGKILL 虚假组合（当无真实退出观测时）
    const fabricatedStmt = rawDb.prepare(`
      SELECT id, result 
      FROM operations 
      WHERE json_extract(result, '$.status') = 'cancelled' 
        AND json_extract(result, '$.signal') = 'SIGKILL'
        AND json_extract(result, '$.identityVerification') = 'not_original_process';
    `);
    const fabricated = fabricatedStmt.all();
    expect(fabricated, 'Found fabricated 137/SIGKILL combinations in operations').toHaveLength(0);
  });
});
