import { prepareCheckpointWorkspace } from './checkpoint-workspace.js';
import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { ObservationReplayResult } from '../workspace/observation-replay.js';
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
  const { sourceAgentId, checkpointSeq, agentId, txId, maxSteps } = options;
  if (!agentId || agents.get(agentId)) throw new Error('Checkpoint fork requires a new agent id');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive safe integer');
  const prepared = await prepareCheckpointWorkspace(agents, supervisor, options);
  if (prepared.status === 'diverged') return prepared;
  const { checkpoint: saved, transaction, replayedSteps } = prepared;
  const domain = agents.getDomain();
  const source = agents.get(sourceAgentId)!;
  try {
    // Preparation is not proof of agent creation: AGENT_STATE remains the binding fact.
    domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: source.runId,
      type: 'AGENT_CHECKPOINT_FORK_PREPARED', timestamp: new Date().toISOString(),
      payload: { version: 1, sourceAgentId, checkpointSeq, agentId, txId,
        baseSnapshotId: transaction.baseSnapshotId, replayedSteps } });
    const agent = agents.create({ id: agentId, runId: source.runId, input: source.input,
      checkpoint: saved.checkpoint, causalHeads: saved.causalHeads, workspace: transaction, maxSteps });
    return { status: 'forked', agent, transaction, replayedSteps };
  } catch (error) {
    try { await supervisor.abortWorkspaceTransaction(txId, 'checkpoint fork rejected'); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Checkpoint fork and cleanup failed'); }
    throw error;
  }
}
