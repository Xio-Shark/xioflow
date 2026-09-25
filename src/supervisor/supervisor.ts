import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExecutionDomain } from '../domain.js';
import {
  PlatformDriver,
  StructuredCommand,
  ManagedProcessHandle,
  ProcessIdentity,
  StopProcessResult,
} from '../driver/types.js';
import {
  Operation,
  OperationResult,
  ProcessOperationResult,
  IndeterminateResult,
  KernelRunStatus,
  TerminationReason,
  ResourceBudget,
  UnsupportedCapabilityError,
  OperationNotActiveError,
} from '../types.js';

export interface ExecuteProcessOptions {
  runId: string;
  opId: string;
  name: string;
  command: StructuredCommand;
  requiredResources: string[];
  timeoutMs?: number;
  inputFingerprint?: string;
  maxOutputBytes?: number;
  drainTimeoutMs?: number;
  resourceBudget?: ResourceBudget;
  waitTimeoutMs?: number;
  artifactsDir?: string;
  /**
   * 流式投影：每个 stdout/stderr chunk 原样转发，不做缓冲或截断。
   * 回调抛错不会中断排空，首个错误以 result.streamCallbackError 记录。
   */
  onStreamChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
}

interface ActiveOperationState {
  opId: string;
  runId: string;
  phase: 'waiting_resources' | 'intent_registered' | 'spawning' | 'active' | 'stopping' | 'done';
  startTime: number;
  handle?: ManagedProcessHandle;
  command?: StructuredCommand;
  cancelRequested: boolean;
  cancelGraceMs?: number;
  timedOut: boolean;
  terminationReason?: TerminationReason;
  stopPromise?: Promise<StopProcessResult>;
  stopResolve?: (res: StopProcessResult) => void;
}

interface StreamDrainer {
  getResult: () => {
    content: string;
    isTruncated: boolean;
    outputRef?: string;
    outputHash?: string;
    bytesSeen: number;
  };
  finishPromise: Promise<void>;
  forceFinalize: () => void;
}

export class ProcessSupervisor {
  private activeOperations: Map<string, ActiveOperationState> = new Map();

  constructor(
    private readonly domain: ExecutionDomain,
    private readonly driver: PlatformDriver
  ) {}

  public getDomain(): ExecutionDomain {
    return this.domain;
  }

  public getDriver(): PlatformDriver {
    return this.driver;
  }

  /**
   * 启动协议：准入检查 -> 先持久化意图 -> 请求驱动启动 -> 登记身份并转 active -> 监督运行 -> 记录结果
   */
  public async executeProcess(options: ExecuteProcessOptions): Promise<ProcessOperationResult> {
    const startTime = Date.now();
    const maxBytes = options.maxOutputBytes ?? 10 * 1024 * 1024; // 默认 10MB
    const drainTimeoutMs = options.drainTimeoutMs ?? 2000;      // 默认 2000ms

    let stdoutDrainer: StreamDrainer | undefined;
    let stderrDrainer: StreamDrainer | undefined;

    // 0. [准入期强校验 Pre-admission Capability Check]
    if (options.resourceBudget?.enforcement === 'hard') {
      if (options.resourceBudget.maxMemoryBytes && !this.driver.capabilities.memoryHardLimit) {
        throw new UnsupportedCapabilityError('memoryHardLimit', this.driver.name, 'hard');
      }
      if (options.resourceBudget.maxPids && !this.driver.capabilities.pidsLimit) {
        throw new UnsupportedCapabilityError('pidsLimit', this.driver.name, 'hard');
      }
      if (options.resourceBudget.maxCpuTimeMs && !this.driver.capabilities.cpuLimit) {
        throw new UnsupportedCapabilityError('cpuLimit', this.driver.name, 'hard');
      }
    }

    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'process',
      name: options.name,
      inputFingerprint: options.inputFingerprint || `${options.command.execPath}:${options.command.args.join(' ')}`,
      requiredResources: options.requiredResources,
      timeoutMs: options.timeoutMs,
      resourceBudget: options.resourceBudget,
      status: 'pending',
    };

    const opState: ActiveOperationState = {
      opId: options.opId,
      runId: options.runId,
      phase: 'waiting_resources',
      startTime,
      cancelRequested: false,
      timedOut: false,
    };
    this.activeOperations.set(options.opId, opState);

