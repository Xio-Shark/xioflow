import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { CommitOptions, CommitResult, WorkspaceTransaction } from './transactions.js';

export interface WorkspaceStrategy {
  id: string;
  /** Resolve only after all work in this fork has stopped. Throw to reject the candidate. */
  execute(transaction: WorkspaceTransaction): Promise<CommitOptions | void>;
}

export interface WorkspaceSpeculationOptions {
  speculationId: string;
  runId: string;
  root: string;
  /** Each candidate gets `${forkPath}-${index}`. */
  forkPath: string;
  /** Priority order; completion timing does not change the selection order. */
  strategies: readonly WorkspaceStrategy[];
}

export interface SpeculationCandidate {
  strategyId: string;
  txId: string;
  status: 'failed' | 'conflict' | 'discarded' | 'committed';
  error?: string;
  commit?: CommitResult;
}

export interface WorkspaceSpeculationResult {
  status: 'committed' | 'no_winner';
  winner?: string;
  baseSnapshotId: string;
  candidates: SpeculationCandidate[];
}

/**
 * Fork once per strategy from one immutable baseline, execute concurrently, then
 * submit in priority order through normal OCC. This is a joined tournament, not
 * a cancellation race: every callback must settle before any fork is reclaimed.
 */
export async function speculateWorkspace(
  supervisor: ProcessSupervisor,
  options: WorkspaceSpeculationOptions,
): Promise<WorkspaceSpeculationResult> {
  const strategies = [...options.strategies];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.speculationId)) throw new Error('Invalid speculation id');
  if (!strategies.length || strategies.some((s) => !s.id.trim()) || new Set(strategies.map((s) => s.id)).size !== strategies.length) {
    throw new Error('Speculation requires nonempty, unique strategy ids');
  }
  const domain = supervisor.getDomain();
  const record = (type: string, payload: Record<string, unknown>) => domain.getStore().recordJournalEvent({
    domainId: domain.domainId, runId: options.runId, type,
    payload: { speculationId: options.speculationId, ...payload }, timestamp: new Date().toISOString(),
  });
  const transactions: WorkspaceTransaction[] = [];
  const pending = new Set<string>();
  let baseSnapshotId: string | undefined;
  let uncertainCommit: string | undefined;
  let result: WorkspaceSpeculationResult | undefined;
  const errors: unknown[] = [];
  try {
    // Materialization is sequential; callbacks start only after every fork exists.
    for (let index = 0; index < strategies.length; index++) {
      const tx = await supervisor.beginWorkspaceTransaction({
        txId: `${options.speculationId}-${index}`, runId: options.runId,
        root: options.root, forkPath: `${options.forkPath}-${index}`,
        ...(baseSnapshotId ? { baseSnapshotId } : {}),
      });
      transactions.push(tx);
      pending.add(tx.txId);
      baseSnapshotId = tx.baseSnapshotId;
    }
    record('SPECULATION_STARTED', { baseSnapshotId, candidates: transactions.map((tx, i) => ({ txId: tx.txId, strategyId: strategies[i].id })) });
    const executions = await Promise.allSettled(strategies.map(async (strategy, index) => strategy.execute({ ...transactions[index] })));
    const candidates: SpeculationCandidate[] = executions.map((execution, index) => ({
      strategyId: strategies[index].id, txId: transactions[index].txId,
      status: execution.status === 'rejected' ? 'failed' : 'discarded',
      ...(execution.status === 'rejected' ? { error: execution.reason instanceof Error ? execution.reason.message : String(execution.reason) } : {}),
    }));
    result = { status: 'no_winner', baseSnapshotId: baseSnapshotId!, candidates };
    for (let index = 0; index < executions.length; index++) {
      const execution = executions[index];
      if (execution.status === 'rejected') continue;
      const candidate = candidates[index];
      // A thrown commit may already have started applying files. Retain its
      // redo fork and baseline; never select a second winner after that error.
      uncertainCommit = candidate.txId;
      const commit = await supervisor.commitWorkspaceTransaction(candidate.txId, execution.value || undefined);
      uncertainCommit = undefined;
      candidate.commit = commit;
      if (commit.status === 'conflict') {
        candidate.status = 'conflict';
        continue;
      }
      pending.delete(candidate.txId);
      candidate.status = 'committed';
      result.status = 'committed';
      result.winner = candidate.strategyId;
      break;
    }
    record('SPECULATION_FINISHED', { ...result });
  } catch (error) {
    errors.push(error);
  }
  for (const txId of pending) {
    if (txId === uncertainCommit) continue;
    try {
      await supervisor.abortWorkspaceTransaction(txId, 'speculation candidate discarded');
      pending.delete(txId);
    } catch (error) { errors.push(error); }
  }
  if (baseSnapshotId && pending.size === 0) {
    try { await supervisor.pruneSnapshots([baseSnapshotId], { runId: options.runId }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) {
    throw new AggregateError(errors, uncertainCommit
      ? `Speculation commit failed for ${uncertainCommit}; retain its fork and retry commit to recover`
      : 'Workspace speculation or cleanup failed');
  }
  return result!;
}
