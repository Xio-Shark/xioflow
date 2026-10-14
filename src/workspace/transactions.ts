import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { JournalEvent, SnapshotRef } from '../types.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { isPathContained } from '../capability/index.js';
import { collectReadTracking, normalizeAccessTimes, probeReadTracking, ReadTracking } from './read-tracking.js';
import { replayObservationLog } from './observation-replay.js';

/**
 * 工作区事务：并行 agent 的乐观并发控制（ARCHITECTURE §3.9）。
 *
 * begin：对主工作区拍基线快照，materialize 出独立 fork，归一 atime 以观测读集。
 * agent 在 fork 里执行任意操作（cwd = forkRoot）。
 * commit：读集（atime）+ 写集（基线树 → fork 当前树的逐文件差异），对「本事务开始之后
 * 已提交的事务」与「绕过事务直接写主工作区的改动」做后向校验；无冲突才把写集应用到主工作区。
 * 应用前先写 TX_COMMITTING（带写集）：崩溃后再次 commit 只重放应用，fork 即重做日志。
 *
 * 观测级校验（可选）：文件级校验报了冲突、而冲突只落在本事务读过但没写过的路径上时，宿主可以交出事务的
 * 观测日志。内核在主工作区当前状态的一个分叉上按顺序重放：只读观测的结果全部相同、改动全部能应用，
 * 就以重放分叉为来源提交。内核不解释工具调用，重放由宿主执行；日志之外还有读取渠道（分叉里跑过进程）
 * 时不使用观测校验。
 */

export interface WriteEntry {
  status: 'A' | 'D' | 'M' | 'T';
  /** 相对事务根目录 */
  path: string;
}

export interface TransactionConflict {
  path: string;
  kind: 'write_write' | 'read_write' | 'external_write';
  /** 与之冲突的已提交事务；external_write 为空（改动不经事务直接写入了主工作区）。 */
  otherTxId?: string;
}

export interface WorkspaceTransaction {
  txId: string;
  runId: string;
  /** 主工作区中的事务根目录 */
  root: string;
  /** agent 应在其中工作的目录（fork 内与 root 对应的位置） */
  forkRoot: string;
  baseSnapshotId: string;
  /** TX_BEGUN 的 journal seq：校验只看它之后提交的事务 */
  beginSeq: number;
  readTracking: ReadTracking;
  status: 'open' | 'committing' | 'committed' | 'conflicted' | 'aborted';
}

export interface TransactionEffects {
  readTracking: ReadTracking;
  /** readTracking 为 'unobserved' 时为 null：不知道就不假装知道 */
  readSet: string[] | null;
  /** 无法观测是否使用过的符号链接路径，保守参与冲突校验；旧事务未记此证据时为 null。 */
  pathDependencies: string[] | null;
  writeSet: WriteEntry[];
}

/** 事务里的一步：只读观测或改动。`call` 由宿主定义，内核不解释。 */
export interface ObservationEntry {
  kind: 'observe' | 'mutate';
  call: { tool: string; args: Record<string, unknown> };
  /**
   * 宿主规范化后的结果哈希。observe 必须有；mutate 的返回值如果也给 agent 看了别处的内容
   * （例如编辑后附带的引用列表），同样带上，重放时一样比较。
   */
  resultHash?: string;
  /**
   * 可选：语义/关键依赖投影哈希（Early Cutoff）。
   * 当原始 resultHash 因无关行号偏移、非目标函数注释或增量目录发现改变，但下游步骤实际依赖的投影未变时，
   * 若重放计算的 cutoffHash 与此值一致，则触发 Early Cutoff 继续验证后续步骤。
   */
  cutoffHash?: string;
}

export interface ObservationStepOutcome {
  resultHash?: string;
  cutoffHash?: string;
  /** 宿主显式证明该步的关键依赖仍成立，允许 Early Cutoff。 */
  cutoff?: boolean;
}

