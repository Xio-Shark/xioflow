/** Same-unit estimates for the entire pending batch, including distribution.
 * Rejection includes stale observations, invalid output and reported probe failure.
 * Forecasts are scheduling hints, never evidence that results can be reused.
 */
export interface AgentCausalResumeForecast {
  rejectionProbability: number;
  validationAccepted: number;
  validationRejected: number;
  resume: number;
  recompute: number;
}

export function planAgentCausalResumePolicy(forecast: AgentCausalResumeForecast) {
  const { rejectionProbability: p, validationAccepted, validationRejected, resume, recompute } = forecast;
  if (!Number.isFinite(p) || p < 0 || p > 1
    || [validationAccepted, validationRejected, resume, recompute].some(n => !Number.isFinite(n) || n < 0)) {
    throw new Error('Invalid causal resume forecast');
  }
  const accepted = validationAccepted + resume;
  const rejected = validationRejected + recompute;
  const expectedValidationCost = (1 - p) * accepted + p * rejected;
  if (![accepted, rejected, expectedValidationCost].every(Number.isFinite)) {
    throw new Error('Causal resume forecast cost overflow');
  }
  return { strategy: recompute < expectedValidationCost ? 'recompute' as const : 'validate' as const,
    forecast: { rejectionProbability: p, validationAccepted, validationRejected, resume, recompute },
    expectedValidationCost, recomputeCost: recompute };
}
