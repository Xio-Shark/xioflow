import crypto from 'node:crypto';
import { artifactPath, recordArtifactCreated } from '../artifacts.js';
import { PassThrough } from 'node:stream';
import { ExecutionDomain } from '../domain.js';
import { PlatformDriver, ManagedProcessHandle, StopProcessResult } from '../driver/types.js';
import {
  ServiceSpec,
  ServiceHandle,
  ReadyFact,
  Operation,
  ProcessOperationResult,
  IndeterminateResult,
  OperationIdConflictError,
} from '../types.js';
import { ProcessSupervisor } from './supervisor.js';
import { setupStreamDrainer, StreamDrainer } from './drainer.js';
import { computeInputFingerprint } from './fingerprint.js';
import { settleProcessTree } from '../driver/tree-settlement.js';

interface ServiceRuntimeState {
  owner: ServiceSupervisor;
  inputFingerprint: string;
  intentRegistered: boolean;
  serviceId: string;
  runId: string;
  spec: ServiceSpec;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  attemptCount: number;
  currentInstanceIndex: number;
  currentOpId: string;
  currentProcessHandle: ManagedProcessHandle | null;
  currentStderrDrainer?: StreamDrainer;
  stdinStream: PassThrough;
  stdoutStream: PassThrough;
  readyResolve: (fact: ReadyFact) => void;
  readyReject: (err: any) => void;
  readyPromise: Promise<ReadyFact>;
  stopResolve: () => void;
  stopReject: (error: unknown) => void;
  stopPromise: Promise<void>;
  stopRequested: boolean;
  restartTimer: NodeJS.Timeout | null;
  instanceExitResolve?: (val: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  instanceExitReject?: (error: unknown) => void;
  clearReadiness?: () => void;
  onInstanceExit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  handle: ServiceHandle;
  instanceStartedAt: number;                        // 当前实例启动时刻（用于真实 durationMs）
  pendingInstanceResult?: ProcessOperationResult;   // 显式停止时由 stopService 在确认停止后落盘
  failureReason?: string;                           // 例如 readiness_timeout：停止后终态记为 failed
}

const servicesByDomain = new WeakMap<ExecutionDomain, Map<string, ServiceRuntimeState>>();

export class ServiceSupervisor {
  private readonly activeServices: Map<string, ServiceRuntimeState>;

  constructor(
    private domain: ExecutionDomain,
    private driver: PlatformDriver,
    private supervisor: ProcessSupervisor
  ) {
    let services = servicesByDomain.get(domain);
    if (!services) servicesByDomain.set(domain, services = new Map());
    this.activeServices = services;
  }

  public async startService(spec: ServiceSpec): Promise<ServiceHandle> {
    const inputFingerprint = this.computeServiceFingerprint(spec);
    const existing = this.activeServices.get(spec.serviceId);
    if (existing) {
      if (existing.status === 'starting' || existing.status === 'running') {
        if (existing.inputFingerprint !== inputFingerprint) {
          throw new OperationIdConflictError(spec.serviceId, existing.inputFingerprint, inputFingerprint, existing.status, existing.runId);
        }
        return existing.handle;
      }
      throw new Error(`Service "${spec.serviceId}" is already finalized with status "${existing.status}"`);
    }

    // 验证所属 Run（N3 契约）
    const store = this.domain.getStore();
    const callingRun = store.getRun(spec.runId);
    if (!callingRun) {
      throw new Error(`Run "${spec.runId}" is not registered in domain "${this.domain.domainId}".`);
    }
    if (
      callingRun.status === 'succeeded' ||
      callingRun.status === 'failed' ||
      callingRun.status === 'cancelled' ||
      callingRun.status === 'indeterminate'
    ) {
      throw new Error(
        `Cannot start service "${spec.serviceId}" for Run "${spec.runId}" because the Run is already finalized with status "${callingRun.status}".`
      );
    }

    // 申请 service 级独占资源租约 (重启间隙保持租约不被其他 op 抢占，ARCHITECTURE §3.8 / 裁决 7)
    const serviceLeaseHolder = `service:${spec.serviceId}`;
    if (spec.requiredResources && spec.requiredResources.length > 0) {
      this.domain.assertOperationIdAvailable(serviceLeaseHolder);
      this.domain.allocateResources(serviceLeaseHolder, spec.requiredResources, 0);
    }

    const stdinStream = new PassThrough();
    const stdoutStream = new PassThrough();

    let readyResolve!: (fact: ReadyFact) => void;
    let readyReject!: (err: any) => void;
    const readyPromise = new Promise<ReadyFact>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A startup failure can precede delivery of the handle. Keep the original
    // rejection observable to later subscribers without an unhandled rejection.
    void readyPromise.catch(() => {});

    let stopResolve!: () => void;
    let stopReject!: (error: unknown) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      stopResolve = resolve;
      stopReject = reject;
    });
    void stopPromise.catch(() => {});

