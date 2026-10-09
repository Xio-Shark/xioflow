import type { ExecutionDomain } from '../domain.js';
import type { CausalRefreshForecast } from './causal-refresh-policy.js';
import { listWorkspaceCausalRefreshTelemetry } from './causal-refresh-telemetry.js';

export interface CausalRefreshHistoryCounts {
  unchanged: number;
  changed: number;
  /** Failed/conflicted/thrown executions or callbacks with errors. */
  failed: number;
  /** Decisions without telemetry by the partition's cutoff. */
  missing: number;
  /** Direct recomputation cannot establish whether inputs changed. */
  recompute: number;
}

export interface CausalRefreshHistoryEstimate {
  taskKey: string;
  trainingAtSeq: number;
  atSeq: number;
  unit: 'callback_duration_ms';
  training: CausalRefreshHistoryCounts;
  heldOut: CausalRefreshHistoryCounts;
  /** Both changed and unchanged successful probe samples are required. */
  forecast: CausalRefreshForecast | null;
  evaluation: { samples: number; meanAbsoluteError: number; meanActualCost: number;
    expectedProbeCost: number } | null;
}

/** Fit only completed historical probes; later decisions form an independent temporal holdout.
 * This is an opt-in descriptive estimate, not validity evidence or an unbiased population model.
 */
export function estimateWorkspaceCausalRefreshHistory(
  domain: ExecutionDomain,
  options: { taskKey: string; trainingAtSeq: number; atSeq?: number },
): CausalRefreshHistoryEstimate {
  const { taskKey, trainingAtSeq } = options;
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!taskKey.trim()) throw new Error('Refresh history requires a nonempty taskKey');
  if (![trainingAtSeq, atSeq].every(n => Number.isSafeInteger(n) && n >= 0) || trainingAtSeq > atSeq) {
    throw new Error('Invalid refresh history sequence cutoffs');
  }
  const reports = new Map(listWorkspaceCausalRefreshTelemetry(domain, { atSeq })
    .map(report => [report.decisionSeq, report]));
  const counts = (): CausalRefreshHistoryCounts => ({ unchanged: 0, changed: 0, failed: 0, missing: 0, recompute: 0 });
  const training = counts();
  const heldOut = counts();
  const unchangedCosts: number[] = [];
  const changedProbeCosts: number[] = [];
  const changedRefreshCosts: number[] = [];
  const heldOutCosts: number[] = [];
  for (const event of domain.getStore().getJournalEvents(domain.domainId)) {
    if (event.type !== 'CAUSAL_REFRESH_POLICY_SELECTED' || event.seq > atSeq
      || event.payload.taskKey !== taskKey) continue;
    if (event.payload.version !== 1) throw new Error('Unsupported causal refresh policy version');
    const isTraining = event.seq <= trainingAtSeq;
    const partition = isTraining ? training : heldOut;
    const report = reports.get(event.seq);
    // Late completion of a training decision is neither training evidence nor a holdout decision.
    if (!report || (isTraining && report.seq > trainingAtSeq)) { partition.missing++; continue; }
    if ((report.status !== 'unchanged' && report.status !== 'committed')
      || Object.values(report.callbacks).some(metric => metric.errors > 0)) {
      partition.failed++;
      continue;
    }
    if (report.strategy === 'recompute') { partition.recompute++; continue; }
    const probe = report.callbacks.probe.durationMs;
    const refresh = report.callbacks.reuse.durationMs + report.callbacks.execute.durationMs
      + report.callbacks.commitReplay.durationMs;
    if (![probe, refresh, probe + refresh].every(n => Number.isFinite(n) && n >= 0)) {
      throw new Error('Invalid refresh history callback duration');
    }
    if (report.status === 'unchanged') partition.unchanged++;
    else partition.changed++;
    if (!isTraining) heldOutCosts.push(probe + refresh);
    else if (report.status === 'unchanged') unchangedCosts.push(probe);
    else { changedProbeCosts.push(probe); changedRefreshCosts.push(refresh); }
  }
  // Divide before summing so a valid mean cannot overflow on a large finite sample.
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value / values.length, 0);
  const forecast: CausalRefreshForecast | null = training.changed && training.unchanged ? {
    changeProbability: training.changed / (training.changed + training.unchanged),
    probeUnchanged: mean(unchangedCosts), probeChanged: mean(changedProbeCosts),
    refreshChanged: mean(changedRefreshCosts),
  } : null;
  let evaluation: CausalRefreshHistoryEstimate['evaluation'] = null;
  if (forecast && heldOutCosts.length) {
    const p = forecast.changeProbability;
    const expectedProbeCost = (1 - p) * forecast.probeUnchanged
      + p * forecast.probeChanged + p * forecast.refreshChanged;
    evaluation = { samples: heldOutCosts.length, expectedProbeCost,
      meanActualCost: mean(heldOutCosts),
      meanAbsoluteError: mean(heldOutCosts.map(cost => Math.abs(cost - expectedProbeCost))) };
  }
  return { taskKey, trainingAtSeq, atSeq, unit: 'callback_duration_ms', training, heldOut, forecast, evaluation };
}
