import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain, type AgentRuntimeOptions } from '../../src/index.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: string;
let domain: ExecutionDomain;
let runtime: AgentRuntime;
const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const hold = () => { const value = gate(); releases.push(value.resolve); return value; };
const open = (options: Partial<AgentRuntimeOptions> = {}) => (runtime = new AgentRuntime(domain, {
  maxConcurrentAgents: 3, step: async () => ({ status: 'completed', checkpoint: 1 }), ...options,
}));
const create = (id: string, parentId?: string) => runtime.create({ id, parentId, runId: 'run', input: null, checkpoint: 0, maxSteps: 3 });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-scopes-'));
  domain = ExecutionDomain.acquire(root, 'scopes');
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'scopes', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  await runtime?.shutdown(); domain.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('joins children without retaining a scheduler slot, including a single-slot runtime', async () => {
  const calls: string[] = [];
  open({ maxConcurrentAgents: 1, step: async (agent) => {
    calls.push(agent.id);
    if (agent.id === 'parent') create('child', 'parent');
    if (agent.id === 'child') {
      expect(runtime.get('parent')?.status).toBe('waiting');
      expect(() => create('late', 'parent')).toThrow('joining');
      create('grandchild', 'child');
    }
    return { status: 'completed', checkpoint: 1 };
  } });
  create('parent'); await runtime.drain();
  expect(calls).toEqual(['parent', 'child', 'grandchild']);
  expect(runtime.list().every((agent) => agent.status === 'completed')).toBe(true);
  expect(runtime.checkpoints('parent')).toHaveLength(2);
});

it('leaves a parent waiting for a paused child and resumes that join after reopen', async () => {
  open({ maxConcurrentAgents: 1 }); create('parent'); create('child', 'parent'); runtime.pause('child');
  await runtime.drain();
  expect(runtime.get('parent')).toMatchObject({ status: 'waiting', stepsUsed: 1, checkpoint: 1 });
  expect(() => domain.getStore().reportRunSucceeded('run')).toThrow('agents');
  runtime.close(); open();
  expect(runtime.get('parent')?.status).toBe('waiting');
  runtime.resume('child'); await runtime.drain();
  expect(runtime.get('parent')).toMatchObject({ status: 'completed', stepsUsed: 1 });
});

it('persists cancellation of the whole tree before notifying an active child', async () => {
  const entered = gate(); const release = hold(); let signal!: AbortSignal;
  open({ step: async (agent, execution) => {
    if (agent.id === 'child') {
      signal = execution.signal;
      signal.addEventListener('abort', () => {
        expect(runtime.get('grandchild')?.status).toBe('interrupted');
        expect(() => create('escape', 'child')).toThrow('closed');
        expect(() => runtime.restoreCheckpoint('parent', runtime.checkpoints('parent')[0].seq)).toThrow('closed');
      }, { once: true });
      entered.resolve(); await release.promise;
    }
    return { status: 'completed', checkpoint: 99 };
  } });
  create('parent'); create('child', 'parent'); create('grandchild', 'child'); runtime.pause('grandchild');
  const draining = runtime.drain(); pending.push(draining); await entered.promise;
  let settled = false;
  const stopping = runtime.interrupt('parent').then(() => { settled = true; }); pending.push(stopping);
  expect(signal.aborted).toBe(true);
  await Promise.resolve(); expect(settled).toBe(false);
  release.resolve(); await stopping; await draining;
  expect(runtime.list().every((agent) => agent.status === 'interrupted')).toBe(true);
  expect(runtime.get('child')).toMatchObject({ checkpoint: 0, stepsUsed: 1 });
});

it('fails fast on child failure and settles its non-cooperative sibling before drain returns', async () => {
  const entered = gate(); const release = hold(); let signal!: AbortSignal;
  open({ step: async (agent, execution) => {
    if (agent.id === 'bad') { await entered.promise; throw new Error('child failed'); }
    if (agent.id === 'sibling') { signal = execution.signal; entered.resolve(); await release.promise; }
    return { status: 'completed', checkpoint: 1 };
  } });
  create('parent'); create('bad', 'parent'); create('sibling', 'parent'); create('unrelated');
  const draining = runtime.drain(); pending.push(draining);
  await expect.poll(() => signal?.aborted).toBe(true);
  expect(runtime.get('bad')?.error).toContain('child failed');
  expect(runtime.get('parent')?.status).toBe('interrupted');
  release.resolve(); await draining;
  expect(runtime.get('sibling')).toMatchObject({ status: 'interrupted', checkpoint: 0 });
  expect(runtime.get('unrelated')?.status).toBe('completed');
});

it('an explicit child cancellation joins the affected root and siblings too', async () => {
  const entered = gate(); const release = hold();
  open({ step: async (agent) => {
    if (agent.id === 'sibling') { entered.resolve(); await release.promise; }
    return { status: 'completed', checkpoint: 1 };
  } });
  create('parent'); create('child', 'parent'); runtime.pause('child'); create('sibling', 'parent');
  pending.push(runtime.drain()); await entered.promise;
  let settled = false;
  const stopping = runtime.interrupt('child').then(() => { settled = true; }); pending.push(stopping);
  await Promise.resolve(); expect(settled).toBe(false);
  release.resolve(); await stopping;
  expect(runtime.get('sibling')?.status).toBe('interrupted');
});

