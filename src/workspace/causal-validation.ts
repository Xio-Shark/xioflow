import path from 'node:path';
import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph, type RecomputationPlan } from './causal-graph.js';
import type { WorkspaceRepairBranch } from './causal-repair.js';
import { replayObservationLog } from './observation-replay.js';
import type { ObservationValidation } from './transactions.js';

export interface CausalValidationOptions {
  /** Unique prefix for the disposable validation transactions. */
  txId: string;
  runId: string;
  root: string;
  forkPath: string;
  atSeq: number;
  branches: readonly WorkspaceRepairBranch[];
  /** Every selected branch contains its complete, ordered filesystem effects and inputs. */
  closedWorld: true;
  replayPolicy: 'deterministic';
  replay: ObservationValidation['replay'];
}

export type CausalBranchValidation =
  | { id: string; status: 'matched'; matchedSteps: number }
  | { id: string; status: 'changed'; matchedSteps: number; seq: number }
  | { id: string; status: 'failed'; matchedSteps: number; seq: number; error: string };

export interface CausalValidationResult {
  atSeq: number;
  heads: number[];
  branches: CausalBranchValidation[];
  /** Only successful replay hash mismatches, never execution errors. */
  changed: number[];
  plan: RecomputationPlan;
  replayedSteps: number;
}

/** Probe each branch on an isolated copy of ONE current-world baseline.
 * A branch stops at its first divergence; other branches are still checked.
 * The result is a repair seed, not an OCC certificate or exhaustive change list.
 */
export async function validateWorkspaceCausalBranches(
  supervisor: ProcessSupervisor, options: CausalValidationOptions,
): Promise<CausalValidationResult> {
  options = { ...options };
  if (options.closedWorld !== true || options.replayPolicy !== 'deterministic') {
    throw new Error('Causal validation requires closed-world deterministic replay');
  }
  const graph = new WorkspaceCausalGraph(supervisor.getDomain());
  const branches = options.branches.map(({ id, heads }) => ({ id, view: graph.view(heads, options.atSeq) }));
  if (!branches.length || branches.some(({ id }) => !id.trim())
    || new Set(branches.map(({ id }) => id)).size !== branches.length) {
    throw new Error('Causal validation requires nonempty unique branch identities');
  }
  const heads = [...new Set(branches.flatMap(({ view }) => view.heads))];
  const results: CausalBranchValidation[] = [];
  const changed = new Set<number>();
  let baseline: string | undefined;
  let replayedSteps = 0;
  try {
    for (const [index, branch] of branches.entries()) {
      const tx = await supervisor.beginWorkspaceTransaction({
        txId: `${options.txId}-${index}`, runId: options.runId, root: options.root,
        forkPath: path.join(options.forkPath, String(index)), baseSnapshotId: baseline,
      });
      baseline ??= tx.baseSnapshotId;
      try {
        const result = await replayObservationLog({ log: branch.view.nodes.map((node) => node.observation),
          replay: async (entry, root) => {
            replayedSteps++;
            return options.replay(structuredClone(entry), root);
          },
        }, tx.forkRoot);
        if (result.status === 'matched') {
          results.push({ id: branch.id, status: 'matched', matchedSteps: result.matchedSteps });
        } else {
          const seq = branch.view.nodes[result.divergedAt].seq;
          if (result.error !== undefined) {
            results.push({ id: branch.id, status: 'failed', matchedSteps: result.matchedSteps, seq, error: result.error });
          } else {
            changed.add(seq);
            results.push({ id: branch.id, status: 'changed', matchedSteps: result.matchedSteps, seq });
          }
        }
      } finally {
        await supervisor.abortWorkspaceTransaction(tx.txId, 'causal validation complete');
      }
    }
  } finally {
    if (baseline) await supervisor.pruneSnapshots([baseline], { runId: options.runId });
  }
  const seeds = [...changed].sort((a, b) => a - b);
  return { atSeq: options.atSeq, heads, branches: results, changed: seeds,
    plan: graph.planRecomputation(seeds, options.atSeq, heads), replayedSteps };
}
