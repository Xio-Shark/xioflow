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
  KernelRunStatus,
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
}

export class ProcessSupervisor {
  private activeOperations: Map<
    string,
    {
      handle: ManagedProcessHandle;
      command: StructuredCommand;
      cancelRequested: boolean;
      timedOut: boolean;
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
   * 启动协议：先持久化意图 -> 请求驱动启动 -> 登记身份并转 active -> 监督运行 -> 记录结果
   */
  public async executeProcess(options: ExecuteProcessOptions): Promise<ProcessOperationResult> {
    const startTime = Date.now();
    const maxBytes = options.maxOutputBytes ?? 10 * 1024 * 1024; // 默认 10MB
    const drainTimeoutMs = options.drainTimeoutMs ?? 2000;      // 默认 2000ms

    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'process',
      name: options.name,
      inputFingerprint: options.inputFingerprint || `${options.command.execPath}:${options.command.args.join(' ')}`,
      requiredResources: options.requiredResources,
      timeoutMs: options.timeoutMs,
      status: 'pending',
    };

    // 1. [启动协议步骤 1] 登记意图与占用资源，写入 SQLite (status: intent_registered)
    this.domain.registerOperationIntent(op);

    let handle: ManagedProcessHandle;
    try {
      // 2. [启动协议步骤 2] 请求平台驱动启动
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
        isTruncated: false,
        identityVerification: 'not_original_process',
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };
      this.domain.getStore().recordOperationResult(options.opId, failResult, true);
      this.domain.releaseResources(options.opId, options.requiredResources);
      return failResult;
    }

    // 3. [启动协议步骤 3] 登记执行身份，状态推进为 active
    this.domain.getStore().updateOperationStatus(options.opId, 'active', handle.identity);

    const opState = {
      handle,
      command: options.command,
      cancelRequested: false,
      timedOut: false,
    };
    this.activeOperations.set(options.opId, opState);

    // 4. [正常监督与有界排空]
    const stdoutDrainer = this.setupStreamDrainer(handle.stdout, maxBytes);
    const stderrDrainer = this.setupStreamDrainer(handle.stderr, maxBytes);

    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeoutPromise =
      options.timeoutMs && options.timeoutMs > 0
        ? new Promise<'timeout'>((resolve) => {
            timeoutTimer = setTimeout(() => resolve('timeout'), options.timeoutMs);
          })
        : new Promise<'timeout'>(() => {});

    try {
      // 等待底层退出或超时触发
      const exitOrTimeout = await Promise.race([
        handle.onExit.then((res) => ({ type: 'exit' as const, res })),
        timeoutPromise.then((type) => ({ type, res: null })),
      ]);

      if (timeoutTimer) clearTimeout(timeoutTimer);

      let exitResult: { exitCode: number | null; signal: NodeJS.Signals | null };

      if (exitOrTimeout.type === 'timeout') {
        opState.timedOut = true;
        await this.handleStopPipeline(options.opId, 'timed_out', 1500);
        exitResult = await handle.onExit;
      } else {
        exitResult = exitOrTimeout.res!;
      }

      // 有界等待流排空
      await Promise.race([
        Promise.all([stdoutDrainer.finishPromise, stderrDrainer.finishPromise]),
        new Promise((resolve) => setTimeout(resolve, drainTimeoutMs)),
      ]);

      const stdoutData = stdoutDrainer.getResult();
      const stderrData = stderrDrainer.getResult();
      const isTruncated = stdoutData.isTruncated || stderrData.isTruncated;

      // 校验进程身份
      const idVerify = await this.driver.verifyIdentity(handle.identity);

      const isSucceeded = exitResult.exitCode === 0 && !opState.timedOut && !opState.cancelRequested;
      const finalStatus = opState.timedOut
        ? 'failed'
        : opState.cancelRequested
        ? 'cancelled'
        : isSucceeded
        ? 'succeeded'
        : 'failed';

      const result: ProcessOperationResult = {
        kind: 'process',
        status: finalStatus,
        exitCode: exitResult.exitCode,
        signal: exitResult.signal,
        stdout: stdoutData.content,
        stderr: stderrData.content,
        isTruncated,
        identityVerification: idVerify,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };

      const existingOp = this.domain.getStore().getOperation(options.opId);
      if (existingOp && existingOp.status === 'done') {
        if (existingOp.result?.status === 'indeterminate') {
          // 关键红线：已进入 indeterminate 状态时，严禁覆盖结果或释放资源锁
          return existingOp.result as ProcessOperationResult;
        }
      }

      // 5. [事务提交结果与释放资源]
      this.domain.getStore().recordOperationResult(options.opId, result, true);
      this.domain.releaseResources(options.opId, options.requiredResources);

      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.activeOperations.delete(options.opId);
    }
  }

  /**
   * 停止确认流水线 (Stopping Pipeline)
   */
  public async cancelOperation(opId: string, graceMs: number = 2000): Promise<StopProcessResult> {
    return this.handleStopPipeline(opId, 'user_cancelled', graceMs);
  }

  private async handleStopPipeline(
    opId: string,
    reason: 'user_cancelled' | 'timed_out',
    graceMs: number
  ): Promise<StopProcessResult> {
    const active = this.activeOperations.get(opId);
    if (!active) {
      return { stopped: true, scope: 'direct_child' };
    }

    if (this.domain.isClosed()) {
      return { stopped: true, scope: 'direct_child' };
    }

    if (reason === 'user_cancelled') {
      active.cancelRequested = true;
    }

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
          status: 'cancelled',
          exitCode: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: `Operation stopped via stopping pipeline (${reason})`,
          isTruncated: false,
          identityVerification: 'not_original_process',
          durationMs: 0,
          completedAt: new Date().toISOString(),
        };
        this.domain.getStore().recordOperationResult(opId, cancelResult, true);
        this.domain.releaseResources(opId, op.requiredResources);
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
      }
    }

    return stopResult;
  }

  private setupStreamDrainer(
    stream: NodeJS.ReadableStream,
    maxBytes: number
  ): { getResult: () => { content: string; isTruncated: boolean }; finishPromise: Promise<void> } {
    const chunks: Buffer[] = [];
    let currentBytes = 0;
    let isTruncated = false;

    const finishPromise = new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
          // 超过上限继续消费事件，排空底层管道缓冲
        }
      });

      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', () => resolve());
    });

    return {
      getResult: () => ({
        content: Buffer.concat(chunks).toString('utf8'),
        isTruncated,
      }),
      finishPromise,
    };
  }
}
