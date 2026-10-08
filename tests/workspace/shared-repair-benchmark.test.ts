import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runSharedRepairBenchmark } from '../../src/testing/shared-repair-benchmark.js';

describe('shared causal repair benchmark', () => {
  it('deduplicates real shared tools while accounting for independent output distribution and commits', async () => {
    const report = await runSharedRepairBenchmark({ trials: 2, branches: 3, hashRounds: 2 });
    expect(report.modelTokens).toBeNull();
    expect(report.samples).toHaveLength(6);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    for (let trial = 0; trial < 2; trial++) {
      const samples = report.samples.filter((sample) => sample.trial === trial);
      const independent = samples.find((sample) => sample.mode === 'independent-repair')!;
      const shared = samples.find((sample) => sample.mode === 'shared-repair')!;
      const unchecked = samples.find((sample) => sample.mode === 'unchecked-reuse')!;
      expect(independent).toMatchObject({ success: true, correctOutputs: 3, executionToolCalls: 9,
        changeDetectionReads: 1, distributionReads: 0, distributionWrites: 0, distributionBytes: 0,
        distributionValidationReads: 0, transactionsStarted: 3 });
      expect(shared).toMatchObject({ success: true, correctOutputs: 3, executionToolCalls: 5,
        changeDetectionReads: 1, distributionReads: 3, distributionWrites: 3, distributionBytes: 198,
        distributionValidationReads: 3, transactionsStarted: 4 });
      expect(shared.outputHashes).toEqual(independent.outputHashes);
      expect(shared.outputHashes).toEqual([0, 1, 2].map((branch) => hash(`${branch}:${hash(hash(`changed-${trial}`))}`)));
      expect(unchecked).toMatchObject({ success: false, correctOutputs: 0, executionToolCalls: 0,
        changeDetectionReads: 0, transactionsStarted: 0, commitValidations: [] });
      expect(unchecked.outputHashes).not.toEqual(shared.outputHashes);
      for (const sample of [independent, shared]) {
        expect(sample.commitValidations).toHaveLength(3);
        expect(sample.commitValidations.every((value) => ['files', 'write_only'].includes(value))).toBe(true);
        expect(sample.elapsedMs).toBeGreaterThan(0);
      }
    }
    expect(report.summary.map((row) => row.successRate)).toEqual([1, 1, 0]);
    expect(report.summary.map((row) => row.meanExecutionToolCalls)).toEqual([9, 5, 0]);
  }, 30_000);

  it('reports no tool savings for a single branch, but still counts distribution overhead', async () => {
    const report = await runSharedRepairBenchmark({ trials: 1, branches: 1, hashRounds: 1 });
    expect(report.samples.find((sample) => sample.mode === 'independent-repair')).toMatchObject({
      success: true, executionToolCalls: 3, transactionsStarted: 1,
    });
    expect(report.samples.find((sample) => sample.mode === 'shared-repair')).toMatchObject({
      success: true, executionToolCalls: 3, transactionsStarted: 2, distributionWrites: 1, distributionBytes: 66,
    });
  }, 30_000);

  it.each([{ trials: 0 }, { branches: -1 }, { hashRounds: 1.5 }, { trials: NaN }])('rejects invalid configuration %j', async (options) => {
    await expect(runSharedRepairBenchmark(options)).rejects.toThrow('positive safe integer');
  });
});
