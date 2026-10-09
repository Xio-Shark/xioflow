import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ExecutionDomain, estimateWorkspaceCausalRefreshHistory, planWorkspaceCausalRefreshPolicy } from '../../src/index.js';
import type { CausalRefreshTelemetry } from '../../src/index.js';

let domain: ExecutionDomain;
let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-history-'));
  domain = ExecutionDomain.acquire(temp, 'history');
});
afterEach(() => { domain.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const event = (type: string, payload: Record<string, unknown>) => domain.getStore().recordJournalEvent({
  domainId: domain.domainId, type, payload, timestamp: new Date().toISOString(),
});
const decision = (taskKey = 'compile') => event('CAUSAL_REFRESH_POLICY_SELECTED', { version: 1, taskKey });
function report(decisionSeq: number, status: CausalRefreshTelemetry['status'], probe: number,
  execute = 0, strategy: CausalRefreshTelemetry['strategy'] = 'probe', errors = 0) {
  return event('CAUSAL_REFRESH_MEASURED', { version: 1, report: {
    runId: 'run', decisionSeq, strategy, status, durationMs: probe + execute,
    callbacks: Object.fromEntries(['probe', 'reuse', 'execute', 'commitReplay'].map(phase =>
      [phase, { calls: 1, errors, durationMs: phase === 'probe' ? probe : phase === 'execute' ? execute : 0 }])),
  } });
}

it('fits by task, freezes training and scores independent future probes across reopen', () => {
  report(decision(), 'unchanged', 2);
  const trainingAtSeq = report(decision(), 'committed', 4, 6);
  report(decision('other'), 'unchanged', 1000);
  report(decision(), 'unchanged', 4);
  const atSeq = report(decision(), 'committed', 6, 8);
  const query = { taskKey: 'compile', trainingAtSeq, atSeq };
  const result = estimateWorkspaceCausalRefreshHistory(domain, query);
  expect(result.forecast).toEqual({ changeProbability: 0.5, probeUnchanged: 2, probeChanged: 4, refreshChanged: 6 });
  expect(result.training).toMatchObject({ unchanged: 1, changed: 1 });
  expect(result.heldOut).toMatchObject({ unchanged: 1, changed: 1 });
  expect(result.evaluation).toEqual({ samples: 2, expectedProbeCost: 6, meanActualCost: 9, meanAbsoluteError: 5 });
  expect(planWorkspaceCausalRefreshPolicy([], result.forecast!, () => ({ execute: 0, reuse: 0, replay: 0 })).strategy).toBe('recompute');
  report(decision(), 'committed', 100, 100);
  expect(estimateWorkspaceCausalRefreshHistory(domain, query)).toEqual(result);
  domain.close(); domain = ExecutionDomain.acquire(temp, 'history');
  expect(estimateWorkspaceCausalRefreshHistory(domain, query)).toEqual(result);
  expect(estimateWorkspaceCausalRefreshHistory(domain, { ...query, atSeq: trainingAtSeq }).evaluation).toBeNull();
});

it('separates failure, missing, recomputation and late completion without inventing a forecast', () => {
  report(decision(), 'unchanged', 2);
  report(decision(), 'failed', 3);
  report(decision(), 'conflict', 3);
  report(decision(), 'threw', 3);
  report(decision(), 'committed', 3, 4, 'probe', 1);
  report(decision(), 'committed', 0, 10, 'recompute');
  decision();
  const late = decision();
  const trainingAtSeq = late;
  report(late, 'committed', 4, 6);
  report(decision(), 'committed', 4, 6);
  const result = estimateWorkspaceCausalRefreshHistory(domain, { taskKey: 'compile', trainingAtSeq });
  expect(result.training).toEqual({ unchanged: 1, changed: 0, failed: 4, missing: 2, recompute: 1 });
  expect(result.heldOut).toEqual({ unchanged: 0, changed: 1, failed: 0, missing: 0, recompute: 0 });
  expect(result.forecast).toBeNull();
  expect(result.evaluation).toBeNull();
});

it.each([
  { taskKey: '', trainingAtSeq: 0 }, { taskKey: 'x', trainingAtSeq: -1 },
  { taskKey: 'x', trainingAtSeq: 1, atSeq: 0 }, { taskKey: 'x', trainingAtSeq: 0, atSeq: NaN },
])('rejects invalid history query %j', options => {
  expect(() => estimateWorkspaceCausalRefreshHistory(domain, options)).toThrow();
});

it('leaves untagged legacy decisions and other tasks out of the cohort', () => {
  const legacy = event('CAUSAL_REFRESH_POLICY_SELECTED', { version: 1 });
  report(legacy, 'committed', 4, 6);
  const cutoff = report(decision('other'), 'unchanged', 2);
  const result = estimateWorkspaceCausalRefreshHistory(domain, { taskKey: 'compile', trainingAtSeq: cutoff });
  expect(result.training).toEqual({ unchanged: 0, changed: 0, failed: 0, missing: 0, recompute: 0 });
  expect(result.forecast).toBeNull();
});

it('excludes stale decisions by start sequence and freezes a recent cohort across reopen', () => {
  report(decision(), 'committed', 1000, 1000);
  const oldPending = decision();
  const trainingAfterSeq = oldPending;
  report(oldPending, 'unchanged', 2000); // Completion in the window does not admit an old decision.
  report(decision(), 'unchanged', 2);
  const trainingAtSeq = report(decision(), 'committed', 4, 6);
  report(decision(), 'committed', 4, 6);
  const atSeq = report(decision(), 'committed', 4, 6);
  const query = { taskKey: 'compile', trainingAfterSeq, trainingAtSeq, atSeq };
  const result = estimateWorkspaceCausalRefreshHistory(domain, query);
  expect(result.excludedDecisions).toBe(2);
  expect(result.forecast).toEqual({ changeProbability: 0.5, probeUnchanged: 2, probeChanged: 4, refreshChanged: 6 });
  expect(result.drift).toEqual({ trainingSamples: 2, heldOutSamples: 2,
    trainingChangeProbability: 0.5, heldOutChangeProbability: 1, changeProbabilityDelta: 0.5, brierScore: 0.25 });
  expect(result.evaluation).toMatchObject({ samples: 2, meanAbsoluteError: 4 });
  report(decision(), 'unchanged', 9000);
  domain.close(); domain = ExecutionDomain.acquire(temp, 'history');
  expect(estimateWorkspaceCausalRefreshHistory(domain, query)).toEqual(result);
  const empty = estimateWorkspaceCausalRefreshHistory(domain, { ...query, trainingAfterSeq: trainingAtSeq });
  expect(empty.forecast).toBeNull();
  expect(empty.drift).toBeNull();
  expect(empty.heldOut).toEqual(result.heldOut);
});

it('scores probability drift with one training class while excluding unlabeled and failed runs', () => {
  const trainingAtSeq = report(decision(), 'unchanged', 2);
  report(decision(), 'committed', 4, 6);
  report(decision(), 'failed', 100);
  report(decision(), 'committed', 0, 100, 'recompute');
  decision();
  const result = estimateWorkspaceCausalRefreshHistory(domain, { taskKey: 'compile', trainingAtSeq });
  expect(result.forecast).toBeNull();
  expect(result.drift).toEqual({ trainingSamples: 1, heldOutSamples: 1,
    trainingChangeProbability: 0, heldOutChangeProbability: 1, changeProbabilityDelta: 1, brierScore: 1 });
  expect(result.heldOut).toEqual({ changed: 1, unchanged: 0, failed: 1, recompute: 1, missing: 1 });
  expect(estimateWorkspaceCausalRefreshHistory(domain, { taskKey: 'compile', trainingAtSeq, atSeq: trainingAtSeq }).drift).toBeNull();
});

it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 11])(
  'rejects invalid training lower bound %s', trainingAfterSeq => {
    expect(() => estimateWorkspaceCausalRefreshHistory(domain, {
      taskKey: 'compile', trainingAtSeq: 10, trainingAfterSeq,
    })).toThrow('Invalid refresh history sequence cutoffs');
  });


it('keeps the default full history and measures a decrease in change frequency', () => {
  report(decision(), 'unchanged', 2);
  for (let i = 0; i < 3; i++) report(decision(), 'committed', 4, 6);
  const trainingAtSeq = domain.getStore().getJournalEvents(domain.domainId).at(-1)!.seq;
  report(decision(), 'committed', 4, 6);
  for (let i = 0; i < 3; i++) report(decision(), 'unchanged', 2);
  const options = { taskKey: 'compile', trainingAtSeq };
  const result = estimateWorkspaceCausalRefreshHistory(domain, options);
  expect(estimateWorkspaceCausalRefreshHistory(domain, { ...options, trainingAfterSeq: 0 })).toEqual(result);
  expect(result.excludedDecisions).toBe(0);
  expect(result.drift).toEqual({ trainingSamples: 4, heldOutSamples: 4,
    trainingChangeProbability: 0.75, heldOutChangeProbability: 0.25,
    changeProbabilityDelta: -0.5, brierScore: 0.4375 });
});
