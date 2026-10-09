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
