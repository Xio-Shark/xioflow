import type { ExecutionDomain } from '../domain.js';
import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import { isAgentCheckpoint, readAgentCheckpoint } from './journal.js';
import type { AgentCheckpoint, AgentState, ExplainedAgentCausalRecoveryPlan } from './runtime.js';

export interface AgentCausalRefreshPlanRecord {
  seq: number;
  runId: string;
  validationSeq: number;
  checkpoints: { agentId: string; checkpointSeq: number }[];
  /** Historical intent only; does not claim reconstruction or checkpoint publication succeeded. */
  preview: ExplainedAgentCausalRecoveryPlan;
}

/** Reconstruct frozen recovery evidence without opening a runtime or replaying tools.
 * Later checkpoints and causal nodes never rewrite a saved plan. runId filters the
 * initiating validation Run, which may differ from a selected agent's Run.
 */
export function listAgentCausalRefreshPlans(
  domain: ExecutionDomain, options: { runId?: string; atSeq?: number } = {},
): AgentCausalRefreshPlanRecord[] {
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid agent causal refresh history sequence');
  const events = domain.getStore().getJournalEvents(domain.domainId).filter(event => event.seq <= atSeq);
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const graph = new WorkspaceCausalGraph(domain);
  return events.filter(event => event.type === 'AGENT_CAUSAL_REFRESH_PLANNED'
    && (options.runId === undefined || event.runId === options.runId)).map(event => {
    if (event.payload.version !== 1) throw new Error('Unsupported agent causal refresh plan version');
    const { validationSeq, changed, checkpoints } = event.payload as unknown as {
      validationSeq: number; changed: number[]; checkpoints: AgentCausalRefreshPlanRecord['checkpoints'];
    };
    const validation = bySeq.get(validationSeq);
    if (!validation || validation.seq >= event.seq || validation.type !== 'CAUSAL_VALIDATION_COMPLETED') {
      throw new Error('Missing or invalid agent causal refresh validation reference');
    }
    const invalid = new Set(graph.planRecomputation(changed, event.seq).invalidated.map(node => node.seq));
    const preview: ExplainedAgentCausalRecoveryPlan = {
      changed: [...new Set(changed)], affected: [], unaffected: [], untracked: [],
    };
    for (const { agentId, checkpointSeq } of checkpoints) {
      const saved = bySeq.get(checkpointSeq);
      if (!saved || saved.seq >= event.seq || saved.type !== 'AGENT_STATE'
        || (saved.payload.state as AgentState).id !== agentId || !isAgentCheckpoint(saved.payload.transition)) {
        throw new Error(`Missing or invalid refresh checkpoint ${checkpointSeq} for agent "${agentId}"`);
      }
      const history: AgentCheckpoint[] = events.filter(entry => entry.seq <= checkpointSeq
        && entry.type === 'AGENT_STATE' && (entry.payload.state as AgentState).id === agentId
        && isAgentCheckpoint(entry.payload.transition)).map(entry => {
        const state = entry.payload.state as AgentState;
        return { seq: entry.seq,
          checkpoint: readAgentCheckpoint(entry.seq, agentId, seq => bySeq.get(seq) ?? null),
          stepsUsed: state.stepsUsed, workspace: state.workspace, causalHeads: state.causalHeads ?? null };
      });
      const checkpoint = history.at(-1)!;
      if (checkpoint.causalHeads == null) { preview.untracked.push(agentId); continue; }
      const invalidatedHeads = checkpoint.causalHeads.filter(seq => invalid.has(seq));
      if (!invalidatedHeads.length) { preview.unaffected.push(agentId); continue; }
      const invalidatedNodes = graph.view(checkpoint.causalHeads, checkpoint.seq).nodes
        .filter(node => invalid.has(node.seq)).map(node => node.seq);
      const restartFrom = [...history].reverse().find(candidate => candidate.causalHeads != null
        && candidate.causalHeads.every(seq => !invalid.has(seq)));
      preview.affected.push({ agentId, checkpoint, invalidatedHeads, invalidatedNodes,
        ...(restartFrom ? { restartFrom } : {}),
        recomputation: graph.explainRecomputation(changed.filter(seq => invalidatedNodes.includes(seq)),
          checkpoint.seq, checkpoint.causalHeads),
      });
    }
    // Runtime previews use agent creation order, independent of caller selection order.
    const order = new Map(events.filter(entry => entry.type === 'AGENT_STATE' && entry.payload.transition === 'created')
      .map(entry => [(entry.payload.state as AgentState).id, entry.seq]));
    const compare = (left: string, right: string) => order.get(left)! - order.get(right)!;
    preview.affected.sort((left, right) => compare(left.agentId, right.agentId));
    preview.unaffected.sort(compare);
    preview.untracked.sort(compare);
    return structuredClone({ seq: event.seq, runId: event.runId!, validationSeq, checkpoints, preview });
  });
}

