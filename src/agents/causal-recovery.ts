import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { validateWorkspaceCausalBranches, type CausalValidationOptions, type CausalValidationResult } from '../workspace/causal-validation.js';
import type { WorkspaceBranchRepairResult } from '../workspace/causal-repair.js';
import type { AgentCausalCheckpointPreparation, AgentCausalRecoveryPlan, AgentRuntime, AgentState, ExplainedAgentCausalRecoveryPlan } from './runtime.js';

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
  return recoverAgentSharedCausalPlan(agents, agents.planCausalRecovery(changed), options);
}

async function recoverAgentSharedCausalPlan(
  agents: AgentRuntime,
  plan: AgentCausalRecoveryPlan,
  options: AgentSharedCausalRecoveryOptions,
): Promise<AgentSharedCausalRecoveryBatch> {
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

export interface AgentSharedCausalRefreshOptions extends AgentSharedCausalRecoveryOptions {
  /** Explicitly selected compatible branches in the supplied current-world root. */
  agentIds: readonly string[];
  validation: Omit<CausalValidationOptions, 'branches' | 'atSeq'>;
}

export type AgentSharedCausalRefreshResult =
  | { status: 'untracked'; untracked: string[] }
  | { status: 'validation_failed'; validation: CausalValidationResult }
  | { status: 'checkpoint_changed'; validation: CausalValidationResult; agentIds: string[] }
  | { status: 'unchanged'; validation: CausalValidationResult; planSeq: number; preview: ExplainedAgentCausalRecoveryPlan }
  | { status: 'recovered'; validation: CausalValidationResult; planSeq: number;
      preview: ExplainedAgentCausalRecoveryPlan; batch: AgentSharedCausalRecoveryBatch };

/** Probe frozen checkpoint branches, explain their invalidation, then share repair.
 * A recovered batch may contain skipped/failed bindings. No transaction is committed.
 */
export async function refreshAgentSharedCausalBatch(
  agents: AgentRuntime, supervisor: ProcessSupervisor, options: AgentSharedCausalRefreshOptions,
): Promise<AgentSharedCausalRefreshResult> {
  const domain = agents.getDomain();
  if (domain !== supervisor.getDomain()) throw new Error('Agent and workspace supervisor must share a domain');
  const ids = [...options.agentIds];
  const validationOptions = { ...options.validation };
  const recovery = { prepare: options.prepare, bind: options.bind };
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Refresh requires nonempty unique agent identities');
  const checkpoints = ids.map((id) => ({ id, checkpoint: agents.checkpoints(id).at(-1)! }));
  const tracked = checkpoints.filter(({ checkpoint }) => checkpoint.causalHeads != null);
  if (!tracked.length) return { status: 'untracked', untracked: ids };
  const validation = await validateWorkspaceCausalBranches(supervisor, {
    ...validationOptions,
    atSeq: Math.max(...checkpoints.map(({ checkpoint }) => checkpoint.seq)),
    branches: tracked.map(({ id, checkpoint }) => ({ id, heads: checkpoint.causalHeads! })),
  });
  // A failed probe is unknown evidence, even when a sibling did find a change.
  if (validation.branches.some(({ status }) => status === 'failed')) return { status: 'validation_failed', validation };
  const advanced = checkpoints.filter(({ id, checkpoint }) => agents.checkpoints(id).at(-1)!.seq !== checkpoint.seq);
  if (advanced.length) return { status: 'checkpoint_changed', validation, agentIds: advanced.map(({ id }) => id) };
  const selected = new Set(ids);
  const explained = agents.explainCausalRecovery(validation.changed);
  const preview: ExplainedAgentCausalRecoveryPlan = {
    changed: explained.changed,
    affected: explained.affected.filter(({ agentId }) => selected.has(agentId)),
    unaffected: explained.unaffected.filter((id) => selected.has(id)),
    untracked: explained.untracked.filter((id) => selected.has(id)),
  };
  const planSeq = domain.getStore().recordJournalEvent({ domainId: domain.domainId,
    runId: validationOptions.runId, type: 'AGENT_CAUSAL_REFRESH_PLANNED', timestamp: new Date().toISOString(),
    payload: { version: 1, validationSeq: validation.seq, changed: validation.changed,
      checkpoints: checkpoints.map(({ id, checkpoint }) => ({ agentId: id, checkpointSeq: checkpoint.seq })) },
  });
  if (!preview.affected.length) return { status: 'unchanged', validation, planSeq, preview };
  const batch = await recoverAgentSharedCausalPlan(agents, structuredClone(preview), recovery);
  return { status: 'recovered', validation, planSeq, preview, batch };
}
