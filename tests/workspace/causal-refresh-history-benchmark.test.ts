import { describe, expect, it } from 'vitest';
import { runCausalRefreshHistoryBenchmark } from '../../src/testing/causal-refresh-history-benchmark.js';

describe('temporal refresh benchmark', () => {
  it('freezes real training telemetry and evaluates independent probes beside paired policies', async () => {
    const report = await runCausalRefreshHistoryBenchmark({ hashRounds: 2, trainingChanges: [0, 1],
      evaluationChanges: [0, 1], staticForecast: { changeProbability: 1,
        probeUnchanged: 1e6, probeChanged: 1e6, refreshChanged: 1e6 } });
    expect(report.modelTokens).toBeNull();
    expect(report.estimate.training).toEqual({ unchanged: 1, changed: 1, failed: 0, missing: 0, recompute: 0 });
    expect(report.estimate.heldOut).toEqual({ unchanged: 1, changed: 1, failed: 0, missing: 0, recompute: 0 });
    expect(report.estimate.forecast).toEqual(report.frozenForecast);
    expect(report.estimate.evaluation?.samples).toBe(2);
    expect(report.frozenForecast.changeProbability).toBe(0.5);
    for (const sample of report.samples) {
      expect(sample.static.strategy).toBe('recompute');
      expect(sample.static.commitValidation).toBe('observations');
      expect(sample.probe.strategy).toBe('probe');
      expect(sample.probe.status).toBe(sample.changedBranches ? 'committed' : 'unchanged');
      expect(sample.history.outputHashes).toEqual(sample.probe.outputHashes);
      expect(sample.static.outputHashes).toEqual(sample.probe.outputHashes);
      for (const measured of [sample.probe, sample.static, sample.history]) {
        expect(measured.success).toBe(true);
        expect(measured.decisionSeq).toBeGreaterThan(report.trainingAtSeq);
        expect(measured.telemetrySeq).toBeGreaterThan(measured.decisionSeq);
        expect(measured.callbackDurationMs).toBeGreaterThanOrEqual(0);
        expect(measured.elapsedMs).toBeGreaterThan(0);
        if (measured.status === 'committed') expect(measured.commitValidation).toBe('observations');
      }
    }
    expect(report.summary.every(row => row.successRate === 1)).toBe(true);
  }, 30_000);

  it.each([{ trainingChanges: [0, 0] }, { trainingChanges: [1] }, { evaluationChanges: [] },
    { evaluationChanges: [3] }, { hashRounds: 0 }, { staticForecast: { changeProbability: 2,
      probeUnchanged: 1, probeChanged: 1, refreshChanged: 1 } }])('rejects invalid protocol %j', async options => {
    await expect(runCausalRefreshHistoryBenchmark(options)).rejects.toThrow();
  });
});
