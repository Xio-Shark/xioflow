import type { CausalNode, RecomputationPlan } from './causal-graph.js';

/** Estimates must use one common unit (for example milliseconds or tool calls).
 * reuse includes evidence validation and materializing retained outputs.
 */
export interface CausalRefreshNodeCost {
  execute: number;
  reuse: number;
  replay: number;
}

export type CausalRefreshCostModel = (node: CausalNode) => CausalRefreshNodeCost;

export interface CausalRefreshCost {
  execution: number;
  reuseValidation: number;
  commitReplay: number;
  total: number;
}

export interface CausalRefreshDecision {
  strategy: 'incremental' | 'full';
  incremental: CausalRefreshCost;
  full: CausalRefreshCost;
}

/** Compare remaining work after probing, counting shared nodes once and replaying
 * the entire union for either strategy. Probe and common transaction overhead are
 * excluded. Estimates choose work, never authorize reuse or replace OCC evidence.
 */
export function planWorkspaceCausalRefresh(
  plan: RecomputationPlan, estimate: CausalRefreshCostModel,
): CausalRefreshDecision {
  const incremental: CausalRefreshCost = { execution: 0, reuseValidation: 0, commitReplay: 0, total: 0 };
  const full = { ...incremental };
  const invalidated = new Set(plan.invalidated.map(node => node.seq));
  const nodes = [...plan.invalidated, ...plan.unaffected].sort((a, b) => a.seq - b.seq);
  for (const node of nodes) {
    const cost = estimate(structuredClone(node));
    if (!cost || [cost.execute, cost.reuse, cost.replay].some(value => !Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid causal refresh cost for node ${node.seq}: expected finite nonnegative estimates`);
    }
    full.execution += cost.execute;
    if (invalidated.has(node.seq)) incremental.execution += cost.execute;
    else incremental.reuseValidation += cost.reuse;
    full.commitReplay += cost.replay;
    incremental.commitReplay += cost.replay;
  }
  for (const cost of [incremental, full]) {
    cost.total = cost.execution + cost.reuseValidation + cost.commitReplay;
    if (!Number.isFinite(cost.total)) throw new Error('Causal refresh cost total overflow');
  }
  // Preserve incremental behavior on ties.
  return { strategy: full.total < incremental.total ? 'full' : 'incremental', incremental, full };
}
