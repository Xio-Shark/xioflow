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
  ProcessOperationResult,
  IndeterminateResult,
  KernelRunStatus,
  TerminationReason,
  ResourceBudget,
  UnsupportedCapabilityError,
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
}

export class ProcessSupervisor {
  private activeOperations: Map<
    string,
    {
      handle: ManagedProcessHandle;
      command: StructuredCommand;
      cancelRequested: boolean;
      timedOut: boolean;
      terminationReason?: TerminationReason;
      stopPromise?: Promise<StopProcessResult>;
    }
  > = new Map();

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

    // 1. [资源分配与排队等待]
    await this.domain.allocateResourcesWithWait(
      options.opId,
      options.requiredResources,
      options.waitTimeoutMs ?? 0,
      options.resourceBudget
    );

    // 2. [启动协议步骤 1] 写入 SQLite (status: intent_registered)
    try {
      this.domain.getStore().registerOperationIntent(op, this.domain.domainId);
    } catch (err) {
      this.domain.releaseResources(options.opId, options.requiredResources);
      throw err;
    }

    let handle: ManagedProcessHandle;
    try {
      // 3. [启动协议步骤 2] 请求平台驱动启动
      handle = await this.driver.spawn(options.command);
    } catch (spawnError: any) {
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
      this.domain.getStore().recordOperationResult(options.opId, failResult, true);
      this.domain.releaseResources(options.opId, options.requiredResources);
      return failResult;
    }

    // 4. [启动协议步骤 3] 登记执行身份，状态推进为 active
    this.domain.getStore().updateOperationStatus(options.opId, 'active', handle.identity);

    const opState = {
      handle,
      command: options.command,
      cancelRequested: false,
      timedOut: false,
      terminationReason: undefined as TerminationReason | undefined,
      stopPromise: undefined as Promise<StopProcessResult> | undefined,
    };
    this.activeOperations.set(options.opId, opState);

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

    const stdoutDrainer = this.setupStreamDrainer(handle.stdout, maxBytes, stdoutSpillPath, onChunk);
    const stderrDrainer = this.setupStreamDrainer(handle.stderr, maxBytes, stderrSpillPath, onChunk);

    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeoutPromise =
      options.timeoutMs && options.timeoutMs > 0
        ? new Promise<'timeout'>((resolve) => {
            timeoutTimer = setTimeout(() => resolve('timeout'), options.timeoutMs);
          })
        : new Promise<'timeout'>(() => {});

    // Soft / Observe 模式资源采样治理
    let peakMemoryBytes = 0;
    let peakCpuTimeMs = 0;
    let samplingInterval: NodeJS.Timeout | null = null;
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

    try {
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
        await this.handleStopPipeline(options.opId, 'timed_out', 1500);
        exitResult = await handle.onExit;
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
          this.domain.getStore().recordOperationResult(options.opId, indetResult, false);
          this.domain.getStore().updateRunStatus(options.runId, 'indeterminate', 'crash_detected');
          return indetResult as unknown as ProcessOperationResult;
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
        await opState.stopPromise;
      }

      const existingOp = this.domain.getStore().getOperation(options.opId);
      if (existingOp && existingOp.status === 'done') {
        const storedResult = existingOp.result as unknown as { status?: string };
        if (storedResult?.status === 'indeterminate') {
          // 驱动无法确认停止：保留隔离事实与资源锁，绝不覆盖
          return existingOp.result as unknown as ProcessOperationResult;
        }
        // 内部停止流水线（超时 / 资源超限）会先写一份粗糙终态；这里用本次采集到的
        // 真实退出码、输出与耗时覆盖它，避免把已捕获的输出证据丢掉。
        this.domain.getStore().recordOperationResult(options.opId, result, true);
        return result;
      }

      // 6. [事务提交结果与释放资源]
      this.domain.getStore().recordOperationResult(options.opId, result, true);
      this.domain.releaseResources(options.opId, options.requiredResources);

