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
  it.each(['stable', 'input-changed'] as const)('publishes recovered results with OCC: %s', async publication => {
    const report = await runCausalRecoveryBenchmark({ trials: 1, branches: 2, hashRounds: 2, publication });
    expect(report.scope).toBe('recovery-through-occ-publication');
    for (const sample of report.samples) {
      expect(sample.success).toBe(true);
      expect(sample.publication).toMatchObject({ scenario: publication, finalStatus: 'committed',
        validation: 'observations', transactionHistoryVerified: true,
        firstStatus: publication === 'stable' ? 'committed' : 'conflict',
        conflictReason: publication === 'stable' ? null : 'observation_changed',
        staleOutputBlocked: true, checkpointsCurrent: true, rootCorrect: true,
        commitAttempts: publication === 'stable' ? 1 : 2,
        commitReplayToolCalls: publication === 'stable' ? 2 : 3,
        executionToolCalls: publication === 'stable' ? 0 : sample.mode === 'durable-recovery' ? 2 : 4,
        probeCalls: publication === 'stable' ? 0 : 2 });
    }
  });
  it('rejects invalid workload sizes before allocating resources', async () => {
    // Runtime callers (including the CLI) are not constrained by TypeScript unions.
    await expect(runCausalRecoveryBenchmark({ interruption: 'invalid' as 'close' })).rejects.toThrow('Invalid interruption');
    await expect(runCausalRecoveryBenchmark({ recoveryOutput: 'invalid' as 'stable' })).rejects.toThrow('Invalid recoveryOutput');
    await expect(runCausalRecoveryBenchmark({ branches: 1 })).rejects.toThrow('Invalid branches');
    await expect(runCausalRecoveryBenchmark({ trials: 0 })).rejects.toThrow('Invalid trials');
    await expect(runCausalRecoveryBenchmark({ hashRounds: NaN })).rejects.toThrow('Invalid hashRounds');
  });
});

it.each(['stable', 'input-changed'] as const)('compares resume validation before stable OCC publication: %s', async recoveryInput => {
  const report = await runCausalRecoveryBenchmark({ trials: 1, branches: 2, hashRounds: 2,
    recoveryInput, publication: 'stable' });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.success).toBe(true);
    expect(sample.preservedPublications).toBe(true);
    expect(sample.publication).toMatchObject({ firstStatus: 'committed', finalStatus: 'committed',
      checkpointsCurrent: true, rootCorrect: true });
  }
  await expect(runCausalRecoveryBenchmark({ recoveryInput: 'invalid' as 'stable' })).rejects.toThrow('Invalid recoveryInput');
});
