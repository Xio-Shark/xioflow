import path from 'node:path';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { ObservationReplayResult } from '../workspace/observation-replay.js';
import type { WorkspaceTransaction } from '../workspace/transactions.js';
import type { AgentRuntime } from './runtime.js';
import { compareAgentCheckpoints, type AgentCheckpointComparison } from './checkpoint-diff.js';
import { prepareCheckpointWorkspace, type CheckpointWorkspaceOptions } from './checkpoint-workspace.js';

export interface AgentCheckpointFilesOptions {
  left: CheckpointWorkspaceOptions;
  right: CheckpointWorkspaceOptions;
}

export type AgentCheckpointFilesResult =
  | { status: 'compared'; comparison: AgentCheckpointComparison;
      /** Actual Git tree differences, relative to the shared workspace root; no rename inference. */
      files: Array<{ status: 'A' | 'D' | 'M' | 'T'; path: string }>;
      replayedSteps: { left: number; right: number } }
  | { status: 'diverged'; side: 'left' | 'right';
      replay: Extract<ObservationReplayResult, { status: 'diverged' }> };

/** Reconstruct both historical worlds, compare covered files, and release temporary forks.
 * Requires the same original workspace root; neither agent is created or scheduled.
 */
export async function compareAgentCheckpointFiles(
  agents: AgentRuntime, supervisor: ProcessSupervisor, options: AgentCheckpointFilesOptions,
): Promise<AgentCheckpointFilesResult> {
  if (agents.getDomain() !== supervisor.getDomain()) throw new Error('Agent and workspace supervisor must share a domain');
  const driver = supervisor.getSnapshotDriver();
  if (!(driver instanceof GitShadowSnapshotDriver)) throw new Error('Checkpoint file comparison requires git-shadow');
  const comparison = compareAgentCheckpoints(agents,
    { agentId: options.left.sourceAgentId, checkpointSeq: options.left.checkpointSeq },
    { agentId: options.right.sourceAgentId, checkpointSeq: options.right.checkpointSeq });
  const transactions: WorkspaceTransaction[] = [];
  let failure: unknown;
  let failed = false;
  try {
    const left = await prepareCheckpointWorkspace(agents, supervisor, options.left);
    if (left.status === 'diverged') return { ...left, side: 'left' };
    transactions.push(left.transaction);
    const right = await prepareCheckpointWorkspace(agents, supervisor, options.right);
    if (right.status === 'diverged') return { ...right, side: 'right' };
    transactions.push(right.transaction);
    if (left.transaction.root !== right.transaction.root) {
      throw new Error('Checkpoint file comparison requires the same original workspace root');
    }
    const trees: string[] = [];
    for (const tx of transactions) {
      const base = agents.getDomain().getStore().getSnapshot(tx.baseSnapshotId);
      if (!base) throw new Error(`Missing checkpoint baseline ${tx.baseSnapshotId}`);
      trees.push(await driver.fingerprint([tx.forkRoot], { against: base }));
    }
    const { repoRoot } = await driver.assertGitRepo(left.transaction.forkRoot);
    const prefix = path.relative(repoRoot, left.transaction.forkRoot);
    const files = (await driver.diffTrees(repoRoot, trees[0], trees[1], [prefix || '.']))
      .map((entry) => ({ ...entry, path: prefix ? path.relative(prefix, entry.path) : entry.path }));
    return { status: 'compared', comparison, files,
      replayedSteps: { left: left.replayedSteps, right: right.replayedSteps } };
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const tx of transactions.reverse()) {
      try { await supervisor.abortWorkspaceTransaction(tx.txId, 'checkpoint comparison finished'); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'Checkpoint comparison cleanup failed');
    }
  }
}
