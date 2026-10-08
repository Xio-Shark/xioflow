import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { replayObservationLog, type ObservationReplayResult } from '../workspace/observation-replay.js';
import type { ObservationValidation, WorkspaceTransaction } from '../workspace/transactions.js';
import type { AgentCheckpoint, AgentRuntime, AgentState } from './runtime.js';

export interface AgentCheckpointForkOptions {
  sourceAgentId: string;
  checkpointSeq: number;
  agentId: string;
  txId: string;
  forkPath: string;
  maxSteps: number;
  /** Host assertion: replay is deterministic and confined to the supplied fork. */
  replayPolicy: 'deterministic';
  /** Complete operation prefix from this checkpoint's workspace baseline, including mutations. */
  observations(checkpoint: AgentCheckpoint): ObservationValidation;
}

export type AgentCheckpointForkResult =
  | { status: 'forked'; agent: AgentState; transaction: WorkspaceTransaction; replayedSteps: number }
  | { status: 'diverged'; replay: Extract<ObservationReplayResult, { status: 'diverged' }> };

/** Reconstruct a historical world and context on a new branch in the same Run.
 * The source agent and live files are untouched. Run usage is never rewound.
 * A successful branch is ready, but no step is dispatched by this helper.
 */
export async function forkAgentCheckpoint(
  agents: AgentRuntime,
  supervisor: ProcessSupervisor,
  options: AgentCheckpointForkOptions,
): Promise<AgentCheckpointForkResult> {
  const domain = agents.getDomain();
  if (domain !== supervisor.getDomain()) throw new Error('Agent and workspace supervisor must share a domain');
  const { sourceAgentId, checkpointSeq, agentId, txId, forkPath, maxSteps } = options;
  if (options.replayPolicy !== 'deterministic') throw new Error('Checkpoint forks require deterministic replay');
  if (!agentId || agents.get(agentId)) throw new Error('Checkpoint fork requires a new agent id');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive safe integer');
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
    // Preparation is not proof of agent creation: AGENT_STATE remains the binding fact.
    domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: source.runId,
      type: 'AGENT_CHECKPOINT_FORK_PREPARED', timestamp: new Date().toISOString(),
      payload: { version: 1, sourceAgentId, checkpointSeq, agentId, txId,
        baseSnapshotId: transaction.baseSnapshotId, replayedSteps: result.matchedSteps } });
    const agent = agents.create({ id: agentId, runId: source.runId, input: source.input,
      checkpoint: saved.checkpoint, causalHeads: saved.causalHeads, workspace: transaction, maxSteps });
    return { status: 'forked', agent, transaction, replayedSteps: result.matchedSteps };
  } catch (error) {
    if (!discarded) {
      try { await discard(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Checkpoint fork and cleanup failed'); }
    }
    throw error;
  }
}
