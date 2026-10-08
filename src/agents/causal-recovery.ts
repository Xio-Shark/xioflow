import type { WorkspaceBranchRepairResult } from '../workspace/causal-repair.js';
import type { AgentCausalCheckpointPreparation, AgentCausalRecoveryPlan, AgentRuntime, AgentState } from './runtime.js';

export type AgentCausalRecoveryImpact = AgentCausalRecoveryPlan['affected'][number];

export type AgentCausalRecoveryOutcome = { agentId: string; checkpointSeq: number } & (
  | { status: 'repaired'; agent: AgentState }
  | { status: 'skipped'; reason: 'checkpoint_changed' | 'not_stopped' | 'not_repaired' }
  | { status: 'failed'; error: unknown }
);

export interface AgentCausalRecoveryBatch {
  /** The initial impact snapshot; later host changes do not rewrite this plan. */
  plan: AgentCausalRecoveryPlan;
  outcomes: AgentCausalRecoveryOutcome[];
}

/**
 * Recover affected agents sequentially in plan order. Each binding is durable
 * independently; errors do not roll back earlier results or stop later entries.
 * The host owns reconstruction and cross-agent dependency coordination. This
 * helper neither stops/resumes agents nor commits their workspace transactions.
 */
export async function recoverAgentCausalBatch(
  agents: AgentRuntime,
  changed: readonly number[],
  prepare: (impact: AgentCausalRecoveryImpact) => Promise<AgentCausalCheckpointPreparation | undefined>,
): Promise<AgentCausalRecoveryBatch> {
  const plan = agents.planCausalRecovery(changed);
  return recoverPlan(agents, plan, prepare);
}

async function recoverPlan(
  agents: AgentRuntime,
  plan: AgentCausalRecoveryPlan,
  prepare: (impact: AgentCausalRecoveryImpact) => Promise<AgentCausalCheckpointPreparation | undefined>,
): Promise<AgentCausalRecoveryBatch> {
  const outcomes: AgentCausalRecoveryOutcome[] = [];
  for (const impact of plan.affected) {
    const identity = { agentId: impact.agentId, checkpointSeq: impact.checkpoint.seq };
    try {
      const current = agents.checkpoints(impact.agentId).at(-1)!;
      if (current.seq !== impact.checkpoint.seq) {
        outcomes.push({ ...identity, status: 'skipped', reason: 'checkpoint_changed' });
        continue;
      }
      const state = agents.get(impact.agentId)!;
      if (state.status !== 'paused' && state.status !== 'interrupted') {
        outcomes.push({ ...identity, status: 'skipped', reason: 'not_stopped' });
        continue;
      }
      const agent = await agents.recoverCausalCheckpoint(impact.agentId, impact.checkpoint.seq,
        () => prepare(structuredClone(impact)));
      outcomes.push(agent ? { ...identity, status: 'repaired', agent }
        : { ...identity, status: 'skipped', reason: 'not_repaired' });
    } catch (error) {
      outcomes.push({ ...identity, status: 'failed', error });
    }
  }
  return { plan, outcomes };
}

export interface AgentSharedCausalRecoveryOptions {
  /** Recompute compatible branches once. Own cleanup if preparation throws. */
  prepare(plan: AgentCausalRecoveryPlan): Promise<WorkspaceBranchRepairResult>;
  /** Rebuild context and provide an independently owned, open transaction.
   * discard must release only this agent's resources, never the shared repair.
   */
  bind(impact: AgentCausalRecoveryImpact, repair: WorkspaceBranchRepairResult): Promise<
    Omit<AgentCausalCheckpointPreparation, 'causalHeads'> | undefined
  >;
}

export interface AgentSharedCausalRecoveryBatch extends AgentCausalRecoveryBatch {
  /** Host-owned even when all bindings fail. Never automatically committed or discarded. */
  repair?: WorkspaceBranchRepairResult;
}

/** Share recomputation, then bind independent agent workspaces against a frozen plan.
 * The shared transaction remains host-owned; per-agent failures cannot release it.
 * Checkpoint publication is durable per agent, not atomic across the batch.
 */
export async function recoverAgentSharedCausalBatch(
  agents: AgentRuntime,
  changed: readonly number[],
  options: AgentSharedCausalRecoveryOptions,
): Promise<AgentSharedCausalRecoveryBatch> {
  const plan = agents.planCausalRecovery(changed);
  if (!plan.affected.length) return { plan, outcomes: [] };
  const repair = structuredClone(await options.prepare(structuredClone(plan)));
  const batch = await recoverPlan(agents, plan, async (impact) => {
    const branches = repair.branches.filter(({ id }) => id === impact.agentId);
    const heads = [...new Set(impact.checkpoint.causalHeads!)].sort((a, b) => a - b);
    const sourceHeads = [...new Set(branches[0]?.sourceHeads ?? [])].sort((a, b) => a - b);
    if (branches.length !== 1 || JSON.stringify(heads) !== JSON.stringify(sourceHeads)) {
      throw new Error(`Shared repair branch does not match checkpoint for "${impact.agentId}"`);
    }
    const prepared = await options.bind(impact, structuredClone(repair));
    if (!prepared) return undefined;
    if (prepared.workspace.txId === repair.transaction.txId) {
      // Never invoke a callback that might dispose the shared workspace.
      throw new Error('Shared repair transaction must remain host-owned; bind an independent workspace');
    }
    return { ...prepared, causalHeads: [...branches[0].heads] };
  });
  return { ...batch, repair };
}
