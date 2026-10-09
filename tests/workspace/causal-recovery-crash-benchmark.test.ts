import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildDist, repoRoot } from '../support/build-dist.js';

buildDist();
const { runCausalRecoveryBenchmark } = await import(pathToFileURL(path.join(repoRoot,
  'dist/testing/causal-recovery-benchmark.js')).href) as typeof import('../../src/testing/causal-recovery-benchmark.js');

it.each(['stable', 'input-changed'] as const)('recovers an actually killed worker and publishes via OCC: %s', async publication => {
  const report = await runCausalRecoveryBenchmark({ trials: 1, branches: 2, hashRounds: 2,
    interruption: 'sigkill', publication });
  expect(report.interruption).toBe('sigkill');
  expect(report.samples).toHaveLength(4);
  for (const sample of report.samples) {
    expect(sample.success).toBe(true);
    expect(sample.historySurvived).toBe(true);
    expect(sample.preservedPublications).toBe(true);
    expect(sample.injectedFaults).toBe(1);
    expect(sample.recoveryExecutionToolCalls).toBe(sample.mode === 'durable-recovery' ? 0 : 2);
    expect(sample).toMatchObject({ processCrash: { signal: 'SIGKILL', gracefulClose: false } });
    expect(sample.publication).toMatchObject({ firstStatus: publication === 'stable' ? 'committed' : 'conflict',
      finalStatus: 'committed', staleOutputBlocked: true, checkpointsCurrent: true,
      rootCorrect: true, transactionHistoryVerified: true });
  }
}, 30_000);
