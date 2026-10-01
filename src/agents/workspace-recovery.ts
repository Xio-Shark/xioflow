import { isDeepStrictEqual } from 'node:util';
import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { ObservationEntry, ObservationValidation, WorkspaceTransaction } from '../workspace/transactions.js';
import { replayObservationLog, type ObservationReplayResult } from '../workspace/observation-replay.js';
import type { AgentCheckpoint, AgentData, AgentRuntime, AgentState } from './runtime.js';

export interface AgentWorkspaceRecoveryOptions {
  agentId: string;
  recoveryId: string;
  root: string;
  forkPath: string;
  /** Opt in only when identical log prefixes on the same tree have identical behavior. */
  replayPolicy?: 'recheck' | 'deterministic';
  observations(checkpoint: AgentData): ObservationValidation;
}

interface RecoveryEvidence {
  attempts: number;
  replayedSteps: number;
  skippedCheckpoints: number;
  rejections: Array<{ checkpointSeq: number; source: 'executed' | 'reused_prefix'; replay: Extract<ObservationReplayResult, { status: 'diverged' }> }>;
}

export type AgentWorkspaceRecoveryResult = RecoveryEvidence & (
  | { status: 'restored'; checkpointSeq: number; transaction: WorkspaceTransaction }
  | { status: 'no_valid_checkpoint' }
);

/**
 * Reconstruct a stopped agent on a new transaction, newest checkpoint first.
 * Candidates share an immutable baseline, never a dirty fork. Deterministic
 * adapters may skip prefixes already disproved on that baseline. Binding and
 * context restoration share one agent-state event. The agent stays paused;
 * its old transaction is retained
 * for the caller to abort after inspecting the result.
 */
export async function recoverAgentWorkspace(
  agents: AgentRuntime,
  supervisor: ProcessSupervisor,
  options: AgentWorkspaceRecoveryOptions
): Promise<AgentWorkspaceRecoveryResult> {
  if (agents.getDomain() !== supervisor.getDomain()) throw new Error('Agent and workspace supervisor must share a domain');
  if (options.replayPolicy !== undefined && !['recheck', 'deterministic'].includes(options.replayPolicy)) throw new Error('Invalid recovery replay policy');
  const agent = agents.get(options.agentId);
  if (!agent) throw new Error('Workspace recovery requires an existing agent');
  let prepared: AgentWorkspaceRecoveryResult | undefined;
  await agents.recoverCheckpoint(agent.id, async (checkpoints) => {
    prepared = await prepareCandidates(supervisor, agent, checkpoints, options);
    if (prepared.status !== 'restored') return undefined;
    const { transaction, checkpointSeq } = prepared;
    return {
      seq: checkpointSeq, workspace: transaction,
      discard: async () => {
        await supervisor.abortWorkspaceTransaction(transaction.txId, 'recovery binding failed');
        await supervisor.pruneSnapshots([transaction.baseSnapshotId], { runId: agent.runId });
      },
    };
  });
  return prepared!;
}

async function prepareCandidates(
  supervisor: ProcessSupervisor,
  agent: AgentState,
  checkpoints: readonly AgentCheckpoint[],
  options: AgentWorkspaceRecoveryOptions
): Promise<AgentWorkspaceRecoveryResult> {
  let attempts = 0;
  let replayedSteps = 0;
  let skippedCheckpoints = 0;
  let baseSnapshotId: string | undefined;
  // Retain the baseline while a candidate is open, including a successful result.
  let candidatePending = false;
  const rejections: RecoveryEvidence['rejections'] = [];
  const knownFailures: Array<{ prefix: ObservationEntry[]; replay: Extract<ObservationReplayResult, { status: 'diverged' }> }> = [];
  try {
    for (const saved of [...checkpoints].reverse()) {
      const observations = options.observations(saved.checkpoint);
      if (observations.closedWorld !== true || observations.log.some((entry) => entry.kind === 'observe' && typeof entry.resultHash !== 'string')) {
        throw new Error('Workspace recovery requires a closed observation log with result hashes');
      }
      const originalLog = structuredClone(observations.log);
      const known = options.replayPolicy === 'deterministic' && knownFailures.find(({ prefix }) =>
        prefix.length <= originalLog.length && isDeepStrictEqual(prefix, originalLog.slice(0, prefix.length)));
      if (known) {
        skippedCheckpoints++;
        rejections.push({ checkpointSeq: saved.seq, source: 'reused_prefix', replay: known.replay });
        continue;
      }
      candidatePending = true;
      const transaction = await supervisor.beginWorkspaceTransaction({
        txId: `${options.recoveryId}-${++attempts}`, runId: agent.runId,
        root: options.root, forkPath: `${options.forkPath}-${attempts}`,
        ...(baseSnapshotId ? { baseSnapshotId } : {}),
      });
      baseSnapshotId = transaction.baseSnapshotId;
      const discard = async () => {
        await supervisor.abortWorkspaceTransaction(transaction.txId, 'recovery candidate rejected');
        candidatePending = false;
      };
      let matched: boolean;
      try {
        const replay = observations.replay;
        const result = await replayObservationLog({
          ...observations,
          replay: async (entry, root) => { replayedSteps++; return replay(entry, root); },
        }, transaction.forkRoot);
        matched = result.status === 'matched';
        if (result.status === 'diverged') {
          rejections.push({ checkpointSeq: saved.seq, source: 'executed', replay: result });
          if (result.error === undefined) knownFailures.push({ prefix: originalLog.slice(0, result.divergedAt + 1), replay: result });
        }
      } catch (error) {
        try { await discard(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Workspace recovery and cleanup failed'); }
        throw error;
      }
      if (matched) {
        return { status: 'restored', checkpointSeq: saved.seq, transaction, attempts, replayedSteps, skippedCheckpoints, rejections };
      }
      await discard();
    }
    return { status: 'no_valid_checkpoint', attempts, replayedSteps, skippedCheckpoints, rejections };
  } finally {
    if (baseSnapshotId && !candidatePending) await supervisor.pruneSnapshots([baseSnapshotId], { runId: agent.runId });
  }
}
