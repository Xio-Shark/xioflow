import { listAgentCausalRefreshExecutions } from './causal-recovery-history.js';
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
  refreshPreparationSeq?: number,
  settled?: (outcome: AgentCausalRecoveryOutcome) => void,
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
        () => prepare(structuredClone(impact)), refreshPreparationSeq);
      outcomes.push(agent ? { ...identity, status: 'repaired', agent }
        : { ...identity, status: 'skipped', reason: 'not_repaired' });
    } catch (error) {
      outcomes.push({ ...identity, status: 'failed', error });
    } finally {
      settled?.(outcomes.at(-1)!);
    }
  }
  return { plan, outcomes };
}

export interface AgentCausalBindingAttempt {
  attemptSeq: number;
  preparationSeq: number;
  /** Persist allocation intent before beginning a transaction. Does not allocate it.
   * Only usable during this bind callback; transaction identities cannot be reused.
   */
  reserveTransaction(txId: string): number;
}

export interface AgentSharedCausalRecoveryOptions {
  /** Recompute compatible branches once. Own cleanup if preparation throws. */
  prepare(plan: AgentCausalRecoveryPlan): Promise<WorkspaceBranchRepairResult>;
  /** Rebuild context and provide an independently owned, open transaction.
   * discard must release only this agent's resources, never the shared repair.
   */
  bind(impact: AgentCausalRecoveryImpact, repair: WorkspaceBranchRepairResult,
    attempt?: AgentCausalBindingAttempt): Promise<
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
  refresh?: { planSeq: number; runId: string },
): Promise<AgentSharedCausalRecoveryBatch> {
  if (!plan.affected.length) return { plan, outcomes: [] };
  const repair = structuredClone(await options.prepare(structuredClone(plan)));
  const domain = agents.getDomain();
  const record = (type: string, payload: Record<string, unknown>) => domain.getStore().recordJournalEvent({
    domainId: domain.domainId, runId: refresh!.runId, type, timestamp: new Date().toISOString(),
    payload: { version: 1, ...payload },
  });
  // Record before invoking any binding; a crash leaves explicit pending entries.
  const preparationSeq = refresh ? record('AGENT_CAUSAL_REFRESH_PREPARED', {
    planSeq: refresh.planSeq, txId: repair.transaction.txId, repair,
  }) : undefined;
  return bindSharedRepair(agents, plan, options.bind, repair, preparationSeq, refresh?.runId);
}

// Domain ownership already excludes another process; this guards overlapping calls.
const activePreparations = new WeakMap<object, Set<number>>();

