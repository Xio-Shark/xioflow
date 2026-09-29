import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { JournalEvent, SnapshotRef } from '../types.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { isPathContained } from '../capability/index.js';
import { collectReadSet, normalizeAccessTimes, probeReadTracking, ReadTracking } from './read-tracking.js';

/**
 * 工作区事务：并行 agent 的乐观并发控制（ARCHITECTURE §3.9）。
 *
 * begin：对主工作区拍基线快照，materialize 出独立 fork，归一 atime 以观测读集。
 * agent 在 fork 里执行任意操作（cwd = forkRoot）。
 * commit：读集（atime）+ 写集（基线树 → fork 当前树的逐文件差异），对「本事务开始之后
 * 已提交的事务」与「绕过事务直接写主工作区的改动」做后向校验；无冲突才把写集应用到主工作区。
 * 应用前先写 TX_COMMITTING（带写集）：崩溃后再次 commit 只重放应用，fork 即重做日志。
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
  writeSet: WriteEntry[];
}

export type CommitResult =
  | ({ status: 'committed'; txId: string } & TransactionEffects)
  | ({ status: 'conflict'; txId: string; conflicts: TransactionConflict[] } & TransactionEffects);

export interface TransactionHost {
  domain: ExecutionDomain;
  snapshotDriver: GitShadowSnapshotDriver;
  captureSnapshot(runId: string, opId: string, root: string): Promise<SnapshotRef>;
  materialize(snapshotId: string, forkPath: string): Promise<void>;
  dematerialize(forkPath: string): Promise<void>;
}

type OpenTransaction = WorkspaceTransaction & { forkPath: string; repoRoot: string };

export class WorkspaceTransactions {
  private readonly open = new Map<string, OpenTransaction>();
  private commitQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: TransactionHost) {}

  public async begin(options: { txId: string; runId: string; root: string; forkPath: string }): Promise<WorkspaceTransaction> {
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
    const base = await this.host.captureSnapshot(options.runId, `${options.txId}-base`, root);
    const forkPath = path.resolve(options.forkPath);
    await this.host.materialize(base.id, forkPath);
    const forkRoot = path.join(fs.realpathSync(forkPath), path.relative(repoRoot, root));

    const readTracking = probeReadTracking(path.dirname(forkPath));
    if (readTracking === 'atime') normalizeAccessTimes(forkRoot);

    const beginSeq = this.record(options.runId, 'TX_BEGUN', {
      txId: options.txId,
      root,
      forkPath,
      forkRoot,
      baseSnapshotId: base.id,
      readTracking,
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
      status: 'open',
    };
    this.open.set(tx.txId, tx);
    return this.view(tx);
  }

  /** 当前读集与写集（不提交）。读集证据在计算写集前取出并落 journal，随后重新归一 atime。 */
  public async inspect(txId: string): Promise<TransactionEffects> {
    return this.effects(await this.require(txId));
  }

  public commit(txId: string): Promise<CommitResult> {
    // 同一域只有一个 owner：进程内串行化即可保证「校验 + 应用」相对其他提交是原子的
    const run = this.commitQueue.then(() => this.commitSerialized(txId));
    this.commitQueue = run.catch(() => {});
    return run;
  }

  public async abort(txId: string, reason = 'aborted by host'): Promise<void> {
    const tx = await this.require(txId);
    if (tx.status === 'committing') {
      throw new Error(`Workspace transaction "${txId}" is committing; call commit() again to finish applying it`);
    }
    await this.host.dematerialize(tx.forkPath);
    this.record(tx.runId, 'TX_ABORTED', { txId, reason });
    this.open.delete(txId);
  }

  /** 本进程内打开过的事务（崩溃后重建的事务在首次 inspect / commit / abort 时载入）。 */
  public get(txId: string): WorkspaceTransaction | undefined {
    const tx = this.open.get(txId);
    return tx ? this.view(tx) : undefined;
  }

  private async commitSerialized(txId: string): Promise<CommitResult> {
    const tx = await this.require(txId);
    if (tx.status === 'conflicted') {
      throw new Error(`Workspace transaction "${txId}" has conflicts; abort it and start again from the current workspace`);
    }
    const committing = this.journal(txId).find((e) => e.type === 'TX_COMMITTING');
    const effects = committing ? (committing.payload.effects as TransactionEffects) : await this.effects(tx);

    if (!committing) {
      const conflicts = await this.validate(tx, effects);
      if (conflicts.length > 0) {
        tx.status = 'conflicted';
        this.record(tx.runId, 'TX_CONFLICTED', { txId, conflicts });
        return { status: 'conflict', txId, conflicts, ...effects };
      }
    }

    const leaseOwner = `${txId}:apply`;
    this.host.domain.allocateResources(leaseOwner, [`workspace:write:${tx.root}`]);
    try {
      if (!committing) {
        tx.status = 'committing';
        this.record(tx.runId, 'TX_COMMITTING', { txId, effects });
      }
      this.apply(tx, effects.writeSet);
      this.record(tx.runId, 'TX_COMMITTED', { txId, root: tx.root, writeSet: effects.writeSet, readSet: effects.readSet });
    } finally {
      this.host.domain.internalReleaseResources(leaseOwner);
    }
    tx.status = 'committed';
    await this.host.dematerialize(tx.forkPath);
    this.open.delete(txId);
    return { status: 'committed', txId, ...effects };
  }

  private async effects(tx: OpenTransaction): Promise<TransactionEffects> {
    let readSet: string[] | null = null;
    if (tx.readTracking === 'atime') {
      // 必须在任何 git 读取之前取证；之前 inspect 落盘的读集一并计入
      const earlier = this.journal(tx.txId)
        .filter((e) => e.type === 'TX_READS')
        .flatMap((e) => e.payload.readSet as string[]);
      readSet = [...new Set([...earlier, ...collectReadSet(tx.forkRoot)])].sort();
      this.record(tx.runId, 'TX_READS', { txId: tx.txId, readSet });
    }

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
    return { readTracking: tx.readTracking, readSet, writeSet };
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

  /** 把 fork 中的写集原样落到主工作区；可重复执行（崩溃后重放）。 */
  private apply(tx: WorkspaceTransaction, writeSet: WriteEntry[]): void {
    for (const entry of writeSet) {
      const dst = path.resolve(tx.root, entry.path);
      const src = path.resolve(tx.forkRoot, entry.path);
      if (!isPathContained(tx.root, dst) || !isPathContained(tx.forkRoot, src)) {
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
  for (const other of others) {
    if (myWrites.has(other.path)) {
      conflicts.push({ path: other.path, kind: writeKind, otherTxId });
    } else if (myReads.has(other.path)) {
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
