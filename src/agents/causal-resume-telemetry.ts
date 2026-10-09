import type { ExecutionDomain } from '../domain.js';
import type { planAgentCausalResumePolicy } from './causal-resume-cost.js';

export interface AgentCausalResumeTelemetry {
  decisionSeq: number;
  runId?: string;
  planSeq: number;
  preparationSeq: number;
  taskKey: string | null;
  forecastUnit: 'ms' | 'host';
  policy: ReturnType<typeof planAgentCausalResumePolicy>;
  pendingAgents: number;
  /** Completion describes control flow, not successful publication of every agent. */
  status: 'pending' | 'completed' | 'failed';
  outcomeSeq?: number;
  path?: string;
  rejection?: string;
  validationSeq?: number;
  outputSeq?: number;
  error?: string;
  durationMs?: number;
  /** Disjoint wall-time phases, including filesystem operations and checkpoint publication. */
  phases?: { validationAndResumeMs: number; recomputeMs: number };
  outcomes?: { repaired: number; skipped: number; failed: number };
  /** Present only for explicitly millisecond forecasts and completed measurements. */
  predictionErrorMs?: number;
}

/** Frozen journal query. Missing/legacy measurements are absent, never zero.
 * Pending means no outcome persisted by atSeq, not that a worker is still alive.
 */
export function listAgentCausalResumeTelemetry(
  domain: ExecutionDomain, options: { runId?: string; taskKey?: string; atSeq?: number } = {},
): AgentCausalResumeTelemetry[] {
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid causal resume telemetry history sequence');
  const records = new Map<number, AgentCausalResumeTelemetry>();
  for (const event of domain.getStore().getJournalEvents(domain.domainId)) {
    if (event.seq > atSeq || (options.runId !== undefined && event.runId !== options.runId)) continue;
    if (!['AGENT_CAUSAL_RESUME_POLICY_SELECTED', 'AGENT_CAUSAL_RESUME_POLICY_COMPLETED',
      'AGENT_CAUSAL_RESUME_POLICY_FAILED'].includes(event.type)) continue;
    const p = event.payload;
    if (p.version !== 1) throw new Error('Unsupported causal resume telemetry version');
    if (event.type === 'AGENT_CAUSAL_RESUME_POLICY_SELECTED') {
      if (options.taskKey !== undefined && p.taskKey !== options.taskKey) continue;
      records.set(event.seq, {
        decisionSeq: event.seq, runId: event.runId, planSeq: p.planSeq as number,
        preparationSeq: p.preparationSeq as number, taskKey: (p.taskKey as string | undefined) ?? null,
        forecastUnit: (p.forecastUnit as 'ms' | 'host' | undefined) ?? 'host',
        policy: structuredClone(p.policy) as AgentCausalResumeTelemetry['policy'],
        pendingAgents: (p.checkpoints as unknown[]).length, status: 'pending',
      });
      continue;
    }
    const entry = records.get(p.decisionSeq as number);
    if (!entry) continue;
    if (entry.status !== 'pending' || entry.runId !== event.runId
      || entry.planSeq !== p.planSeq || entry.preparationSeq !== p.preparationSeq) {
      throw new Error('Invalid causal resume telemetry outcome reference');
    }
    entry.status = event.type === 'AGENT_CAUSAL_RESUME_POLICY_COMPLETED' ? 'completed' : 'failed';
    entry.outcomeSeq = event.seq;
    entry.path = p.status as string | undefined;
    entry.rejection = p.rejection as string | undefined;
    entry.validationSeq = p.validationSeq as number | undefined;
    entry.outputSeq = p.outputSeq as number | undefined;
    entry.error = p.error as string | undefined;
    entry.durationMs = p.durationMs as number | undefined;
    entry.phases = structuredClone(p.phases) as AgentCausalResumeTelemetry['phases'];
    entry.outcomes = structuredClone(p.outcomes) as AgentCausalResumeTelemetry['outcomes'];
    if (entry.forecastUnit === 'ms' && entry.status === 'completed' && entry.durationMs !== undefined) {
      const expected = entry.policy.strategy === 'validate'
        ? entry.policy.expectedValidationCost : entry.policy.recomputeCost;
      entry.predictionErrorMs = entry.durationMs - expected;
    }
  }
  return [...records.values()];
}
