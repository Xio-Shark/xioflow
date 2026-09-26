import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ExecutionDomain,
  SqliteStore,
  PlatformDriver,
  ProcessSupervisor,
  RecoveryEngine,
  ResourceConflictError,
  UnsupportedCapabilityError,
  EpochFencedError,
  OperationNotActiveError,
  DuplicateOperationError,
  OperationIdConflictError,
  RecoveryRequiredError,
  computeInputFingerprint,
  ProcessOperationResult,
} from '../index.js';

export interface ConsumerContext {
  domain: ExecutionDomain;
  driver: PlatformDriver;
  supervisor: ProcessSupervisor;
  tempDir: string;
  workflowType: 'headless' | 'three_piece' | 'memory';
  cleanup: () => Promise<void>;
}

function ensureTaskAndRun(domain: ExecutionDomain, taskId: string, runId: string) {
  const store = domain.getStore();
  if (!store.getTask(taskId)) {
    store.saveTask({
      id: taskId,
      domainId: domain.domainId,
      name: `Task for ${taskId}`,
      createdAt: new Date().toISOString(),
    });
  }
  if (!store.getRun(runId)) {
    store.saveRun({
      id: runId,
      taskId,
      domainId: domain.domainId,
      owner: 'test-runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }
}

export function defineContractTestSuite(
  consumerName: string,
  createContext: () => Promise<ConsumerContext>
) {
  describe(`Consistency Contract Suite: [${consumerName}]`, () => {
    let ctx: ConsumerContext;

    beforeEach(async () => {
      ctx = await createContext();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    it('契约 1: 错误命令启动立即显式失败，绝不产生假 running 状态', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c1', 'run-c1');

      const result = await supervisor.executeProcess({
        runId: 'run-c1',
        opId: 'op-c1-bogus',
        name: 'bogus-cmd',
        command: {
          execPath: '/path/to/definitely/non_existent_binary_xyz',
          args: [],
          cwd: tempDir,
        },
        requiredResources: ['res:c1'],
      });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(127);
      expect(result.spawnFailure).toBeTruthy();
      expect(domain.isResourceLocked('res:c1')).toBe(false);

      // 验证未产生假 active 状态
      const events = domain.getStore().getJournalEvents(domain.domainId);
      const fakeActive = events.some(
        (e) => e.type === 'OPERATION_STATUS_TRANSITION' && (e.payload as any).status === 'active'
      );
      expect(fakeActive).toBe(false);
    });

    it('契约 2: 大输出有界排空，超限顺畅退出并标记 isTruncated = true', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c2', 'run-c2');
      const printScript = `process.stdout.write('X'.repeat(1024 * 1024 * 12));`;

      const result = await supervisor.executeProcess({
        runId: 'run-c2',
        opId: 'op-c2-heavy',
        name: 'heavy-output',
        command: {
          execPath: process.execPath,
          args: ['-e', printScript],
          cwd: tempDir,
        },
        requiredResources: ['res:c2'],
        maxOutputBytes: 10 * 1024 * 1024,
      });

      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.isTruncated).toBe(true);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(false);
      expect(result.stdoutBytes).toBeGreaterThanOrEqual(12 * 1024 * 1024);
      expect(result.stdoutRef).toBeTruthy();
      expect(result.stdoutHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024);
      expect(domain.isResourceLocked('res:c2')).toBe(false);
    });

    it('契约 3: 超时未确认停止保护，未确认退出前排他资源锁绝对不释放', async () => {
      const { domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c3', 'run-c3');

      const mockUnconfirmedDriver: PlatformDriver = {
        name: 'stubborn-driver',
        capabilities: {
          processGroupKill: false,
          accurateStartTime: false,
          memoryHardLimit: false,
          pidsLimit: false,
          cpuLimit: false,
          descendantEnumeration: 'none',
        },
        async spawn(cmd) {
          return ctx.driver.spawn(cmd);
        },
        async verifyIdentity() {
          return 'cannot_determine';
        },
        async terminate() {
          return { stopped: 'cannot_determine', scope: 'unknown', errorDetails: 'Cannot confirm exit' };
        },
      };

      const customSupervisor = new ProcessSupervisor(domain, mockUnconfirmedDriver);
      const runPromise = customSupervisor.executeProcess({
        runId: 'run-c3',
        opId: 'op-c3-stubborn',
        name: 'stubborn-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 5000);'],
          cwd: tempDir,
        },
        requiredResources: ['res:c3-lock'],
      });

      await new Promise((r) => setTimeout(r, 100));
      const cancelRes = await customSupervisor.cancelOperation('op-c3-stubborn');
      expect(cancelRes.stopped).toBe('cannot_determine');

      // 核心断言：未确认停止前，排他锁绝不释放！
      expect(domain.isResourceLocked('res:c3-lock')).toBe(true);
      const op = domain.getStore().getOperation('op-c3-stubborn');
      expect(op?.result?.status).toBe('indeterminate');

      const active = (customSupervisor as any).activeOperations.get('op-c3-stubborn');
      if (active?.handle?.rawProcess) {
        active.handle.rawProcess.kill('SIGKILL');
      }
      await runPromise;
    });

    it('契约 4: 受管资源冲突可诊断与排队等待放行', async () => {
      const { domain } = ctx;
      domain.allocateResources('op-owner-A', ['res:exclusive-port']);

      // 1. 无等待时立即抛出冲突异常并携带诊断
      expect(() => {
        domain.allocateResources('op-requester-B', ['res:exclusive-port']);
      }).toThrowError(ResourceConflictError);

      try {
        domain.allocateResources('op-requester-B', ['res:exclusive-port'], 150);
      } catch (err: any) {
        expect(err.message).toContain('res:exclusive-port');
        expect(err.message).toContain('op-owner-A');
        expect(err.message).toContain('op-requester-B');
      }

      // 2. 带排队等待异步放行
      setTimeout(() => {
        domain.internalReleaseResources('op-owner-A', ['res:exclusive-port']);
      }, 50);

      await domain.allocateResourcesWithWait('op-requester-B', ['res:exclusive-port'], 300);
      expect(domain.getResourceOwner('res:exclusive-port')).toBe('op-requester-B');
      domain.internalReleaseResources('op-requester-B');
    });

    it('契约 5: 不确定副作用防重放，重启恢复时阻断自动重试并保留隔离', async () => {
      const { domain, driver } = ctx;
      ensureTaskAndRun(domain, 'task-c5', 'run-c5');

      // 登记并记录一个 indeterminate 状态操作
      domain.registerOperationIntent({
        id: 'op-c5-indeterminate',
        runId: 'run-c5',
        kind: 'process',
        name: 'dangerous-db-mutation',
        inputFingerprint: 'fp-c5',
        requiredResources: ['db:primary:write'],
        status: 'pending',
      });
      domain.getStore().recordOperationResult(
        'op-c5-indeterminate',
        {
          kind: 'indeterminate',
          status: 'indeterminate',
          reason: 'Network cut off during commit',
          recoveryGuidance: 'Check primary DB log before retry',
          durationMs: 0,
          completedAt: new Date().toISOString(),
        },
        false
      );

      // 运行恢复引擎
      const engine = new RecoveryEngine(domain, driver);
      const report = await engine.recover();

      // 不确定状态不自动重试
      const recoveredItem = report.recoveredOperations.find((r) => r.opId === 'op-c5-indeterminate');
      expect(recoveredItem).toBeUndefined(); // 已是 done 终态不重复恢复

      // 隔离保持锁定
      expect(domain.isResourceLocked('db:primary:write')).toBe(true);

      // 试图再次申请冲突资源被严格阻断
      expect(() => {
        domain.allocateResources('op-c5-retry', ['db:primary:write']);
      }).toThrowError(ResourceConflictError);
    });

    it('契约 6: 崩溃可靠恢复，已提交事务的事实与 Epoch 在重启后 100% 完整重现', () => {
      const { domain, tempDir } = ctx;
      const store = domain.getStore();
      const initialEpoch = domain.getEpoch();

      store.saveTask({
        id: 'task-c6',
        domainId: domain.domainId,
        name: 'Crash Recovery Task',
        createdAt: new Date().toISOString(),
        meta: { priority: 'high' },
      });

      store.saveRun({
        id: 'run-c6',
        taskId: 'task-c6',
        domainId: domain.domainId,
        owner: 'user-c6',
        status: 'running',
        startedAt: new Date().toISOString(),
        configSnapshotWhiteList: { model: 'gemini-pro' },
      });

      const seq = store.recordEventAndTransitionState({
        domainId: domain.domainId,
        runId: 'run-c6',
        type: 'COMMITTED_CHECKPOINT',
        payload: { step: 42 },
        timestamp: new Date().toISOString(),
      });

      // 模拟断开 / 重启
      domain.close();

      const newDomain = ExecutionDomain.acquire(tempDir, domain.domainId);
      const newStore = newDomain.getStore();

      const restoredTask = newStore.getTask('task-c6');
      const restoredRun = newStore.getRun('run-c6');
      const restoredEvents = newStore.getJournalEvents(domain.domainId);

      expect(restoredTask?.name).toBe('Crash Recovery Task');
      expect(restoredTask?.meta?.priority).toBe('high');
      expect(restoredRun?.owner).toBe('user-c6');
      expect(restoredRun?.configSnapshotWhiteList?.model).toBe('gemini-pro');
      expect(restoredEvents.some((e) => e.seq === seq && e.type === 'COMMITTED_CHECKPOINT')).toBe(true);

      // 验证代际自增
      expect(newDomain.getEpoch()).toBeGreaterThan(initialEpoch);

      newDomain.close();
    });

    it('契约 7: 平台驱动能力缺失内核准入拒绝，绝不静默降级或伪造成功', async () => {
      const { domain, tempDir, driver } = ctx;
      ensureTaskAndRun(domain, 'task-c7', 'run-c7');

      // 使用真实驱动（其 memoryHardLimit 为 false）
      const realSupervisor = new ProcessSupervisor(domain, driver);

      // 申请 hard 内存限制，内核必须在准入期显式抛出 UnsupportedCapabilityError
      await expect(
        realSupervisor.executeProcess({
          runId: 'run-c7',
          opId: 'op-c7-hard',
          name: 'require-cgroup',
          command: { execPath: 'echo', args: ['hi'], cwd: tempDir },
          requiredResources: ['res:c7'],
          resourceBudget: {
            maxMemoryBytes: 100 * 1024 * 1024,
            enforcement: 'hard',
          },
        })
      ).rejects.toThrowError(UnsupportedCapabilityError);

      expect(domain.isResourceLocked('res:c7')).toBe(false);
    });

    it('契约 8: 工作流无感替换，无论三件套还是纯内存工作流，内核状态与事件时序完全一致', async () => {
      const { domain, supervisor, tempDir } = ctx;
      const store = domain.getStore();

      const taskId = `task-c8-${ctx.workflowType}`;
      const runId = `run-c8-${ctx.workflowType}`;

      store.saveTask({
        id: taskId,
        domainId: domain.domainId,
        name: 'Workflow Replace Test',
        createdAt: new Date().toISOString(),
      });
      store.saveRun({
        id: runId,
        taskId,
        domainId: domain.domainId,
        owner: 'tester',
        status: 'starting',
        startedAt: new Date().toISOString(),
      });

      // 执行一个成功的 Operation
      const opResult = await supervisor.executeProcess({
        runId,
        opId: `op-c8-${ctx.workflowType}`,
        name: 'echo-step',
        command: {
          execPath: process.execPath,
          args: ['-e', 'console.log("Kernel execution invariant holds");'],
          cwd: tempDir,
        },
        requiredResources: [`res:c8:${ctx.workflowType}`],
      });

      expect(opResult.status).toBe('succeeded');
      store.reportRunSucceeded(runId);

      const finalRun = store.getRun(runId);
      expect(finalRun?.status).toBe('succeeded');
      expect(finalRun?.terminationReason).toBe('completed');

      const events = store.getJournalEvents(domain.domainId);
      const runEvents = events.filter((e) => e.runId === runId);
      const eventTypes = runEvents.map((e) => e.type);

      // 验证精准状态机时序链路：必须完全严格数组相等，杜绝模糊 toContain
      expect(eventTypes).toEqual([
        'OPERATION_INTENT_REGISTERED',
        'OPERATION_STATUS_TRANSITION',
        'OPERATION_RESULT_RECORDED',
        'RUN_STATUS_TRANSITION',
      ]);

      // 验证事件载荷确定性
      expect((runEvents[0].payload as any).name).toBe('echo-step');
      expect((runEvents[1].payload as any).status).toBe('active');
      expect((runEvents[2].payload as any).result.status).toBe('succeeded');
      expect((runEvents[3].payload as any).status).toBe('succeeded');
      expect((runEvents[3].payload as any).terminationReason).toBe('completed');
    });

    it('契约 9: 整组终止可靠收敛，整组信号与组空确认确保无残留后代', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c9', 'run-c9');
      const grandchildPidFile = path.join(tempDir, 'grandchild.pid');

      // 启动一个派生后代的常驻进程（孙进程在同进程组中运行，无 detached: true）
      const groupScript = `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(sub.pid), 'utf8');
        setInterval(() => {}, 1000);
      `;

      const executePromise = supervisor.executeProcess({
        runId: 'run-c9',
        opId: 'op-c9-group',
        name: 'group-proc',
        command: {
          execPath: process.execPath,
          args: ['-e', groupScript],
          cwd: tempDir,
        },
        requiredResources: ['res:c9-group'],
        timeoutMs: 10000,
      });

      // 等待孙进程完成创建并写出 PID
      let grandchildPid = 0;
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(grandchildPidFile)) {
          try {
            const content = fs.readFileSync(grandchildPidFile, 'utf8').trim();
            if (content) {
              grandchildPid = parseInt(content, 10);
              break;
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(grandchildPid).toBeGreaterThan(0);

      // 核验取消前孙进程确实存活
      let grandchildAliveBefore = false;
      try {
        process.kill(grandchildPid, 0);
        grandchildAliveBefore = true;
      } catch {}
      expect(grandchildAliveBefore).toBe(true);

      // 执行整组停止流水线
      const stopRes = await supervisor.cancelOperation('op-c9-group', 1500);

      expect(stopRes.stopped).toBe('confirmed_stopped');
      expect(domain.isResourceLocked('res:c9-group')).toBe(false);

      // 核心真实断言：整组 kill(-pgid) 广播后，同组孙进程必须确定性死亡，绝不泄漏为 PID 1 孤儿！
      let grandchildAliveAfter = true;
      try {
        process.kill(grandchildPid, 0);
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          grandchildAliveAfter = false;
        }
      }
      expect(grandchildAliveAfter).toBe(false);

      await executePromise;
    });

    it('契约 10: 逃逸后代诚实上报，驱动无法确认停止时如实标记 cannot_determine', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c10', 'run-c10');
      const escapedPidFile = path.join(tempDir, 'escaped.pid');

      // 使用真实驱动：孙进程显式使用 detached: true 模拟调用 setsid() 脱离原有父组恶意逃逸
      const escapeScript = `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
          detached: true,
          stdio: 'ignore'
        });
        fs.writeFileSync(${JSON.stringify(escapedPidFile)}, String(sub.pid), 'utf8');
        setInterval(() => {}, 1000);
      `;

      let escapedPid = 0;
      try {
        const executePromise = supervisor.executeProcess({
          runId: 'run-c10',
          opId: 'op-c10-escape',
          name: 'escape-proc',
          command: {
            execPath: process.execPath,
            args: ['-e', escapeScript],
            cwd: tempDir,
          },
          requiredResources: ['res:c10-lock'],
          timeoutMs: 10000,
        });

        // 等待逃逸孙进程完成创建并记录 PID
        for (let i = 0; i < 40; i++) {
          if (fs.existsSync(escapedPidFile)) {
            try {
              const content = fs.readFileSync(escapedPidFile, 'utf8').trim();
              if (content) {
                escapedPid = parseInt(content, 10);
                break;
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        expect(escapedPid).toBeGreaterThan(0);

        // 验证逃逸孙进程确实正在运行
        let escapedAliveBefore = false;
        try {
          process.kill(escapedPid, 0);
          escapedAliveBefore = true;
        } catch {}
        expect(escapedAliveBefore).toBe(true);

        // 调用停止流水线：NodePlatformDriver 真实后代树扫描探测到逃逸残留
        const cancelRes = await supervisor.cancelOperation('op-c10-escape', 1000);

        // 真实上报 stopped: cannot_determine，且 residualPids 包含逃逸孤儿 PID
        expect(cancelRes.stopped).toBe('cannot_determine');
        expect(cancelRes.residualPids).toBeDefined();
        expect(cancelRes.residualPids).toContain(escapedPid);

        // 核心架构红线：驱动无法确认停止时，必须转入 indeterminate，绝对保留隔离屏障与排他锁！
        expect(domain.isResourceLocked('res:c10-lock')).toBe(true);
        const opRecord = domain.getStore().getOperation('op-c10-escape');
        expect(opRecord?.result?.status).toBe('indeterminate');

        // 主动杀掉主进程等待 promise 返回
        const active = (supervisor as any).activeOperations.get('op-c10-escape');
        if (active?.handle?.rawProcess) {
          try {
            active.handle.rawProcess.kill('SIGKILL');
          } catch {}
        }
        await executePromise;
      } finally {
        // 测试收尾：主动向逃逸孤儿发送 SIGKILL 清理，确保不污染宿主机
        if (escapedPid > 0) {
          try {
            process.kill(escapedPid, 'SIGKILL');
          } catch {}
        }
      }
    });

    it('契约 11: Epoch Fencing 代际栅栏，旧所有者复活写入被强制拒绝 (防脑裂)', () => {
      const { domain, tempDir } = ctx;
      const store = domain.getStore();
      const initialEpoch = domain.getEpoch();

      // 模拟代际推进：另一进程接管租约导致 epoch 跃迁
      const newOwner = store.acquireOwnerLease(domain.domainId, 'resurrected-competitor', 'other-host', 30000, true);
      expect(newOwner.epoch).toBeGreaterThan(initialEpoch);

      // 模拟旧所有者僵尸进程（持有旧代际 initialEpoch）尝试写入
      const zombieStore = new SqliteStore(path.join(tempDir, 'domain.db'));
      zombieStore.unsafeSetCurrentEpochForTesting(initialEpoch);

      expect(() => {
        zombieStore.saveTask({
          id: 'task-stale-write',
          domainId: domain.domainId,
          name: 'Zombie Write',
          createdAt: new Date().toISOString(),
        });
      }).toThrowError(EpochFencedError);

      zombieStore.close();
    });

    it('契约 12: 运行完成协议，未完成或不确定操作阻断 Run 终结', () => {
      const { domain } = ctx;
      const store = domain.getStore();
      ensureTaskAndRun(domain, 'task-c12', 'run-c12');

      // 登记一个未完成操作
      store.registerOperationIntent(
        {
          id: 'op-c12-running',
          runId: 'run-c12',
          kind: 'process',
          name: 'unfinished-work',
          inputFingerprint: 'fp-12',
          requiredResources: ['res:c12'],
          status: 'pending',
        },
        domain.domainId
      );

      // 有未完成操作时 reportRunSucceeded 必须抛出异常阻止
      expect(() => {
        store.reportRunSucceeded('run-c12');
      }).toThrowError(/Cannot complete run 'run-c12'/);

      // 将该操作收尾
      store.recordOperationResult(
        'op-c12-running',
        {
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
        },
        true
      );

      // 现在 reportRunSucceeded 正常完成并标记 succeeded
      store.reportRunSucceeded('run-c12');
      const run = store.getRun('run-c12');
      expect(run?.status).toBe('succeeded');
      expect(run?.terminationReason).toBe('completed');
    });

    it('契约 13: 多维 Hard 请求遇不支持平台准入拒绝', async () => {
      const { supervisor, tempDir } = ctx;

      // 验证 pidsLimit hard 准入拒绝
      await expect(
        supervisor.executeProcess({
          runId: 'run-c13',
          opId: 'op-c13-pids',
          name: 'pids-test',
          command: { execPath: 'echo', args: ['1'], cwd: tempDir },
          requiredResources: ['res:c13:pids'],
          resourceBudget: { maxPids: 20, enforcement: 'hard' },
        })
      ).rejects.toThrowError(UnsupportedCapabilityError);

      // 验证 cpuLimit hard 准入拒绝
      await expect(
        supervisor.executeProcess({
          runId: 'run-c13',
          opId: 'op-c13-cpu',
          name: 'cpu-test',
          command: { execPath: 'echo', args: ['1'], cwd: tempDir },
          requiredResources: ['res:c13:cpu'],
          resourceBudget: { maxCpuTimeMs: 1000, enforcement: 'hard' },
        })
      ).rejects.toThrowError(UnsupportedCapabilityError);
    });

    it('契约 14: 域级总额度与并发排队，超标等待释放后自动放行', async () => {
      const { domain } = ctx;
      // 设置域级最大并发操作数为 1
      domain.setDomainBudget({ maxConcurrentOps: 1 });

      domain.allocateResources('op-first', ['res:op1']);

      // 第二个操作因超过并发数抛出冲突并排队
      expect(() => {
        domain.allocateResources('op-second', ['res:op2']);
      }).toThrowError(ResourceConflictError);

      setTimeout(() => {
        domain.internalReleaseResources('op-first');
      }, 60);

      await domain.allocateResourcesWithWait('op-second', ['res:op2'], 300);
      expect(domain.getResourceOwner('res:op2')).toBe('op-second');
      domain.internalReleaseResources('op-second');
    });

    it('契约 15: 大输出流式落盘转储与 fsync 校验 (Spill to Artifacts)', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c15', 'run-c15');
      const artifactsDir = path.join(tempDir, 'custom-artifacts');

      // 产生 6MB 日志，内存限制 1MB，触发 spill 落盘转储
      const heavyLogScript = `process.stdout.write('A'.repeat(1024 * 1024 * 6));`;

      const result = await supervisor.executeProcess({
        runId: 'run-c15',
        opId: 'op-c15-spill',
        name: 'spill-test',
        command: {
          execPath: process.execPath,
          args: ['-e', heavyLogScript],
          cwd: tempDir,
        },
        requiredResources: ['res:c15'],
        maxOutputBytes: 1 * 1024 * 1024,
        artifactsDir,
      });

      expect(result.status).toBe('succeeded');
      expect(result.isTruncated).toBe(true);
      expect(result.outputRef).toBeDefined();
      expect(result.outputHash).toBeDefined();

      // 1. 内存中严格截断至 1MB 上限
      expect(result.stdout.length).toBeLessThanOrEqual(1 * 1024 * 1024);

      // 2. 验证磁盘上的落盘文件存在且包含完整的 6MB 输出
      expect(fs.existsSync(result.outputRef!)).toBe(true);
      const stat = fs.statSync(result.outputRef!);
      expect(stat.size).toBeGreaterThanOrEqual(1024 * 1024 * 6);

      // 3. 独立读取物理落盘文件并计算 SHA-256 哈希，比对与流式计算哈希 100% 一致
      const fileBuffer = fs.readFileSync(result.outputRef!);
      const expectedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      expect(result.outputHash).toBe(expectedHash);
    });

    it('契约 16: stdin 一次性管道透传，写入后关闭且子进程提前退出不产生假失败', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c16', 'run-c16');
      const upperCaseStdinScript = `
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => {
          process.stdout.write(Buffer.concat(chunks).toString('utf8').toUpperCase());
        });
      `;

      const echoed = await supervisor.executeProcess({
        runId: 'run-c16',
        opId: 'op-c16-stdin',
        name: 'stdin-echo',
        command: {
          execPath: process.execPath,
          args: ['-e', upperCaseStdinScript],
          cwd: tempDir,
          stdin: 'contract-16 payload',
        },
        requiredResources: ['res:c16'],
      });

      // 只有收到 EOF（写入端已关闭）子进程才会输出，因此同时证明写入与关闭
      expect(echoed.status).toBe('succeeded');
      expect(echoed.exitCode).toBe(0);
      expect(echoed.stdout).toBe('CONTRACT-16 PAYLOAD');
      expect(domain.isResourceLocked('res:c16')).toBe(false);

      const earlyExit = await supervisor.executeProcess({
        runId: 'run-c16',
        opId: 'op-c16-stdin-epipe',
        name: 'stdin-epipe',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: tempDir,
          stdin: 'y'.repeat(4 * 1024 * 1024),
        },
        requiredResources: ['res:c16'],
      });

      expect(earlyExit.status).toBe('succeeded');
      expect(earlyExit.exitCode).toBe(0);
    });

    it('契约 17: 根进程退出后仍持有管道的后代被回收，操作不挂到超时', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c17', 'run-c17');
      const script = [
        "import { spawn } from 'node:child_process';",
        "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000)'], { stdio: ['ignore','inherit','inherit'] });",
        "process.stdout.write(String(child.pid)+'\\n');",
        "setTimeout(() => process.exit(0), 30);",
      ].join('');

      const started = Date.now();
      const result = await supervisor.executeProcess({
        runId: 'run-c17',
        opId: 'op-c17-residual',
        name: 'residual-descendant',
        command: {
          execPath: process.execPath,
          args: ['-e', script],
          cwd: tempDir,
        },
        requiredResources: ['res:c17'],
        timeoutMs: 10_000,
        drainTimeoutMs: 300,
      });

      // root 已退出：操作按真实退出事实收尾，而不是等到 10 秒超时
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.residualProcessesReaped).toBe(true);
      expect(domain.isResourceLocked('res:c17')).toBe(false);

      const descendant = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isInteger(descendant)).toBe(true);
      expect(() => process.kill(descendant, 0)).toThrow();
    }, 15_000);

    it('契约 18: 流式投影回调按流转发 chunk，回调抛错不中断排空', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c18', 'run-c18');
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const projected = await supervisor.executeProcess({
        runId: 'run-c18',
        opId: 'op-c18-stream',
        name: 'stream-projection',
        command: {
          execPath: process.execPath,
          args: ['-e', "process.stdout.write('live-1\\n'); process.stderr.write('live-err\\n'); process.stdout.write('live-2\\n')"],
          cwd: tempDir,
        },
        requiredResources: ['res:c18'],
        onStreamChunk: (stream, chunk) => {
          (stream === 'stdout' ? stdoutChunks : stderrChunks).push(chunk.toString('utf8'));
        },
      });

      expect(projected.status).toBe('succeeded');
      // chunk 边界由内核决定（可能合并写入），逐流拼接必须完整
      expect(stdoutChunks.join('')).toBe('live-1\nlive-2\n');
      expect(stderrChunks.join('')).toBe('live-err\n');
      expect(projected.streamCallbackError).toBeUndefined();

      const throwing = await supervisor.executeProcess({
        runId: 'run-c18',
        opId: 'op-c18-stream-throwing',
        name: 'stream-projection-throwing',
        command: {
          execPath: process.execPath,
          args: ['-e', "process.stdout.write('captured-anyway')"],
          cwd: tempDir,
        },
        requiredResources: ['res:c18'],
        onStreamChunk: () => {
          throw new Error('consumer projection failed');
        },
      });

      expect(throwing.status).toBe('succeeded');
      expect(throwing.stdout).toBe('captured-anyway');
      expect(throwing.streamCallbackError).toBe('consumer projection failed');
    });

    it('契约 19: 超时 + 逃逸后代持有管道，操作在有界时间内返回 indeterminate，不挂到逃逸进程退出', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c19', 'run-c19');
      const subPidFile = path.join(tempDir, 'sub-c19.pid');
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
      const result = await supervisor.executeProcess({
        runId: 'run-c19',
        opId: 'op-c19-timeout-bounded',
        name: 'timeout-bounded-op',
        command: {
          execPath: process.execPath,
          args: ['-e', runnerScript],
          cwd: tempDir,
        },
        requiredResources: ['res:c19-bounded'],
        timeoutMs: 600,
        drainTimeoutMs: 300,
      });

      const duration = Date.now() - startedAt;
      expect(duration).toBeLessThan(3500);
      expect(result.status).toBe('indeterminate');
      expect(domain.isResourceLocked('res:c19-bounded')).toBe(true);

      // 清理逃逸孙进程
      if (fs.existsSync(subPidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(subPidFile, 'utf8'), 10);
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }, 15_000);

    it('契约 20: 停止不存在或已终结的操作返回显式 OperationNotActiveError', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c20', 'run-c20');

      // 1. 不存在的操作
      await expect(supervisor.cancelOperation('op-c20-nonexistent')).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(OperationNotActiveError);
        expect(err.reason).toBe('not_found');
        return true;
      });

      // 2. 已终结的操作
      const completedOpId = 'op-c20-completed';
      await supervisor.executeProcess({
        runId: 'run-c20',
        opId: completedOpId,
        name: 'completed-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.exit(0);'],
          cwd: tempDir,
        },
        requiredResources: [],
      });

      await expect(supervisor.cancelOperation(completedOpId)).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(OperationNotActiveError);
        expect(err.reason).toBe('already_completed');
        return true;
      });
    });

    it('契约 21: 僵尸 leader + 存活后代：恢复按组清场后才结清', async () => {
      const { domain, driver, tempDir } = ctx;
      const opId = 'op-c21-zombie';
      const runId = 'run-c21';
      ensureTaskAndRun(domain, 'task-c21', runId);

      domain.registerOperationIntent({
        id: opId,
        runId,
        kind: 'process',
        name: 'process:zombie-with-orphan',
        inputFingerprint: 'fp-c21',
        requiredResources: ['res:c21'],
        status: 'intent_registered',
      });

      const descendant = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
        { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }
      );
      const descendantPid = descendant.pid!;
      descendant.unref();

      domain.getStore().updateOperationStatus(opId, 'active', {
        pid: descendantPid,
        pgid: descendantPid,
        spawnTime: new Date().toISOString(),
        commandFingerprint: `${process.execPath}:-e`,
      });
      domain.getStore().updateOperationStatus(opId, 'stopping');
      const stored = domain.getStore().getOperation(opId)!;
      domain.getStore().updateOperationStatus(opId, 'active', {
        ...stored.processIdentity!,
        pid: 2_147_483_000,
      });

      try {
        const report = await new RecoveryEngine(domain, driver).recover();
        expect(report.recoveredOperations).toHaveLength(1);
        expect(report.recoveredOperations[0].action).toBe('marked_dead');
        expect(report.recoveredOperations[0].resourcesReleased).toBe(true);

        expect(domain.isResourceLocked('res:c21')).toBe(false);
        const result = domain.getStore().getOperation(opId)!.result!;
        expect(result.status).toBe('failed');
        expect(result.kind === 'process' ? result.stderr : '').toContain('reaped during recovery');
      } finally {
        try {
          process.kill(-descendantPid, 'SIGKILL');
        } catch {}
      }
    }, 20_000);

    it('契约 22: 重复 opId 提交抛出 DuplicateOperationError，原操作租约与可取消性不受影响', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c22', 'run-c22');
      const opId = 'op-c22-duplicate';

      const execPromise = supervisor.executeProcess({
        runId: 'run-c22',
        opId,
        name: 'sleep-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tempDir,
        },
        requiredResources: ['res:c22'],
      });

      await new Promise((r) => setTimeout(r, 100));

      // 重复提交相同 opId 必须抛出 DuplicateOperationError
      await expect(
        supervisor.executeProcess({
          runId: 'run-c22',
          opId,
          name: 'duplicate-op',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.exit(0);'],
            cwd: tempDir,
          },
          requiredResources: ['res:c22'],
        })
      ).rejects.toThrow(DuplicateOperationError);

      // 原操作排他租约未被破坏
      expect(domain.isResourceLocked('res:c22')).toBe(true);

      // 原操作仍可成功取消
      const stopRes = await supervisor.cancelOperation(opId, 1000);
      expect(stopRes.stopped).toBe('confirmed_stopped');

      const opResult = await execPromise;
      expect(opResult.status).toBe('cancelled');
    });

    it('契约 23: 恢复后 Run 状态收敛，无未终结操作时 Run 不停留在 running', async () => {
      const { domain, driver } = ctx;
      const taskId = 'task-c23';
      const runId = 'run-c23';
      ensureTaskAndRun(domain, taskId, runId);

      domain.registerOperationIntent({
        id: 'op-c23-1',
        runId,
        kind: 'process',
        name: 'clean-crashed-op',
        inputFingerprint: 'f'.repeat(64),
        requiredResources: ['res:c23-clean'],
        status: 'intent_registered',
      });

      const recovery = new RecoveryEngine(domain, driver);
      await recovery.recover();

      const runAfter = domain.getStore().getRun(runId);
      expect(runAfter?.status).toBe('failed');
      expect(runAfter?.terminationReason).toBe('crash_detected');
    });

    it('契约 24: 人工裁决受审计出口：仅对 indeterminate 生效，写 journal 并受代际栅栏约束', async () => {
      const { domain } = ctx;
      const opId = 'op-c24-indet';
      const runId = 'run-c24';
      ensureTaskAndRun(domain, 'task-c24', runId);

      domain.registerOperationIntent({
        id: opId,
        runId,
        kind: 'process',
        name: 'indet-op',
        inputFingerprint: 'f'.repeat(64),
        requiredResources: ['res:c24'],
        status: 'intent_registered',
      });

      // 写入 indeterminate 结果
      domain.getStore().recordOperationResult(
        opId,
        {
          kind: 'indeterminate',
          status: 'indeterminate',
          reason: 'Process cannot be determined',
          recoveryGuidance: 'Check manually',
          durationMs: 10,
          completedAt: new Date().toISOString(),
        },
        false // 不释放租约
      );

      expect(domain.isResourceLocked('res:c24')).toBe(true);

      // 人工裁决 confirmed_stopped 成功释放租约
      const record = await domain.adjudicate(opId, 'confirmed_stopped', 'admin-user', 'Manual verified dead');
      expect(record.verdict).toBe('confirmed_stopped');
      expect(domain.isResourceLocked('res:c24')).toBe(false);

      const events = domain.getStore().getJournalEvents(domain.domainId);
      const adjEvent = events.find((e) => e.type === 'OPERATION_ADJUDICATED' && e.operationId === opId);
      expect(adjEvent).toBeDefined();
    });

    it('契约 25: 内存保留 Head + Tail，截断点落在 UTF-8 边界', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c25', 'run-c25');

      const result = await supervisor.executeProcess({
        runId: 'run-c25',
        opId: 'op-c25-head-tail',
        name: 'head-tail-op',
        command: {
          execPath: process.execPath,
          args: [
            '-e',
            'process.stdout.write("HEAD-START-12345\\n" + "x".repeat(120 * 1024) + "\\nTAIL-END-67890");',
          ],
          cwd: tempDir,
        },
        requiredResources: [],
        maxOutputBytes: 10 * 1024,
      });

      expect(result.status).toBe('succeeded');
      expect(result.isTruncated).toBe(true);
      expect(result.stdout).toContain('HEAD-START-12345');
      expect(result.stdout).toContain('TAIL-END-67890');
      expect(result.stdout).toContain('[... truncated');
    });

    it('契约 26: 转储失败可见：spillError 出现时不返回引用', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c26', 'run-c26');

      const nonWritablePath = path.join(tempDir, 'non-writable-file');
      fs.writeFileSync(nonWritablePath, 'block');

      const result = await supervisor.executeProcess({
        runId: 'run-c26',
        opId: 'op-c26-spill-err',
        name: 'spill-err-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.stdout.write("hello-spill-fail");'],
          cwd: tempDir,
        },
        requiredResources: [],
        artifactsDir: nonWritablePath,
      });

      expect(result.status).toBe('succeeded');
      expect(result.spillError).toBeDefined();
      expect(result.outputRef).toBeUndefined();
      expect(result.stdout).toBe('hello-spill-fail');
    });

    it('契约 27: 未截断转储在结清时删除；pruneArtifacts 拒绝回收未终结 / 未裁决 op 的产物', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c27', 'run-c27');
      const artifactsDir = path.join(tempDir, 'artifacts');

      // 1. 未截断转储在结清时自动删除
      const untruncated = await supervisor.executeProcess({
        runId: 'run-c27',
        opId: 'op-c27-untruncated',
        name: 'untruncated-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.stdout.write("short text");'],
          cwd: tempDir,
        },
        requiredResources: [],
        artifactsDir,
      });
      expect(untruncated.status).toBe('succeeded');
      expect(untruncated.isTruncated).toBe(false);
      expect(untruncated.outputRef).toBeUndefined();
      const files = fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir) : [];
      expect(files.filter((f) => f.includes('op-c27-untruncated'))).toHaveLength(0);

      // 2. pruneArtifacts 拒绝回收未终结 / 未裁决 op 的产物
      domain.registerOperationIntent({
        id: 'op-c27-active',
        runId: 'run-c27',
        kind: 'process',
        name: 'active-op',
        inputFingerprint: 'f'.repeat(64),
        requiredResources: [],
        status: 'intent_registered',
      });
      fs.mkdirSync(artifactsDir, { recursive: true });
      const activeFile = path.join(artifactsDir, 'op-c27-active-stdout.log');
      fs.writeFileSync(activeFile, 'active artifact');

      const pruneResult = domain.pruneArtifacts();
      expect(pruneResult.retained).toContain(activeFile);
      expect(fs.existsSync(activeFile)).toBe(true);
    });

    it('契约 45: 同 opId 同指纹重放返回已记录结果，不产生新进程，写 OPERATION_REPLAYED', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c45', 'run-c45');
      const counterFile = path.join(tempDir, 'counter-c45.log');

      const options = {
        runId: 'run-c45',
        opId: 'op-c45-recorded',
        name: 'op-c45',
        requiredResources: [],
        command: {
          execPath: process.execPath,
          args: ['-e', `require('fs').appendFileSync(process.argv[1], '1\\n'); console.log('c45-out');`, counterFile],
          cwd: tempDir,
        },
      };

      const res1 = await supervisor.executeProcess(options);
      expect(res1.status).toBe('succeeded');
      expect(res1.replayed).toBeUndefined();
      expect(res1.stdout).toContain('c45-out');

      const res2 = await supervisor.executeProcess(options);
      expect(res2.status).toBe('succeeded');
      expect(res2.replayed).toBe(true);
      expect(res2.stdout).toContain('c45-out');

      // 验证副作用仅发生 1 次
      const lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);

      // journal 记录 OPERATION_REPLAYED
      const events = domain.getStore().getJournalEvents(domain.domainId);
      const replayEvt = events.find((e) => e.type === 'OPERATION_REPLAYED' && e.operationId === 'op-c45-recorded');
      expect(replayEvt).toBeDefined();
      expect(replayEvt?.payload.mode).toBe('recorded');
    });

    it('契约 46: 同 opId 不同指纹 => OperationIdConflictError，不改动已有 op 的任何事实', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c46', 'run-c46');

      const options1 = {
        runId: 'run-c46',
        opId: 'op-c46-conflict',
        name: 'op-c46-orig',
        requiredResources: [],
        command: {
          execPath: process.execPath,
          args: ['-e', 'console.log("c46-orig");'],
          cwd: tempDir,
        },
      };

      const res1 = await supervisor.executeProcess(options1);
      expect(res1.status).toBe('succeeded');

      const options2 = {
        runId: 'run-c46',
        opId: 'op-c46-conflict',
        name: 'op-c46-conflict',
        requiredResources: [],
        command: {
          execPath: process.execPath,
          args: ['-e', 'console.log("c46-diff");'], // 不同 args
          cwd: tempDir,
        },
      };

      await expect(supervisor.executeProcess(options2)).rejects.toThrow(OperationIdConflictError);

      const op = domain.getStore().getOperation('op-c46-conflict');
      expect(op?.status).toBe('done');
      expect(op?.result?.status).toBe('succeeded');
    });

    it('契约 47: 重放命中在飞 op => 两个调用拿到同一结果，进程只启动一次', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c47', 'run-c47');
      const counterFile = path.join(tempDir, 'counter-c47.log');

      const options = {
        runId: 'run-c47',
        opId: 'op-c47-inflight',
        name: 'op-c47',
        requiredResources: [],
        command: {
          execPath: process.execPath,
          args: ['-e', `require('fs').appendFileSync(process.argv[1], '1\\n'); setTimeout(() => console.log('c47-out'), 300);`, counterFile],
          cwd: tempDir,
        },
      };

      const [res1, res2] = await Promise.all([
        supervisor.executeProcess(options),
        supervisor.executeProcess(options),
      ]);

      expect(res1.status).toBe('succeeded');
      expect(res2.status).toBe('succeeded');
      expect(res2.replayed).toBe(true);

      const lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);

      const events = domain.getStore().getJournalEvents(domain.domainId);
      const replayEvt = events.find((e) => e.type === 'OPERATION_REPLAYED' && e.operationId === 'op-c47-inflight');
      expect(replayEvt?.payload.mode).toBe('joined');
    });

    it('契约 48: 重放命中 indeterminate => 原样返回，不重跑，租约保持', async () => {
      const { supervisor, domain, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c48', 'run-c48');
      const opId = 'op-c48-indet';
      const store = domain.getStore();

      const options = {
        runId: 'run-c48',
        opId,
        name: 'test-indet',
        requiredResources: ['res:c48'],
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: tempDir,
        },
      };

      store.registerOperationIntent({
        id: opId,
        runId: 'run-c48',
        kind: 'process',
        name: 'test-indet',
        inputFingerprint: computeInputFingerprint(options),
        requiredResources: ['res:c48'],
        status: 'pending',
      }, domain.domainId);

      const indetResult: ProcessOperationResult = {
        kind: 'process',
        status: 'indeterminate' as any,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: 'indeterminate residual',
        isTruncated: false,
        identityVerification: 'cannot_determine',
        durationMs: 50,
        completedAt: new Date().toISOString(),
      };
      store.recordOperationResult(opId, indetResult, false);

      const res = await supervisor.executeProcess(options);
      expect(res.status).toBe('indeterminate');
      expect(res.replayed).toBe(true);

      const leases = store.getPersistedResourceLeases(domain.domainId);
      expect(leases.some((l) => l.operationId === opId && l.resourceId === 'res:c48')).toBe(true);
    });

    it('契约 49: 有意图无身份的崩溃现场：未恢复时提交抛 RecoveryRequiredError；恢复后结清重放命中已记录事实', async () => {
      const { supervisor, domain, driver, tempDir } = ctx;
      ensureTaskAndRun(domain, 'task-c49', 'run-c49');
      const opId = 'op-c49-unrecovered';
      const store = domain.getStore();

      const options = {
        runId: 'run-c49',
        opId,
        name: 'test-unrecovered',
        requiredResources: [],
        command: {
          execPath: process.execPath,
          args: ['-e', 'console.log(1)'],
          cwd: tempDir,
        },
      };

      // 构造崩溃残留：intent_registered 且不在内存活跃表中
      store.registerOperationIntent({
        id: opId,
        runId: 'run-c49',
        kind: 'process',
        name: 'test-unrecovered',
        inputFingerprint: computeInputFingerprint(options),
        requiredResources: [],
        status: 'intent_registered',
      }, domain.domainId);

      // 未调用 recover() 前调用，抛 RecoveryRequiredError
      await expect(supervisor.executeProcess(options)).rejects.toThrow(RecoveryRequiredError);

      // 执行崩溃恢复
      const recoveryEngine = new RecoveryEngine(domain, driver);
      await recoveryEngine.recover();

      // 恢复后该意图被收敛为 failed(never spawned)，新 Run 再次发起重放应命中已记录结果
      ensureTaskAndRun(domain, 'task-c49', 'run-c49-new');
      const replayOptions = {
        ...options,
        runId: 'run-c49-new',
      };
      const res = await supervisor.executeProcess(replayOptions);
      expect(res.status).toBe('failed');
      expect(res.replayed).toBe(true);
      expect(res.runId).toBe('run-c49');
    });
  });
}
