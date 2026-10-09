import type { ExecutionDomain } from '../domain.js';
import { planAgentCausalResumePolicy, type AgentCausalResumeForecast } from './causal-resume-cost.js';
import { listAgentCausalResumeTelemetry } from './causal-resume-telemetry.js';

export interface AgentCausalResumeHistoryCounts {
  accepted: number;
  rejected: number;
  recompute: number;
  failed: number;
  missing: number;
  unmeasured: number;
}

/** Fit comparable successful validation paths, never infer labels from direct recomputation.
 * The host explicitly adopts the forecast; it is not evidence permitting reuse.
 */
export function estimateAgentCausalResumeHistory(domain: ExecutionDomain, options: {
  taskKey: string;
  pendingAgents: number;
  trainingAtSeq: number;
  trainingAfterSeq?: number;
  atSeq?: number;
}) {
  const { taskKey, pendingAgents, trainingAtSeq } = options;
  const trainingAfterSeq = options.trainingAfterSeq ?? 0;
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!taskKey.trim() || !Number.isSafeInteger(pendingAgents) || pendingAgents < 1) {
    throw new Error('Invalid causal resume history cohort');
  }
  if (![trainingAfterSeq, trainingAtSeq, atSeq].every(n => Number.isSafeInteger(n) && n >= 0)
    || trainingAfterSeq > trainingAtSeq || trainingAtSeq > atSeq) {
    throw new Error('Invalid causal resume history sequence cutoffs');
  }
  const counts = (): AgentCausalResumeHistoryCounts => ({ accepted: 0, rejected: 0,
    recompute: 0, failed: 0, missing: 0, unmeasured: 0 });
  const training = counts();
  const heldOut = counts();
  let excludedDecisions = 0;
  const acceptedCosts: number[] = [];
  const rejectedCosts: number[] = [];
  const rebuildCosts: number[] = [];
  const heldOutCosts: number[] = [];
  for (const report of listAgentCausalResumeTelemetry(domain, { taskKey, atSeq })) {
    if (report.pendingAgents !== pendingAgents) continue;
    if (report.decisionSeq <= trainingAfterSeq) { excludedDecisions++; continue; }
    const isTraining = report.decisionSeq <= trainingAtSeq;
    const partition = isTraining ? training : heldOut;
    if (report.outcomeSeq === undefined || (isTraining && report.outcomeSeq > trainingAtSeq)) {
      partition.missing++; continue;
    }
    if (report.status === 'failed' || (report.outcomes &&
      (report.outcomes.failed > 0 || report.outcomes.skipped > 0))) {
      partition.failed++; continue;
    }
    if (!report.phases || !report.outcomes || report.outcomes.repaired !== pendingAgents) {
      partition.unmeasured++; continue;
    }
    const { validationAndResumeMs: validation, recomputeMs: recompute } = report.phases;
    if (![validation, recompute, validation + recompute].every(n => Number.isFinite(n) && n >= 0)) {
      throw new Error('Invalid causal resume history phase duration');
    }
    if (report.policy.strategy === 'recompute') { partition.recompute++; continue; }
    const accepted = report.path === 'resumed' && report.rejection === undefined && recompute === 0;
    const rejected = report.path === 'recomputed' &&
      ['stale', 'validation_failed', 'output_invalid'].includes(report.rejection ?? '');
    if (!accepted && !rejected) { partition.unmeasured++; continue; }
    if (accepted) partition.accepted++; else partition.rejected++;
    if (!isTraining) heldOutCosts.push(validation + recompute);
    else if (accepted) acceptedCosts.push(validation);
    else { rejectedCosts.push(validation); rebuildCosts.push(recompute); }
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value / values.length, 0);
  // Existing telemetry combines accepted validation and distribution. Preserve that
  // measured sum in validationAccepted; resume=0 is an encoding, not a free binding.
  const forecast: AgentCausalResumeForecast | null = training.accepted && training.rejected ? {
    rejectionProbability: training.rejected / (training.accepted + training.rejected),
    validationAccepted: mean(acceptedCosts), resume: 0,
    validationRejected: mean(rejectedCosts), recompute: mean(rebuildCosts),
  } : null;
  const policy = forecast ? planAgentCausalResumePolicy(forecast) : null;
  const evaluation = policy && heldOutCosts.length ? {
    samples: heldOutCosts.length, expectedValidationCost: policy.expectedValidationCost,
    meanActualCost: mean(heldOutCosts),
    meanAbsoluteError: mean(heldOutCosts.map(cost => Math.abs(cost - policy.expectedValidationCost))),
    rejectionProbability: heldOut.rejected / heldOutCosts.length,
    brierScore: (heldOut.accepted * forecast!.rejectionProbability ** 2
      + heldOut.rejected * (1 - forecast!.rejectionProbability) ** 2) / heldOutCosts.length,
  } : null;
  return { taskKey, pendingAgents, trainingAfterSeq, trainingAtSeq, atSeq, excludedDecisions,
    unit: 'phase_duration_ms' as const, training, heldOut, forecast, policy, evaluation };
}