it('cancels reconstruction, discards its candidate once, and joins cleanup', async () => {
  const prepared = gate(); const release = hold(); const cleaning = gate(); const cleaned = hold();
  open(); create('parent'); create('child', 'parent'); runtime.pause('child');
  const discard = vi.fn(async () => { cleaning.resolve(); await cleaned.promise; });
  const recovery = runtime.recoverCheckpoint('child', async (checkpoints) => {
    prepared.resolve(); await release.promise; return { seq: checkpoints[0].seq, discard };
  }); pending.push(recovery); await prepared.promise;
  let settled = false;
  const stopping = runtime.interrupt('parent').then(() => { settled = true; }); pending.push(stopping);
  expect(() => runtime.pause('child')).toThrow('pending interruption');
  release.resolve(); await cleaning.promise;
  expect(settled).toBe(false);
  cleaned.resolve(); await stopping;
  expect(await recovery).toBeUndefined(); expect(discard).toHaveBeenCalledTimes(1);
  expect(runtime.get('child')).toMatchObject({ status: 'interrupted', checkpoint: 0 });
});

it('rolls back the entire scope cancellation if a descendant journal write fails', async () => {
  open(); create('parent'); create('child', 'parent'); create('grandchild', 'child');
  const store = domain.getStore(); const record = store.recordJournalEvent.bind(store);
  const spy = vi.spyOn(store, 'recordJournalEvent').mockImplementation((event) => {
    if (event.payload.transition === 'interrupted' && (event.payload.state as { id: string }).id === 'child') throw new Error('disk full');
    return record(event);
  });
  await expect(runtime.interrupt('parent')).rejects.toThrow('disk full');
  expect(runtime.list().every((agent) => agent.status === 'ready')).toBe(true);
  spy.mockRestore(); await runtime.interrupt('parent');
  runtime.close(); open();
  expect(runtime.list().every((agent) => agent.status === 'interrupted')).toBe(true);
});

it('does not resurrect cancelled queued descendants during shutdown', async () => {
  const entered = gate(); const release = hold();
  open({ maxConcurrentAgents: 1, step: async () => { entered.resolve(); await release.promise; return { status: 'completed', checkpoint: 1 }; } });
  create('parent'); create('child', 'parent'); create('grandchild', 'child');
  pending.push(runtime.drain()); await entered.promise;
  const stopped = runtime.shutdown(); pending.push(stopped); release.resolve(); await stopped;
  open(); expect(runtime.list().every((agent) => agent.status === 'interrupted')).toBe(true);
});

it('joins reentrant interruption requests and fences restoration until the barrier settles', async () => {
  const entered = gate(); const release = hold(); let repeated!: Promise<unknown>;
  open({ step: async (_agent, execution) => {
    execution.signal.addEventListener('abort', () => { repeated = runtime.interrupt('parent'); });
    entered.resolve(); await release.promise; return { status: 'completed', checkpoint: 1 };
  } });
  create('parent'); pending.push(runtime.drain()); await entered.promise;
  const stopped = runtime.interrupt('parent'); pending.push(stopped);
  expect(repeated).toBe(stopped); release.resolve(); await stopped;
});

it('retains reconstruction cleanup failures and does not discard twice', async () => {
  const entered = gate(); const release = hold();
  open(); create('parent'); create('child', 'parent'); runtime.pause('child');
  const failure = new Error('discard failed');
  const discard = vi.fn(async () => { throw failure; });
  const recovery = runtime.recoverCheckpoint('child', async (checkpoints) => {
    entered.resolve(); await release.promise; return { seq: checkpoints[0].seq, discard };
  });
  const recovered = recovery.catch((error) => error); pending.push(recovered); await entered.promise;
  const stopped = runtime.interrupt('parent').catch((error) => error); pending.push(stopped);
  release.resolve();
  expect(await recovered).toBe(failure);
  expect((await stopped as AggregateError).errors).toContain(failure);
  expect(discard).toHaveBeenCalledTimes(1);
  expect(runtime.get('child')).toMatchObject({ status: 'interrupted', error: 'Error: discard failed' });
});

it('does not revisit historical cancelled scopes when unrelated work advances', async () => {
  open();
  for (let i = 0; i < 40; i++) { create(`old-${i}`); await runtime.interrupt(`old-${i}`); }
  await runtime.drain();
  create('fresh');
  const transaction = vi.spyOn(domain.getStore(), 'transaction');
  await runtime.drain();
  expect(runtime.get('fresh')?.status).toBe('completed');
  expect(transaction.mock.calls.length).toBeLessThan(20);
});

it('blocks restoring an automatically cancelled parent until descendants settle', async () => {
  const entered = gate(); const release = hold();
  open({ step: async (agent) => {
    if (agent.id === 'bad') { await entered.promise; throw new Error('failure'); }
    if (agent.id === 'sibling') { entered.resolve(); await release.promise; }
    return { status: 'completed', checkpoint: 1 };
  } });
  create('parent'); create('bad', 'parent'); create('sibling', 'parent');
  pending.push(runtime.drain());
  await expect.poll(() => runtime.get('parent')?.status).toBe('interrupted');
  expect(() => runtime.restoreCheckpoint('parent', runtime.checkpoints('parent')[0].seq)).toThrow('unsettled');
  release.resolve();
});

it('drain joins reconstruction cancelled by a parent failure', async () => {
  const entered = gate(); const release = hold();
  open({ step: async () => { throw new Error('parent failed'); } });
  create('parent'); create('child', 'parent'); runtime.pause('child');
  const recovery = runtime.recoverCheckpoint('child', async () => {
    entered.resolve(); await release.promise; return undefined;
  }); pending.push(recovery); await entered.promise;
  let settled = false;
  const draining = runtime.drain().then(() => { settled = true; }); pending.push(draining);
  await expect.poll(() => runtime.get('child')?.reason).toBe('interrupt_requested');
  expect(settled).toBe(false);
  release.resolve(); await draining;
  expect(runtime.get('child')?.status).toBe('interrupted');
});
