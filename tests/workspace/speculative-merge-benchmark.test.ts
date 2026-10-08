import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runSpeculativeMergeBenchmark } from '../../src/testing/speculative-merge-benchmark.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('speculative merge benchmark', () => {
  it('counts the losing attempt and validates every merged output against an independent oracle', async () => {
    const report = await runSpeculativeMergeBenchmark({ trials: 2, branches: 3, hashRounds: 2 });
    expect(report.modelTokens).toBeNull();
    expect(report.samples).toHaveLength(4);
    for (let trial = 0; trial < 2; trial++) {
      const samples = report.samples.filter((sample) => sample.trial === trial);
      const full = samples.find((sample) => sample.mode === 'full-rerun')!;
      const repair = samples.find((sample) => sample.mode === 'incremental-repair')!;
      expect(full).toMatchObject({ initialToolCalls: 10, recoveryToolCalls: 9, executionToolCalls: 19,
        changeDetectionReads: 0, reuseValidationReads: 0, materializationWrites: 0, reusedNodes: 0 });
      expect(repair).toMatchObject({ initialToolCalls: 10, recoveryToolCalls: 3, executionToolCalls: 13,
        changeDetectionReads: 3, reuseValidationReads: 4, materializationWrites: 2, reusedNodes: 6 });
      for (const sample of samples) {
        expect(sample).toMatchObject({ changedBranch: trial, success: true, correctOutputs: 3,
          conflictDetected: true, winners: ['update', 'transform'] });
        expect(sample.commitValidation).not.toBeNull();
        expect(sample.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(sample.outputHashes).toEqual(Array.from({ length: 3 }, (_, branch) =>
          hash(hash(hash(`branch-${branch}:${branch === trial ? `changed-${trial}` : 'initial'}`)))));
      }
    }
    expect(report.summary.map((row) => row.successRate)).toEqual([1, 1]);
    expect(report.summary.map((row) => row.meanExecutionToolCalls)).toEqual([19, 13]);
  }, 30_000);

  it('reports no savings when the entire graph is invalidated', async () => {
    const report = await runSpeculativeMergeBenchmark({ trials: 1, branches: 1, hashRounds: 1 });
    for (const sample of report.samples) expect(sample).toMatchObject({ success: true,
      executionToolCalls: 7, recoveryToolCalls: 3, reusedNodes: 0, materializationWrites: 0 });
  }, 30_000);

  it.each([{ trials: 0 }, { branches: NaN }, { hashRounds: 1.5 }])('rejects invalid configuration %j', async (options) => {
    await expect(runSpeculativeMergeBenchmark(options)).rejects.toThrow('positive safe integer');
  });
});