    let timeoutTimer: NodeJS.Timeout | null = null;
    let samplingInterval: NodeJS.Timeout | null = null;

    try {
      // 1. [资源分配与排队等待]
      await this.domain.allocateResourcesWithWait(
        options.opId,
        options.requiredResources || [],
        options.waitTimeoutMs ?? 0,
        options.resourceBudget,
        () => opState.cancelRequested === true
      );

      if (opState.cancelRequested) {
        return this.handlePreSpawnCancellation(options, opState, startTime);
      }

      // 2. [启动协议步骤 1] 写入 SQLite (status: intent_registered)
      try {
        this.domain.getStore().registerOperationIntent(op, this.domain.domainId);
        opState.phase = 'intent_registered';
      } catch (err) {
        this.domain.releaseResources(options.opId, options.requiredResources);
        throw err;
      }

      if (opState.cancelRequested) {
        return this.handlePreSpawnCancellation(options, opState, startTime);
      }

      let handle: ManagedProcessHandle;
      opState.phase = 'spawning';
      try {
        // 3. [启动协议步骤 2] 请求平台驱动启动
        handle = await this.driver.spawn(options.command);
        opState.handle = handle;
        opState.command = options.command;
      } catch (spawnError: any) {
        opState.phase = 'done';
        opState.stopResolve?.({ stopped: true, scope: 'direct_child', errorDetails: spawnError?.message });
        opState.stopResolve = undefined;
        // 启动失败（如可执行文件不存在），不产生假运行状态，直接失败收尾并释放资源
        const failResult: ProcessOperationResult = {
          kind: 'process',
          status: 'failed',
          exitCode: 127,
          signal: null,
          stdout: '',
          stderr: spawnError?.message || String(spawnError),
          spawnFailure: spawnError?.message || String(spawnError),
          isTruncated: false,
          identityVerification: 'not_original_process',
          durationMs: Date.now() - startTime,
          completedAt: new Date().toISOString(),
        };
        return this.finalizeOperation(options.opId, failResult, options.requiredResources, true);
      }

      // 4. [启动协议步骤 3] 登记执行身份，状态推进为 active
      this.domain.getStore().updateOperationStatus(options.opId, 'active', handle.identity);
      opState.phase = 'active';

      // 准备 artifacts 溢出转储目录
      const artifactsDir = options.artifactsDir || path.join(this.domain.domainPath, 'artifacts');
      if (!fs.existsSync(artifactsDir)) {
        try {
          fs.mkdirSync(artifactsDir, { recursive: true });
        } catch {}
      }
      const stdoutSpillPath = path.join(artifactsDir, `${options.opId}-stdout.log`);
      const stderrSpillPath = path.join(artifactsDir, `${options.opId}-stderr.log`);

      // 5. [正常监督、有界排空与流式转储 (Spill to Artifacts)]
      let totalOutputBytes = 0;
      const onChunk = (bytes: number) => {
        totalOutputBytes += bytes;
        if (
          options.resourceBudget?.enforcement === 'soft' &&
          options.resourceBudget.maxOutputBytes &&
          totalOutputBytes > options.resourceBudget.maxOutputBytes &&
          !opState.terminationReason
        ) {
          opState.terminationReason = 'output_exceeded';
          this.handleStopPipeline(options.opId, 'output_exceeded', 1000).catch(() => {});
        }
      };

      let streamCallbackError: string | undefined;
      const forwardChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        if (!options.onStreamChunk) return;
        try {
          options.onStreamChunk(stream, chunk);
        } catch (err) {
          streamCallbackError ??= err instanceof Error ? err.message : String(err);
        }
      };
      stdoutDrainer = this.setupStreamDrainer(
        handle.stdout,
        maxBytes,
        stdoutSpillPath,
        onChunk,
        forwardChunk('stdout')
      );
      stderrDrainer = this.setupStreamDrainer(
        handle.stderr,
        maxBytes,
        stderrSpillPath,
        onChunk,
        forwardChunk('stderr')
      );

      // 检查在 spawn 途中是否已被请求取消：若已请求取消，立即触发停止流水线向底层发送终止信号
      if (opState.cancelRequested) {
        this.handleStopPipeline(options.opId, 'user_cancelled', opState.cancelGraceMs ?? 2000).catch(() => {});
      }

