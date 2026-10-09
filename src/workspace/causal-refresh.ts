import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph } from './causal-graph.js';
import type { CommitResult } from './transactions.js';
import { planWorkspaceCausalRefresh, type CausalRefreshCostModel,
  type CausalRefreshDecision } from './causal-refresh-cost.js';
import { prepareWorkspaceBranchRepair, type WorkspaceBranchRepairOptions,
  type WorkspaceBranchRepairResult } from './causal-repair.js';
import { validateWorkspaceCausalBranches, type CausalValidationOptions,
  type CausalValidationResult } from './causal-validation.js';

export interface WorkspaceCausalRefreshOptions extends CausalValidationOptions {
  repair: Pick<WorkspaceBranchRepairOptions, 'txId' | 'forkPath' | 'validateReuse' | 'execute'>;
  /** Opt in to choosing incremental repair or full selected-union recomputation. */
  costModel?: CausalRefreshCostModel;
}

export type WorkspaceCausalRefreshResult =
  | { status: 'failed' | 'unchanged'; validation: CausalValidationResult }
  | { status: 'prepared'; validation: CausalValidationResult; repair: WorkspaceBranchRepairResult;
      decision?: CausalRefreshDecision };

export type WorkspaceCausalRefreshCommitResult =
  | { status: 'failed' | 'unchanged'; validation: CausalValidationResult }
  | { status: 'committed' | 'conflict'; validation: CausalValidationResult;
      repair: WorkspaceBranchRepairResult; commit: CommitResult; decision?: CausalRefreshDecision };

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
  const published = await publishCausalRepair(supervisor, prepared.repair, prepared.validation.runId, options.replay);
  return { ...published, validation: prepared.validation,
    ...(prepared.decision ? { decision: prepared.decision } : {}) };
}

export interface WorkspaceCausalRecomputationOptions extends Pick<CausalValidationOptions,
  'txId' | 'runId' | 'root' | 'forkPath' | 'atSeq' | 'branches' | 'closedWorld' | 'replayPolicy' | 'replay'> {
  execute: WorkspaceBranchRepairOptions['execute'];
}

export interface WorkspaceCausalRecomputationResult {
  status: 'committed' | 'conflict';
  preparationSeq: number;
  repair: WorkspaceBranchRepairResult;
  commit: CommitResult;
}

/** Recompute the selected union without probing old evidence. Shared ancestors run
 * once; publication still requires complete deterministic replay and OCC.
 * This explicit strategy does not diagnose changed observations or bind checkpoints.
 */
export async function recomputeWorkspaceCausalBranches(
  supervisor: ProcessSupervisor, options: WorkspaceCausalRecomputationOptions,
): Promise<WorkspaceCausalRecomputationResult> {
  options = { ...options, branches: structuredClone(options.branches) };
  if (options.closedWorld !== true || options.replayPolicy !== 'deterministic') {
    throw new Error('Causal recomputation requires closed-world deterministic replay');
  }
  const domain = supervisor.getDomain();
  const graph = new WorkspaceCausalGraph(domain);
  const heads = options.branches.flatMap(branch => [...branch.heads]);
  const changed = graph.view(heads, options.atSeq).nodes.map(node => node.seq);
  const repair = await prepareWorkspaceBranchRepair(supervisor, {
    ...options, changed, validateReuse: async () => {},
  });
  let preparationSeq: number;
  try {
    preparationSeq = domain.getStore().recordJournalEvent({
      domainId: domain.domainId, runId: options.runId, type: 'CAUSAL_RECOMPUTATION_PREPARED',
      payload: { version: 1, strategy: 'full', txId: repair.transaction.txId,
        atSeq: options.atSeq, sourceBranches: repair.branches.map(branch => ({
          id: branch.id, heads: branch.sourceHeads,
        })) }, timestamp: new Date().toISOString(),
    });
  } catch (error) {
    try {
      await supervisor.abortWorkspaceTransaction(repair.transaction.txId, 'causal recomputation linkage failed');
      await supervisor.pruneSnapshots([repair.transaction.baseSnapshotId], { runId: options.runId });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Causal recomputation linkage failed; cleanup incomplete');
    }
    throw error;
  }
  return { ...await publishCausalRepair(supervisor, repair, options.runId, options.replay), preparationSeq };
}

async function publishCausalRepair(
  supervisor: ProcessSupervisor, repair: WorkspaceBranchRepairResult, runId: string,
  replay: CausalValidationOptions['replay'],
): Promise<Omit<WorkspaceCausalRecomputationResult, 'preparationSeq'>> {
  const tx = repair.transaction;
  let commitStarted = false;
  let commit: CommitResult;
  try {
    const log = new WorkspaceCausalGraph(supervisor.getDomain()).view(repair.heads)
      .nodes.map((node) => node.observation);
    commitStarted = true;
    commit = await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: { closedWorld: true, log, replay },
    });
  } catch (error) {
    if (commitStarted) {
      // TX_COMMITTING may already exist or files may already have been applied.
      throw new Error(`Causal refresh commit failed for ${tx.txId}; retain its fork and baseline, inspect the journal before recovery`, { cause: error });
    }
    try {
      await supervisor.abortWorkspaceTransaction(tx.txId, 'causal refresh evidence failed');
      await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Causal refresh evidence failed; cleanup incomplete');
    }
    throw error;
  }
  try {
    if (commit.status === 'conflict') await supervisor.abortWorkspaceTransaction(tx.txId, 'causal refresh conflict');
    await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId });
  } catch (error) {
    throw new Error(`Causal refresh ${tx.txId} ${commit.status}; cleanup incomplete`, { cause: error });
  }
  return { status: commit.status, repair: {
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
  const decision = options.costModel ? planWorkspaceCausalRefresh(validation.plan, options.costModel) : undefined;
  const changed = decision?.strategy === 'full'
    ? [...validation.plan.invalidated, ...validation.plan.unaffected].map(node => node.seq).sort((a, b) => a - b)
    : validation.changed;
  const repair = await prepareWorkspaceBranchRepair(supervisor, {
    ...options.repair, runId: validation.runId, root: validation.root,
    atSeq: validation.atSeq, branches: validation.sourceBranches, changed,
  });
  const domain = supervisor.getDomain();
  try {
    domain.getStore().recordJournalEvent({
      domainId: domain.domainId, runId: validation.runId, type: 'CAUSAL_VALIDATION_REPAIR_PREPARED',
      payload: { version: 1, validationSeq: validation.seq, txId: repair.transaction.txId,
        ...(decision ? { decision } : {}) },
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
  return { status: 'prepared', validation, repair, ...(decision ? { decision } : {}) };
}
