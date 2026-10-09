import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ExecutionDomain, estimateAgentCausalResumeHistory, planAgentCausalResumePolicy } from '../../src/index.js';

let domain: ExecutionDomain;
let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-resume-history-'));
  domain = ExecutionDomain.acquire(temp, 'history');
});
afterEach(() => { domain.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const record = (type: string, payload: Record<string, unknown>) => domain.getStore().recordJournalEvent({
  domainId: domain.domainId, type: `AGENT_CAUSAL_RESUME_POLICY_${type}`, timestamp: new Date().toISOString(),
  payload: { version: 1, planSeq: 1, preparationSeq: 2, ...payload },
});
const decision = (taskKey = '16MiB', pendingAgents = 2, direct = false) => record('SELECTED', {
  taskKey, checkpoints: Array.from({ length: pendingAgents }, (_, i) => ({ agentId: `${i}`, checkpointSeq: 1 })),
  policy: planAgentCausalResumePolicy({ rejectionProbability: direct ? 1 : 0,
    validationAccepted: 1, resume: 0, validationRejected: 1, recompute: 10 }),
});
const finish = (decisionSeq: number, validation: number, recompute = 0, extra: Record<string, unknown> = {}) =>
  record('COMPLETED', { decisionSeq, status: recompute ? 'recomputed' : 'resumed',
    ...(recompute ? { rejection: 'stale' } : {}), phases: { validationAndResumeMs: validation, recomputeMs: recompute },
    outcomes: { repaired: 2, skipped: 0, failed: 0 }, ...extra });
const query = (trainingAtSeq: number) => ({ taskKey: '16MiB', pendingAgents: 2, trainingAtSeq });

it('freezes a cohort, fits measured phases and scores later decisions across reopen', () => {
  finish(decision(), 4);
  const trainingAtSeq = finish(decision(), 2, 10);
  finish(decision('1GiB'), 1000);
  finish(decision('16MiB', 4), 1000);
  finish(decision(), 6);
  const atSeq = finish(decision(), 4, 12);
  const options = { ...query(trainingAtSeq), atSeq };
  const before = domain.getStore().getJournalEvents(domain.domainId).length;
  const result = estimateAgentCausalResumeHistory(domain, options);
  expect(result.forecast).toEqual({ rejectionProbability: 0.5, validationAccepted: 4,
    resume: 0, validationRejected: 2, recompute: 10 });
  expect(result.policy?.strategy).toBe('validate');
  expect(result.evaluation).toEqual({ samples: 2, expectedValidationCost: 8,
    meanActualCost: 11, meanAbsoluteError: 5, rejectionProbability: 0.5, brierScore: 0.25 });
  expect(domain.getStore().getJournalEvents(domain.domainId)).toHaveLength(before);
  finish(decision(), 900);
  domain.close(); domain = ExecutionDomain.acquire(temp, 'history');
  expect(estimateAgentCausalResumeHistory(domain, options)).toEqual(result);
  expect(estimateAgentCausalResumeHistory(domain, { ...options, atSeq: trainingAtSeq }).evaluation).toBeNull();
});

it('separates late, failed, partial, skipped, legacy and unlabeled direct recompute outcomes', () => {
  finish(decision(), 2);
  record('FAILED', { decisionSeq: decision(), error: 'interrupted' });
  finish(decision(), 1, 0, { outcomes: { repaired: 1, failed: 1, skipped: 0 } });
  finish(decision(), 1, 0, { outcomes: { repaired: 1, failed: 0, skipped: 1 } });
  finish(decision(), 1, 0, { phases: undefined });
  finish(decision(), 1, 0, { outcomes: undefined });
  finish(decision('16MiB', 2, true), 0, 10, { rejection: undefined });
  decision();
  const late = decision();
  finish(late, 2, 10);
  finish(decision(), 2, 10);
  const result = estimateAgentCausalResumeHistory(domain, query(late));
  expect(result.training).toEqual({ accepted: 1, rejected: 0, failed: 3, missing: 2, unmeasured: 2, recompute: 1 });
  expect(result.heldOut.rejected).toBe(1);
  expect(result.forecast).toBeNull();
  expect(result.evaluation).toBeNull();
});

it('uses decision lower bounds and admits each normal rejection reason', () => {
  const old = decision();
  finish(old, 900);
  finish(decision(), 4);
  for (const rejection of ['stale', 'validation_failed', 'output_invalid']) finish(decision(), 2, 10, { rejection });
  const trainingAtSeq = domain.getStore().getJournalEvents(domain.domainId).at(-1)!.seq;
  const result = estimateAgentCausalResumeHistory(domain, { ...query(trainingAtSeq), trainingAfterSeq: old });
  expect(result.excludedDecisions).toBe(1);
  expect(result.forecast?.rejectionProbability).toBe(0.75);
  expect(result.forecast?.validationAccepted).toBe(4);
  expect(estimateAgentCausalResumeHistory(domain, { ...query(trainingAtSeq), trainingAfterSeq: trainingAtSeq }).forecast).toBeNull();
});

it.each([
  { pendingAgents: 0 }, { pendingAgents: 1.5 }, { taskKey: ' ' }, { trainingAtSeq: -1 },
  { trainingAtSeq: 2, atSeq: 1 }, { trainingAfterSeq: 2 }, { atSeq: NaN },
])('rejects invalid cohort or window %j', overrides => {
  expect(() => estimateAgentCausalResumeHistory(domain, { ...query(0), ...overrides })).toThrow('Invalid');
});

it('rejects corrupt measured costs instead of training a free recovery', () => {
  const trainingAtSeq = finish(decision(), -1);
  expect(() => estimateAgentCausalResumeHistory(domain, query(trainingAtSeq))).toThrow('duration');
});
