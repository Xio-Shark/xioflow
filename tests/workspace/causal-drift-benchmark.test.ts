import { expect, it } from 'vitest';
import { runCausalDriftBenchmark } from '../../src/testing/causal-drift-benchmark.js';

it('freezes distinct eras, repeats paired trials, and scores a shared independent holdout', async () => {
  const report = await runCausalDriftBenchmark({ repetitions: 2, hashRounds: 2,
    oldChanges: [false, false, false, true], recentChanges: [false, true, true, true],
    evaluationChanges: [true, false] });
  expect(report.modelTokens).toBeNull();
  expect(report.pairedCallbackDeltaMs.samples).toBe(4);
  expect(report.summary.every(s => s.successRate === 1)).toBe(true);
  for (const repetition of report.repetitions) {
    expect(repetition.history.forecast?.changeProbability).toBe(0.5);
    expect(repetition.recent.forecast?.changeProbability).toBe(0.75);
    expect(repetition.recent.excludedDecisions).toBe(4);
    expect(repetition.history.heldOut).toEqual(repetition.recent.heldOut);
    expect(repetition.history.heldOut).toMatchObject({ changed: 1, unchanged: 1, recompute: 0 });
    expect(repetition.history.drift?.brierScore).toBe(0.25);
    expect(repetition.recent.drift?.brierScore).toBe(0.3125);
    expect(repetition.history.evaluation?.samples).toBe(2);
    for (const sample of repetition.samples) {
      expect(sample.history.outputHash).toBe(sample.probe.outputHash);
      expect(sample.recent.outputHash).toBe(sample.probe.outputHash);
      for (const measured of [sample.history, sample.recent, sample.probe]) {
        expect(measured.success).toBe(true);
        expect(measured.telemetry.decisionSeq).toBeGreaterThan(repetition.trainingAtSeq);
        if (measured.status === 'committed') expect(measured.validation).toBe('observations');
      }
    }
  }
  expect(report.repetitions[0].samples[0].order).toEqual(['history', 'recent']);
  expect(report.repetitions[1].samples[0].order).toEqual(['recent', 'history']);
}, 30_000);

it.each([{ repetitions: 0 }, { hashRounds: NaN }, { oldChanges: [] },
  { recentChanges: [true] }, { evaluationChanges: [] },
  { evaluationChanges: [1] as unknown as boolean[] }])('rejects invalid protocol %j', async options => {
  await expect(runCausalDriftBenchmark(options)).rejects.toThrow();
});
