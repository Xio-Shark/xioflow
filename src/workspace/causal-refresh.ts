import type { ProcessSupervisor } from '../supervisor/supervisor.js';
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
