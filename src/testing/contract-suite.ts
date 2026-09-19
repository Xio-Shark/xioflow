import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ExecutionDomain,
  SqliteStore,
  PlatformDriver,
  ProcessSupervisor,
  RecoveryEngine,
  ResourceConflictError,
  UnsupportedCapabilityError,
  EpochFencedError,
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
  describe(`16-Item Consistency Contract Suite: [${consumerName}]`, () => {
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
          return { stopped: false, scope: 'unknown', errorDetails: 'Cannot confirm exit' };
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
      expect(cancelRes.stopped).toBe(false);

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
        domain.releaseResources('op-owner-A', ['res:exclusive-port']);
      }, 50);

      await domain.allocateResourcesWithWait('op-requester-B', ['res:exclusive-port'], 300);
      expect(domain.getResourceOwner('res:exclusive-port')).toBe('op-requester-B');
      domain.releaseResources('op-requester-B');
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

      expect(stopRes.stopped).toBe(true);
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

        // 真实上报 stopped: false，且 residualPids 包含逃逸孤儿 PID
        expect(cancelRes.stopped).toBe(false);
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
        domain.releaseResources('op-first');
      }, 60);

      await domain.allocateResourcesWithWait('op-second', ['res:op2'], 300);
      expect(domain.getResourceOwner('res:op2')).toBe('op-second');
      domain.releaseResources('op-second');
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
  });
}