      const timeoutPromise =
        options.timeoutMs && options.timeoutMs > 0
          ? new Promise<'timeout'>((resolve) => {
              timeoutTimer = setTimeout(() => resolve('timeout'), options.timeoutMs);
            })
          : new Promise<'timeout'>(() => {});

      // Soft / Observe 模式资源采样治理
      let peakMemoryBytes = 0;
      let peakCpuTimeMs = 0;
      if (
        this.driver.sampleMetrics &&
        options.resourceBudget &&
        (options.resourceBudget.enforcement === 'soft' || options.resourceBudget.enforcement === 'observe')
      ) {
        samplingInterval = setInterval(async () => {
          try {
            const metrics = await this.driver.sampleMetrics!(handle.identity);
            peakMemoryBytes = Math.max(peakMemoryBytes, metrics.rssBytes);
            peakCpuTimeMs = Math.max(peakCpuTimeMs, metrics.cpuTimeMs);

            if (options.resourceBudget?.enforcement === 'soft') {
              if (options.resourceBudget.maxMemoryBytes && metrics.rssBytes > options.resourceBudget.maxMemoryBytes) {
                opState.terminationReason = 'memory_exceeded';
                if (samplingInterval) clearInterval(samplingInterval);
                await this.handleStopPipeline(options.opId, 'memory_exceeded', 1000);
              } else if (options.resourceBudget.maxCpuTimeMs && metrics.cpuTimeMs > options.resourceBudget.maxCpuTimeMs) {
                opState.terminationReason = 'cpu_exceeded';
                if (samplingInterval) clearInterval(samplingInterval);
                await this.handleStopPipeline(options.opId, 'cpu_exceeded', 1000);
              } else if (options.resourceBudget.maxPids && metrics.pidsCount > options.resourceBudget.maxPids) {
                opState.terminationReason = 'pids_exceeded';
                if (samplingInterval) clearInterval(samplingInterval);
                await this.handleStopPipeline(options.opId, 'pids_exceeded', 1000);
              }
            }
          } catch {}
        }, 100);
      }
      // 等待根进程退出或超时触发；有 onRootExit 时不等待持有管道的后代
      const rootExitPromise = handle.onRootExit ?? handle.onExit;
      const exitOrTimeout = await Promise.race([
        rootExitPromise.then((res) => ({ type: 'exit' as const, res })),
        timeoutPromise.then((type) => ({ type, res: null })),
      ]);

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (samplingInterval) clearInterval(samplingInterval);

      let exitResult: { exitCode: number | null; signal: NodeJS.Signals | null };

