import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain, type AgentRuntimeOptions, type AgentState } from '../../src/index.js';

let root: string;
let domain: ExecutionDomain;
let runtime: AgentRuntime;
const step = vi.fn(async (_agent: AgentState) => ({ status: 'completed' as const, checkpoint: 1 }));
const open = (options: Partial<AgentRuntimeOptions> = {}) => {
  runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1, step, ...options });
  runtime.create({ id: 'a', runId: 'run', input: null, checkpoint: 0, maxSteps: 3 });
};
beforeEach(() => {
  step.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-version-'));
  domain = ExecutionDomain.acquire(root, 'version');
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'version', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
});
afterEach(async () => { await runtime?.shutdown(); domain.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('reproduces the legacy unversioned validation window without claiming freshness', async () => {
  let version = 'v1';
  open({ validate: async () => { const checked = version; await Promise.resolve(); version = 'v2'; return checked === 'v1' ? 'valid' : 'stale'; } });
  await runtime.drain();
  expect(step).toHaveBeenCalledTimes(1);
  expect(runtime.get('a')?.validatedWorkspaceVersion).toBeNull();
});

it('rejects a valid verdict whose workspace revision changed before dispatch', async () => {
  let version = 'v1';
  open({ workspaceVersion: () => version, validate: async () => { await Promise.resolve(); version = 'v2'; return 'valid'; } });
  await runtime.drain();
  expect(step).not.toHaveBeenCalled();
  expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: 'evidence_stale', stepsUsed: 0 });
  expect(runtime.getRunUsage('run').stepsUsed).toBe(0);
});

it('journals the validated revision with the step reservation', async () => {
  open({ workspaceVersion: () => 'immutable-tree-1', validate: async () => 'valid' });
  await runtime.drain();
  expect(step.mock.calls[0]?.[0]).toMatchObject({ validatedWorkspaceVersion: 'immutable-tree-1' });
  const started = domain.getStore().getJournalEvents(domain.domainId).find((event) => event.payload.transition === 'step_started');
  expect(started?.payload.state).toMatchObject({ validatedWorkspaceVersion: 'immutable-tree-1' });
});

it('checks an already-resolved verdict again on the dispatch continuation', async () => {
  let version = 'v1';
  open({ workspaceVersion: () => version, validate: () => {
    queueMicrotask(() => { version = 'v2'; });
    return Promise.resolve('valid');
  } });
  await runtime.drain(); expect(step).not.toHaveBeenCalled();
});

it('does not claim a malformed or failing revision source is fresh', async () => {
  open({ workspaceVersion: () => '', validate: async () => 'valid' });
  await runtime.drain();
  expect(runtime.get('a')).toMatchObject({ status: 'failed', reason: 'validation_failed', stepsUsed: 0 });
  expect(step).not.toHaveBeenCalled();
});

it('refuses a revision source without a validator', () => {
  expect(() => new AgentRuntime(domain, { maxConcurrentAgents: 1, step, workspaceVersion: () => 'v1' })).toThrow('requires an evidence validator');
});

it('rechecks the workspace transaction after asynchronous validation', async () => {
  const store = domain.getStore();
  store.recordJournalEvent({ domainId: domain.domainId, runId: 'run', type: 'TX_BEGUN',
    payload: { txId: 'tx', forkRoot: root }, timestamp: new Date().toISOString() });
  runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1, step, validate: async () => {
    store.recordJournalEvent({ domainId: domain.domainId, runId: 'run', type: 'TX_ABORTED',
      payload: { txId: 'tx' }, timestamp: new Date().toISOString() });
    return 'valid';
  } });
  runtime.create({ id: 'a', runId: 'run', input: null, checkpoint: 0, maxSteps: 3, workspace: { txId: 'tx', forkRoot: root } });
  await runtime.drain();
  expect(step).not.toHaveBeenCalled();
  expect(runtime.get('a')).toMatchObject({ status: 'failed', reason: 'validation_failed', stepsUsed: 0 });
});
