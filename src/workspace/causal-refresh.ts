import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph } from './causal-graph.js';
import type { CommitResult } from './transactions.js';
import { prepareWorkspaceBranchRepair, type WorkspaceBranchRepairOptions,
  type WorkspaceBranchRepairResult } from './causal-repair.js';
import { validateWorkspaceCausalBranches, type CausalValidationOptions,
  type CausalValidationResult } from './causal-validation.js';

export interface WorkspaceCausalRefreshOptions extends CausalValidationOptions {
  repair: Pick<WorkspaceBranchRepairOptions, 'txId' | 'forkPath' | 'validateReuse' | 'execute'>;
}

export type WorkspaceCausalRefreshResult =
  | { status: 'failed' | 'unchanged'; validation: CausalValidationResult }
  | { status: 'prepared'; validation: CausalValidationResult; repair: WorkspaceBranchRepairResult };

export type WorkspaceCausalRefreshCommitResult =
  | { status: 'failed' | 'unchanged'; validation: CausalValidationResult }
  | { status: 'committed' | 'conflict'; validation: CausalValidationResult;
      repair: WorkspaceBranchRepairResult; commit: CommitResult };

/** Refresh compatible branches and publish their union with mandatory observation replay.
 * The selected union must be a complete deterministic operation log, including reused nodes.
 * Does not bind agent checkpoints. A thrown commit retains recovery resources.
 */
export async function refreshWorkspaceCausalBranches(
  supervisor: ProcessSupervisor, options: WorkspaceCausalRefreshOptions,
): Promise<WorkspaceCausalRefreshCommitResult> {
  options = { ...options, repair: { ...options.repair } };
  const prepared = await prepareWorkspaceCausalRefresh(supervisor, options);
  if (prepared.status !== 'prepared') return prepared;
  const { validation, repair } = prepared;
  const tx = repair.transaction;
  let commitStarted = false;
  let commit: CommitResult;
  try {
    const log = new WorkspaceCausalGraph(supervisor.getDomain()).view(repair.heads)
      .nodes.map((node) => node.observation);
    commitStarted = true;
    commit = await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: { closedWorld: true, log, replay: options.replay },
    });
  } catch (error) {
    if (commitStarted) {
      // TX_COMMITTING may already exist or files may already have been applied.
      throw new Error(`Causal refresh commit failed for ${tx.txId}; retain its fork and baseline, inspect the journal before recovery`, { cause: error });
    }
    try {
      await supervisor.abortWorkspaceTransaction(tx.txId, 'causal refresh evidence failed');
      await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId: validation.runId });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Causal refresh evidence failed; cleanup incomplete');
    }
    throw error;
  }
  try {
    if (commit.status === 'conflict') await supervisor.abortWorkspaceTransaction(tx.txId, 'causal refresh conflict');
    await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId: validation.runId });
  } catch (error) {
    throw new Error(`Causal refresh ${tx.txId} ${commit.status}; cleanup incomplete`, { cause: error });
  }
  return { status: commit.status, validation, repair: {
    ...repair, transaction: { ...tx, status: commit.status === 'committed' ? 'committed' : 'aborted' },
  }, commit };
}

/** Detect changes and prepare one shared repair for compatible branches.
 * Failed probes block repair. Nothing is committed or bound to agent checkpoints.
 */
export async function prepareWorkspaceCausalRefresh(
  supervisor: ProcessSupervisor, options: WorkspaceCausalRefreshOptions,
): Promise<WorkspaceCausalRefreshResult> {
  options = { ...options, repair: { ...options.repair } };
  const validation = await validateWorkspaceCausalBranches(supervisor, options);
  if (validation.branches.some((branch) => branch.status === 'failed')) return { status: 'failed', validation };
  if (!validation.changed.length) return { status: 'unchanged', validation };
  const repair = await prepareWorkspaceBranchRepair(supervisor, {
    ...options.repair, runId: validation.runId, root: validation.root,
    atSeq: validation.atSeq, branches: validation.sourceBranches, changed: validation.changed,
  });
  const domain = supervisor.getDomain();
  try {
    domain.getStore().recordJournalEvent({
      domainId: domain.domainId, runId: validation.runId, type: 'CAUSAL_VALIDATION_REPAIR_PREPARED',
      payload: { version: 1, validationSeq: validation.seq, txId: repair.transaction.txId },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    try {
      await supervisor.abortWorkspaceTransaction(repair.transaction.txId, 'causal refresh linkage failed');
      await supervisor.pruneSnapshots([repair.transaction.baseSnapshotId], { runId: validation.runId });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Causal refresh linkage failed; cleanup incomplete');
    }
    throw error;
  }
  return { status: 'prepared', validation, repair };
}
