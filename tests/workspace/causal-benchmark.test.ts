import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCausalRepairBenchmark } from '../../src/testing/causal-repair-benchmark.js';

describe('reproducible causal repair benchmark', () => {
  it('compares identical disturbances, counts validation and verifies every output across repeated trials', async () => {
    const report = await runCausalRepairBenchmark({ trials: 2, branches: 3, hashRounds: 2 });
    expect(report.modelTokens).toBeNull();
    expect(report.samples).toHaveLength(6);
    for (let trial = 0; trial < 2; trial++) {
      const samples = report.samples.filter((sample) => sample.trial === trial);
      const full = samples.find((sample) => sample.mode === 'full-rerun')!;
      const repair = samples.find((sample) => sample.mode === 'incremental-repair')!;
      const unchecked = samples.find((sample) => sample.mode === 'unchecked-reuse')!;
      expect(full).toMatchObject({ changedBranch: trial, success: true, correctOutputs: 3,
        executionToolCalls: 9, changeDetectionReads: 0, reuseValidationReads: 0, reusedNodes: 0 });
      expect(repair).toMatchObject({ changedBranch: trial, success: true, correctOutputs: 3,
        executionToolCalls: 3, changeDetectionReads: 3, reuseValidationReads: 4, reusedNodes: 6 });
      expect(repair.outputHashes).toEqual(full.outputHashes);
      let expected = `branch-${trial}:changed-${trial}`;
      for (let round = 0; round < 3; round++) expected = createHash('sha256').update(expected).digest('hex');
      expect(full.outputHashes[trial]).toBe(expected);
      expect(repair.commitValidation).not.toBeNull();
      expect(full.commitValidation).not.toBeNull();
      expect(unchecked).toMatchObject({ success: false, correctOutputs: 2, executionToolCalls: 0,
        changeDetectionReads: 0, reuseValidationReads: 0, reusedNodes: 9, commitValidation: null });
      for (let branch = 0; branch < 3; branch++) {
        if (branch === trial) expect(unchecked.outputHashes[branch]).not.toBe(full.outputHashes[branch]);
        else expect(unchecked.outputHashes[branch]).toBe(full.outputHashes[branch]);
      }
      for (const sample of samples) expect(sample.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(report.summary.map((row) => row.successRate)).toEqual([1, 1, 0]);
    expect(report.summary.map((row) => row.meanExecutionToolCalls)).toEqual([9, 3, 0]);
  }, 30_000);

  it('handles a fully invalidated graph without claiming any reuse', async () => {
    const report = await runCausalRepairBenchmark({ trials: 1, branches: 1, hashRounds: 1 });
    expect(report.samples.find((sample) => sample.mode === 'incremental-repair')).toMatchObject({
      success: true, executionToolCalls: 3, changeDetectionReads: 1, reuseValidationReads: 0, reusedNodes: 0,
    });
    expect(report.samples.find((sample) => sample.mode === 'unchecked-reuse')?.correctOutputs).toBe(0);
  }, 30_000);

  it.each([{ trials: 0 }, { branches: -1 }, { hashRounds: 1.5 }, { trials: NaN }])('rejects invalid fixture configuration %j', async (options) => {
    await expect(runCausalRepairBenchmark(options)).rejects.toThrow('positive safe integer');
  });
});
