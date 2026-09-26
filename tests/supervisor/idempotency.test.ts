import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ProcessSupervisor, computeInputFingerprint } from '../../src/supervisor/supervisor.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';
import {
  OperationIdConflictError,
  RecoveryRequiredError,
  DuplicateOperationError,
  ProcessOperationResult,
} from '../../src/types.js';

describe('内核 0.3.0: op 幂等执行契约测试 (Idempotent Execution) [ARCHITECTURE §3.7 / 契约 #45–#49]', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;
  let counterFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-idempotency-test-'));
    counterFile = path.join(tempDir, 'counter.log');
    domain = ExecutionDomain.acquire(tempDir, 'test-domain-idem');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);

    domain.getStore().saveTask({
      id: 'task-1',
      domainId: 'test-domain-idem',
      name: 'Task 1',
      createdAt: new Date().toISOString(),
    });

    domain.getStore().saveRun({
      id: 'run-1',
      taskId: 'task-1',
      domainId: 'test-domain-idem',
      owner: 'runner-1',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    if (!domain.isClosed()) {
      domain.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // 1.1 已结清 op 同指纹重放 → 返回同一结果，replayed: true，进程未再启动，journal 有 OPERATION_REPLAYED(mode=recorded)
  it('1.1 已结清 op 同指纹重放：返回同一结果且 replayed=true，副作用仅发生一次，记录 OPERATION_REPLAYED(mode=recorded)', async () => {
    const opId = 'op-recorded-1';
    const script = `const fs = require('fs'); fs.appendFileSync(process.argv[1], 'hit\\n'); console.log('hello');`;

    const options = {
      runId: 'run-1',
      opId,
      name: 'test-effect',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', script, counterFile],
        cwd: tempDir,
      },
    };

    // 第一次执行
    const res1 = await supervisor.executeProcess(options);
    expect(res1.status).toBe('succeeded');
    expect(res1.replayed).toBeUndefined();
    expect(res1.stdout).toContain('hello');

    // 验证副作用发生了 1 次
    const content1 = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(content1).toEqual(['hit']);

    // 第二次执行：相同 opId、相同输入指纹
    const res2 = await supervisor.executeProcess(options);
    expect(res2.status).toBe('succeeded');
    expect(res2.replayed).toBe(true);
    expect(res2.stdout).toContain('hello');

    // 验证副作用没有再次发生（依然是 1 次）
    const content2 = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(content2.length).toBe(1);

    // 验证 journal 记录了 OPERATION_REPLAYED (mode: 'recorded')
    const events = domain.getStore().getJournalEvents('test-domain-idem');
    const replayEvent = events.find(
      (e) => e.type === 'OPERATION_REPLAYED' && e.operationId === opId
    );
    expect(replayEvent).toBeDefined();
    expect(replayEvent?.payload.mode).toBe('recorded');
  });

  // 1.2 同 opId 不同指纹（只改 cwd）→ OperationIdConflictError，已有 op 事实不变
  it('1.2 同 opId 不同指纹：抛出 OperationIdConflictError，已有 op 事实不变', async () => {
    const opId = 'op-conflict-2';
    const subDir = path.join(tempDir, 'sub-dir');
    fs.mkdirSync(subDir, { recursive: true });

    const options1 = {
      runId: 'run-1',
      opId,
      name: 'test-original',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("original")'],
        cwd: tempDir,
      },
    };

    const res1 = await supervisor.executeProcess(options1);
    expect(res1.status).toBe('succeeded');

    const options2 = {
      runId: 'run-1',
      opId,
      name: 'test-conflict',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("original")'],
        cwd: subDir, // 不同 cwd 导致指纹不同
      },
    };

    await expect(supervisor.executeProcess(options2)).rejects.toThrow(OperationIdConflictError);

    // 验证已有 op 记录未被破坏
    const recorded = domain.getStore().getOperation(opId);
    expect(recorded).toBeDefined();
    expect(recorded?.status).toBe('done');
    expect(recorded?.result?.status).toBe('succeeded');
  });

  // 1.3 在飞重放 → 两个 promise 得到同一结果，副作用次数 = 1，mode=joined
  it('1.3 在飞重放：并发调用共享同一执行结果，副作用仅执行一次，记录 OPERATION_REPLAYED(mode=joined)', async () => {
    const opId = 'op-joined-3';
    const script = `
      const fs = require('fs');
      fs.appendFileSync(process.argv[1], 'inflight-hit\\n');
      setTimeout(() => {
        console.log('done-slow');
      }, 300);
    `;

    const options = {
      runId: 'run-1',
      opId,
      name: 'test-inflight',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', script, counterFile],
        cwd: tempDir,
      },
    };

    // 并发启动两次调用
    const p1 = supervisor.executeProcess(options);
    const p2 = supervisor.executeProcess(options);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.status).toBe('succeeded');
    expect(res2.status).toBe('succeeded');
    expect(res2.replayed).toBe(true);

    // 副作用仅发生 1 次
    const content = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(content).toEqual(['inflight-hit']);

    // 验证 journal 包含 mode=joined
    const events = domain.getStore().getJournalEvents('test-domain-idem');
    const replayEvent = events.find(
      (e) => e.type === 'OPERATION_REPLAYED' && e.operationId === opId
    );
    expect(replayEvent).toBeDefined();
    expect(replayEvent?.payload.mode).toBe('joined');
  });

  // 1.4 indeterminate op 重放 → 原样返回，副作用次数不增加，租约仍在
  it('1.4 indeterminate op 重放：原样返回 indeterminate 结果，租约维持不放', async () => {
    const opId = 'op-indet-4';
    const store = domain.getStore();

    const options = {
      runId: 'run-1',
      opId,
      name: 'test-indet',
      requiredResources: ['res-lock-1'],
      command: {
        execPath: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: tempDir,
      },
    };

    // 人工预先构造一个 indeterminate 状态的操作（带排他资源租约）
    const indetResult: ProcessOperationResult = {
      kind: 'process',
      status: 'indeterminate' as any,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'process left running',
      isTruncated: false,
      identityVerification: 'cannot_determine',
      durationMs: 100,
      completedAt: new Date().toISOString(),
    };

    store.registerOperationIntent({
      id: opId,
      runId: 'run-1',
      kind: 'process',
      name: 'test-indet',
      inputFingerprint: computeInputFingerprint(options),
      requiredResources: ['res-lock-1'],
      status: 'pending',
    }, 'test-domain-idem');
    store.recordOperationResult(opId, indetResult, false); // releaseResources=false

    // 验证租约存在
    let leases = store.getPersistedResourceLeases('test-domain-idem');
    expect(leases.some((l) => l.operationId === opId && l.resourceId === 'res-lock-1')).toBe(true);

    // 幂等调用重放
    const res = await supervisor.executeProcess(options);
    expect(res.status).toBe('indeterminate');
    expect(res.replayed).toBe(true);

    // 租约绝不释放
    leases = store.getPersistedResourceLeases('test-domain-idem');
    expect(leases.some((l) => l.operationId === opId && l.resourceId === 'res-lock-1')).toBe(true);

    // journal 记录 mode=indeterminate
    const events = store.getJournalEvents('test-domain-idem');
    const replayEvent = events.find(
      (e) => e.type === 'OPERATION_REPLAYED' && e.operationId === opId
    );
    expect(replayEvent?.payload.mode).toBe('indeterminate');
  });

  // 1.5 构造未恢复的崩溃现场（op 停在 active，新 domain 实例未调 recover()）→ RecoveryRequiredError
  it('1.5 构造未恢复的崩溃现场：抛出 RecoveryRequiredError，拒绝盲目执行', async () => {
    const opId = 'op-unrecovered-5';
    const store = domain.getStore();

    const options = {
      runId: 'run-1',
      opId,
      name: 'test-unrecovered',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log(1)'],
        cwd: tempDir,
      },
    };

    // 写入一个未终结（active）且不在当前内存活跃表里的操作
    store.registerOperationIntent({
      id: opId,
      runId: 'run-1',
      kind: 'process',
      name: 'test-unrecovered',
      inputFingerprint: computeInputFingerprint(options),
      requiredResources: [],
      status: 'pending',
    }, 'test-domain-idem');
    store.updateOperationStatus(opId, 'active');

    // 应该抛出 RecoveryRequiredError
    await expect(supervisor.executeProcess(options)).rejects.toThrow(RecoveryRequiredError);
  });

  // 1.6 跨 Run：Run A 结清 op 后，Run B 以同 opId 同指纹调用 → 返回 Run A 的结果，结果中 runId 为 A
  it('1.6 跨 Run 重放：Run A 结清 op 后，Run B 以同 opId 同指纹调用，返回 Run A 的结果且附带原 runId', async () => {
    const opId = 'op-cross-run-6';
    const store = domain.getStore();

    // 注册 Run B
    store.saveRun({
      id: 'run-2',
      taskId: 'task-1',
      domainId: 'test-domain-idem',
      owner: 'runner-2',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const optionsA = {
      runId: 'run-1',
      opId,
      name: 'test-cross-run',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("from-run-A")'],
        cwd: tempDir,
      },
    };

    const resA = await supervisor.executeProcess(optionsA);
    expect(resA.status).toBe('succeeded');
    expect(resA.stdout).toContain('from-run-A');

    // Run B 发起同 opId 同指纹调用
    const optionsB = {
      ...optionsA,
      runId: 'run-2', // 调用方是 Run B
    };

    const resB = await supervisor.executeProcess(optionsB);
    expect(resB.status).toBe('succeeded');
    expect(resB.replayed).toBe(true);
    expect(resB.runId).toBe('run-1'); // 结果归属原 Run A
    expect(resB.stdout).toContain('from-run-A');
  });

  // 1.7 宿主重启后重放：关闭 domain → 重新 acquire → recover() → 重放命中
  it('1.7 宿主重启后重放：关闭 domain 重新 acquire 并 recover() 后，重放依然命中持久化结果', async () => {
    const opId = 'op-restart-7';
    const script = `const fs = require('fs'); fs.appendFileSync(process.argv[1], 'restart-hit\\n'); console.log('restart-ok');`;

    const options = {
      runId: 'run-1',
      opId,
      name: 'test-restart',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', script, counterFile],
        cwd: tempDir,
      },
    };

    // 1. 在当前 domain 实例中执行完毕
    const res1 = await supervisor.executeProcess(options);
    expect(res1.status).toBe('succeeded');
    domain.close();

    // 2. 模拟宿主进程重启：重新 acquire
    const domain2 = ExecutionDomain.acquire(tempDir, 'test-domain-idem');
    const driver2 = new NodePlatformDriver();
    const supervisor2 = new ProcessSupervisor(domain2, driver2);

    // 3. 执行崩溃恢复流水线
    const recoveryEngine = new RecoveryEngine(domain2, driver2);
    await recoveryEngine.recover();

    // 4. 重启后新会话开启新 Run (D17 / N3)
    domain2.getStore().saveRun({
      id: 'run-2',
      taskId: 'task-1',
      domainId: 'test-domain-idem',
      owner: 'runner-1',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const options2 = {
      ...options,
      runId: 'run-2',
    };

    // 5. 发起重放
    const res2 = await supervisor2.executeProcess(options2);
    expect(res2.status).toBe('succeeded');
    expect(res2.replayed).toBe(true);
    expect(res2.runId).toBe('run-1'); // 结果归属原 Run 1
    expect(res2.stdout).toContain('restart-ok');

    // 6. 验证副作用依然仅发生 1 次
    const content = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(content).toEqual(['restart-hit']);

    domain2.close();
  });

  // 1.8 在飞加入时第二调用方的 AbortSignal 只取消自身等待，不影响底层进程与第一调用方
  it('1.8 在飞加入时第二调用方的 AbortSignal 只取消自身等待，底层进程不受影响且第一调用方正常完成', async () => {
    const opId = 'op-joined-abort-8';
    const script = `
      const fs = require('fs');
      fs.appendFileSync(process.argv[1], 'started\\n');
      setTimeout(() => {
        fs.appendFileSync(process.argv[1], 'finished\\n');
        console.log('done-slow-8');
      }, 300);
    `;

    const options1 = {
      runId: 'run-1',
      opId,
      name: 'test-inflight-abort-1',
      requiredResources: [],
      command: {
        execPath: process.execPath,
        args: ['-e', script, counterFile],
        cwd: tempDir,
      },
    };

    const abortController = new AbortController();
    const options2 = {
      ...options1,
      name: 'test-inflight-abort-2',
      abortSignal: abortController.signal,
    };

    // 1. 启动第一调用方
    const p1 = supervisor.executeProcess(options1);

    // 2. 稍等 50ms 确保第一调用方已进入在飞状态
    await new Promise((r) => setTimeout(r, 50));

    // 3. 第二调用方在飞加入
    const p2 = supervisor.executeProcess(options2);

    // 4. 第二调用方主动取消等待
    setTimeout(() => {
      abortController.abort(new Error('caller-2-cancelled-wait'));
    }, 50);

    // 5. 断言第二调用方抛出取消错误
    await expect(p2).rejects.toThrow('caller-2-cancelled-wait');

    // 6. 断言第一调用方不受影响，成功执行并返回结果
    const res1 = await p1;
    expect(res1.status).toBe('succeeded');
    expect(res1.stdout).toContain('done-slow-8');

    // 7. 验证进程完整跑完，副作用完整产生
    const lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(lines).toEqual(['started', 'finished']);
  });
});