export type AgentCausalRefreshPublication = { agentId: string; checkpointSeq: number } & (
  | { status: 'pending' }
  | { status: 'repaired'; seq: number; workspace: AgentState['workspace'] }
  | { status: 'skipped'; seq: number; reason: string }
  | { status: 'failed'; seq: number; error: string }
);

export interface AgentCausalRefreshExecutionRecord extends AgentCausalRefreshPlanRecord {
  repair?: { seq: number; txId: string };
  /** Pending means no durable outcome at this cutoff, not proof of failure. */
  publications: AgentCausalRefreshPublication[];
}

/** Explicit publication lineage, including partial batches. Checkpoint binding is
 * not an OCC commit. Preparation failures and legacy plans remain pending.
 */
export function listAgentCausalRefreshExecutions(
  domain: ExecutionDomain, options: { runId?: string; atSeq?: number } = {},
): AgentCausalRefreshExecutionRecord[] {
  const plans = listAgentCausalRefreshPlans(domain, options);
  const events = domain.getStore().getJournalEvents(domain.domainId)
    .filter(event => event.seq <= (options.atSeq ?? Number.MAX_SAFE_INTEGER));
  return plans.map(plan => {
    const preparations = events.filter(event => event.type === 'AGENT_CAUSAL_REFRESH_PREPARED'
      && event.payload.planSeq === plan.seq);
    if (preparations.length > 1) throw new Error('Duplicate causal refresh preparation');
    const prepared = preparations[0];
    if (prepared && (prepared.payload.version !== 1 || prepared.seq <= plan.seq
      || typeof prepared.payload.txId !== 'string')) throw new Error('Invalid causal refresh preparation');
    const publications = plan.preview.affected.map(({ agentId, checkpoint }): AgentCausalRefreshPublication => {
      const identity = { agentId, checkpointSeq: checkpoint.seq };
      if (!prepared) return { ...identity, status: 'pending' };
      const outcomes = events.filter(event =>
        (event.type === 'AGENT_STATE' && event.payload.transition === 'causal_repaired'
          && event.payload.refreshPreparationSeq === prepared.seq
          && (event.payload.state as AgentState).id === agentId)
        || (event.type === 'AGENT_CAUSAL_REFRESH_OUTCOME' && event.payload.preparationSeq === prepared.seq
          && event.payload.agentId === agentId));
      if (outcomes.length > 1) throw new Error('Duplicate causal refresh publication');
      const outcome = outcomes[0];
      if (!outcome) return { ...identity, status: 'pending' };
      if (outcome.seq <= prepared.seq) throw new Error('Invalid causal refresh publication order');
      if (outcome.type === 'AGENT_STATE') {
        if (outcome.payload.version !== 2 || outcome.payload.checkpointRef !== checkpoint.seq) {
          throw new Error('Invalid causal refresh publication reference');
        }
        // Validate that the published checkpoint data remains resolvable.
        readAgentCheckpoint(outcome.seq, agentId, seq => domain.getStore().getJournalEvent(domain.domainId, seq));
        return { ...identity, status: 'repaired', seq: outcome.seq,
          workspace: structuredClone((outcome.payload.state as AgentState).workspace) };
      }
      if (outcome.payload.version !== 1 || outcome.payload.checkpointSeq !== checkpoint.seq) {
        throw new Error('Invalid causal refresh outcome reference');
      }
      if (outcome.payload.status === 'failed' && typeof outcome.payload.error === 'string') {
        return { ...identity, status: 'failed', seq: outcome.seq, error: outcome.payload.error };
      }
      if (outcome.payload.status === 'skipped' && typeof outcome.payload.reason === 'string') {
        return { ...identity, status: 'skipped', seq: outcome.seq, reason: outcome.payload.reason };
      }
      throw new Error('Invalid causal refresh outcome');
    });
    return { ...plan, ...(prepared ? { repair: { seq: prepared.seq, txId: prepared.payload.txId as string } } : {}),
      publications };
  });
}
