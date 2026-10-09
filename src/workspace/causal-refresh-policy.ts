import { measureCausalRefreshCallbacks, type CausalRefreshTelemetry } from './causal-refresh-telemetry.js';
import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph, type CausalNode } from './causal-graph.js';
import { planWorkspaceCausalRefresh, type CausalRefreshCostModel } from './causal-refresh-cost.js';
import { refreshWorkspaceCausalBranches, recomputeWorkspaceCausalBranches,
  type WorkspaceCausalRefreshOptions, type WorkspaceCausalRefreshCommitResult,
  type WorkspaceCausalRecomputationResult } from './causal-refresh.js';

/** Host forecasts in the same unit as costModel. These are not validity evidence. */
export interface CausalRefreshForecast {
  /** Probability that at least one selected branch has changed. */
  changeProbability: number;
  /** Conditional total probe costs, including branch duplication and early stops. */
  probeUnchanged: number;
  probeChanged: number;
  /** Conditional remaining refresh cost after detecting a change, including reuse and OCC replay. */
  refreshChanged: number;
}

export interface CausalRefreshPolicyDecision {
  strategy: 'probe' | 'recompute';
  forecast: CausalRefreshForecast;
  expectedProbeCost: number;
  recomputeCost: number;
}

/** Compare expected total work before any workspace is allocated. Ties preserve probing. */
export function planWorkspaceCausalRefreshPolicy(
  nodes: readonly CausalNode[], forecast: CausalRefreshForecast, costModel: CausalRefreshCostModel,
): CausalRefreshPolicyDecision {
  const { changeProbability: p, probeUnchanged, probeChanged, refreshChanged } = forecast;
  if (!Number.isFinite(p) || p < 0 || p > 1
    || [probeUnchanged, probeChanged, refreshChanged].some(n => !Number.isFinite(n) || n < 0)) {
    throw new Error('Invalid causal refresh forecast: expected probability in [0, 1] and finite nonnegative costs');
  }
  const recomputeCost = planWorkspaceCausalRefresh({
    invalidated: [...new Map(nodes.map(node => [node.seq, node])).values()], unaffected: [],
  }, costModel).full.total;
  const changedCost = probeChanged + refreshChanged;
  const expectedProbeCost = (1 - p) * probeUnchanged + p * changedCost;
  if (!Number.isFinite(changedCost) || !Number.isFinite(expectedProbeCost)) {
    throw new Error('Causal refresh forecast cost overflow');
  }
  return { strategy: recomputeCost < expectedProbeCost ? 'recompute' : 'probe',
    forecast: { changeProbability: p, probeUnchanged, probeChanged, refreshChanged },
    expectedProbeCost, recomputeCost };
}

export interface WorkspaceCausalRefreshPolicyOptions extends WorkspaceCausalRefreshOptions {
  /** Host-defined comparable workload category for historical estimates. */
  taskKey?: string;
  costModel: CausalRefreshCostModel;
  forecast: CausalRefreshForecast;
}

export type WorkspaceCausalRefreshPolicyResult = {
  decisionSeq: number;
  telemetrySeq: number;
  policy: CausalRefreshPolicyDecision;
} & (
  | { strategy: 'probe'; result: WorkspaceCausalRefreshCommitResult }
  | { strategy: 'recompute'; result: WorkspaceCausalRecomputationResult }
);

/** Choose a path before probing; both publishing paths retain mandatory OCC replay.
 * A durable decision is intent, not evidence of completion. Follow transaction events.
 */
export async function refreshWorkspaceCausalBranchesWithPolicy(
  supervisor: ProcessSupervisor, options: WorkspaceCausalRefreshPolicyOptions,
): Promise<WorkspaceCausalRefreshPolicyResult> {
  options = { ...options, branches: structuredClone(options.branches),
    repair: { ...options.repair }, forecast: { ...options.forecast } };
  if (options.closedWorld !== true || options.replayPolicy !== 'deterministic') {
    throw new Error('Causal refresh policy requires closed-world deterministic replay');
  }
  if (!options.branches.length || options.branches.some(branch => !branch.id.trim())
    || new Set(options.branches.map(branch => branch.id)).size !== options.branches.length) {
    throw new Error('Causal refresh policy requires nonempty unique branch identities');
  }
  if (options.replayReuse !== undefined && !['none', 'baseline_observations'].includes(options.replayReuse)) {
    throw new Error('Invalid causal replay reuse policy');
  }
  if (options.taskKey !== undefined && !options.taskKey.trim()) {
    throw new Error('Causal refresh policy requires a nonempty taskKey');
  }
  const domain = supervisor.getDomain();
  const nodes = new WorkspaceCausalGraph(domain).view(
    options.branches.flatMap(branch => [...branch.heads]), options.atSeq,
  ).nodes;
  const policy = planWorkspaceCausalRefreshPolicy(nodes, options.forecast, options.costModel);
  const decisionSeq = domain.getStore().recordJournalEvent({
    domainId: domain.domainId, runId: options.runId, type: 'CAUSAL_REFRESH_POLICY_SELECTED',
    payload: { version: 1, policy, taskKey: options.taskKey, sourceBranches: options.branches, atSeq: options.atSeq,
      probeTxPrefix: options.txId, repairTxId: options.repair.txId },
    timestamp: new Date().toISOString(),
  });
  const started = performance.now();
  const measured = measureCausalRefreshCallbacks(options, policy.strategy);
  let outcome: Omit<WorkspaceCausalRefreshPolicyResult, 'telemetrySeq'> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    if (policy.strategy === 'recompute') {
      const result = await recomputeWorkspaceCausalBranches(supervisor, {
        ...measured.options, txId: options.repair.txId, forkPath: options.repair.forkPath,
        execute: measured.options.repair.execute,
      });
      outcome = { decisionSeq, policy, strategy: 'recompute', result };
    } else {
      outcome = { decisionSeq, policy, strategy: 'probe',
        result: await refreshWorkspaceCausalBranches(supervisor, measured.options) };
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  const report: Omit<CausalRefreshTelemetry, 'seq'> = {
    runId: options.runId, decisionSeq, strategy: policy.strategy,
    status: outcome?.result.status ?? 'threw', durationMs: performance.now() - started,
    callbacks: measured.callbacks,
    ...(outcome && 'validation' in outcome.result ? { validationSeq: outcome.result.validation.seq } : {}),
  };
  let telemetrySeq: number;
  try {
    telemetrySeq = domain.getStore().recordJournalEvent({
      domainId: domain.domainId, runId: options.runId, type: 'CAUSAL_REFRESH_MEASURED',
      payload: { version: 1, report }, timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = `Causal refresh telemetry failed after ${report.status}; inspect decision ${decisionSeq} and transaction ${options.repair.txId} before retrying`;
    if (failed) throw new AggregateError([failure, error], message);
    throw new Error(message, { cause: error });
  }
  if (failed) throw failure;
  return { ...outcome!, telemetrySeq } as WorkspaceCausalRefreshPolicyResult;
}