    let instanceExitResolve!: (val: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
    let instanceExitReject!: (error: unknown) => void;
    const onInstanceExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      instanceExitResolve = resolve;
      instanceExitReject = reject;
    });
    void onInstanceExit.catch(() => {});

    const state: ServiceRuntimeState = {
      owner: this,
      inputFingerprint,
      intentRegistered: false,
      serviceId: spec.serviceId,
      runId: spec.runId,
      spec,
      status: 'starting',
      attemptCount: 0,
      currentInstanceIndex: 1,
      currentOpId: `${spec.serviceId}#1`,
      currentProcessHandle: null,
      stdinStream,
      stdoutStream,
      readyResolve,
      readyReject,
      readyPromise,
      stopResolve,
      stopReject,
      stopPromise,
      stopRequested: false,
      restartTimer: null,
      instanceExitResolve,
      instanceExitReject,
      onInstanceExit,
      handle: null as any,
      instanceStartedAt: Date.now(),
    };

    state.handle = {
      serviceId: spec.serviceId,
      runId: spec.runId,
      stdin: stdinStream,
      stdout: stdoutStream,
      ready: readyPromise,
      stop: (graceMs) => this.stopService(spec.serviceId, graceMs),
      get onInstanceExit() {
        return state.onInstanceExit;
      },
      get currentInstanceOpId() {
        return state.currentOpId;
      },
    };

    this.activeServices.set(spec.serviceId, state);

    try {
      await this.spawnInstance(state, 1);
    } catch (err) {
      throw await this.settleStartupFailure(state, err);
    }

    return state.handle;
  }

  private async spawnInstance(state: ServiceRuntimeState, instanceIndex: number): Promise<void> {
    state.currentInstanceIndex = instanceIndex;
    state.currentOpId = `${state.serviceId}#${instanceIndex}`;
    state.instanceStartedAt = Date.now();
    state.pendingInstanceResult = undefined;
    state.intentRegistered = false;

    // 更新 onInstanceExit 为当前实例的 promise
    // The first promise may already have subscribers from a joining entry point.
    if (instanceIndex > 1) {
      state.currentProcessHandle = null;
      state.onInstanceExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        state.instanceExitResolve = resolve;
        state.instanceExitReject = reject;
      });
      void state.onInstanceExit.catch(() => {});
    }

    const store = this.domain.getStore();
    const inputFingerprint = this.computeServiceFingerprint(state.spec);

    // 1. [意图登记] SQLite 写入 Operation (status: intent_registered, kind: service)
    const op: Operation = {
      id: state.currentOpId,
      runId: state.runId,
      kind: 'service',
      name: `service-instance-${state.serviceId}-${instanceIndex}`,
      inputFingerprint,
      requiredResources: state.spec.requiredResources ?? [],
      spawnGated: this.driver.capabilities.gatedSpawn === true,
      status: 'intent_registered',
    };
    this.supervisor.assertOperationIdAvailable(op.id);
    store.registerOperationIntent(op, this.domain.domainId);
    state.intentRegistered = true;

    // 2. 写入 journal 事件
    if (instanceIndex === 1) {
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_STARTED',
        payload: {
          serviceId: state.serviceId,
          runId: state.runId,
          instanceIndex,
          opId: state.currentOpId,
          spec: {
            serviceId: state.spec.serviceId,
            command: journalSafeCommand(state.spec.command),
            restart: state.spec.restart,
            readiness: state.spec.readiness,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

    // 3. 驱动启动受管进程
    const commandWithStream = {
      ...state.spec.command,
      stdinMode: 'stream' as const,
    };
    const processHandle = await this.driver.spawn(commandWithStream);
    state.currentProcessHandle = processHandle;

    // 4. [登记执行身份] 推进为 active
    store.updateOperationStatus(state.currentOpId, 'active', processHandle.identity);

    // 5. 放行门管道
    if (processHandle.releaseGate) {
      processHandle.releaseGate();
    }

    // 6. 连接 stdin/stdout 管道
    if (processHandle.stdin) {
      state.stdinStream.pipe(processHandle.stdin as any, { end: false });
    }
    // 直通消费 stdout，内核内存不保留 Head+Tail (ARCHITECTURE §3.8 / 契约 #50)
    processHandle.stdout.pipe(state.stdoutStream, { end: false });

    // 7. 消费 stderr 按 B3 有界上限排空并转储
    const maxStderrBytes = state.spec.maxStderrBytes ?? 10 * 1024 * 1024;
    let stderrSpillPath: string | undefined;
    if (state.spec.artifactsDir) {
      stderrSpillPath = artifactPath(state.spec.artifactsDir, state.currentOpId, '.stderr.log');
    }
    const stderrDrainer = setupStreamDrainer(
      processHandle.stderr,
      maxStderrBytes,
      stderrSpillPath,
      undefined,
      undefined,
      undefined,
      (artifact) => recordArtifactCreated(this.domain, state.currentOpId, artifact)
    );
    state.currentStderrDrainer = stderrDrainer;

    // 8. 处理就绪探测 (仅在第 1 次启动时)
    if (instanceIndex === 1) {
      this.setupReadiness(state, processHandle);
    }

    // 9. 监听退出事件
    const exitPromise = processHandle.onRootExit ?? processHandle.onExit;
    exitPromise.then((exitResult) => {
      this.handleInstanceExit(state, instanceIndex, exitResult).catch((error) => this.rejectLifecycle(state, error));
    }, (error) => this.rejectLifecycle(state, error));
  }

  /** Failed launches keep their error, and release leases only after confirmed cleanup. */
  private async settleStartupFailure(state: ServiceRuntimeState, error: unknown): Promise<unknown> {
    state.stopRequested = true;
    state.clearReadiness?.();
    const errors: unknown[] = [error];
    const handle = state.currentProcessHandle;
    let confirmed = !handle;
    let exit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
    if (handle) {
      try {
        handle.destroyGate?.();
        const stopped = await this.driver.terminate(handle.identity, state.spec.graceMs ?? 1000);
        let timer: NodeJS.Timeout | undefined;
        try {
          exit = await Promise.race([
            handle.onRootExit ?? handle.onExit,
            new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
        confirmed = stopped.stopped === 'confirmed_stopped' && exit !== undefined;
        if (!confirmed) errors.push(new Error(`Service startup cleanup was not confirmed: ${stopped.errorDetails ?? stopped.stopped}`));
      } catch (cleanupError) { errors.push(cleanupError); }
    }
    try {
      const store = this.domain.getStore();
      const op = store.getOperation(state.currentOpId);
      if (state.intentRegistered && op && op.status !== 'done') {
        const message = errors.map(String).join('; ');
        const result: ProcessOperationResult | IndeterminateResult = confirmed ? {
          kind: 'process', status: 'failed', exitCode: handle ? exit!.exitCode : 127,
          signal: exit?.signal ?? null, stdout: '', stderr: message, spawnFailure: message,
          isTruncated: false, identityVerification: 'cannot_determine',
          durationMs: Date.now() - state.instanceStartedAt, completedAt: new Date().toISOString(),
        } : {
          kind: 'indeterminate', status: 'indeterminate', reason: message,
          recoveryGuidance: 'Inspect the service process and adjudicate its operation before releasing leases.',
          durationMs: Date.now() - state.instanceStartedAt, completedAt: new Date().toISOString(),
        };
        store.recordOperationResult(state.currentOpId, result, confirmed);
      }
      if (confirmed) this.domain.internalReleaseResources(`service:${state.serviceId}`, state.spec.requiredResources);
    } catch (recordError) { errors.push(recordError); confirmed = false; }
    state.status = 'failed';
    if (handle?.stdin) state.stdinStream.unpipe(handle.stdin as any);
    handle?.stdout.unpipe(state.stdoutStream);
    // An unconfirmed survivor must not keep writing into an ended public stream.
    // Drain its output while its durable indeterminate record retains the lease.
    (handle?.stdout as any)?.resume?.();
    state.currentStderrDrainer?.forceFinalize();
    state.stdinStream.end();
    state.stdoutStream.end();
    const failure = errors.length === 1 ? error : new AggregateError(errors, errors.map(String).join('; '), { cause: error });
    state.readyReject(failure);
    if (exit) state.instanceExitResolve?.(exit);
    else state.instanceExitReject?.(failure);
    if (confirmed) state.stopResolve();
    else state.stopReject(failure);
    return failure;
  }

  private rejectLifecycle(state: ServiceRuntimeState, error: unknown): void {
    // Durable facts and leases remain available for recovery when journal writes fail.
    state.status = 'failed';
    state.clearReadiness?.();
    state.readyReject(error);
    state.instanceExitReject?.(error);
    state.stopReject(error);
  }

  private setupReadiness(state: ServiceRuntimeState, processHandle: ManagedProcessHandle): void {
    const store = this.domain.getStore();
    const readiness = state.spec.readiness;

    if (!readiness || readiness === 'spawned') {
      state.status = 'running';
      const readyAt = new Date().toISOString();
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_READY',
        payload: {
          serviceId: state.serviceId,
          runId: state.runId,
          instanceIndex: 1,
          opId: state.currentOpId,
          readyAt,
        },
        timestamp: readyAt,
      });
      state.readyResolve({
        serviceId: state.serviceId,
        instanceIndex: 1,
        readyAt,
      });
      return;
    }

    if (typeof readiness === 'object' && readiness.stdoutLine) {
      const regex = readiness.stdoutLine;
      const timeoutMs = readiness.timeoutMs ?? 5000;
      let matched = false;

      const onData = (chunk: Buffer) => {
        if (matched) return;
        const text = chunk.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          if (regex.test(line)) {
            matched = true;
            processHandle.stdout.off('data', onData);
            if (timer) clearTimeout(timer);

            state.status = 'running';
            const readyAt = new Date().toISOString();
            store.recordEventAndTransitionState({
              domainId: this.domain.domainId,
              runId: state.runId,
              operationId: state.currentOpId,
              type: 'SERVICE_READY',
              payload: {
                serviceId: state.serviceId,
                runId: state.runId,
                instanceIndex: 1,
                opId: state.currentOpId,
                readyAt,
                matchedLine: line,
              },
              timestamp: readyAt,
            });
            state.readyResolve({
              serviceId: state.serviceId,
              instanceIndex: 1,
              readyAt,
              matchedLine: line,
            });
            break;
          }
        }
      };

      processHandle.stdout.on('data', onData);

      const timer = setTimeout(() => {
        if (!matched) {
          matched = true;
          processHandle.stdout.off('data', onData);
          // 不能先把 status 置为 failed：stopService 会把 failed 当作已终结直接返回，进程就泄漏了。
          // 记下失败原因，由停止流水线在确认停止后把终态记为 failed。
          state.failureReason = 'readiness_timeout';
          const err = new Error(`Service "${state.serviceId}" readiness check timed out after ${timeoutMs}ms`);
          state.readyReject(err);
          this.stopService(state.serviceId, 500).catch(() => {});
        }
      }, timeoutMs);
      state.clearReadiness = () => {
        clearTimeout(timer);
        processHandle.stdout.off('data', onData);
      };
    }
  }

  private async handleInstanceExit(
    state: ServiceRuntimeState,
    instanceIndex: number,
    exitResult: { exitCode: number | null; signal: NodeJS.Signals | null }
  ): Promise<void> {
    const exitedIdentity = state.currentProcessHandle?.identity;
    state.clearReadiness?.();
    state.readyReject(new Error(`Service "${state.serviceId}" exited before readiness`));

    // 释放管道连接
    if (state.currentProcessHandle?.stdin) {
      try {
        state.stdinStream.unpipe(state.currentProcessHandle.stdin as any);
      } catch {}
    }
    if (state.currentProcessHandle?.stdout) {
      try {
        state.currentProcessHandle.stdout.unpipe(state.stdoutStream);
      } catch {}
    }

    state.currentStderrDrainer?.forceFinalize();
    const stderrData = state.currentStderrDrainer?.getResult();

    const store = this.domain.getStore();
    const serviceLeaseHolder = `service:${state.serviceId}`;

    // 身份核验走驱动真实结论，不再写死 is_original_process；驱动核验失败时如实记为 cannot_determine
    let identityVerification: ProcessOperationResult['identityVerification'] = 'cannot_determine';
    if (exitedIdentity) {
      try {
        identityVerification = await this.driver.verifyIdentity(exitedIdentity);
      } catch {
        identityVerification = 'cannot_determine';
      }
    }

    // 更新当前 operation 结果
    const op = store.getOperation(state.currentOpId);
    if (op) {
      const isSuccess = exitResult.exitCode === 0 && exitResult.signal === null;
      const isTruncated = stderrData?.isTruncated ?? false;
      const result: ProcessOperationResult = {
        kind: 'process',
        status: isSuccess ? 'succeeded' : 'failed',
        exitCode: exitResult.exitCode,
        signal: exitResult.signal,
        stdout: '',
        stderr: stderrData?.content ?? '',
        isTruncated,
        stderrTruncated: isTruncated,
        stderrRef: !stderrData?.spillError ? stderrData?.outputRef : undefined,
        outputRef: !stderrData?.spillError ? stderrData?.outputRef : undefined,
        stderrBytes: stderrData?.bytesSeen ?? 0,
        stderrHash: !stderrData?.spillError ? stderrData?.outputHash : undefined,
        outputHash: !stderrData?.spillError ? stderrData?.outputHash : undefined,
        durationMs: Date.now() - state.instanceStartedAt,
        completedAt: new Date().toISOString(),
        identityVerification,
        ...(stderrData?.spillError ? { spillError: stderrData.spillError, stderrSpillError: stderrData.spillError } : {}),
      };
      if (!state.stopRequested && exitedIdentity) {
        const settlement = await settleProcessTree(this.driver, exitedIdentity, 0, state.spec.graceMs ?? 1000);
        if (!state.stopRequested) {
          if (settlement.status === 'unconfirmed') {
            store.recordOperationResult(state.currentOpId, {
              kind: 'indeterminate', status: 'indeterminate',
              reason: `Service root exited but its descendants could not be confirmed stopped: ${settlement.stop.errorDetails ?? settlement.stop.stopped}`,
              recoveryGuidance: 'Inspect the service process tree and adjudicate its operation before releasing leases.',
              durationMs: result.durationMs, completedAt: new Date().toISOString(),
            }, false);
            state.status = 'failed';
            state.instanceExitResolve?.(exitResult);
            state.stdoutStream.end();
            state.stopResolve();
            return;
          }
          result.treeSettlement = settlement.treeSettlement;
          if (settlement.residualProcessesReaped) result.residualProcessesReaped = true;
        }
      }
      if (state.stopRequested) {
        // 显式停止：根进程退出不等于整组已停，结果交给 stopService 在拿到驱动停止结论后落盘
        state.pendingInstanceResult = result;
      } else {
        store.recordOperationResult(state.currentOpId, result);
      }
    }

    state.instanceExitResolve?.(exitResult);

    // 1. 如果是显式请求停止：终态、事件与租约统一由 stopService → finalizeStop 处理
    if (state.stopRequested) {
      return;
    }

    // 2. 如果 domain 已关闭
    if (this.domain.isClosed()) {
      state.status = 'stopped';
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
      state.stopResolve();
      return;
    }

    // 3. 如果进程正常以 0 退出，不重启
    if (exitResult.exitCode === 0 && exitResult.signal === null) {
      state.status = 'stopped';
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_STOPPED',
        payload: { serviceId: state.serviceId, runId: state.runId, reason: 'exit' },
        timestamp: new Date().toISOString(),
      });
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
      state.stdoutStream.end();
      state.stopResolve();
      return;
    }

    // 4. 异常退出：评估重启策略 (ARCHITECTURE §3.8 / D19)
    const restart = state.spec.restart;
    const shouldRestart =
      restart &&
      restart !== 'never' &&
      restart.policy === 'on-failure' &&
      state.attemptCount < restart.maxRestarts;

    if (shouldRestart) {
      state.attemptCount++;
      const newInstanceIndex = state.attemptCount + 1;
      const newOpId = `${state.serviceId}#${newInstanceIndex}`;

      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_RESTARTED',
        payload: {
          serviceId: state.serviceId,
          runId: state.runId,
          newInstanceIndex,
          newOpId,
          exitCode: exitResult.exitCode,
          signal: exitResult.signal,
          attempt: state.attemptCount,
        },
        timestamp: new Date().toISOString(),
      });

      // 重启间隙租约保持在 service 名下，不释放
      state.restartTimer = setTimeout(() => {
        state.restartTimer = null;
        if (state.stopRequested || this.domain.isClosed()) return;
        this.spawnInstance(state, newInstanceIndex).catch((error) => this.settleStartupFailure(state, error));
      }, restart.backoffMs);
    } else {
      // 超过重启上限或 restart: never
      state.status = 'failed';
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_FAILED',
        payload: {
          serviceId: state.serviceId,
          runId: state.runId,
          maxRestartsExceeded: restart !== 'never' && state.attemptCount >= (restart?.maxRestarts ?? 0),
          exitCode: exitResult.exitCode,
          signal: exitResult.signal,
        },
        timestamp: new Date().toISOString(),
      });
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
      state.stdoutStream.end();
      state.stopResolve();
    }
  }

  public async stopService(serviceId: string, graceMs: number = 2000): Promise<void> {
    const state = this.activeServices.get(serviceId);
    if (!state) return;
    // A second entry point must use the driver that owns the running instance.
    if (state.owner !== this) return state.owner.stopService(serviceId, graceMs);
    if (state.status === 'stopped' || state.status === 'failed') return state.stopPromise;
    // 停止流水线已在进行（例如 readiness 超时触发的停止）：加入同一个结果，避免重复终态写入
    if (state.status === 'stopping') return state.stopPromise;

    state.stopRequested = true;
    state.status = 'stopping';

    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
      state.status = 'stopped';
      const serviceLeaseHolder = `service:${state.serviceId}`;
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
      const store = this.domain.getStore();
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_STOPPED',
        payload: { serviceId: state.serviceId, runId: state.runId, reason: 'stopped' },
        timestamp: new Date().toISOString(),
      });
      state.stdoutStream.end();
      state.stopResolve();
      return state.stopPromise;
    }

    if (state.currentProcessHandle) {
      let stopRes: StopProcessResult;
      try {
        stopRes = await this.driver.terminate(state.currentProcessHandle.identity, graceMs);
      } catch (err: any) {
        stopRes = { stopped: 'cannot_determine', scope: 'unknown', errorDetails: err?.message ?? String(err) };
      }
      // 有界等待根进程退出事实：停止未确认时根进程可能仍活着，不能无限挂起调用方
      const rootExitBoundMs = 1000;
      const rootExited = await Promise.race([
        state.onInstanceExit.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), rootExitBoundMs)),
      ]);
      this.finalizeStop(state, stopRes, rootExited);
    } else {
      state.status = 'stopped';
      state.stopResolve();
    }

    return state.stopPromise;
  }

  /**
   * 显式停止的唯一终态写入点：只有驱动确认整组已停且观测到根进程退出，才记录实例结果并释放 service 租约；
   * 否则实例记为 indeterminate、租约保留，等待人工裁决（与 ProcessSupervisor 的 No premature release 一致）。
   */
  private finalizeStop(state: ServiceRuntimeState, stopRes: StopProcessResult, rootExited: boolean): void {
    const store = this.domain.getStore();
    const serviceLeaseHolder = `service:${state.serviceId}`;
    const pending = state.pendingInstanceResult;
    state.pendingInstanceResult = undefined;
    const confirmed = stopRes.stopped === 'confirmed_stopped' && rootExited && pending !== undefined;
    const now = new Date().toISOString();

    if (confirmed) {
      const failed = state.failureReason !== undefined;
      // 与 ProcessSupervisor 的取消语义一致：显式停止的实例记为 cancelled（被信号终止不是"失败"），
      // readiness 超时等内核判定的失败记为 failed
      const finalResult: ProcessOperationResult = failed
        ? { ...pending!, status: 'failed' }
        : { ...pending!, status: 'cancelled', terminationReason: 'user_cancelled' };
      store.recordOperationResult(state.currentOpId, finalResult);
      state.status = failed ? 'failed' : 'stopped';
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: failed ? 'SERVICE_FAILED' : 'SERVICE_STOPPED',
        payload: {
          serviceId: state.serviceId,
          runId: state.runId,
          reason: failed ? state.failureReason : 'stopped',
        },
        timestamp: now,
      });
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
    } else {
      const op = store.getOperation(state.currentOpId);
      if (op && op.status !== 'done') {
        const indetResult: IndeterminateResult = {
          kind: 'indeterminate',
          status: 'indeterminate',
          reason: `Service "${state.serviceId}" instance ${state.currentOpId} stop could not be confirmed (driver: ${stopRes.stopped}, rootExited: ${rootExited})${stopRes.errorDetails ? `: ${stopRes.errorDetails}` : ''}`,
          recoveryGuidance: 'Inspect residual processes manually, then adjudicate the instance operation before releasing the service leases.',
          durationMs: Date.now() - state.instanceStartedAt,
          completedAt: now,
        };
        store.recordOperationResult(state.currentOpId, indetResult, false);
      }
      state.status = 'failed';
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_FAILED',
        payload: {
          serviceId: state.serviceId,
          runId: state.runId,
          reason: 'stop_unconfirmed',
          stopped: stopRes.stopped,
          rootExited,
          ...(stopRes.residualPids ? { residualPids: stopRes.residualPids } : {}),
        },
        timestamp: now,
      });
      // 租约保留在 service 名下，不释放
    }

    state.stdoutStream.end();
    state.stopResolve();
  }

  public close(): void {
    for (const state of this.activeServices.values()) {
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.status === 'starting' || state.status === 'running') {
        this.stopService(state.serviceId, 500).catch(() => {});
      }
    }
    this.activeServices.clear();
  }

  private computeServiceFingerprint(spec: ServiceSpec): string {
    const canonical = {
      serviceId: spec.serviceId,
      runId: spec.runId,
      command: computeInputFingerprint({
        opId: spec.serviceId, runId: spec.runId, name: spec.serviceId,
        command: spec.command, requiredResources: spec.requiredResources,
      }),
      readiness: typeof spec.readiness === 'object'
        ? { source: spec.readiness.stdoutLine.source, flags: spec.readiness.stdoutLine.flags, timeoutMs: spec.readiness.timeoutMs ?? null }
        : spec.readiness ?? 'spawned',
      restart: typeof spec.restart === 'object'
        ? { policy: spec.restart.policy, maxRestarts: spec.restart.maxRestarts, backoffMs: spec.restart.backoffMs }
        : spec.restart ?? 'never',
      maxStderrBytes: spec.maxStderrBytes ?? null,
      artifactsDir: spec.artifactsDir ?? null,
      graceMs: spec.graceMs ?? null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}

/**
 * The journal is an audit record on disk: env values, argument values and
 * stdin can carry credentials (`--api-key …`, `GITHUB_TOKEN=…`), so only their
 * shape is kept. `inputFingerprint` still identifies the exact command.
 */
function journalSafeCommand(command: ServiceSpec['command']): Record<string, unknown> {
  return {
    execPath: command.execPath,
    cwd: command.cwd,
    argCount: command.args.length,
    envKeys: command.envWhiteList ? Object.keys(command.envWhiteList).sort() : undefined,
    inheritEnv: command.inheritEnv,
    hasStdin: command.stdin !== undefined,
  };
}
