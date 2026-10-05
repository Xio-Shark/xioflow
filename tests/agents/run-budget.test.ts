import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain, type AgentRuntimeOptions } from '../../src/index.js';

let root: string;
let domain: ExecutionDomain;
let runtime: AgentRuntime;
const open = (options: Partial<AgentRuntimeOptions> = {}) => (runtime = new AgentRuntime(domain, {
  maxConcurrentAgents: 4,
  runBudget: { maxSteps: 3, maxAgents: 4, maxPendingCommands: 2 },
  step: async () => ({ status: 'ready', checkpoint: 1 }), ...options,
}));
const create = (id: string, runId = 'run') => runtime.create({ id, runId, input: null, checkpoint: 0, maxSteps: 10 });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-run-budget-'));
  domain = ExecutionDomain.acquire(root, 'run-budget');
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'budget', createdAt: new Date().toISOString() });
  for (const id of ['run', 'other']) store.saveRun({ id, taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
});
afterEach(async () => {
  vi.restoreAllMocks(); await runtime?.shutdown(); domain.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('reserves a shared step budget after concurrent validators resolve', async () => {
  open({ validate: async () => 'valid' });
  for (const id of ['a', 'b', 'c', 'd']) create(id);
  await runtime.drain();
  expect(runtime.getRunUsage('run')).toMatchObject({ stepsUsed: 3, agentsCreated: 4 });
  expect(runtime.list().every((agent) => agent.status === 'paused' && agent.reason === 'run_budget_exhausted')).toBe(true);
  expect(() => runtime.resume('d')).toThrow('Run step budget');
});

it('persists limits and usage across reopen, restoration, and larger defaults', async () => {
  open(); create('a'); await runtime.drain();
  runtime.restoreCheckpoint('a', runtime.checkpoints('a')[0].seq);
  expect(runtime.getRunUsage('run').stepsUsed).toBe(3);
  runtime.close();
  open({ runBudget: { maxSteps: 500, maxAgents: 500, maxPendingCommands: 500 } });
  expect(runtime.getRunUsage('run')).toEqual({ budget: { maxSteps: 3, maxAgents: 4, maxPendingCommands: 2 }, stepsUsed: 3, agentsCreated: 1, pendingCommands: 0 });
  expect(() => runtime.resume('a')).toThrow('Run step budget');
  create('other', 'other');
  expect(runtime.getRunUsage('other').budget.maxSteps).toBe(500);
});

it('caps lifetime agent creation, not just currently runnable agents', async () => {
  open({ step: async () => ({ status: 'completed', checkpoint: 1 }) });
  for (const id of ['a', 'b', 'c', 'd']) create(id);
  await runtime.drain();
  expect(() => create('overflow')).toThrow('Run agent budget');
  expect(runtime.get('overflow')).toBeUndefined();
  expect(runtime.getRunUsage('run').agentsCreated).toBe(4);
  create('independent', 'other');
});

it('does not refund an interrupted step, or charge stale validation', async () => {
  open({ validate: async (agent) => agent.id === 'stale' ? 'stale' : 'valid', step: async () => { throw new Error('provider died'); } });
  create('failed'); create('stale'); await runtime.drain();
  expect(runtime.getRunUsage('run').stepsUsed).toBe(1);
  expect(runtime.get('stale')?.stepsUsed).toBe(0);
});

it('a failed reservation journal does not consume budget or invoke the adapter', async () => {
  const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
  open({ maxConcurrentAgents: 1, step }); create('a');
  const store = domain.getStore(); const record = store.recordJournalEvent.bind(store);
  const spy = vi.spyOn(store, 'recordJournalEvent').mockImplementation((event) => {
    if (event.payload.transition === 'step_started') throw new Error('disk full');
    return record(event);
  });
  await expect(runtime.drain()).rejects.toThrow('disk full');
  expect(step).not.toHaveBeenCalled();
  expect(runtime.getRunUsage('run').stepsUsed).toBe(0);
  spy.mockRestore();
});

it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid Run limits: %s', (limit) => {
  expect(() => open({ runBudget: { maxSteps: limit, maxAgents: 1, maxPendingCommands: 1 } })).toThrow('positive safe integer');
});

it('bounds a synchronous burst before journaling or creating process waiters', async () => {
  domain.setDomainBudget({ maxConcurrentOps: 1 });
  open({ step: async (_agent, execution) => {
    const commands = Array.from({ length: 100 }, (_, index) => execution.executeProcess({
      opId: `burst-${index}`, name: 'burst', waitTimeoutMs: 5000,
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: root },
    }));
    expect(runtime.getRunUsage('run').pendingCommands).toBe(2);
    const outcomes = await Promise.allSettled(commands);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(98);
    return { status: 'completed', checkpoint: 1 };
  } });
  create('a'); await runtime.drain();
  expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 0 });
  expect(runtime.get('a')?.error).toContain('pending command limit');
  expect(runtime.getRunUsage('run').pendingCommands).toBe(0);
  expect(domain.getStore().getOperationsByRun('run')).toHaveLength(2);
});

it('shares command reservations across agents, but not across Runs', async () => {
  open({ runBudget: { maxSteps: 10, maxAgents: 4, maxPendingCommands: 1 }, step: async (agent, execution) => {
    const result = await execution.executeProcess({ opId: agent.id, name: 'one',
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: root },
    });
    expect(result.status).toBe('succeeded');
    return { status: 'completed', checkpoint: 1 };
  } });
  create('first'); create('second'); create('third', 'other');
  await runtime.drain();
  expect(runtime.get('first')?.status).toBe('completed');
  expect(runtime.get('second')?.error).toContain('pending command limit');
  expect(runtime.get('third')?.status).toBe('completed');
  expect(runtime.getRunUsage('run').pendingCommands).toBe(0);
  expect(runtime.getRunUsage('other').pendingCommands).toBe(0);
});
