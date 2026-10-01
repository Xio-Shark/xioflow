import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { PlatformDriver, StopProcessResult } from '../driver/types.js';
import {
  Operation,
  OperationResult,
  ProcessOperationResult,
  TerminationReason,
  OperationNotActiveError,
  ServiceSpec,
  ServiceHandle,
  SnapshotDriver,
  SnapshotOperationResult,
  RollbackOperationResult,
  ConfinementDriver,
} from '../types.js';
import { NodePlatformDriver } from '../driver/node-driver.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { ServiceSupervisor } from './service.js';
import {
  admitProcessScope,
  assertHardBudgetSupported,
  assertRunAcceptsOperations,
  resolveConfinementDriver,
} from './admission.js';
import { computeInputFingerprint } from './fingerprint.js';
import { finalizeOperation, indeterminateResult } from './finalize.js';
import { joinInFlight, replayRecorded } from './replay.js';
import { runProcess, ProcessRunContext } from './process-run.js';
import * as snapshotOps from './snapshot-ops.js';
import { rollback } from './rollback.js';
import {
  CommitOptions,
  CommitResult,
  TransactionEffects,
  WorkspaceTransaction,
  WorkspaceTransactions,
} from '../workspace/transactions.js';
import {
  ActiveOperationState,
  CaptureSnapshotOptions,
  ExecuteProcessOptions,
  RollbackOptions,
  StreamSubscriber,
} from './types.js';

export type { ExecuteProcessOptions, CaptureSnapshotOptions, RollbackOptions } from './types.js';
export { normalizeResourceName, computeInputFingerprint } from './fingerprint.js';

export class ProcessSupervisor {
  private activeOperations: Map<string, ActiveOperationState> = new Map();
  private serviceSupervisor: ServiceSupervisor;
  private snapshotDriver: SnapshotDriver;
  private confinementDriver?: ConfinementDriver;
  private transactions?: WorkspaceTransactions;

  constructor(
    private readonly domain: ExecutionDomain,
    private readonly driver: PlatformDriver = domain.getDriver?.() || new NodePlatformDriver(),
    snapshotDriver?: SnapshotDriver,
    confinementDriver?: ConfinementDriver
  ) {
    this.domain.setDriver?.(driver);
    this.serviceSupervisor = new ServiceSupervisor(domain, driver, this);
    this.snapshotDriver = snapshotDriver || new GitShadowSnapshotDriver();
    this.confinementDriver = confinementDriver;
    this.domain.setSnapshotDriver?.(this.snapshotDriver);
  }

  public getDomain(): ExecutionDomain {
    return this.domain;
  }

  public getDriver(): PlatformDriver {
    return this.driver;
  }

  public getSnapshotDriver(): SnapshotDriver {
    return this.snapshotDriver;
  }

  public setConfinementDriver(driver: ConfinementDriver): void {
    this.confinementDriver = driver;
  }

  public getConfinementDriver(): ConfinementDriver | undefined {
    return this.confinementDriver;
  }

  public async startService(spec: ServiceSpec): Promise<ServiceHandle> {
    return this.serviceSupervisor.startService(spec);
  }

  private get snapshotContext(): snapshotOps.SnapshotContext {
    return { domain: this.domain, snapshotDriver: this.snapshotDriver };
  }

  /**
   * 快照捕获协议 (ARCHITECTURE §3.5 / 契约 #32, #53)
   */
  public async captureSnapshot(options: CaptureSnapshotOptions): Promise<SnapshotOperationResult> {
    return snapshotOps.captureSnapshot(this.snapshotContext, options);
  }

  /**
   * 回滚协议 (ARCHITECTURE §3.5 / 契约 #28–#30, #56)
   */
  public async rollback(options: RollbackOptions): Promise<RollbackOperationResult> {
    return rollback(this.snapshotContext, options);
  }

  /**
   * 分叉工作区 Materialize (ARCHITECTURE §3.5 / 契约 #54)
   */
  public async materialize(snapshotId: string, newRoot: string): Promise<{ worktreePath: string }> {
    return snapshotOps.materialize(this.snapshotContext, snapshotId, newRoot);
  }

