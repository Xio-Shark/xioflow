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

it.each(['stable', 'input-changed'] as const)('validates pending recovery after SIGKILL before distribution: %s', async recoveryInput => {
  const report = await runCausalRecoveryBenchmark({ trials: 1, branches: 2, hashRounds: 2,
    interruption: 'sigkill', publication: 'input-changed', recoveryInput });
  expect(report.schemaVersion).toBe(6);
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.success).toBe(true);
    expect(sample.preservedPublications).toBe(true);
    expect(sample).toMatchObject({ processCrash: { signal: 'SIGKILL', gracefulClose: false } });
    expect(sample.publication).toMatchObject({ firstStatus: 'conflict', finalStatus: 'committed',
      checkpointsCurrent: true, rootCorrect: true, transactionHistoryVerified: true });
    const changed = recoveryInput === 'input-changed';
    expect(sample.recoveryExecutionToolCalls).toBe(changed || sample.mode === 'rerun-unfinished' ? 2 : 0);
    expect(sample.recoveryEvidence.bindingCalls).toBe(changed && sample.mode === 'durable-recovery' ? 2 : 1);
    expect(sample.recoveryEvidence.rejectedBindings).toBe(changed && sample.mode === 'durable-recovery' ? 1 : 0);
    expect(sample.recoveryEvidence.distributionValidationReads).toBe(sample.recoveryEvidence.bindingCalls);
    if (sample.mode === 'validated-recovery') {
      expect(sample.recoveryEvidence.resumeStatus).toBe(changed ? 'stale' : 'resumed');
      expect(sample.recoveryEvidence.resumeValidationSeq).toBeGreaterThan(0);
      expect(sample.recoveryEvidence.validationRecorded).toBe(true);
      expect(sample.recoveryEvidence.probeCalls).toBe(2);
    }
  }
}, 30_000);


it.each(['tampered', 'deleted'] as const)('rejects damaged shared output after SIGKILL: %s', async recoveryOutput => {
  const report = await runCausalRecoveryBenchmark({ trials: 1, branches: 2, hashRounds: 2,
    interruption: 'sigkill', publication: 'stable', recoveryOutput, outputFileBytes: [17, 131072] });
  expect(report.recoveryOutput).toBe(recoveryOutput);
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.success).toBe(true);
    expect('processCrash' in sample && sample.processCrash.signal).toBe('SIGKILL');
    expect(sample.recoveryExecutionToolCalls).toBe(2);
    expect(sample.recoveryEvidence).toMatchObject({
      bindingCalls: sample.mode === 'durable-recovery' ? 2 : 1,
      rejectedBindings: sample.mode === 'durable-recovery' ? 1 : 0,
      distributionOutputChecks: sample.mode === 'durable-recovery' ? 2 : 1,
      outputValidationRecorded: true,
    });
    expect(sample.publication).toMatchObject({ firstStatus: 'committed', rootCorrect: true,
      checkpointsCurrent: true, transactionHistoryVerified: true });
    if (sample.mode === 'validated-recovery') {
      expect(sample.recoveryEvidence).toMatchObject({ resumeStatus: 'output_invalid',
        outputStatus: 'changed', outputChecks: 1, resumeValidationSeq: null, probeCalls: 1 });
      expect(sample.recoveryEvidence.outputSeq).toBeGreaterThan(0);
      expect(sample.recoveryEvidence.prebindValidationMs).toBeGreaterThan(0);
    }
  }
}, 30_000);
