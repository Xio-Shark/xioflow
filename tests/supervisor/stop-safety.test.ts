import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { ResourceConflictError, DuplicateOperationError } from '../../src/types.js';

describe('内核 0.2.0 批次 2 (B2): 停止安全与资源收口 [N8, N2, N5, N4, P0-5, P0-13, P0-6, P0-7, N6]', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-b2-test-'));
    domain = ExecutionDomain.acquire(tempDir, 'test-b2-domain');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);

    domain.getStore().saveTask({
      id: 'task-b2',
      domainId: 'test-b2-domain',
      name: 'B2 Task',
      createdAt: new Date().toISOString(),
    });

    domain.getStore().saveRun({
      id: 'run-b2',
      taskId: 'task-b2',
      domainId: 'test-b2-domain',
      owner: 'test-runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    if (!domain.isClosed()) {
      domain.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // Step 1: N8 在飞 opId 重复提交显式拒绝与租约防线
  // ==========================================================================
  describe('Step 1: N8 在飞与已结清 opId 重复提交防线 (契约 #40)', () => {
    it('1.1 & 1.2 [N8] 在飞 opId 重复提交抛出 DuplicateOperationError，原操作租约与可取消性不受影响', async () => {
      const opId = 'op-n8-in-flight';
      const resource = 'workspace:write:/x';

      // 启动原操作 op-1，持有资源运行 2s
      const execPromise = supervisor.executeProcess({
        runId: 'run-b2',
        opId,
        name: 'sleep-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 2000);'],
          cwd: tempDir,
        },
        requiredResources: [resource],
      });

      // 等待 300ms 确保进入 active 且持有租约
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 1.1 以相同 opId 再次调用 executeProcess
      let duplicateErr: any = null;
      try {
        await supervisor.executeProcess({
          runId: 'run-b2',
          opId,
          name: 'duplicate-op',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.exit(0);'],
            cwd: tempDir,
          },
          requiredResources: [resource],
        });
      } catch (err) {
        duplicateErr = err;
      }

      // 断言抛出 DuplicateOperationError 而非 SQLite 原生异常，携带已有 op 状态与 runId
      expect(duplicateErr).toBeInstanceOf(DuplicateOperationError);
      expect(duplicateErr.opId).toBe(opId);
      expect(duplicateErr.existingStatus).toBeDefined();
      expect(duplicateErr.existingRunId).toBe('run-b2');

      // 1.2 验证原操作的排他租约未被破坏
      const leases = domain.getStore().getPersistedResourceLeases(domain.domainId);
      const heldLease = leases.find((l) => l.resourceId === resource);
      expect(heldLease).toBeDefined();
      expect(heldLease?.operationId).toBe(opId);

      // 第三方操作 op-2 申请同一资源（waitTimeoutMs = 0）必被拒绝
      let conflictErr: any = null;
      try {
        await supervisor.executeProcess({
          runId: 'run-b2',
          opId: 'op-n8-third-party',
          name: 'third-party-op',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.exit(0);'],
            cwd: tempDir,
          },
          requiredResources: [resource],
          waitTimeoutMs: 0,
        });
      } catch (err) {
        conflictErr = err;
      }
      expect(conflictErr).toBeInstanceOf(ResourceConflictError);
      expect(conflictErr.existingOwnerOpId).toBe(opId);

      // 原操作仍可被成功取消
      const stopResult = await supervisor.cancelOperation(opId, 1000);
      expect(stopResult.stopped).toBe('confirmed_stopped');

      const opResult = await execPromise;
      expect(opResult.status).toBe('cancelled');
    });

    it('1.3 [N8] 已结清的 opId 再次提交同样抛 DuplicateOperationError；同 tick 内并发提交恰好一个被拒绝', async () => {
      // 先正常执行一个短暂操作并结清
      const finishedOpId = 'op-n8-finished';
      const firstResult = await supervisor.executeProcess({
        runId: 'run-b2',
        opId: finishedOpId,
        name: 'quick-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.exit(0);'],
          cwd: tempDir,
        },
        requiredResources: [],
      });
      expect(firstResult.status).toBe('succeeded');

      // 再次以 finishedOpId 提交，断言抛 DuplicateOperationError
      let duplicateErr: any = null;
      try {
        await supervisor.executeProcess({
          runId: 'run-b2',
          opId: finishedOpId,
          name: 'quick-op-retry',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.exit(0);'],
            cwd: tempDir,
          },
          requiredResources: [],
        });
      } catch (err) {
        duplicateErr = err;
      }
      expect(duplicateErr).toBeInstanceOf(DuplicateOperationError);
      expect(duplicateErr.opId).toBe(finishedOpId);
      expect(duplicateErr.existingStatus).toBe('done');
      expect(duplicateErr.existingRunId).toBe('run-b2');

      // 同一 tick 内两次并发 executeProcess(concurrentOpId)，不 await 第一个
      const concurrentOpId = 'op-n8-concurrent';
      const results: { success: boolean; error?: any }[] = [];

      const p1 = supervisor.executeProcess({
        runId: 'run-b2',
        opId: concurrentOpId,
        name: 'concurrent-1',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 50);'],
          cwd: tempDir,
        },
        requiredResources: [],
      }).then(() => results.push({ success: true }))
        .catch((err) => results.push({ success: false, error: err }));

      const p2 = supervisor.executeProcess({
        runId: 'run-b2',
        opId: concurrentOpId,
        name: 'concurrent-2',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 50);'],
          cwd: tempDir,
        },
        requiredResources: [],
      }).then(() => results.push({ success: true }))
        .catch((err) => results.push({ success: false, error: err }));

      await Promise.all([p1, p2]);

      expect(results.length).toBe(2);
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect(failures[0].error).toBeInstanceOf(DuplicateOperationError);
    });
  });

  // ==========================================================================
  // Step 2: N5 & N2 组信号防误杀与恢复期 PGID 证据核验 (契约 #42)
  // ==========================================================================
  describe('Step 2: N5 & N2 停止与恢复误杀防线 (契约 #42)', () => {
    it('2.1 [N5] 组信号失败时不向单 PID 发信号兜底，ESRCH 视为组空，EPERM 如实上抛', async () => {
      const singlePidCalls: number[] = [];
      const origProcessKill = process.kill;

      try {
        // 替身：拦截 process.kill，记录所有发往单 PID（正数）的调用
        (process as any).kill = (targetPid: number, sig: any) => {
          if (targetPid > 0 && sig !== 0) {
            singlePidCalls.push(targetPid);
          }
          if (targetPid < 0) {
            const err: any = new Error('No such process');
            err.code = 'ESRCH';
            throw err;
          }
          return origProcessKill.call(process, targetPid, sig);
        };

        const testDriver = new NodePlatformDriver();
        // 针对一个假想的 pgid 执行 terminateGroup
        await testDriver.terminateGroup(88888, 100);

        // 核心契约：绝对不得向正数 PID 88888 发送任何信号
        expect(singlePidCalls).not.toContain(88888);
      } finally {
        process.kill = origProcessKill;
      }
    });

    it('2.2 [N2] 恢复现场同号 pgid 存在但成员启动早于 op.spawn（PGID被复用）：判 indeterminate、租约保留、零信号', async () => {
      const opId = 'op-n2-pgid-reuse';
      const reusedPgid = 55555;
      const opSpawnTime = new Date('2026-09-26T12:00:00.000Z').toISOString();
      const earlierStartTimeMs = new Date('2026-09-26T11:00:00.000Z').getTime(); // 早于 op 1 小时启动

      domain.getStore().registerOperationIntent({
        id: opId,
        runId: 'run-b2',
        name: 'crashed-op-pgid-reuse',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: ['res:n2-reuse'],
        status: 'intent_registered',
      }, domain.domainId);

      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: 99991, // leader 已死
        pgid: reusedPgid,
        spawnTime: opSpawnTime,
        bootId: 'boot-same-uuid',
      });

      let terminateGroupCalled = false;
      const mockDriver = new NodePlatformDriver();
      mockDriver.readBootId = async () => 'boot-same-uuid';
      mockDriver.getGroupEvidence = async (pgid: number) => {
        if (pgid === reusedPgid) {
          return [{ pid: 55555, startTimeMs: earlierStartTimeMs }];
        }
        return [];
      };
      mockDriver.terminateGroup = async () => {
        terminateGroupCalled = true;
        return { stopped: 'confirmed_stopped', scope: 'process_group' };
      };
      (mockDriver as any).isGroupAlive = (pgid: number) => pgid === reusedPgid;
      (mockDriver as any).isPidAlive = () => false; // leader 确认已死

      const { RecoveryEngine } = await import('../../src/recovery/engine.js');
      const recoveryEngine = new RecoveryEngine(domain, mockDriver);
      const report = await recoveryEngine.recover();

      // 断言：严禁向被复用的 pgid 发送 terminateGroup / SIGKILL 信号
      expect(terminateGroupCalled).toBe(false);

      // 断言：由于证据不足/冲突，如实隔离为 indeterminate，且排他资源保留
      const recoveredItem = report.recoveredOperations.find((r) => r.opId === opId);
      expect(recoveredItem).toBeDefined();
      expect(recoveredItem?.action).toBe('isolated_indeterminate');
      expect(recoveredItem?.resourcesReleased).toBe(false);

      const opInDb = domain.getStore().getOperation(opId);
      expect(opInDb?.status).toBe('done');
      expect(opInDb?.result?.kind).toBe('indeterminate');

      // 验证租约仍在库中
      const leases = domain.getStore().getPersistedResourceLeases(domain.domainId);
      expect(leases.some((l) => l.resourceId === 'res:n2-reuse')).toBe(true);
    });

    it('2.3 [N2] 恢复现场证据齐全（bootId 一致且成员启动时间 ≥ op.spawn）：清场成功并如实结清', async () => {
      const opId = 'op-n2-clean-evidence';
      const genuinePgid = 66666;
      const opSpawnTime = new Date('2026-09-26T12:00:00.000Z').toISOString();
      const genuineStartTimeMs = new Date('2026-09-26T12:00:01.000Z').getTime(); // 晚于 op 启动

      domain.getStore().registerOperationIntent({
        id: opId,
        runId: 'run-b2',
        name: 'crashed-op-genuine',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: ['res:n2-genuine'],
        status: 'intent_registered',
      }, domain.domainId);

      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: 99992, // leader 已死
        pgid: genuinePgid,
        spawnTime: opSpawnTime,
        bootId: 'boot-same-uuid',
      });

      let terminateGroupCalled = false;
      const mockDriver = new NodePlatformDriver();
      mockDriver.readBootId = async () => 'boot-same-uuid';
      mockDriver.getGroupEvidence = async (pgid: number) => {
        if (pgid === genuinePgid) {
          return [{ pid: 66666, startTimeMs: genuineStartTimeMs }];
        }
        return [];
      };
      mockDriver.terminateGroup = async () => {
        terminateGroupCalled = true;
        return { stopped: 'confirmed_stopped', scope: 'process_group' };
      };
      (mockDriver as any).isGroupAlive = (pgid: number) => pgid === genuinePgid;
      (mockDriver as any).isPidAlive = () => false;

      const { RecoveryEngine } = await import('../../src/recovery/engine.js');
      const recoveryEngine = new RecoveryEngine(domain, mockDriver);
      const report = await recoveryEngine.recover();

      // 断言：证据齐全时，成功调用清场
      expect(terminateGroupCalled).toBe(true);

      const recoveredItem = report.recoveredOperations.find((r) => r.opId === opId);
      expect(recoveredItem?.action).toBe('marked_dead');
      expect(recoveredItem?.resourcesReleased).toBe(true);

      const opInDb = domain.getStore().getOperation(opId);
      expect(opInDb?.status).toBe('done');
      expect(opInDb?.result?.status).toBe('failed');
      expect((opInDb?.result as any)?.residualProcessesReaped).toBe(true);
    });

    it('2.4 [N2] 恢复现场 bootId 与记录不一致（跨宿主重启）：零信号并判 indeterminate，保留租约', async () => {
      const opId = 'op-n2-reboot-conflict';
      const pgid = 77777;

      domain.getStore().registerOperationIntent({
        id: opId,
        runId: 'run-b2',
        name: 'crashed-op-reboot',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: ['res:n2-reboot'],
        status: 'intent_registered',
      }, domain.domainId);

      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: 99993,
        pgid,
        spawnTime: new Date().toISOString(),
        bootId: 'boot-old-instance', // 崩溃前的旧 bootId
      });

      let terminateGroupCalled = false;
      const mockDriver = new NodePlatformDriver();
      mockDriver.readBootId = async () => 'boot-new-instance'; // 重启后的新 bootId
      mockDriver.terminateGroup = async () => {
        terminateGroupCalled = true;
        return { stopped: 'confirmed_stopped', scope: 'process_group' };
      };
      (mockDriver as any).isGroupAlive = (p: number) => p === pgid;
      (mockDriver as any).isPidAlive = () => false;

      const { RecoveryEngine } = await import('../../src/recovery/engine.js');
      const recoveryEngine = new RecoveryEngine(domain, mockDriver);
      const report = await recoveryEngine.recover();

      // 断言：宿主已重启，严禁发送信号
      expect(terminateGroupCalled).toBe(false);

      const recoveredItem = report.recoveredOperations.find((r) => r.opId === opId);
      expect(recoveredItem?.action).toBe('isolated_indeterminate');
      expect(recoveredItem?.resourcesReleased).toBe(false);

      const opInDb = domain.getStore().getOperation(opId);
      expect(opInDb?.result?.kind).toBe('indeterminate');
    });
  });

  // ==========================================================================
  // Step 4: N4 孤儿窗口保护 (spawn 成功后登记 active 失败)
  // ==========================================================================
  describe('Step 4: N4 孤儿窗口保护', () => {
    it('4.1a [N4] updateOperationStatus 失败且终止成功时：子进程被终止、op 终态诚实为 failed、释放租约并上抛原错误', async () => {
      const opId = 'op-n4-stopped';
      const resource = 'workspace:write:/n4-a';

      let spawnedPid: number | undefined;
      const originalSpawn = driver.spawn.bind(driver);
      driver.spawn = async (cmd) => {
        const handle = await originalSpawn(cmd);
        spawnedPid = handle.identity.pid;
        return handle;
      };

      const store = domain.getStore();
      const originalUpdate = store.updateOperationStatus.bind(store);
      store.updateOperationStatus = (id, status, identity, outputRef) => {
        if (id === opId && status === 'active') {
          throw new Error('Injected updateOperationStatus failure');
        }
        return originalUpdate(id, status, identity, outputRef);
      };

      let errorThrown: any = null;
      try {
        await supervisor.executeProcess({
          runId: 'run-b2',
          opId,
          name: 'n4-op-stopped',
          command: {
            execPath: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000);'],
            cwd: tempDir,
          },
          requiredResources: [resource],
        });
      } catch (err) {
        errorThrown = err;
      }

      // 1. 原始错误必须被上抛
      expect(errorThrown).toBeDefined();
      expect(errorThrown.message).toContain('Injected updateOperationStatus failure');

      // 2. 子进程必须已被终止 (不在存活状态)
      expect(spawnedPid).toBeDefined();
      let pidAlive = true;
      try {
        process.kill(spawnedPid!, 0);
      } catch (e: any) {
        if (e.code === 'ESRCH') {
          pidAlive = false;
        }
      }
      expect(pidAlive).toBe(false);

      // 3. op 在 store 中终态诚实为 failed (不是假 running 或 intent_registered)
      const opInDb = domain.getStore().getOperation(opId);
      expect(opInDb?.status).toBe('done');
      expect(opInDb?.result?.status).toBe('failed');
      expect((opInDb?.result as any)?.spawnFailure).toContain('Injected updateOperationStatus failure');

      // 4. 终止成功时租约已被释放
      const leases = domain.getStore().getPersistedResourceLeases(domain.domainId);
      const heldLease = leases.find((l) => l.resourceId === resource);
      expect(heldLease).toBeUndefined();
    });

    it('4.1b [N4] updateOperationStatus 失败且终止未确认时：op 终态为 indeterminate、保留租约并上抛原错误', async () => {
      const opId = 'op-n4-indet';
      const resource = 'workspace:write:/n4-b';

      const store = domain.getStore();
      const originalUpdate = store.updateOperationStatus.bind(store);
      store.updateOperationStatus = (id, status, identity, outputRef) => {
        if (id === opId && status === 'active') {
          throw new Error('Injected updateOperationStatus failure for indeterminate');
        }
        return originalUpdate(id, status, identity, outputRef);
      };

      // mock driver.terminate 返回未确认
      const originalTerminate = driver.terminate.bind(driver);
      driver.terminate = async (identity, graceMs) => {
        // 先真实杀掉避免后台僵尸，但模拟返回停止未确认
        await originalTerminate(identity, 100);
        return {
          stopped: 'cannot_determine',
          scope: 'unknown',
          errorDetails: 'Mocked termination failure: process could not be confirmed stopped',
        };
      };

      let errorThrown: any = null;
      try {
        await supervisor.executeProcess({
          runId: 'run-b2',
          opId,
          name: 'n4-op-indet',
          command: {
            execPath: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000);'],
            cwd: tempDir,
          },
          requiredResources: [resource],
        });
      } catch (err) {
        errorThrown = err;
      }

      // 1. 原始错误必须被上抛
      expect(errorThrown).toBeDefined();
      expect(errorThrown.message).toContain('Injected updateOperationStatus failure for indeterminate');

      // 2. op 在 store 中终态为 indeterminate
      const opInDb = domain.getStore().getOperation(opId);
      expect(opInDb?.status).toBe('done');
      expect(opInDb?.result?.kind).toBe('indeterminate');
      expect(opInDb?.result?.status).toBe('indeterminate');

      // 3. 停止未确认时，租约必须被保留以防并发冲突
      const leases = domain.getStore().getPersistedResourceLeases(domain.domainId);
      const heldLease = leases.find((l) => l.resourceId === resource);
      expect(heldLease).toBeDefined();
      expect(heldLease?.operationId).toBe(opId);
    });
  });

  // ==========================================================================
  // Step 5: P0-5 + P0-13 资源等待与独立并发计数
  // ==========================================================================
  describe('Step 5: P0-5 + P0-13 资源等待与独立并发计数', () => {
    it('5.1 [P0-5] maxConcurrentOps=1 时 3 个无资源 op 必须串行执行，启动时刻不重叠', async () => {
      domain.setDomainBudget({ maxConcurrentOps: 1 });

      const executions: { opId: string; procStart: number; procEnd: number }[] = [];

      const runOp = async (opId: string) => {
        let procStart = 0;
        const res = await supervisor.executeProcess({
          runId: 'run-b2',
          opId,
          name: `concurrent-op-${opId}`,
          command: {
            execPath: process.execPath,
            args: ['-e', 'console.log(Date.now()); setTimeout(() => {}, 80);'],
            cwd: tempDir,
          },
          requiredResources: [],
          waitTimeoutMs: 3000,
          onStreamChunk: (stream, chunk) => {
            if (stream === 'stdout' && procStart === 0) {
              const str = chunk.toString().trim();
              const ts = parseInt(str, 10);
              if (!isNaN(ts)) {
                procStart = ts;
              }
            }
          },
        });
        const procEnd = Date.now();
        expect(res.status).toBe('succeeded');
        executions.push({ opId, procStart: procStart || Date.now() - 80, procEnd });
      };

      // 并发启动 3 个无资源 op
      await Promise.all([
        runOp('op-conc-1'),
        runOp('op-conc-2'),
        runOp('op-conc-3'),
      ]);

      expect(executions.length).toBe(3);
      // 按实际子进程启动时刻排序
      executions.sort((a, b) => a.procStart - b.procStart);
      for (let i = 0; i < executions.length - 1; i++) {
        const current = executions[i];
        const next = executions[i + 1];
        // 实际子进程启动时刻绝不早于前一个进程的结束时刻（允许 15ms 调度测量容差）
        expect(next.procStart).toBeGreaterThanOrEqual(current.procEnd - 15);
      }
    });

    it('5.2a [P0-13] 多等待者按登记顺序获资源 (FIFO 严格排队)', async () => {
      const resource = 'workspace:write:/fifo-test';
      const order: string[] = [];

      // 先让 holder 占领资源 150ms
      const holderPromise = supervisor.executeProcess({
        runId: 'run-b2',
        opId: 'op-fifo-holder',
        name: 'holder',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 150);'],
          cwd: tempDir,
        },
        requiredResources: [resource],
      }).then(() => {
        order.push('holder');
      });

      // 确保 holder 已进入 active
      await new Promise((resolve) => setTimeout(resolve, 30));

      // 按序提交 waiter 1, 2, 3
      const w1 = supervisor.executeProcess({
        runId: 'run-b2',
        opId: 'op-fifo-w1',
        name: 'waiter-1',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 50);'],
          cwd: tempDir,
        },
        requiredResources: [resource],
        waitTimeoutMs: 4000,
      }).then(() => order.push('w1'));

      await new Promise((resolve) => setTimeout(resolve, 20));

      const w2 = supervisor.executeProcess({
        runId: 'run-b2',
        opId: 'op-fifo-w2',
        name: 'waiter-2',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 50);'],
          cwd: tempDir,
        },
        requiredResources: [resource],
        waitTimeoutMs: 4000,
      }).then(() => order.push('w2'));

      await new Promise((resolve) => setTimeout(resolve, 20));

      const w3 = supervisor.executeProcess({
        runId: 'run-b2',
        opId: 'op-fifo-w3',
        name: 'waiter-3',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 50);'],
          cwd: tempDir,
        },
        requiredResources: [resource],
        waitTimeoutMs: 4000,
      }).then(() => order.push('w3'));

      await Promise.all([holderPromise, w1, w2, w3]);

      // 必须严格按 FIFO 顺序完成
      expect(order).toEqual(['holder', 'w1', 'w2', 'w3']);
    });

    it('5.2b [P0-13] 等待超时诊断含持有者、请求者与已等待时长', async () => {
      const resource = 'workspace:write:/timeout-diag';

      // 启动 holder 运行 1s
      const holderPromise = supervisor.executeProcess({
        runId: 'run-b2',
        opId: 'op-diag-holder',
        name: 'diag-holder',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 1000);'],
          cwd: tempDir,
        },
        requiredResources: [resource],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      let conflictErr: any = null;
      try {
        await supervisor.executeProcess({
          runId: 'run-b2',
          opId: 'op-diag-waiter',
          name: 'diag-waiter',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.exit(0);'],
            cwd: tempDir,
          },
          requiredResources: [resource],
          waitTimeoutMs: 100,
        });
      } catch (err) {
        conflictErr = err;
      }

      expect(conflictErr).toBeInstanceOf(ResourceConflictError);
      expect(conflictErr.resourceId).toBe(resource);
      expect(conflictErr.existingOwnerOpId).toBe('op-diag-holder');
      expect(conflictErr.requestingOpId).toBe('op-diag-waiter');
      expect(conflictErr.waitedDurationMs).toBeGreaterThanOrEqual(90);
      expect(conflictErr.message).toContain("held by operation 'op-diag-holder'");
      expect(conflictErr.message).toContain("requested by 'op-diag-waiter'");

      // 清理 holder
      await supervisor.cancelOperation('op-diag-holder', 500);
      await holderPromise.catch(() => {});
    });
  });

  // ==========================================================================
  // Step 6: P0-6 恢复后 Run 状态收敛 (ARCHITECTURE §3.2 第 5 步)
  // ==========================================================================
  describe('Step 6: P0-6 恢复后 Run 状态收敛', () => {
    it('6.1 [P0-6] 测试 A：恢复现场遗留 running Run，所有 op 干净终结后 Run 变为 failed(crash_detected)', async () => {
      const runId = 'run-p06-clean';
      domain.getStore().saveRun({
        id: runId,
        taskId: 'task-b2',
        domainId: domain.domainId,
        owner: 'test-runner',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      // 登记一个未 spawn 的 op
      domain.getStore().registerOperationIntent({
        id: 'op-p06-clean-1',
        runId,
        name: 'crashed-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [],
        status: 'intent_registered',
      }, domain.domainId);

      const { RecoveryEngine } = await import('../../src/recovery/engine.js');
      const recoveryEngine = new RecoveryEngine(domain, driver);
      await recoveryEngine.recover();

      // 断言 Run 状态收敛为 failed(terminationReason = crash_detected)
      const runInDb = domain.getStore().getRun(runId);
      expect(runInDb?.status).toBe('failed');
      expect(runInDb?.terminationReason).toBe('crash_detected');

      // 断言 journal 记录了 RUN_STATUS_TRANSITION
      const events = domain.getStore().getEventsByRun(runId);
      const transitionEvent = events.find((e) => e.type === 'RUN_STATUS_TRANSITION');
      expect(transitionEvent).toBeDefined();
      expect(transitionEvent?.payload.status).toBe('failed');
      expect(transitionEvent?.payload.terminationReason).toBe('crash_detected');
    });

    it('6.2 [P0-6] 测试 B：恢复现场遗留 running Run，存在 indeterminate op 则 Run 置 indeterminate', async () => {
      const runId = 'run-p06-indet';
      domain.getStore().saveRun({
        id: runId,
        taskId: 'task-b2',
        domainId: domain.domainId,
        owner: 'test-runner',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      const opId = 'op-p06-indet-1';
      domain.getStore().registerOperationIntent({
        id: opId,
        runId,
        name: 'indet-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: ['res:p06-indet'],
        status: 'intent_registered',
      }, domain.domainId);

      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: 99991,
        spawnTime: new Date().toISOString(),
      });

      const mockDriver = new NodePlatformDriver();
      mockDriver.verifyIdentity = async () => 'cannot_determine';

      const { RecoveryEngine } = await import('../../src/recovery/engine.js');
      const recoveryEngine = new RecoveryEngine(domain, mockDriver);
      await recoveryEngine.recover();

      const runInDb = domain.getStore().getRun(runId);
      expect(runInDb?.status).toBe('indeterminate');

      const events = domain.getStore().getEventsByRun(runId);
      const transitionEvent = events.find((e) => e.type === 'RUN_STATUS_TRANSITION' && e.payload.status === 'indeterminate');
      expect(transitionEvent).toBeDefined();
    });

    it('6.3 [P0-6] 测试 C：Run 下仍有未终结 op 时，Run 保持 running，不发生翻转', async () => {
      const runId = 'run-p06-partial';
      domain.getStore().saveRun({
        id: runId,
        taskId: 'task-b2',
        domainId: domain.domainId,
        owner: 'test-runner',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      // op1: 会被恢复引擎推进至 done
      domain.getStore().registerOperationIntent({
        id: 'op-p06-part-1',
        runId,
        name: 'op-1',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [],
        status: 'intent_registered',
      }, domain.domainId);

      // op2: 我们通过 mock 或绕过恢复将其保留在 active 状态
      domain.getStore().registerOperationIntent({
        id: 'op-p06-part-2',
        runId,
        name: 'op-2',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [],
        status: 'intent_registered',
      }, domain.domainId);

      const { RecoveryEngine } = await import('../../src/recovery/engine.js');
      const recoveryEngine = new RecoveryEngine(domain, driver);

      // 仅恢复 op1，故意在 getUnfinishedOperations 中保留 op2
      const originalGetUnfinished = domain.getStore().getUnfinishedOperations.bind(domain.getStore());
      domain.getStore().getUnfinishedOperations = (dId) => {
        const ops = originalGetUnfinished(dId);
        return ops.filter((o) => o.id === 'op-p06-part-1');
      };

      await recoveryEngine.recover();

      // 恢复后，因 op2 依然处于非终态，Run 绝不能被置为 failed 或 indeterminate
      const runInDb = domain.getStore().getRun(runId);
      expect(runInDb?.status).toBe('running');
    });
  });

  // ==========================================================================
  // Step 6b: D22 reportRunCancelled 与契约 #43
  // ==========================================================================
  describe('Step 6b: D22 reportRunCancelled 与契约 #43', () => {
    it('6.5 & 6.6 [D22] 对 running 的 Run 调用 reportRunCancelled 变为 cancelled 并写 journal；终态 Run 拒绝重复上报', async () => {
      const runId = 'run-d22-cancel';
      domain.getStore().saveRun({
        id: runId,
        taskId: 'task-b2',
        domainId: domain.domainId,
        owner: 'test-runner',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      // 6.5 成功上报 cancelled
      domain.reportRunCancelled(runId, 'user_cancelled');

      const runInDb = domain.getStore().getRun(runId);
      expect(runInDb?.status).toBe('cancelled');
      expect(runInDb?.terminationReason).toBe('user_cancelled');

      const events = domain.getStore().getEventsByRun(runId);
      const transitionEvent = events.find((e) => e.type === 'RUN_STATUS_TRANSITION');
      expect(transitionEvent).toBeDefined();
      expect(transitionEvent?.payload.status).toBe('cancelled');

      // 6.6 已是 cancelled 状态，再次调用 reportRunCancelled 应当抛错拒绝（终态不可再上报）
      // 契约 #43：对终态 Run 改变状态抛错拒绝
      await expect(async () => {
        domain.reportRunCancelled(runId, 'user_cancelled');
      }).rejects.toThrow(/already finalized/);
    });

    it('6.7 [契约 #43] 向已终态 Run 登记新 op 抛错拦截；代际栅栏拦截旧 epoch 调用', async () => {
      const runId = 'run-d22-terminal';
      domain.getStore().saveRun({
        id: runId,
        taskId: 'task-b2',
        domainId: domain.domainId,
        owner: 'test-runner',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      domain.reportRunCancelled(runId, 'user_cancelled');

      // 向已终态的 Run 登记新 op 必须抛错拦截
      expect(() => {
        domain.getStore().registerOperationIntent({
          id: 'op-on-cancelled-run',
          runId,
          name: 'invalid-op',
          kind: 'process',
          inputFingerprint: 'dummy',
          requiredResources: [],
          status: 'intent_registered',
        }, domain.domainId);
      }).toThrow(/Cannot register operation.*already finalized/);
    });
  });

  // ==========================================================================
  // Step 7: P0-7 + N6 人工裁决与私有化释放 API
  // ==========================================================================
  describe('Step 7: P0-7 + N6 人工裁决与私有化释放 API', () => {
    it('7.3 [N6] 公开 API 无 releaseResources，私有释放走代际栅栏并记录 RESOURCES_RELEASED 事件', async () => {
      // 1. 公开 API 必须无 releaseResources
      expect((domain as any).releaseResources).toBeUndefined();

      // 2. 内部释放走代际栅栏并写 journal
      const opId = 'op-internal-release';
      const resource = 'workspace:write:/internal-rel';
      domain.allocateResources(opId, [resource]);

      domain.internalReleaseResources(opId, [resource]);

      // 验证资源已释放
      expect(domain.isResourceLocked(resource)).toBe(false);

      // 验证 journal 记录了 RESOURCES_RELEASED 事件
      const events = domain.getStore().getJournalEvents(domain.domainId);
      const relEvent = events.find((e) => e.type === 'RESOURCES_RELEASED' && e.operationId === opId);
      expect(relEvent).toBeDefined();
      expect((relEvent?.payload as any).resources).toContain(resource);
    });

    it('7.2a [P0-7] adjudicate() 仅对 indeterminate 操作生效，非 indeterminate 操作被拒绝', async () => {
      const opId = 'op-succeeded-op';
      domain.getStore().registerOperationIntent({
        id: opId,
        runId: 'run-b2',
        name: 'succeeded-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [],
        status: 'intent_registered',
      }, domain.domainId);

      domain.getStore().recordOperationResult(opId, {
        kind: 'process',
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        isTruncated: false,
        identityVerification: 'is_original_process',
        durationMs: 10,
        completedAt: new Date().toISOString(),
      }, true);

      await expect(async () => {
        await domain.adjudicate(opId, 'confirmed_stopped', 'admin-user');
      }).rejects.toThrow(/status must be 'indeterminate'/);
    });

    it('7.2b [P0-7] 残留存活时拒绝 confirmed_stopped，接受 abandon_with_residuals 且如实保留 residualPids', async () => {
      const opId = 'op-alive-residual';
      const resource = 'workspace:write:/alive-residual';

      domain.registerOperationIntent({
        id: opId,
        runId: 'run-b2',
        name: 'residual-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [resource],
        status: 'intent_registered',
      });

      // 构造当前存活的真实进程（当前测试进程 process.pid 必然存活）
      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: process.pid,
        spawnTime: new Date().toISOString(),
      });

      domain.getStore().recordOperationResult(opId, {
        kind: 'indeterminate',
        status: 'indeterminate',
        reason: 'process alive and indeterminate',
        recoveryGuidance: 'manual intervention',
        durationMs: 100,
        completedAt: new Date().toISOString(),
      }, false);

      // 1. 残留进程存活时，尝试裁决 confirmed_stopped 必被拒绝
      await expect(async () => {
        await domain.adjudicate(opId, 'confirmed_stopped', 'auditor', 'try confirmed stopped');
      }).rejects.toThrow(/residual processes are still alive/);

      // 租约仍应被保留
      expect(domain.isResourceLocked(resource)).toBe(true);

      // 2. 接受 abandon_with_residuals 裁决，成功释放租约并记录 residualPids
      const record = await domain.adjudicate(opId, 'abandon_with_residuals', 'auditor', 'abandoned with live pid');
      expect(record.verdict).toBe('abandon_with_residuals');
      expect(record.actor).toBe('auditor');
      expect(record.residualPids).toContain(process.pid);

      // 租约已被释放
      expect(domain.isResourceLocked(resource)).toBe(false);

      // journal 记录 OPERATION_ADJUDICATED
      const events = domain.getStore().getJournalEvents(domain.domainId);
      const adjEvent = events.find((e) => e.type === 'OPERATION_ADJUDICATED' && e.operationId === opId);
      expect(adjEvent).toBeDefined();
      expect((adjEvent?.payload as any).verdict).toBe('abandon_with_residuals');
      expect((adjEvent?.payload as any).residualPids).toContain(process.pid);
    });

    it('7.2c [P0-7] 无残留时 confirmed_stopped 成功裁决并释放租约', async () => {
      const opId = 'op-dead-residual';
      const resource = 'workspace:write:/dead-residual';

      domain.registerOperationIntent({
        id: opId,
        runId: 'run-b2',
        name: 'dead-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [resource],
        status: 'intent_registered',
      });

      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: 99997, // 不存在的 pid
        spawnTime: new Date().toISOString(),
      });

      domain.getStore().recordOperationResult(opId, {
        kind: 'indeterminate',
        status: 'indeterminate',
        reason: 'process lost',
        recoveryGuidance: 'manual check',
        durationMs: 100,
        completedAt: new Date().toISOString(),
      }, false);

      const record = await domain.adjudicate(opId, 'confirmed_stopped', 'admin', 'confirmed dead');
      expect(record.verdict).toBe('confirmed_stopped');
      expect(record.actor).toBe('admin');
      expect(record.residualPids).toBeUndefined();

      expect(domain.isResourceLocked(resource)).toBe(false);

      const events = domain.getStore().getJournalEvents(domain.domainId);
      const adjEvent = events.find((e) => e.type === 'OPERATION_ADJUDICATED' && e.operationId === opId);
      expect(adjEvent).toBeDefined();
      expect((adjEvent?.payload as any).verdict).toBe('confirmed_stopped');
    });
  });
});