export interface ObservationValidation {
  log: ObservationEntry[];
  /** 宿主声明：agent 在分叉里的所有读取都在 log 里。内核仍会核对分叉里有没有跑过进程。 */
  closedWorld: true;
  /** 在 root 里重新执行一步并返回结果哈希或带 cutoff 证据的结果；改动无法应用则抛错。 */
  replay(entry: ObservationEntry, root: string): Promise<string | void | ObservationStepOutcome>;
  /**
   * 可选 Early Cutoff 判定（Salsa/Adapton 风格）：
   * 当某一步未抛错但原始 resultHash 变化时调用；返回 true 表示下游步骤所依赖的实质内容未变，可跳过级联失效。
   */
  canCutoff?(
    entry: ObservationEntry,
    replayed: { resultHash?: string; cutoffHash?: string; index: number },
    root: string
  ): boolean | Promise<boolean>;
}

/** 「无冲突」凭的是什么证据：重放的观测、文件级读写集，还是只有写集（读集观测不到）。 */
export type CommitValidation = 'observations' | 'files' | 'write_only';

/** 冲突时观测校验走到了哪一步。没有尝试也要说原因。 */
export type ObservationOutcome =
  | { attempted: true; divergedAt: number; reason: 'observation_changed' | 'mutation_not_applicable' }
  | { attempted: false; reason: 'write_conflict' | 'not_closed_world' }
  /** 重放通过了，但重放期间主工作区又被改动：结论作废，不应用。 */
  | { attempted: true; reason: 'workspace_changed' };

export type CommitResult =
  | ({ status: 'committed'; txId: string; validation: CommitValidation } & TransactionEffects)
  | ({ status: 'conflict'; txId: string; conflicts: TransactionConflict[]; observation?: ObservationOutcome } & TransactionEffects);

export interface CommitOptions {
  observations?: ObservationValidation;
}

/** 已通过校验、等待应用的提交：写集、从哪个目录拷贝、凭什么证据、要回收的重放分叉。 */
interface CommitPlan {
  effects: TransactionEffects;
  sourceRoot: string;
  validation: CommitValidation;
  replay?: { forkPath: string; snapshotId: string };
}

export interface TransactionHost {
  domain: ExecutionDomain;
  snapshotDriver: GitShadowSnapshotDriver;
  assertOperationIdAvailable(opId: string): void;
  captureSnapshot(runId: string, opId: string, root: string): Promise<SnapshotRef>;
  materialize(snapshotId: string, forkPath: string): Promise<void>;
  dematerialize(forkPath: string, leaseOwner?: string): Promise<void>;
  pruneSnapshot(snapshotId: string, runId: string): Promise<void>;
}

type OpenTransaction = WorkspaceTransaction & { forkPath: string; repoRoot: string; pathDependencies: string[] | null };