async function bindSharedRepair(
  agents: AgentRuntime, plan: AgentCausalRecoveryPlan,
  bind: AgentSharedCausalRecoveryOptions['bind'], repair: WorkspaceBranchRepairResult,
  preparationSeq?: number, runId?: string,
): Promise<AgentSharedCausalRecoveryBatch> {
  const domain = agents.getDomain();
  const active = activePreparations.get(domain) ?? new Set<number>();
  activePreparations.set(domain, active);
  if (preparationSeq !== undefined && active.has(preparationSeq)) throw new Error('Causal refresh binding already active');
  if (preparationSeq !== undefined) active.add(preparationSeq);
  try {
    const batch = await recoverPlan(agents, plan, async (impact) => {
      const branches = repair.branches.filter(({ id }) => id === impact.agentId);
      const heads = [...new Set(impact.checkpoint.causalHeads!)].sort((a, b) => a - b);
      const sourceHeads = [...new Set(branches[0]?.sourceHeads ?? [])].sort((a, b) => a - b);
      if (branches.length !== 1 || JSON.stringify(heads) !== JSON.stringify(sourceHeads)) {
        throw new Error(`Shared repair branch does not match checkpoint for "${impact.agentId}"`);
      }
      let binding = true;
      const record = (type: string, payload: Record<string, unknown>) => domain.getStore().recordJournalEvent({
        domainId: domain.domainId, runId, type, timestamp: new Date().toISOString(),
        payload: { version: 1, ...payload },
      });
      const attemptSeq = preparationSeq === undefined ? undefined : record('AGENT_CAUSAL_BINDING_STARTED', {
        preparationSeq, agentId: impact.agentId, checkpointSeq: impact.checkpoint.seq,
      });
      const attempt: AgentCausalBindingAttempt | undefined = attemptSeq === undefined ? undefined : {
        attemptSeq, preparationSeq: preparationSeq!,
        reserveTransaction(txId) {
          if (!binding) throw new Error('Causal binding attempt is no longer active');
          if (typeof txId !== 'string' || !txId.trim()) throw new Error('Transaction identity must be nonempty');
          const events = domain.getStore().getJournalEvents(domain.domainId);
          if (txId === repair.transaction.txId || events.some(event => event.payload.txId === txId
            && (event.type.startsWith('TX_') || event.type === 'AGENT_CAUSAL_BINDING_RESERVED'))) {
            throw new Error('Transaction identity already allocated or reserved');
          }
          return record('AGENT_CAUSAL_BINDING_RESERVED', { attemptSeq, txId });
        },
      };
      let prepared: Awaited<ReturnType<AgentSharedCausalRecoveryOptions['bind']>>;
      try { prepared = await bind(impact, structuredClone(repair), attempt); }
      finally { binding = false; }
      if (!prepared) return undefined;
      if (prepared.workspace.txId === repair.transaction.txId) {
        // Never invoke a callback that might dispose the shared workspace.
        throw new Error('Shared repair transaction must remain host-owned; bind an independent workspace');
      }
      return { ...prepared, causalHeads: [...branches[0].heads] };
    }, preparationSeq, preparationSeq !== undefined ? (outcome) => {
      // Successful publication carries this reference in the same AGENT_STATE write.
      if (outcome.status === 'repaired') return;
      domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId,
        type: 'AGENT_CAUSAL_REFRESH_OUTCOME', timestamp: new Date().toISOString(),
        payload: { version: 1, preparationSeq, agentId: outcome.agentId,
          checkpointSeq: outcome.checkpointSeq, status: outcome.status,
          ...(outcome.status === 'failed' ? { error: String(outcome.error) } : { reason: outcome.reason }),
        } });
    } : undefined);
    return { ...batch, repair };
  } finally {
    if (preparationSeq !== undefined) active.delete(preparationSeq);
  }
}

/** Continue only unpublished bindings from durable repair data, without probing or
 * recomputing. bind must reconcile any earlier side effects/orphan transactions
 * before returning an independently owned open workspace. Terminal outcomes are
 * never retried; changed checkpoints are skipped. This does not commit files.
 */
export async function resumeAgentSharedCausalRefresh(
  agents: AgentRuntime, planSeq: number, bind: AgentSharedCausalRecoveryOptions['bind'],
): Promise<AgentSharedCausalRecoveryBatch> {
  const domain = agents.getDomain();
  const execution = listAgentCausalRefreshExecutions(domain).find(entry => entry.seq === planSeq);
  if (!execution) throw new Error('Unknown causal refresh plan');
  const pending = new Set(execution.publications.filter(entry => entry.status === 'pending').map(entry => entry.agentId));
  const plan = { ...execution.preview, affected: execution.preview.affected.filter(entry => pending.has(entry.agentId)) };
  if (!pending.size) return { plan, outcomes: [] };
  const prepared = execution.repair && domain.getStore().getJournalEvent(domain.domainId, execution.repair.seq);
  const repair = prepared?.payload.repair as WorkspaceBranchRepairResult | undefined;
  if (!repair || repair.transaction.txId !== execution.repair?.txId) {
    throw new Error('Causal refresh has no durable repair; cannot resume');
  }
  const events = domain.getStore().getJournalEvents(domain.domainId)
    .filter(event => event.payload.txId === repair.transaction.txId && event.type.startsWith('TX_'));
  const begun = events.find(event => event.type === 'TX_BEGUN');
  if (!begun || begun.seq >= prepared!.seq || begun.runId !== repair.transaction.runId
    || begun.payload.forkRoot !== repair.transaction.forkRoot
    || events.some(event => ['TX_COMMITTING', 'TX_COMMITTED', 'TX_ABORTED', 'TX_CONFLICTED'].includes(event.type))) {
    throw new Error('Shared repair must remain an open transaction');
  }
  return bindSharedRepair(agents, plan, bind, structuredClone(repair), execution.repair!.seq, execution.runId);
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
  const batch = await recoverAgentSharedCausalPlan(agents, structuredClone(preview), recovery, { planSeq, runId: validationOptions.runId });
  return { status: 'recovered', validation, planSeq, preview, batch };
}
