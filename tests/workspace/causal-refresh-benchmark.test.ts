import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCausalRefreshBenchmark } from '../../src/testing/causal-refresh-benchmark.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('causal refresh benchmark', () => {
  it('measures actual probe, repair, reuse and mandatory publication replay against equal guarantees', async () => {
    const report = await runCausalRefreshBenchmark({ trials: 2, branches: 3, hashRounds: 2 });
    expect(report.modelTokens).toBeNull();
    expect(report.samples).toHaveLength(8);
    for (let trial = 0; trial < 2; trial++) {
      const samples = report.samples.filter((sample) => sample.trial === trial);
      const full = samples.find((sample) => sample.mode === 'full-rerun')!;
      const refresh = samples.find((sample) => sample.mode === 'causal-refresh')!;
      const unchecked = samples.find((sample) => sample.mode === 'unchecked-reuse')!;
      expect(full).toMatchObject({ success: true, executionToolCalls: 6, probeToolCalls: 0,
        reuseToolCalls: 0, commitReplayToolCalls: 6, totalToolCalls: 12, transactionsStarted: 1,
        commitValidation: 'observations', snapshotsCaptured: 2 });
      expect(refresh).toMatchObject({ success: true, executionToolCalls: 2, probeToolCalls: 5,
        reuseToolCalls: 4, commitReplayToolCalls: 6, totalToolCalls: 17, transactionsStarted: 4,
        commitValidation: 'observations', snapshotsCaptured: 3 });
      const cached = samples.find((sample) => sample.mode === 'causal-refresh-reuse')!;
      expect(cached).toMatchObject({ success: true, probeToolCalls: 5, reusedProbeSteps: 0, totalToolCalls: 17 });
      expect(cached.outputHashes).toEqual(full.outputHashes);
      expect(refresh.outputHashes).toEqual(full.outputHashes);
      expect(refresh.outputHashes).toEqual([0, 1, 2].map((branch) =>
        hash(hash(hash(branch === trial ? `changed-${trial}-${branch}` : `initial-${branch}`)))));
      expect(unchecked).toMatchObject({ success: false, correctOutputs: 2, totalToolCalls: 0,
        commitValidation: null, transactionsStarted: 0, snapshotsCaptured: 0 });
      expect(refresh.elapsedMs).toBeGreaterThan(0);
    }
    expect(report.summary.map((row) => row.successRate)).toEqual([1, 1, 1, 0]);
    expect(report.summary.map((row) => row.meanTotalToolCalls)).toEqual([12, 17, 17, 0]);
  }, 30_000);

  it.each([0, 2])('covers %i changed inputs including unchanged fast path and full invalidation', async (changedBranches) => {
    const report = await runCausalRefreshBenchmark({ trials: 1, branches: 2, hashRounds: 1, changedBranches });
    const refresh = report.samples.find((sample) => sample.mode === 'causal-refresh')!;
    expect(refresh).toMatchObject({ success: true, executionToolCalls: changedBranches * 2,
      probeToolCalls: 4 - changedBranches, reuseToolCalls: 0,
      commitReplayToolCalls: changedBranches ? 4 : 0,
      status: changedBranches ? 'committed' : 'unchanged', transactionsStarted: changedBranches ? 3 : 2 });
    expect(report.samples.find((sample) => sample.mode === 'unchecked-reuse')!.success).toBe(changedBranches === 0);
  }, 30_000);


  it.each([
    { changedBranches: 0, changeSharedInput: false },
    { changedBranches: 1, changeSharedInput: false },
    { changedBranches: 3, changeSharedInput: false },
    { changedBranches: 0, changeSharedInput: true },
  ])('measures shared evidence reuse through publication: %j', async (changes) => {
    const report = await runCausalRefreshBenchmark({ trials: 1, branches: 3, hashRounds: 2,
      sharedInput: true, ...changes });
    const [full, refresh, cached, unchecked] = ['full-rerun', 'causal-refresh', 'causal-refresh-reuse', 'unchecked-reuse']
      .map(mode => report.samples.find(sample => sample.mode === mode)!);
    const changed = changes.changeSharedInput || changes.changedBranches > 0;
    const execution = changes.changeSharedInput ? 7 : 2 * changes.changedBranches;
    const probe = changes.changeSharedInput ? 3 : 9 - changes.changedBranches;
    const reuse = changed && !changes.changeSharedInput ? 7 - execution : 0;
    expect(full).toMatchObject({ success: true, executionToolCalls: 7, commitReplayToolCalls: 7, totalToolCalls: 14 });
    for (const sample of [refresh, cached]) {
      expect(sample).toMatchObject({ success: true, executionToolCalls: execution,
        reuseToolCalls: reuse, commitReplayToolCalls: changed ? 7 : 0,
        commitValidation: changed ? 'observations' : null, status: changed ? 'committed' : 'unchanged' });
      expect(sample.outputHashes).toEqual(full.outputHashes);
      expect(sample.totalToolCalls).toBe(execution + reuse + sample.probeToolCalls + (changed ? 7 : 0));
    }
    expect(refresh).toMatchObject({ probeToolCalls: probe, reusedProbeSteps: 0 });
    expect(cached).toMatchObject({ probeToolCalls: probe - 2, reusedProbeSteps: 2 });
    expect(cached.totalToolCalls).toBe(refresh.totalToolCalls - 2);
    expect(unchecked).toMatchObject({ success: !changed,
      correctOutputs: changes.changeSharedInput ? 0 : 3 - changes.changedBranches });
  }, 30_000);

  it.each([{ trials: 0 }, { branches: 1.5 }, { hashRounds: NaN }, { changedBranches: -1 },
    { branches: 2, changedBranches: 3 }, { changedBranches: Infinity }, { changeSharedInput: true }])('rejects invalid configuration %j', async (options) => {
    await expect(runCausalRefreshBenchmark(options)).rejects.toThrow();
  });
});