export class WorkspaceTransactions {
  private readonly open = new Map<string, OpenTransaction>();
  private commitQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: TransactionHost) {}

  public async begin(options: { txId: string; runId: string; root: string; forkPath: string; baseSnapshotId?: string }): Promise<WorkspaceTransaction> {
    const { snapshotDriver } = this.host;
    // txId 会成为快照 id 与 git ref 名的一部分
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.txId)) {
      throw new Error(`Invalid workspace transaction id "${options.txId}": use letters, digits, ".", "_" or "-"`);
    }
    if (this.open.has(options.txId) || this.journal(options.txId).length > 0) {
      throw new Error(`Workspace transaction "${options.txId}" already exists`);
    }
    const root = fs.realpathSync(options.root);
    const { repoRoot } = await snapshotDriver.assertGitRepo(root);
    let base: SnapshotRef;
    if (options.baseSnapshotId !== undefined) {
      const store = this.host.domain.getStore();
      const saved = store.getSnapshot(options.baseSnapshotId);
      const run = store.getRun(options.runId);
      if (!run || run.domainId !== this.host.domain.domainId || !['queued', 'starting', 'running'].includes(run.status)) {
        throw new Error('A workspace transaction requires an active Run in its domain');
      }
      if (!saved || saved.domainId !== this.host.domain.domainId || saved.driver !== snapshotDriver.name
        || saved.roots.length !== 1 || fs.realpathSync(saved.roots[0]) !== root) {
        throw new Error('Transaction base snapshot must cover the same root in this domain');
      }
      base = saved;
    } else {
      base = await this.host.captureSnapshot(options.runId, `${options.txId}-base`, root);
    }
    const forkPath = path.resolve(options.forkPath);
    await this.host.materialize(base.id, forkPath);
    const forkRoot = path.join(fs.realpathSync(forkPath), path.relative(repoRoot, root));

    const readTracking = probeReadTracking(path.dirname(forkPath));
    const pathDependencies = readTracking === 'atime'
      ? normalizeAccessTimes(forkRoot)
      : collectReadTracking(forkRoot).pathDependencies;

    const beginSeq = this.record(options.runId, 'TX_BEGUN', {
      txId: options.txId,
      root,
      forkPath,
      forkRoot,
      baseSnapshotId: base.id,
      readTracking,
      pathDependencies,
    });
    const tx: OpenTransaction = {
      txId: options.txId,
      runId: options.runId,
      root,
      forkRoot,
      forkPath,
      repoRoot,
      baseSnapshotId: base.id,
      beginSeq,
      readTracking,
      pathDependencies,
      status: 'open',
    };
    this.open.set(tx.txId, tx);
    return this.view(tx);
  }

  /** 当前读集与写集（不提交）。读集证据在计算写集前取出并落 journal，随后重新归一 atime。 */
  public async inspect(txId: string): Promise<TransactionEffects> {
    const tx = await this.require(txId);
    const owner = `${txId}:inspect`;
    this.host.assertOperationIdAvailable(owner);
    this.host.domain.allocateResources(owner, [`workspace:write:${tx.forkRoot}`]);
    try {
      return await this.effects(tx);
    } finally {
      this.host.domain.internalReleaseResources(owner);
    }
  }

  public commit(txId: string, options?: CommitOptions): Promise<CommitResult> {
    return this.serialize(() => this.commitSerialized(txId, options));
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    // 提交与回收共用队列，abort 不能在异步校验期间销毁提交的重做源。
    const run = this.commitQueue.then(action);
    this.commitQueue = run.catch(() => {});
    return run;
  }

  public abort(txId: string, reason = 'aborted by host'): Promise<void> {
    return this.serialize(() => this.abortSerialized(txId, reason));
  }

  private async abortSerialized(txId: string, reason: string): Promise<void> {
    const tx = await this.require(txId);
    if (tx.status === 'committing') {
      throw new Error(`Workspace transaction "${txId}" is committing; call commit() again to finish applying it`);
    }
    const owner = `${txId}:abort`;
    this.host.assertOperationIdAvailable(owner);
    this.host.domain.allocateResources(owner, [`workspace:write:${tx.forkRoot}`]);
    try {
      await this.host.dematerialize(tx.forkPath, owner);
      await this.discardReplayFork(tx);
      this.record(tx.runId, 'TX_ABORTED', { txId, reason });
      this.open.delete(txId);
    } finally {
      this.host.domain.internalReleaseResources(owner);
    }
  }

  /** 本进程内打开过的事务（崩溃后重建的事务在首次 inspect / commit / abort 时载入）。 */
  public get(txId: string): WorkspaceTransaction | undefined {
    const tx = this.open.get(txId);
    return tx ? this.view(tx) : undefined;
  }

  private async commitSerialized(txId: string, options?: CommitOptions): Promise<CommitResult> {
    const tx = await this.require(txId);
    if (tx.status === 'conflicted') {
      throw new Error(`Workspace transaction "${txId}" has conflicts; abort it and start again from the current workspace`);
    }
    const committing = this.journal(txId).find((e) => e.type === 'TX_COMMITTING');
    const leaseOwner = `${txId}:apply`;
    const { domain } = this.host;
    let held = false;
    let durable = committing !== undefined;
    let committed = false;
    let primaryError: unknown;
    let plan!: CommitPlan;
    let fileConflicts: TransactionConflict[] = [];
    const acquire = (roots: string[]) => {
      if (!held) {
        if (committing) {
          // 只有 journal 对应的内部 owner 可以重入；不能借用公开操作的同名身份。
          if (domain.getStore().getOperation(leaseOwner)) throw new Error(`Workspace commit owner "${leaseOwner}" belongs to a registered operation`);
        } else {
          this.host.assertOperationIdAvailable(leaseOwner);
        }
      }
      domain.allocateResources(leaseOwner, [...new Set(roots)].map((root) => `workspace:write:${root}`));
      held = true;
    };
    const release = () => {
      domain.internalReleaseResources(leaseOwner);
      held = false;
    };
    try {
      if (committing) {
        // 隔离从未结清的 journal 在域启动时重建，源分叉仍是受保护的重做日志。
        const p = committing.payload as Partial<CommitPlan> & { effects: TransactionEffects; isolationVersion?: number };
        plan = {
          effects: { ...p.effects, pathDependencies: p.effects.pathDependencies ?? null },
          sourceRoot: p.sourceRoot ?? tx.forkRoot,
          validation: p.validation ?? (p.effects.readSet === null ? 'write_only' : 'files'),
          replay: p.replay,
        };
        acquire([tx.root, plan.sourceRoot]);
        if (p.isolationVersion !== 1) {
          throw new Error(`Workspace transaction "${txId}" lacks continuous commit isolation evidence; automatic replay is refused. Inspect its target and redo source before manual resolution.`);
        }
        if (!fs.existsSync(plan.sourceRoot)) {
          throw new Error(`Workspace transaction "${txId}" cannot finish committing: ${plan.sourceRoot} is gone`);
        }
      } else {
        // effects 也会 await；源和目标在取证之前一起占用，避免读集和写集随后失效。
        acquire([tx.root, tx.forkRoot]);
        const effects = await this.effects(tx);
        const conflicts = await this.validate(tx, effects);
        plan = { effects, sourceRoot: tx.forkRoot, validation: effects.readSet === null ? 'write_only' : 'files' };
        if (conflicts.length > 0) {
          // 重放会为主工作区拍快照，不能与同名写租约嵌套；它的结论稍后重新核对。
          release();
          const byObservation = options?.observations
            ? await this.validateByObservations(tx, effects, conflicts, options.observations, (source) => acquire([source]))
            : undefined;
          if (!byObservation?.plan) return this.conflicted(tx, conflicts, effects, byObservation?.outcome);
          plan = byObservation.plan;
          fileConflicts = conflicts;
          acquire([tx.root]);
        }
      }
      const { effects, validation } = plan;
      if (!committing && plan.replay && !(await this.unchangedSince(tx, plan.replay.snapshotId))) {
        // 重放用的是拍快照那一刻的工作区；拿到写租约时它已经不是那个状态，重放的结论与写集都不再成立
        release();
        await this.discardReplayFork(tx);
        return this.conflicted(tx, fileConflicts, { ...effects, writeSet: (await this.inspect(txId)).writeSet }, {
          attempted: true,
          reason: 'workspace_changed',
        });
      }
      if (!committing) {
        this.record(tx.runId, 'TX_COMMITTING', { txId, root: tx.root, ...plan, isolationVersion: 1 });
        durable = true;
        tx.status = 'committing';
      }
      this.apply(tx, effects.writeSet, plan.sourceRoot);
      this.record(tx.runId, 'TX_COMMITTED', {
        txId,
        root: tx.root,
        writeSet: effects.writeSet,
        readSet: effects.readSet,
        pathDependencies: effects.pathDependencies,
        validation,
      });
      committed = true;
      tx.status = 'committed';
      this.open.delete(txId);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // 部分应用、落结果失败都保留隔离；重试完成或启动重建之前不允许新写入。
      if (held && (!durable || committed)) {
        try { release(); }
        catch (error) {
          if (primaryError !== undefined) throw new AggregateError([primaryError, error], `Workspace commit ${txId} and isolation release both failed`);
          throw error;
        }
      }
    }
    await this.host.dematerialize(tx.forkPath);
    if (plan.replay) {
      await this.host.dematerialize(plan.replay.forkPath);
      await this.host.pruneSnapshot(plan.replay.snapshotId, tx.runId);
    }
    return { status: 'committed', txId, validation: plan.validation, ...plan.effects };
  }

  private conflicted(
    tx: OpenTransaction,
    conflicts: TransactionConflict[],
    effects: TransactionEffects,
    observation?: ObservationOutcome
  ): CommitResult {
    tx.status = 'conflicted';
    this.record(tx.runId, 'TX_CONFLICTED', { txId: tx.txId, conflicts, ...(observation ? { observation } : {}) });
    return { status: 'conflict', txId: tx.txId, conflicts, ...(observation ? { observation } : {}), ...effects };
  }

  /** 主工作区的事务根目录是否仍与该快照一致。 */
  private async unchangedSince(tx: OpenTransaction, snapshotId: string): Promise<boolean> {
    const snapshot = this.host.domain.getStore().getSnapshot(snapshotId)!;
    return (await this.host.snapshotDriver.fingerprint([tx.root], { against: snapshot })) === snapshot.treeFingerprint;
  }

  /**
   * 文件级校验报了冲突之后的第二道判断：在主工作区当前状态的分叉上重放事务的观测。
   * 返回 plan 表示可以提交；否则 outcome 说明停在哪里。
   */
  private async validateByObservations(
    tx: OpenTransaction,
    effects: TransactionEffects,
    conflicts: TransactionConflict[],
    observations: ObservationValidation,
    protectSource: (root: string) => void
  ): Promise<{ plan?: CommitPlan; outcome?: ObservationOutcome }> {
    // 两边都写过的路径不靠观测放行：内核分不清带范围的编辑与整文件覆盖，后者会抹掉对方的改动
    const myWrites = new Set(effects.writeSet.map((w) => w.path));
    if (conflicts.some((c) => c.kind === 'write_write' || myWrites.has(c.path))) {
      return { outcome: { attempted: false, reason: 'write_conflict' } };
    }
    // 封闭性：分叉里跑过进程，agent 就有日志之外的读取渠道，宿主的声明不作数
    const escaped = this.processInFork(tx);
    if (escaped) {
      this.record(tx.runId, 'TX_VALIDATION_DOWNGRADED', { txId: tx.txId, reason: 'not_closed_world', operationId: escaped });
      return { outcome: { attempted: false, reason: 'not_closed_world' } };
    }

    const { snapshotDriver } = this.host;
    await this.discardReplayFork(tx);
    const replayPath = replayForkPath(tx);
    const attempt = this.journal(tx.txId).filter((e) => e.type === 'TX_REPLAY_STARTED').length + 1;
    const snapshotId = `${tx.txId}-replay-${attempt}`;
    // 先记意图：崩溃后留下的重放分叉与快照能据此找到并回收
    this.record(tx.runId, 'TX_REPLAY_STARTED', { txId: tx.txId, replayPath, snapshotId });
    const snapshot = await this.host.captureSnapshot(tx.runId, snapshotId, tx.root);
    await this.host.materialize(snapshot.id, replayPath);
    const replayRoot = path.join(fs.realpathSync(replayPath), path.relative(tx.repoRoot, tx.root));

    const replayed = await replayObservationLog(observations, replayRoot);
    if (replayed.status === 'diverged') {
      await this.host.dematerialize(replayPath);
      await this.host.pruneSnapshot(snapshot.id, tx.runId);
      return { outcome: { attempted: true, divergedAt: replayed.divergedAt, reason: replayed.reason } };
    }

    // 写集取「主工作区当前状态 → 重放分叉」的差异：它就是要落到主工作区的全部改动
    protectSource(replayRoot);
    const current = await snapshotDriver.fingerprint([replayRoot], { against: snapshot });
    const forkRepo = (await snapshotDriver.assertGitRepo(replayRoot)).repoRoot;
    const prefix = path.relative(forkRepo, replayRoot);
    const writeSet = (await snapshotDriver.diffTrees(forkRepo, snapshot.treeFingerprint, current, [prefix || '.'])).map(
      (c) => ({ status: c.status, path: prefix ? path.relative(prefix, c.path) : c.path })
    );
    return {
      plan: {
        effects: { ...effects, writeSet },
        sourceRoot: replayRoot,
        validation: 'observations',
        replay: { forkPath: replayPath, snapshotId: snapshot.id },
      },
    };
  }

  /** 事务开始以来在分叉里运行过的进程（按声明的写根与租约判断）；没有则返回 undefined。 */
  private processInFork(tx: OpenTransaction): string | undefined {
    const store = this.host.domain.getStore();
    const forks = new Set([tx.forkPath, fs.realpathSync(tx.forkPath)]);
    const inFork = (p: string) => [...forks].some((fork) => isPathContained(fork, p));
    const seen = new Set<string>();
    for (const event of store.getJournalEvents(this.host.domain.domainId, tx.beginSeq)) {
      if (!event.operationId || seen.has(event.operationId)) continue;
      seen.add(event.operationId);
      const op = store.getOperation(event.operationId);
      if (!op || (op.kind !== 'process' && op.kind !== 'service')) continue;
      const roots = [
        ...(op.mutationRoots ?? []),
        ...op.requiredResources.filter((r) => r.startsWith('workspace:write:')).map((r) => r.slice('workspace:write:'.length)),
      ];
      if (roots.some(inFork)) return op.id;
    }
    return undefined;
  }

  /** 回收上一次尝试留下的重放分叉与它的快照（冲突后重试、崩溃后重启、abort）。 */
  private async discardReplayFork(tx: OpenTransaction): Promise<void> {
    if (fs.existsSync(replayForkPath(tx))) await this.host.dematerialize(replayForkPath(tx));
    const store = this.host.domain.getStore();
    for (const event of this.journal(tx.txId).filter((e) => e.type === 'TX_REPLAY_STARTED')) {
      const snapshotId = event.payload.snapshotId as string;
      if (store.getSnapshot(snapshotId)) await this.host.pruneSnapshot(snapshotId, tx.runId);
    }
  }

  private async effects(tx: OpenTransaction): Promise<TransactionEffects> {
    // 必须在任何 git 读取之前取证；链接只记路径，不跟随，也不声称它们被读过。
    const currentReads = collectReadTracking(tx.forkRoot);
    const earlier = this.journal(tx.txId).filter((e) => e.type === 'TX_READS');
    let readSet: string[] | null = null;
    if (tx.readTracking === 'atime') {
      readSet = [...new Set([...earlier.flatMap((e) => (e.payload.readSet as string[] | null) ?? []), ...currentReads.readSet])].sort();
    }
    const pathDependencies = tx.pathDependencies === null ? null : [...new Set([
      ...tx.pathDependencies,
      ...earlier.flatMap((e) => (e.payload.pathDependencies as string[] | null) ?? []),
      ...currentReads.pathDependencies,
    ])].sort();
    this.record(tx.runId, 'TX_READS', { txId: tx.txId, readSet, pathDependencies });

    const { snapshotDriver } = this.host;
    const base = this.host.domain.getStore().getSnapshot(tx.baseSnapshotId);
    if (!base) throw new Error(`Base snapshot ${tx.baseSnapshotId} of transaction "${tx.txId}" is missing`);
    const current = await snapshotDriver.fingerprint([tx.forkRoot], { against: base });
    const forkRepo = (await snapshotDriver.assertGitRepo(tx.forkRoot)).repoRoot;
    const prefix = path.relative(forkRepo, tx.forkRoot);
    const writeSet = (await snapshotDriver.diffTrees(forkRepo, base.treeFingerprint, current, [prefix || '.'])).map(
      (c) => ({ status: c.status, path: prefix ? path.relative(prefix, c.path) : c.path })
    );
    if (tx.readTracking === 'atime') normalizeAccessTimes(tx.forkRoot); // git 读过所有文件，重新归零证据
    return { readTracking: tx.readTracking, readSet, pathDependencies, writeSet };
  }

  /** 后向校验：本事务开始后提交的事务，以及绕过事务直接写入主工作区的改动。 */
  private async validate(tx: OpenTransaction, effects: TransactionEffects): Promise<TransactionConflict[]> {
    const conflicts: TransactionConflict[] = [];
    const committedAfter = this.host.domain
      .getStore()
      .getJournalEvents(this.host.domain.domainId, tx.beginSeq)
      .filter((e) => e.type === 'TX_COMMITTED' && e.payload.root === tx.root && e.payload.txId !== tx.txId);

    const explained = new Set<string>();
    for (const other of committedAfter) {
      const otherWrites = other.payload.writeSet as WriteEntry[];
      for (const w of otherWrites) explained.add(w.path);
      conflicts.push(...intersect(effects, otherWrites, 'write_write', 'read_write', other.payload.txId as string));
    }

    const external = (await this.mainChangesSinceBase(tx)).filter((w) => !explained.has(w.path));
    conflicts.push(...intersect(effects, external, 'external_write', 'external_write'));
    return conflicts;
  }

  private async mainChangesSinceBase(tx: OpenTransaction): Promise<WriteEntry[]> {
    const { snapshotDriver } = this.host;
    const base = this.host.domain.getStore().getSnapshot(tx.baseSnapshotId)!;
    const current = await snapshotDriver.fingerprint([tx.root], { against: base });
    const prefix = path.relative(tx.repoRoot, tx.root);
    return (await snapshotDriver.diffTrees(tx.repoRoot, base.treeFingerprint, current, [prefix || '.'])).map((c) => ({
      status: c.status,
      path: prefix ? path.relative(prefix, c.path) : c.path,
    }));
  }

  /** 把 sourceRoot（事务分叉或重放分叉）中的写集原样落到主工作区；可重复执行（崩溃后重放）。 */
  private apply(tx: WorkspaceTransaction, writeSet: WriteEntry[], sourceRoot: string): void {
    for (const entry of writeSet) {
      const dst = path.resolve(tx.root, entry.path);
      const src = path.resolve(sourceRoot, entry.path);
      if (!isPathContained(tx.root, dst) || !isPathContained(sourceRoot, src)) {
        throw new Error(`Refusing to apply ${entry.path}: it resolves outside the transaction root`);
      }
      assertNoSymlinkedParent(tx.root, dst);
      if (entry.status === 'D') {
        fs.rmSync(dst, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const st = fs.lstatSync(src);
      fs.rmSync(dst, { force: true });
      if (st.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(src), dst);
      } else {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, st.mode & 0o777);
      }
    }
  }

  private record(runId: string, type: string, payload: Record<string, unknown>): number {
    const { domain } = this.host;
    return domain.getStore().recordJournalEvent({
      domainId: domain.domainId,
      runId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  private journal(txId: string): JournalEvent[] {
    const { domain } = this.host;
    return domain
      .getStore()
      .getJournalEvents(domain.domainId)
      .filter((e) => e.type.startsWith('TX_') && e.payload.txId === txId);
  }

  /** 内存里没有时从 journal 重建（例如 TX_COMMITTING 之后监督进程崩溃重启），已结束的事务不可再用。 */
  private async require(txId: string): Promise<OpenTransaction> {
    const cached = this.open.get(txId);
    if (cached) return cached;
    const events = this.journal(txId);
    const begun = events.find((e) => e.type === 'TX_BEGUN');
    if (!begun) throw new Error(`Workspace transaction "${txId}" does not exist`);
    const closed = events.find((e) => e.type === 'TX_COMMITTED' || e.type === 'TX_ABORTED');
    if (closed) throw new Error(`Workspace transaction "${txId}" is already closed (${closed.type})`);
    const p = begun.payload as Record<string, string>;
    if (!fs.existsSync(p.forkRoot)) {
      throw new Error(`Workspace transaction "${txId}" cannot resume: its fork ${p.forkRoot} is gone`);
    }
    const status = events.some((e) => e.type === 'TX_COMMITTING')
      ? 'committing'
      : events.some((e) => e.type === 'TX_CONFLICTED')
        ? 'conflicted'
        : 'open';
    const tx: OpenTransaction = {
      txId,
      runId: begun.runId ?? '',
      root: p.root,
      forkRoot: p.forkRoot,
      forkPath: p.forkPath,
      repoRoot: (await this.host.snapshotDriver.assertGitRepo(p.root)).repoRoot,
      baseSnapshotId: p.baseSnapshotId,
      beginSeq: begun.seq,
      readTracking: p.readTracking as ReadTracking,
      pathDependencies: (begun.payload.pathDependencies as string[] | undefined) ?? null,
      status,
    };
    this.open.set(txId, tx);
    return tx;
  }

  private view(tx: WorkspaceTransaction): WorkspaceTransaction {
    const { txId, runId, root, forkRoot, baseSnapshotId, beginSeq, readTracking, status } = tx;
    return { txId, runId, root, forkRoot, baseSnapshotId, beginSeq, readTracking, status };
  }
}

const replayForkPath = (tx: { forkPath: string }) => `${tx.forkPath}-replay`;

/**
 * 与 others 的交集。读集里的目录（`dir/`）只和「在该目录下直接新增或删除条目」冲突：
 * 列目录看到的是条目集合，内容修改不改变它。
 */
function intersect(
  mine: TransactionEffects,
  others: WriteEntry[],
  writeKind: TransactionConflict['kind'],
  readKind: TransactionConflict['kind'],
  otherTxId?: string
): TransactionConflict[] {
  const conflicts: TransactionConflict[] = [];
  const myWrites = new Set(mine.writeSet.map((w) => w.path));
  const myReads = new Set(mine.readSet ?? []);
  const pathDependencies = new Set(mine.pathDependencies ?? []);
  for (const other of others) {
    if (myWrites.has(other.path)) {
      conflicts.push({ path: other.path, kind: writeKind, otherTxId });
    } else if (myReads.has(other.path) || mine.pathDependencies === null || pathDependencies.has(other.path)) {
      conflicts.push({ path: other.path, kind: readKind, otherTxId });
    } else if (other.status === 'A' || other.status === 'D') {
      const parent = path.posix.dirname(other.path);
      const dirKey = `${parent}/`;
      if (myReads.has(dirKey)) conflicts.push({ path: dirKey, kind: readKind, otherTxId });
    }
  }
  return conflicts;
}

/** 目标路径上的每一级父目录都必须是真实目录：主工作区里的符号链接不能把写入带出事务根。 */
function assertNoSymlinkedParent(root: string, target: string): void {
  let dir = path.dirname(target);
  while (dir !== root && isPathContained(root, dir)) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
      throw new Error(`Refusing to apply into ${target}: ${dir} is a symbolic link`);
    }
    dir = path.dirname(dir);
  }
}
