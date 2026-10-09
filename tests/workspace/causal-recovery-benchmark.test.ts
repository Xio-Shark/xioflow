import { describe, expect, it } from 'vitest';
import { runCausalRecoveryBenchmark } from '../../src/testing/causal-recovery-benchmark.js';

describe('causal recovery fault benchmark', () => {
  it('reopens durable evidence, preserves settled agents and avoids recomputation', async () => {
    const report = await runCausalRecoveryBenchmark({ trials: 1, branches: 2, hashRounds: 2 });
    expect(report.modelTokens).toBeNull();
    expect(report.samples).toHaveLength(4);
    for (const sample of report.samples) {
      expect(sample.success).toBe(true);
      expect(sample.correctOutputs).toBe(2);
      expect(sample.injectedFaults).toBe(1);
      expect(sample.bindingCalls).toBe(3);
      expect(sample.distributionWrites).toBe(3);
      expect(sample.executionBeforeRecovery).toBe(2);
      expect(sample.recoveryExecutionToolCalls).toBe(sample.mode === 'durable-recovery' ? 0 : 2);
      expect(sample.probeCalls).toBe(sample.mode === 'durable-recovery' ? 2 : 3);
      const pendingOldPlan = sample.mode === 'rerun-unfinished' && sample.fault === 'outcome-interruption';
      expect(sample.cleanedForks).toBe(pendingOldPlan ? 0 : 1);
      expect(sample.abandonedForkDisposition).toBe(pendingOldPlan ? 'retain' : 'review');
      expect(sample.recoveryMs).toBeGreaterThan(0);
    }
  });
  it('rejects invalid workload sizes before allocating resources', async () => {
    await expect(runCausalRecoveryBenchmark({ branches: 1 })).rejects.toThrow('Invalid branches');
    await expect(runCausalRecoveryBenchmark({ trials: 0 })).rejects.toThrow('Invalid trials');
    await expect(runCausalRecoveryBenchmark({ hashRounds: NaN })).rejects.toThrow('Invalid hashRounds');
  });
});