  /**
   * 回收分叉工作区 Dematerialize (ARCHITECTURE §3.5 / 契约 #54)
   */
  public async dematerialize(newRoot: string, options?: { force?: boolean }): Promise<void> {
    return snapshotOps.dematerialize(this.snapshotContext, newRoot, options);
  }

  /**
   * 回收快照：删除驱动侧的私有 ref 与 store 记录，并写 SNAPSHOT_PRUNED。
   * 宿主按自己的保留策略调用（例如每轮只保留会话基线与当前轮检查点），否则快照 ref 会无限累积。
   * 未知 id 视为已回收（幂等）；驱动删除失败直接抛出，store 记录保留，便于重试。
   */
  public async pruneSnapshots(snapshotIds: string[], options?: { runId?: string }): Promise<string[]> {
    return snapshotOps.pruneSnapshots(this.snapshotContext, snapshotIds, options);
  }

  /**
   * 工作区事务（ARCHITECTURE §3.9）：在主工作区的基线快照上 materialize 出独立 fork，
   * agent 以 `forkRoot` 为 cwd 工作；commit 时按读写集做乐观并发校验，无冲突才把写集应用回主工作区。
   */
  public async beginWorkspaceTransaction(options: {
    txId: string;
    runId: string;
    root: string;
    forkPath: string;
  }): Promise<WorkspaceTransaction> {
    return this.workspaceTransactions().begin(options);
  }

  public async inspectWorkspaceTransaction(txId: string): Promise<TransactionEffects> {
    return this.workspaceTransactions().inspect(txId);
  }

  public async commitWorkspaceTransaction(txId: string, options?: CommitOptions): Promise<CommitResult> {
    return this.workspaceTransactions().commit(txId, options);
  }

  public async abortWorkspaceTransaction(txId: string, reason?: string): Promise<void> {
    return this.workspaceTransactions().abort(txId, reason);
  }

  private workspaceTransactions(): WorkspaceTransactions {
    if (this.transactions) return this.transactions;
    const snapshotDriver = this.snapshotDriver;
    if (!(snapshotDriver instanceof GitShadowSnapshotDriver)) {
      throw new Error(`Workspace transactions need the git-shadow snapshot driver (got ${snapshotDriver.name})`);
    }
    this.transactions = new WorkspaceTransactions({
      domain: this.domain,
      snapshotDriver,
      captureSnapshot: async (runId, opId, root) => {
        const res = await this.captureSnapshot({ runId, opId, roots: [root] });
        if (res.status !== 'succeeded' || !res.snapshot) {
          throw new Error(`Base snapshot for ${opId} failed: ${res.errorMessage ?? res.status}`);
        }
        return res.snapshot;
      },
      materialize: async (snapshotId, forkPath) => {
        await this.materialize(snapshotId, forkPath);
        // 租约移交：materialize 以独占租约保留 fork（§3.5）；事务接管 fork 后释放它，
        // fork 内 agent 操作之间的互斥由各自声明的 workspace:write:<fork> 保证。
        for (const res of new Set([`workspace:write:${path.resolve(forkPath)}`, `workspace:write:${fs.realpathSync(forkPath)}`])) {
          const owner = this.domain.getResourceOwner(res);
          if (owner?.startsWith('mat-')) this.domain.internalReleaseResources(owner, [res]);
        }
      },
      dematerialize: (forkPath) => this.dematerialize(forkPath, { force: true }),
      pruneSnapshot: async (snapshotId, runId) => {
        await this.pruneSnapshots([snapshotId], { runId });
      },
    });
    return this.transactions;
  }