      if (terminationReason && terminationReason !== 'completed') {
        this.domain.getStore().updateRunStatus(
          options.runId,
          finalStatus === 'cancelled' ? 'cancelled' : 'failed',
          terminationReason
        );
      }

      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (samplingInterval) clearInterval(samplingInterval);
      this.activeOperations.delete(options.opId);
    }
  }

  /**
   * 停止确认流水线 (Stopping Pipeline)
   */
  public async cancelOperation(opId: string, graceMs: number = 2000): Promise<StopProcessResult> {
    return this.handleStopPipeline(opId, 'user_cancelled', graceMs);
  }

  public async handleStopPipeline(
    opId: string,
    reason: TerminationReason,
    graceMs: number
  ): Promise<StopProcessResult> {
    const active = this.activeOperations.get(opId);
    if (!active) {
      return { stopped: true, scope: 'direct_child' };
    }

    if (active.stopPromise) {
      return active.stopPromise;
    }

    active.stopPromise = (async () => {
      if (this.domain.isClosed()) {
        return { stopped: true, scope: 'direct_child' };
      }

      if (reason === 'user_cancelled') {
        active.cancelRequested = true;
      }
      active.terminationReason = reason;

      // 1. 进入 stopping 中间态（保持排他资源锁定，阻断新操作）
      this.domain.getStore().updateOperationStatus(opId, 'stopping');

      // 2. 调用驱动停止流水线 (SIGINT -> grace -> SIGTERM -> SIGKILL)
      const stopResult = await this.driver.terminate(active.handle.identity, graceMs);

      if (stopResult.stopped) {
        // 3a. 驱动确认停止 -> 记录终态并安全释放资源
        const op = this.domain.getStore().getOperation(opId);
        if (op && op.status !== 'done') {
          const cancelResult: ProcessOperationResult = {
            kind: 'process',
            status: reason === 'user_cancelled' ? 'cancelled' : 'failed',
            exitCode: null,
            signal: 'SIGKILL',
            stdout: '',
            stderr: `Operation stopped via stopping pipeline (${reason})`,
            isTruncated: false,
            terminationReason: reason,
            identityVerification: 'not_original_process',
            durationMs: 0,
            completedAt: new Date().toISOString(),
          };
          this.domain.getStore().recordOperationResult(opId, cancelResult, true);
          this.domain.releaseResources(opId, op.requiredResources);
          this.domain.getStore().updateRunStatus(
            op.runId,
            reason === 'user_cancelled' ? 'cancelled' : 'failed',
            reason
          );
        }
      } else {
        // 3b. 驱动无法确认完全停止 -> 转入 indeterminate，绝对保留隔离屏障与锁！
        const op = this.domain.getStore().getOperation(opId);
        if (op && op.status !== 'done') {
          const indetResult = {
            kind: 'indeterminate' as const,
            status: 'indeterminate' as const,
            reason: `Process ${active.handle.identity.pid} could not be confirmed stopped: ${stopResult.errorDetails}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: 0,
            completedAt: new Date().toISOString(),
          };
          // 传递 releaseResources = false，绝对不释放锁
          this.domain.getStore().recordOperationResult(opId, indetResult, false);
          this.domain.getStore().updateRunStatus(op.runId, 'indeterminate', 'crash_detected');
        }
      }

      return stopResult;
    })();

    return active.stopPromise;
  }

  private setupStreamDrainer(
    stream: NodeJS.ReadableStream,
    maxBytes: number,
    spillFilePath?: string,
    onChunk?: (bytes: number) => void
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
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesSeen += buf.length;
        if (onChunk) {
          try {
            onChunk(buf.length);
          } catch {}
        }
        hash.update(buf);

        // 持续落盘转储全部流
        if (spillFd !== null) {
          try {
            fs.writeSync(spillFd, buf);
          } catch {}
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
