import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ExecutionDomain } from '../domain.js';
import { PlatformDriver, ManagedProcessHandle } from '../driver/types.js';
import {
  ServiceSpec,
  ServiceHandle,
  ReadyFact,
  Operation,
  ProcessOperationResult,
} from '../types.js';
import { ProcessSupervisor } from './supervisor.js';
import { setupStreamDrainer, StreamDrainer } from './drainer.js';

interface ServiceRuntimeState {
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
  stopPromise: Promise<void>;
  stopRequested: boolean;
  restartTimer: NodeJS.Timeout | null;
  instanceExitResolve?: (val: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  onInstanceExit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  handle: ServiceHandle;
}

export class ServiceSupervisor {
  private activeServices = new Map<string, ServiceRuntimeState>();

  constructor(
    private domain: ExecutionDomain,
    private driver: PlatformDriver,
    private supervisor: ProcessSupervisor
  ) {}

  public async startService(spec: ServiceSpec): Promise<ServiceHandle> {
    const existing = this.activeServices.get(spec.serviceId);
    if (existing) {
      if (existing.status === 'starting' || existing.status === 'running') {
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

    let stopResolve!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      stopResolve = resolve;
    });

    let instanceExitResolve!: (val: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
    const onInstanceExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      instanceExitResolve = resolve;
    });

    const state: ServiceRuntimeState = {
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
      stopPromise,
      stopRequested: false,
      restartTimer: null,
      instanceExitResolve,
      onInstanceExit,
      handle: null as any,
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
      state.status = 'failed';
      if (spec.requiredResources && spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, spec.requiredResources);
      }
      this.activeServices.delete(spec.serviceId);
      throw err;
    }

    return state.handle;
  }

  private async spawnInstance(state: ServiceRuntimeState, instanceIndex: number): Promise<void> {
    state.currentInstanceIndex = instanceIndex;
    state.currentOpId = `${state.serviceId}#${instanceIndex}`;

    // 更新 onInstanceExit 为当前实例的 promise
    state.onInstanceExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      state.instanceExitResolve = resolve;
    });

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
      status: 'intent_registered',
    };
    store.registerOperationIntent(op, this.domain.domainId);

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
            command: state.spec.command,
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
      try {
        fs.mkdirSync(state.spec.artifactsDir, { recursive: true });
      } catch {}
      stderrSpillPath = path.join(state.spec.artifactsDir, `${state.currentOpId}.stderr.log`);
    }
    const stderrDrainer = setupStreamDrainer(
      processHandle.stderr,
      maxStderrBytes,
      stderrSpillPath
    );
    state.currentStderrDrainer = stderrDrainer;

    // 8. 处理就绪探测 (仅在第 1 次启动时)
    if (instanceIndex === 1) {
      this.setupReadiness(state, processHandle);
    }

    // 9. 监听退出事件
    const exitPromise = processHandle.onRootExit ?? processHandle.onExit;
    exitPromise.then((exitResult) => {
      this.handleInstanceExit(state, instanceIndex, exitResult).catch(() => {});
    });
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
          state.status = 'failed';
          const err = new Error(`Service "${state.serviceId}" readiness check timed out after ${timeoutMs}ms`);
          state.readyReject(err);
          this.stopService(state.serviceId, 500).catch(() => {});
        }
      }, timeoutMs);
    }
  }

  private async handleInstanceExit(
    state: ServiceRuntimeState,
    instanceIndex: number,
    exitResult: { exitCode: number | null; signal: NodeJS.Signals | null }
  ): Promise<void> {
    state.instanceExitResolve?.(exitResult);

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
        durationMs: 0,
        completedAt: new Date().toISOString(),
        identityVerification: 'is_original_process',
        ...(stderrData?.spillError ? { spillError: stderrData.spillError, stderrSpillError: stderrData.spillError } : {}),
      };
      store.recordOperationResult(state.currentOpId, result);
    }

    // 1. 如果是显式请求停止
    if (state.stopRequested) {
      state.status = 'stopped';
      store.recordEventAndTransitionState({
        domainId: this.domain.domainId,
        runId: state.runId,
        operationId: state.currentOpId,
        type: 'SERVICE_STOPPED',
        payload: { serviceId: state.serviceId, runId: state.runId, reason: 'stopped' },
        timestamp: new Date().toISOString(),
      });
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
      state.stdoutStream.end();
      state.stopResolve();
      return;
    }

    // 2. 如果 domain 已关闭
    if (this.domain.isClosed()) {
      state.status = 'stopped';
      if (state.spec.requiredResources && state.spec.requiredResources.length > 0) {
        this.domain.internalReleaseResources(serviceLeaseHolder, state.spec.requiredResources);
      }
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
      state.restartTimer = setTimeout(async () => {
        state.restartTimer = null;
        if (state.stopRequested || this.domain.isClosed()) return;
        await this.spawnInstance(state, newInstanceIndex);
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
    }
  }

  public async stopService(serviceId: string, graceMs: number = 2000): Promise<void> {
    const state = this.activeServices.get(serviceId);
    if (!state) return;
    if (state.status === 'stopped' || state.status === 'failed') return state.stopPromise;

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
      try {
        await this.driver.terminate(state.currentProcessHandle.identity, graceMs);
      } catch {}
      await state.onInstanceExit;
    } else {
      state.status = 'stopped';
      state.stopResolve();
    }

    return state.stopPromise;
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
      execPath: spec.command.execPath,
      args: spec.command.args,
      cwd: spec.command.cwd,
      requiredResources: [...(spec.requiredResources || [])].sort(),
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}