  /**
   * 启动协议：准入检查 -> 先持久化意图 -> 请求驱动启动 -> 登记身份并转 active -> 监督运行 -> 记录结果
   */
  public async executeProcess(options: ExecuteProcessOptions): Promise<ProcessOperationResult> {
    // 0. 准入：capability 范围、写入限制、hard 预算能力、调用 Run 状态
    const { mutationRoots, capAdmission } = admitProcessScope(this.domain, options);
    const confinementDriver = resolveConfinementDriver(options, this.confinementDriver);
    const command = confinementDriver ? confinementDriver.wrap(options.command, mutationRoots || []) : options.command;
    const startTime = Date.now();
    assertHardBudgetSupported(this.driver, options.resourceBudget);
    const inputFingerprint = options.inputFingerprint || computeInputFingerprint(options);
    assertRunAcceptsOperations(this.domain, options.runId, options.opId);

    // 1–2. 幂等重放（ARCHITECTURE §3.7）：在飞加入，已持久化原样返回
    const inFlight = this.activeOperations.get(options.opId);
    if (inFlight) {
      return joinInFlight(this.domain, inFlight, options, inputFingerprint);
    }
    const replayed = replayRecorded(this.domain, options, inputFingerprint);
    if (replayed) {
      return replayed;
    }

    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'process',
      name: options.name,
      inputFingerprint,
      requiredResources: options.requiredResources || [],
      mutationRoots,
      capabilityId: options.capabilityId,
      timeoutMs: options.timeoutMs,
      resourceBudget: options.resourceBudget,
      status: 'pending',
    };
    const opState = this.trackOperation(options, inputFingerprint, startTime);
    const executionPromise = runProcess(this.runContext, {
      options,
      op,
      opState,
      command,
      confined: confinementDriver !== undefined,
      confinementDriverName: confinementDriver?.name,
      capAdmission,
    });
    opState.resultPromise = executionPromise;
    return await executionPromise;
  }

  private get runContext(): ProcessRunContext {
    return {
      domain: this.domain,
      driver: this.driver,
      stop: (opId, reason, graceMs) => this.handleStopPipeline(opId, reason, graceMs),
      forget: (opId) => {
        this.activeOperations.delete(opId);
      },
    };
  }

  /** 登记在飞状态；abortSignal 触发即走取消流水线（已中止则在启动前取消）。 */
  private trackOperation(options: ExecuteProcessOptions, inputFingerprint: string, startTime: number): ActiveOperationState {
    const streamSubscribers = new Set<StreamSubscriber>();
    if (options.onStreamChunk) {
      streamSubscribers.add(options.onStreamChunk);
    }
    const opState: ActiveOperationState = {
      opId: options.opId,
      runId: options.runId,
      phase: 'waiting_resources',
      startTime,
      inputFingerprint,
      streamSubscribers,
      cancelRequested: false,
      timedOut: false,
    };
    this.activeOperations.set(options.opId, opState);

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        opState.cancelRequested = true;
      } else {
        const onAbort = () => {
          this.cancelOperation(options.opId).catch(() => {});
        };
        options.abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }
    return opState;
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

    // 若操作仍在等待队列中排队，立刻唤醒
    this.domain.cancelWait(opId);

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
        const res: StopProcessResult = { stopped: 'confirmed_stopped', scope: 'direct_child' };
        existingResolve?.(res);
        return res;
      }

      // 1. 进入 stopping 中间态（保持排他资源锁定，阻断新操作）
      this.domain.getStore().updateOperationStatus(opId, 'stopping');

      // 2. 调用驱动停止流水线 (SIGINT -> grace -> SIGTERM -> SIGKILL)
      const stopResult = await this.driver.terminate(active.handle.identity, graceMs);

      // 3. 驱动无法确认停止 -> 立即转入 indeterminate，绝对保留隔离屏障与锁！
      if (stopResult.stopped !== 'confirmed_stopped') {
        const op = this.domain.getStore().getOperation(opId);
        if (op && op.status !== 'done') {
          const indet = indeterminateResult({
            reason: `Process ${active.handle.identity.pid} could not be confirmed stopped: ${stopResult.errorDetails}`,
            startTime: active.startTime,
          });
          finalizeOperation(this.domain, opId, indet, { releaseResourceLock: false });
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

  public pruneArtifacts(filter?: { olderThanMs?: number; prefix?: string }): {
    deleted: string[];
    retained: string[];
  } {
    return this.domain.pruneArtifacts(filter);
  }

  /** 保留原签名：共享契约与单写者测试直接调用它验证「重复终结必须抛错」。 */
  private finalizeOperation(
    opId: string,
    result: OperationResult,
    requiredResources?: string[],
    releaseResourceLock: boolean = true,
    artifactsDir?: string
  ): ProcessOperationResult {
    return finalizeOperation(this.domain, opId, result, { requiredResources, releaseResourceLock, artifactsDir });
  }
}
