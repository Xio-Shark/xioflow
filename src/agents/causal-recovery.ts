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