      if (exitOrTimeout.type === 'timeout') {
        opState.timedOut = true;
        opState.terminationReason = 'timed_out';
        const stopRes = await this.handleStopPipeline(options.opId, 'timed_out', 1500);

        // 超时路径：根进程已由停止流水线终止，等待根进程退出事实（避免被持有管道的逃逸后代挂死）
        // 关键防护（问题 4）：给等待根进程退出增加有界上限（1000ms），
        // 若驱动停止未确认（stopped: false）或根进程超出上限仍未退出，转入 indeterminate
        const rootExitWaitMs = 1000;
        const rootExitOrTimeout = await Promise.race([
          (handle.onRootExit ?? handle.onExit).then((res) => ({ exited: true as const, res })),
          new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), rootExitWaitMs)),
        ]);

        if (!stopRes.stopped || !rootExitOrTimeout.exited) {
          const stored = this.domain.getStore().getOperation(options.opId);
          if (stored && stored.status === 'done' && stored.result?.status === 'indeterminate') {
            return stored.result as unknown as ProcessOperationResult;
          }
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} timed out and root process could not be confirmed exited within ${rootExitWaitMs}ms bound: ${stopRes.errorDetails || 'root process still alive'}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }

        exitResult = rootExitOrTimeout.res;
      } else {
        exitResult = exitOrTimeout.res!;
      }

      // 有界等待流排空
      const drainPromise = Promise.all([stdoutDrainer.finishPromise, stderrDrainer.finishPromise]);
      const drainTimeoutPromise = new Promise((resolve) => setTimeout(resolve, drainTimeoutMs));

      let drained = await Promise.race([
        drainPromise.then(() => true),
        drainTimeoutPromise.then(() => false),
      ]);

      // 排空超时说明根进程已退出但仍有后代持有管道：回收整个进程组，
      // 否则操作会一直挂到超时，且 root 的真实退出事实会被超时掩盖。
      let residualProcessesReaped = false;
      if (!drained && exitOrTimeout.type === 'exit') {
        const reapResult = await this.driver.terminate(handle.identity, 1500);
        if (!reapResult.stopped) {
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} exited but residual descendants could not be confirmed stopped: ${reapResult.errorDetails}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }
        residualProcessesReaped = true;
        // 被杀死的后代释放管道后，给排空最后一次机会
        drained = await Promise.race([
          drainPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
        ]);
      }

      if (!drained) {
        // 排空超时路径强制调用 fsyncSync + closeSync 结清刷盘
        stdoutDrainer.forceFinalize();
        stderrDrainer.forceFinalize();
      }

      const stdoutData = stdoutDrainer.getResult();
      const stderrData = stderrDrainer.getResult();
      const isTruncated = stdoutData.isTruncated || stderrData.isTruncated;
      const outputRef = stdoutData.outputRef || stderrData.outputRef;
      const outputHash = stdoutData.outputHash || stderrData.outputHash;

      // 校验进程身份
      const idVerify = await this.driver.verifyIdentity(handle.identity);

      const isResourceOrTimeoutStopped =
        opState.timedOut ||
        opState.terminationReason === 'memory_exceeded' ||
        opState.terminationReason === 'cpu_exceeded' ||
        opState.terminationReason === 'pids_exceeded' ||
        opState.terminationReason === 'output_exceeded';

      const isSucceeded =
        exitResult.exitCode === 0 &&
        !isResourceOrTimeoutStopped &&
        !opState.cancelRequested;

      const finalStatus = isResourceOrTimeoutStopped
        ? 'failed'
        : opState.cancelRequested
        ? 'cancelled'
        : isSucceeded
        ? 'succeeded'
        : 'failed';

      const terminationReason =
        opState.terminationReason || (finalStatus === 'succeeded' ? 'completed' : undefined);

      const result: ProcessOperationResult = {
        kind: 'process',
        status: finalStatus,
        exitCode: exitResult.exitCode,
        signal: exitResult.signal,
        stdout: stdoutData.content,
        stderr: stderrData.content,
        isTruncated,
        stdoutTruncated: stdoutData.isTruncated,
        stderrTruncated: stderrData.isTruncated,
        stdoutRef: stdoutData.outputRef,
        stderrRef: stderrData.outputRef,
        stdoutBytes: stdoutData.bytesSeen,
        stderrBytes: stderrData.bytesSeen,
        stdoutHash: stdoutData.outputHash,
        stderrHash: stderrData.outputHash,
        ...(residualProcessesReaped ? { residualProcessesReaped: true } : {}),
        ...(streamCallbackError ? { streamCallbackError } : {}),
        outputRef,
        outputHash,
        terminationReason,
        peakMemoryBytes,
        cpuTimeMs: peakCpuTimeMs,
        identityVerification: idVerify,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };

      if (opState.stopPromise) {
        const stopRes = await opState.stopPromise;
        if (!stopRes.stopped) {
          const stored = this.domain.getStore().getOperation(options.opId);
          if (stored && stored.status === 'done') {
            return (stored.result ?? null) as unknown as ProcessOperationResult;
          }
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} was cancelled or stopped but could not be confirmed: ${stopRes.errorDetails || 'residual processes still alive'}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }
      }

      // 6. [事务提交结果与释放资源 - Single Writer]
      // 统一由 finalizeOperation 写入事实与处理资源
      return this.finalizeOperation(options.opId, result, options.requiredResources, true);
    } finally {
      stdoutDrainer?.forceFinalize();
      stderrDrainer?.forceFinalize();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (samplingInterval) clearInterval(samplingInterval);
      if (opState.stopResolve) {
        const resolveFn = opState.stopResolve;
        opState.stopResolve = undefined;
        resolveFn({
          stopped: true,
          scope: 'direct_child',
          errorDetails: opState.phase === 'done' ? undefined : 'Operation terminated before process activation',
        });
      }
      this.activeOperations.delete(options.opId);
    }
  }

  /**
   * 停止确认流水线 (Stopping Pipeline)
   */
  public async cancelOperation(opId: string, graceMs: number = 2000): Promise<StopProcessResult> {
    const active = this.ensureActiveOperation(opId);
    active.cancelRequested = true;
    if (active.cancelGraceMs === undefined) {
      active.cancelGraceMs = graceMs;
    }
    active.terminationReason = 'user_cancelled';

    if (active.phase === 'active' || active.phase === 'stopping') {
      return this.handleStopPipeline(opId, 'user_cancelled', graceMs);
    }

    // 操作仍在等资源、intent_registered 或 spawn 途中，返回已有的或新建的 stopPromise
    if (!active.stopPromise) {
      active.stopPromise = new Promise((resolve) => {
        active.stopResolve = resolve;
      });
    }
    return active.stopPromise;
  }

  public async handleStopPipeline(
    opId: string,
    reason: TerminationReason,
    graceMs: number
  ): Promise<StopProcessResult> {
    const active = this.ensureActiveOperation(opId);

    if (active.phase === 'stopping' && active.stopPromise) {
      return active.stopPromise;
    }

    active.phase = 'stopping';
    if (reason === 'user_cancelled') {
      active.cancelRequested = true;
    }
    active.terminationReason = reason;

    const existingResolve = active.stopResolve;
    const runPipeline = (async () => {
      if (!active.handle) {
        const res: StopProcessResult = { stopped: true, scope: 'direct_child' };
        existingResolve?.(res);
        return res;
      }

      // 1. 进入 stopping 中间态（保持排他资源锁定，阻断新操作）
      this.domain.getStore().updateOperationStatus(opId, 'stopping');

      // 2. 调用驱动停止流水线 (SIGINT -> grace -> SIGTERM -> SIGKILL)
      const stopResult = await this.driver.terminate(active.handle.identity, graceMs);

      // 3. 驱动无法确认停止 -> 立即转入 indeterminate，绝对保留隔离屏障与锁！
      if (!stopResult.stopped) {
        const op = this.domain.getStore().getOperation(opId);
        if (op && op.status !== 'done') {
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${active.handle.identity.pid} could not be confirmed stopped: ${stopResult.errorDetails}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - active.startTime,
            completedAt: new Date().toISOString(),
          };
          this.finalizeOperation(opId, indetResult, undefined, false);
        }
      }

      existingResolve?.(stopResult);
      return stopResult;
    })();

    active.stopPromise = runPipeline;
    return runPipeline;
  }

  private ensureActiveOperation(opId: string): ActiveOperationState {
    if (this.domain.isClosed()) {
      throw new OperationNotActiveError(opId, 'domain_closed');
    }

    const active = this.activeOperations.get(opId);
    if (!active || active.phase === 'done') {
      const stored = this.domain.getStore().getOperation(opId);
      if (!stored) {
        throw new OperationNotActiveError(opId, 'not_found');
      }
      if (stored.status === 'done') {
        throw new OperationNotActiveError(opId, 'already_completed');
      }
      throw new OperationNotActiveError(
        opId,
        'not_found',
        `Operation "${opId}" is not active (current status: ${stored.status}).`
      );
    }

    return active;
  }

  private handlePreSpawnCancellation(
    options: ExecuteProcessOptions,
    opState: ActiveOperationState,
    startTime: number
  ): ProcessOperationResult {
    opState.phase = 'done';
    const stopRes: StopProcessResult = { stopped: true, scope: 'direct_child' };
    opState.stopResolve?.(stopRes);
    opState.stopResolve = undefined;

    const cancelResult: ProcessOperationResult = {
      kind: 'process',
      status: 'cancelled',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      isTruncated: false,
      terminationReason: 'user_cancelled',
      evidence: 'unobserved',
      identityVerification: 'not_original_process',
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };

    const stored = this.domain.getStore().getOperation(options.opId);
    if (!stored) {
      // 此时操作是在 waiting_resources 阶段就被取消，尚未获取资源租约，亦未正常注册意图。
      // 为保证 store 中有该操作记录以便写入 cancelled 结果，直接记录预意图取消操作，
      // 绝不向 resource_leases 写入虚假租约，亦不产生虚假的 OPERATION_INTENT_REGISTERED 事件。
      const op: Operation = {
        id: options.opId,
        runId: options.runId,
        kind: 'process',
        name: options.name,
        inputFingerprint: options.inputFingerprint || 'fingerprint-pre-spawn-cancelled',
        requiredResources: options.requiredResources || [],
        status: 'done',
      };
      this.domain.getStore().recordPreIntentCancelledOperation(op, this.domain.domainId, cancelResult);
      return cancelResult;
    }

    return this.finalizeOperation(options.opId, cancelResult, options.requiredResources, true);
  }

  private finalizeOperation(
    opId: string,
    result: OperationResult,
    requiredResources?: string[],
    releaseResourceLock: boolean = true
  ): ProcessOperationResult {
    const existing = this.domain.getStore().getOperation(opId);
    if (existing && existing.status === 'done') {
      throw new Error(
        `Cannot finalize operation "${opId}": operation is already finalized with status "${existing.status}"`
      );
    }

    if (result.status === 'indeterminate') {
      this.domain.getStore().recordOperationResult(opId, result, false);
      const op = this.domain.getStore().getOperation(opId);
      if (op) {
        const termReason = (result as any).terminationReason as TerminationReason | undefined;
        this.domain.getStore().updateRunStatus(op.runId, 'indeterminate', termReason);
      }
    } else {
      this.domain.getStore().recordOperationResult(opId, result, true);
      if (releaseResourceLock && requiredResources && requiredResources.length > 0) {
        this.domain.releaseResources(opId, requiredResources);
      }
    }
    return result as ProcessOperationResult;
  }

  private setupStreamDrainer(
    stream: NodeJS.ReadableStream,
    maxBytes: number,
    spillFilePath?: string,
    onChunk?: (bytes: number) => void,
    onData?: (chunk: Buffer) => void
  ): {
    getResult: () => {
      content: string;
      isTruncated: boolean;
      outputRef?: string;
      outputHash?: string;
      bytesSeen: number;
    };
    finishPromise: Promise<void>;
    forceFinalize: () => void;
  } {
    const chunks: Buffer[] = [];
    let currentBytes = 0;
    let bytesSeen = 0;
    let isTruncated = false;
    let spillFd: number | null = null;
    const hash = crypto.createHash('sha256');
    let isFinalized = false;
    let outputHash: string | undefined = undefined;

    if (spillFilePath) {
      try {
        spillFd = fs.openSync(spillFilePath, 'w');
      } catch {}
    }

    const doFinalize = () => {
      if (isFinalized) return;
      isFinalized = true;
      if (spillFd !== null) {
        try {
          fs.fsyncSync(spillFd);
          fs.closeSync(spillFd);
        } catch {}
        spillFd = null;
      }
      try {
        outputHash = hash.digest('hex');
      } catch {}
    };

    const finishPromise = new Promise<void>((resolve) => {
      const finalize = () => {
        doFinalize();
        resolve();
      };

      stream.on('data', (chunk: Buffer | string) => {
        if (isFinalized) {
          // finalize 之后，流继续读走数据避免堵塞或 SIGPIPE，但跳过 hash、落盘和转发
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesSeen += buf.length;
        if (onChunk) {
          try {
            onChunk(buf.length);
          } catch {}
        }
        try {
          hash.update(buf);
        } catch {}

        // 持续落盘转储全部流
        if (spillFd !== null) {
          try {
            fs.writeSync(spillFd, buf);
          } catch {}
        }

        if (onData) {
          onData(buf);
        }

        // 内存有界保留
        if (currentBytes + buf.length <= maxBytes) {
          chunks.push(buf);
          currentBytes += buf.length;
        } else {
          if (!isTruncated) {
            const remaining = maxBytes - currentBytes;
            if (remaining > 0) {
              chunks.push(buf.subarray(0, remaining));
              currentBytes += remaining;
            }
            isTruncated = true;
          }
        }
      });

      stream.on('end', finalize);
      stream.on('close', finalize);
      stream.on('error', finalize);
    });

    return {
      getResult: () => {
        doFinalize();
        return {
          content: Buffer.concat(chunks).toString('utf8'),
          isTruncated,
          outputRef: isTruncated && spillFilePath ? spillFilePath : undefined,
          outputHash,
          bytesSeen,
        };
      },
      finishPromise,
      forceFinalize: doFinalize,
    };
  }
}
