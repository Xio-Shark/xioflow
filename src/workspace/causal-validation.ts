import path from 'node:path';
import type { ExecutionDomain } from '../domain.js';
import type { SnapshotRef } from '../types.js';
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
  /** Opt in only when observations are pure and independent of fork paths / adapter state. */
  replayReuse?: 'none' | 'baseline_observations';
  replay: ObservationValidation['replay'];
}

export type CausalBranchValidation =
  | { id: string; status: 'matched'; matchedSteps: number }
  | { id: string; status: 'changed'; matchedSteps: number; seq: number }
  | { id: string; status: 'failed'; matchedSteps: number; seq: number; error: string };

export interface CausalValidationResult {
  /** Journal identity of the completed validation report. */
  seq: number;
  validationId: string;
  runId: string;
  root: string;
  /** Historical identity only: validation reclaims the snapshot itself. */
  baseline: SnapshotRef;
  sourceBranches: { id: string; heads: number[] }[];
  atSeq: number;
  heads: number[];
  branches: CausalBranchValidation[];
  /** Only successful replay hash mismatches, never execution errors. */
  changed: number[];
  plan: RecomputationPlan;
  replayedSteps: number;
  replayReuse: 'none' | 'baseline_observations';
  /** Successful tool results reused across branches before their first mutation. */
  reusedSteps: number;
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
  const replayReuse = options.replayReuse ?? 'none';
  if (replayReuse !== 'none' && replayReuse !== 'baseline_observations') {
    throw new Error('Invalid causal replay reuse policy');
  }
  const domain = supervisor.getDomain();
  const graph = new WorkspaceCausalGraph(domain);
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
  let reusedSteps = 0;
  // Node identity, not call equality: distinct evidence is never conflated.
  // This cache belongs to this baseline only and never survives the invocation.
  const observed = new Map<number, string>();
  let baselineRef: SnapshotRef | undefined;
  let root = options.root;
  try {
    for (const [index, branch] of branches.entries()) {
      const tx = await supervisor.beginWorkspaceTransaction({
        txId: `${options.txId}-${index}`, runId: options.runId, root: options.root,
        forkPath: path.join(options.forkPath, String(index)), baseSnapshotId: baseline,
      });
      baseline ??= tx.baseSnapshotId;
      try {
        if (!baselineRef) {
          const saved = domain.getStore().getSnapshot(tx.baseSnapshotId);
          if (!saved) throw new Error('Causal validation baseline is missing');
          baselineRef = structuredClone(saved);
          root = tx.root;
        }
        let index = 0;
        let mutated = false;
        const result = await replayObservationLog({ log: branch.view.nodes.map((node) => node.observation),
          replay: async (entry, root) => {
            const node = branch.view.nodes[index++];
            if (entry.kind === 'mutate') mutated = true;
            const reusable = replayReuse === 'baseline_observations' && !mutated;
            if (reusable && observed.has(node.seq)) {
              reusedSteps++;
              return observed.get(node.seq)!;
            }
            replayedSteps++;
            const seen = await options.replay(structuredClone(entry), root);
            // Errors are retried on sibling forks, never cached as evidence.
            if (reusable && typeof seen === 'string') observed.set(node.seq, seen);
            return seen;
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
  const report: Omit<CausalValidationResult, 'seq' | 'plan'> = {
    validationId: options.txId, runId: options.runId, root, baseline: baselineRef!,
    sourceBranches: branches.map(({ id, view }) => ({ id, heads: view.heads })),
    atSeq: options.atSeq, heads, branches: results, changed: seeds, replayedSteps, replayReuse, reusedSteps,
  };
  const plan = graph.planRecomputation(seeds, options.atSeq, heads);
  const seq = domain.getStore().recordJournalEvent({
    domainId: domain.domainId, runId: options.runId, type: 'CAUSAL_VALIDATION_COMPLETED',
    payload: { version: 1, report }, timestamp: new Date().toISOString(),
  });
  return { ...report, seq, plan };
}

/** Query completed reports after reopening a domain, even after snapshot pruning.
 * atSeq limits report events, whereas each report.atSeq freezes its source graph.
 */
export function listWorkspaceCausalValidations(
  domain: ExecutionDomain, options: { runId?: string; atSeq?: number } = {},
): CausalValidationResult[] {
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid validation history sequence');
  const graph = new WorkspaceCausalGraph(domain);
  return domain.getStore().getJournalEvents(domain.domainId)
    .filter((event) => event.type === 'CAUSAL_VALIDATION_COMPLETED' && event.seq <= atSeq
      && (options.runId === undefined || event.runId === options.runId))
    .map((event) => {
      if (event.payload.version !== 1) throw new Error('Unsupported causal validation journal version');
      const report = structuredClone(event.payload.report) as Omit<CausalValidationResult, 'seq' | 'plan'>;
      // Version 1 reports written before observation reuse had no cost fields for it.
      report.replayReuse ??= 'none';
      report.reusedSteps ??= 0;
      return { ...report, seq: event.seq,
        plan: graph.planRecomputation(report.changed, report.atSeq, report.heads) };
    });
}
