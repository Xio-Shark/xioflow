import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, type AgentRuntimeOptions, type AgentState } from '../../src/agents/runtime.js';
import { ExecutionDomain } from '../../src/domain.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('kernel-owned agent scheduling', () => {
  let root: string;
  let domain: ExecutionDomain;
  let runtime: AgentRuntime;
  const complete = async (state: AgentState) => ({ status: 'completed' as const, checkpoint: state.checkpoint });
  const open = (options: Partial<AgentRuntimeOptions> = {}) => {
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: complete, ...options });
    return runtime;
  };
  const create = (id: string, maxSteps = 3, parentId?: string) => runtime.create({
    id, runId: 'run', ...(parentId ? { parentId } : {}), input: { instruction: id }, checkpoint: { turn: 0 }, maxSteps,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agents-'));
    domain = ExecutionDomain.acquire(root, 'agents');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });
  afterEach(() => {
    runtime?.close();
    domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists identity, task input, parent and independent checkpoints', async () => {
    open();
    create('parent');
    create('child', 2, 'parent');
    const state = runtime.get('child')!;
    (state.checkpoint as { turn: number }).turn = 100;
    expect(runtime.get('child')?.checkpoint).toEqual({ turn: 0 });
    await runtime.drain();
    expect(runtime.get('child')).toMatchObject({ parentId: 'parent', status: 'completed', stepsUsed: 1 });
    expect(runtime.checkpoints('child')).toHaveLength(2);
  });

  it('round-robins ready agents instead of running one to completion', async () => {
    const calls: string[] = [];
    open({ step: async (state) => {
      calls.push(state.id);
      return { status: state.stepsUsed === 2 ? 'completed' : 'ready', checkpoint: state.stepsUsed };
    } });
    create('a'); create('b');
    const first = runtime.drain();
    expect(runtime.drain()).toBe(first);
    await first;
    expect(calls).toEqual(['a', 'b', 'a', 'b']);
  });

  it('bounds parallel execution and pauses one agent without blocking another', async () => {
    const entered = deferred(); const release = deferred();
    let active = 0; let maximum = 0;
    const calls: string[] = [];
    open({ maxConcurrentAgents: 2, step: async (state) => {
      active++; maximum = Math.max(maximum, active); calls.push(state.id);
      if (state.id === 'a') { entered.resolve(); await release.promise; }
      active--;
      return { status: state.id === 'a' ? 'ready' : 'completed', checkpoint: state.stepsUsed };
    } });
    create('a'); create('b'); create('c');
    const draining = runtime.drain();
    await entered.promise;
    expect(runtime.pause('a')).toMatchObject({ status: 'running', pauseRequested: true });
    release.resolve();
    await draining;
    expect(maximum).toBe(2);
    expect(calls.filter((id) => id === 'a')).toHaveLength(1);
    expect(runtime.get('a')?.status).toBe('paused');
    expect(runtime.get('b')?.status).toBe('completed');
    expect(runtime.get('c')?.status).toBe('completed');
  });

  it.each(['stale', 'unknown'] as const)('does not spend budget or call the model for %s evidence', async (verdict) => {
    const step = vi.fn(complete);
    open({ step, validate: async () => verdict });
    create('a');
    await runtime.drain();
    expect(step).not.toHaveBeenCalled();
    expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: `evidence_${verdict}`, stepsUsed: 0 });
  });

  it('honors a pause requested during asynchronous validation', async () => {
    const entered = deferred(); const release = deferred(); const step = vi.fn(complete);
    open({ step, validate: async () => { entered.resolve(); await release.promise; return 'valid'; } });
    create('a');
    const draining = runtime.drain();
    await entered.promise;
    runtime.pause('a'); release.resolve();
    await draining;
    expect(step).not.toHaveBeenCalled();
    expect(runtime.get('a')).toMatchObject({ status: 'paused', stepsUsed: 0 });
  });

  it('persists budgets across reopen and does not refund a restored prefix', async () => {
    open({ step: async (state) => ({ status: 'ready', checkpoint: state.stepsUsed }) });
    create('a', 2);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    expect(runtime.get('a')).toMatchObject({ stepsUsed: 2, reason: 'budget_exhausted' });
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(root, 'agents'); open();
    runtime.restoreCheckpoint('a', initial.seq);
    expect(runtime.get('a')).toMatchObject({ checkpoint: { turn: 0 }, stepsUsed: 2 });
    expect(() => runtime.resume('a')).toThrow('budget exhausted');
  });

  it('does not auto-retry a failed step, but explicit restore retains its charge', async () => {
    const step = vi.fn(async () => { throw new Error('provider disconnected'); });
    open({ step }); create('a');
    await runtime.drain(); await runtime.drain();
    expect(step).toHaveBeenCalledTimes(1);
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', stepsUsed: 1 });
    expect(() => runtime.resume('a')).toThrow('restore');
    runtime.restoreCheckpoint('a', runtime.checkpoints('a')[0].seq);
    runtime.resume('a');
    expect(runtime.get('a')).toMatchObject({ status: 'ready', stepsUsed: 1 });
  });

  it('does not auto-run ready agents after restarting the runtime', async () => {
    open(); create('a'); runtime.close();
    const step = vi.fn(complete); open({ step });
    await runtime.drain();
    expect(step).not.toHaveBeenCalled();
    expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: 'host_restarted' });
    runtime.resume('a'); await runtime.drain();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('selects the latest checkpoint whose evidence is still valid without refunding budget', async () => {
    let changed = false;
    open({
      validate: async (state) => changed && typeof state.checkpoint === 'number' && state.checkpoint > 1 ? 'stale' : 'valid',
      step: async (state) => ({ status: 'ready', checkpoint: state.stepsUsed }),
    });
    create('a', 3); await runtime.drain(); changed = true;
    const saved = await runtime.findValidCheckpoint('a');
    expect(saved?.checkpoint).toBe(1);
    runtime.restoreCheckpoint('a', saved!.seq);
    expect(runtime.get('a')).toMatchObject({ checkpoint: 1, stepsUsed: 3 });
  });

  it('does not let a Run succeed while one of its agents is paused', async () => {
    open(); create('a'); runtime.pause('a');
    expect(() => domain.reportRunSucceeded('run')).toThrow('agents');
    runtime.resume('a'); await runtime.drain();
    domain.reportRunSucceeded('run');
    expect(domain.getStore().getRun('run')?.status).toBe('succeeded');
  });

  it('rejects two runtime owners and closed-runtime writes', () => {
    open();
    expect(() => new AgentRuntime(domain, { maxConcurrentAgents: 2, step: complete })).toThrow('already');
    runtime.close();
    expect(() => create('a')).toThrow('closed');
    const previous = runtime;
    open(); previous.close();
    expect(() => new AgentRuntime(domain, { maxConcurrentAgents: 2, step: complete })).toThrow('already');
  });

  it('rejects invalid budgets and non-JSON checkpoints before persisting an agent', () => {
    open();
    expect(() => create('a', 0)).toThrow('maxSteps');
    expect(() => runtime.create({ id: 'a', runId: 'run', input: null, checkpoint: NaN, maxSteps: 1 })).toThrow('JSON');
    expect(runtime.list()).toEqual([]);
  });

  it('can create a child from a running parent without a second drain', async () => {
    const calls: string[] = [];
    open({ step: async (state) => {
      calls.push(state.id);
      if (state.id === 'parent') create('child', 2, 'parent');
      return complete(state);
    } });
    create('parent'); await runtime.drain();
    expect(calls).toEqual(['parent', 'child']);
  });

  it('preserves an interrupted origin when recovery produces no checkpoint', async () => {
    open({ step: async () => { throw new Error('lost step'); } });
    create('a'); await runtime.drain();
    const before = runtime.get('a');
    expect(await runtime.recoverCheckpoint('a', async () => undefined)).toBeUndefined();
    expect(runtime.get('a')).toEqual(before);
    expect(() => runtime.resume('a')).toThrow('interrupted');
  });

  it('does not start reconstruction after its Run has ended', async () => {
    open(); create('a'); runtime.pause('a'); domain.reportRunFailed('run');
    const prepare = vi.fn(async () => undefined);
    await expect(runtime.recoverCheckpoint('a', prepare)).rejects.toThrow('cannot accept');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('stores input once and omits checkpoint bodies from control-only transitions', async () => {
    open({ step: async (agent) => {
      runtime.pause(agent.id);
      return { status: 'ready', checkpoint: { content: 'new'.repeat(1024) } };
    } });
    create('a');
    const original = runtime.checkpoints('a')[0];
    await runtime.drain();
    runtime.restoreCheckpoint('a', original.seq);
    const events = domain.getStore().getJournalEvents(domain.domainId).filter((event) => event.type === 'AGENT_STATE');
    expect(events.every((event) => event.payload.version === 2)).toBe(true);
    expect(events.filter((event) => Object.hasOwn(event.payload, 'input'))).toHaveLength(1);
    expect(events.filter((event) => Object.hasOwn(event.payload, 'checkpoint'))).toHaveLength(2);
    expect(events.at(-1)?.payload.checkpointRef).toBe(original.seq);
    expect(events.every((event) => !Object.hasOwn(event.payload.state as object, 'checkpoint'))).toBe(true);
    expect(runtime.get('a')).toMatchObject({ input: { instruction: 'a' }, checkpoint: { turn: 0 }, stepsUsed: 1 });
  });

  it('reads mixed legacy and compact events and follows restored checkpoint references after reopen', async () => {
    const store = domain.getStore();
    const legacy: AgentState = { id: 'legacy', runId: 'run', parentId: null, input: 'old input', checkpoint: 'old checkpoint',
      workspace: null, status: 'paused', maxSteps: 5, stepsUsed: 1, pauseRequested: false, reason: 'requested', error: null };
    const oldSeq = store.recordJournalEvent({ domainId: domain.domainId, runId: 'run', type: 'AGENT_STATE',
      payload: { version: 1, transition: 'step_completed', state: legacy }, timestamp: new Date().toISOString() });
    open({ step: async (agent) => { runtime.pause(agent.id); return { status: 'ready', checkpoint: 'new checkpoint' }; } });
    runtime.resume('legacy'); await runtime.drain();
    runtime.restoreCheckpoint('legacy', oldSeq);
    runtime.restoreCheckpoint('legacy', runtime.checkpoints('legacy').at(-1)!.seq);
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(root, 'agents'); open();
    expect(runtime.get('legacy')).toMatchObject({ input: 'old input', checkpoint: 'old checkpoint', stepsUsed: 2 });
    expect(runtime.checkpoints('legacy').map((entry) => entry.checkpoint)).toEqual([
      'old checkpoint', 'new checkpoint', 'old checkpoint', 'old checkpoint',
    ]);
    expect(domain.getStore().getJournalEvent('another-domain', oldSeq)).toBeNull();
  });

  it.each(['self', 'foreign'] as const)('does not silently skip a corrupt %s checkpoint reference', (kind) => {
    open(); create('a'); runtime.pause('a'); create('b');
    const store = domain.getStore();
    const foreign = runtime.checkpoints('b')[0].seq;
    const next = store.getJournalEvents(domain.domainId).at(-1)!.seq + 1;
    const { input: _input, checkpoint: _checkpoint, ...state } = runtime.get('a')!;
    store.recordJournalEvent({ domainId: domain.domainId, runId: 'run', type: 'AGENT_STATE', timestamp: new Date().toISOString(),
      payload: { version: 2, transition: 'restored', state, checkpointRef: kind === 'self' ? next : foreign } });
    expect(() => runtime.get('a')).toThrow(/checkpoint/);
    expect(() => runtime.get('a')).toThrow(/checkpoint/);
  });

  it('holds recovery ownership through failed binding cleanup and reports both errors', async () => {
    open(); create('a'); runtime.pause('a');
    const before = runtime.get('a');
    const entered = deferred(); const release = deferred();
    const pending = runtime.recoverCheckpoint('a', async () => ({
      seq: -1, discard: async () => { entered.resolve(); await release.promise; throw new Error('cleanup failed'); },
    })).then(() => undefined, (error: unknown) => error);
    await entered.promise;
    try {
      expect(runtime.get('a')?.status).toBe('recovering');
      expect(() => runtime.close()).toThrow('recovery');
      expect(() => runtime.resume('a')).toThrow('recovering');
      expect(runtime.pause('a')).toMatchObject({ status: 'recovering', pauseRequested: true });
    } finally { release.resolve(); }
    const error = await pending;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual([
      'Error: No checkpoint -1 for agent "a"', 'Error: cleanup failed',
    ]);
    expect(runtime.get('a')).toEqual(before);
  });
});
