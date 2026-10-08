import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { replayObservationLog, type ObservationReplayResult } from '../workspace/observation-replay.js';
import type { WorkspaceTransaction } from '../workspace/transactions.js';
import type { AgentCheckpoint, AgentRuntime } from './runtime.js';
import type { AgentCheckpointForkOptions } from './checkpoint-fork.js';

export type CheckpointWorkspaceOptions = Omit<AgentCheckpointForkOptions, 'agentId' | 'maxSteps'>;

/** Shared reconstruction path; callers own successful transactions and must release them. */
export async function prepareCheckpointWorkspace(
  agents: AgentRuntime, supervisor: ProcessSupervisor, options: CheckpointWorkspaceOptions,
): Promise<
  | { status: 'prepared'; checkpoint: AgentCheckpoint; transaction: WorkspaceTransaction; replayedSteps: number }
  | { status: 'diverged'; replay: Extract<ObservationReplayResult, { status: 'diverged' }> }
> {
  const domain = agents.getDomain();
  if (domain !== supervisor.getDomain()) throw new Error('Agent and workspace supervisor must share a domain');
  const { sourceAgentId, checkpointSeq, txId, forkPath } = options;
  if (options.replayPolicy !== 'deterministic') throw new Error('Checkpoint forks require deterministic replay');
  const source = agents.get(sourceAgentId);
  if (!source) throw new Error('Checkpoint fork requires an existing source agent');
  const saved = agents.checkpoints(sourceAgentId).find((entry) => entry.seq === checkpointSeq);
  if (!saved) throw new Error(`No checkpoint ${checkpointSeq} for agent "${sourceAgentId}"`);
  if (!saved.workspace || saved.causalHeads == null) throw new Error('Checkpoint fork requires a workspace and tracked causal heads');
  const begun = domain.getStore().getJournalEvents(domain.domainId).find((event) =>
    event.type === 'TX_BEGUN' && event.payload.txId === saved.workspace!.txId && event.seq <= saved.seq);
  if (!begun) throw new Error('Checkpoint workspace baseline is absent from history');
  const observations = options.observations(structuredClone(saved));
  if (observations.closedWorld !== true || observations.log.some((entry) =>
    typeof entry.resultHash !== 'string' || !entry.resultHash.trim())) {
    throw new Error('Checkpoint fork requires a closed observation log with result hashes for every step');
  }
  const log = structuredClone(observations.log);
  const replay = observations.replay;
  const transaction = await supervisor.beginWorkspaceTransaction({ txId, runId: source.runId,
    root: begun.payload.root as string, forkPath, baseSnapshotId: begun.payload.baseSnapshotId as string });
  // This baseline belongs to the source history; never prune it when discarding a fork.
  let discarded = false;
  const discard = async () => {
    discarded = true;
    await supervisor.abortWorkspaceTransaction(txId, 'checkpoint fork rejected');
  };
  try {
    const result = await replayObservationLog({ log,
      replay: (entry, root) => replay(structuredClone(entry), root),
    }, transaction.forkRoot);
    if (result.status === 'diverged') {
      await discard();
      return { status: 'diverged', replay: result };
    }
    return { status: 'prepared', checkpoint: saved, transaction, replayedSteps: result.matchedSteps };
  } catch (error) {
    if (!discarded) {
      try { await discard(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Checkpoint replay and cleanup failed'); }
    }
    throw error;
  }
}
