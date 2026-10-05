import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain, type AgentRuntimeOptions } from '../../src/index.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('agent interruption barrier', () => {
  let root: string;
  let domain: ExecutionDomain;
  let runtime: AgentRuntime;
  let draining: Promise<void> | undefined;
  const releases: (() => void)[] = [];
  const open = (options: Partial<AgentRuntimeOptions> = {}) => {
    runtime = new AgentRuntime(domain, {
      maxConcurrentAgents: 2,
      step: async () => ({ status: 'completed', checkpoint: 1 }),
      ...options,
    });
    return runtime;
  };
  const create = (id = 'a') => runtime.create({ id, runId: 'run', input: null, checkpoint: 0, maxSteps: 3 });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-interrupt-')));
    domain = ExecutionDomain.acquire(root, 'interrupt');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    draining = undefined;
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    try { await draining; }
    finally { runtime?.close(); domain.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['ready', 'paused'] as const)('interrupts a %s agent without dispatch or budget charge', async (status) => {
    const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
    open({ step }); create();
    if (status === 'paused') runtime.pause('a');
    expect(await runtime.interrupt('a')).toMatchObject({ status: 'interrupted', reason: 'interrupt_requested', checkpoint: 0, stepsUsed: 0 });
    await runtime.drain();
    expect(step).not.toHaveBeenCalled();
    expect(() => runtime.resume('a')).toThrow('restore');
    runtime.restoreCheckpoint('a', runtime.checkpoints('a')[0].seq);
    runtime.resume('a'); await runtime.drain();
    expect(runtime.get('a')).toMatchObject({ status: 'completed', stepsUsed: 1 });
    await expect(runtime.interrupt('a')).rejects.toThrow('completed');
  });

  it('cancels validation without spending a step and waits for validator settlement', async () => {
    const entered = gate(); const release = gate(); releases.push(release.resolve);
    let signal!: AbortSignal;
    const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
    open({ step, validate: async (_agent, cancellation) => {
      signal = cancellation; entered.resolve(); await release.promise;
      signal.throwIfAborted(); return 'valid';
    } });
    create(); draining = runtime.drain(); await entered.promise;
    const stopping = runtime.interrupt('a');
    expect(signal.aborted).toBe(true);
    expect(runtime.get('a')?.status).toBe('checking');
    release.resolve();
    expect(await stopping).toMatchObject({ status: 'interrupted', reason: 'interrupt_requested', stepsUsed: 0 });
    await draining;
    expect(step).not.toHaveBeenCalled();
  });

  it('does not checkpoint or claim settlement when an adapter ignores cancellation', async () => {
    const entered = gate(); const release = gate(); releases.push(release.resolve);
    let signal!: AbortSignal;
    open({ step: async (agent, execution) => {
      if (agent.id === 'a') { signal = execution.signal; entered.resolve(); await release.promise; }
      return { status: 'completed', checkpoint: 1 };
    } });
    create(); create('b'); draining = runtime.drain(); await entered.promise;
    let settled = false;
    const stopping = runtime.interrupt('a').then((state) => { settled = true; return state; });
    const repeated = runtime.interrupt('a');
    await expect.poll(() => runtime.get('b')?.status).toBe('completed');
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(() => runtime.pause('a')).toThrow('pending interruption');
    expect(runtime.get('a')).toMatchObject({ status: 'running', checkpoint: 0 });
    expect(() => runtime.close()).toThrow('drain');
    release.resolve();
    expect(await stopping).toMatchObject({ status: 'interrupted', checkpoint: 0, stepsUsed: 1 });
    expect(await repeated).toEqual(runtime.get('a'));
    await draining;
    expect(runtime.checkpoints('a')).toHaveLength(1);
    const requests = domain.getStore().getJournalEvents(domain.domainId).filter((event) => event.payload.transition === 'interrupt_requested');
    expect(requests).toHaveLength(1);
    runtime.close(); open();
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 0, stepsUsed: 1 });
  });

  it('settles running and queued commands before acknowledging interruption', async () => {
    domain.setDomainBudget({ maxConcurrentOps: 1 });
    const entered = gate();
    open({ step: async (_agent, execution) => {
      const running = execution.executeProcess({
        opId: 'running', name: 'running', requiredResources: ['exclusive'], timeoutMs: 5000,
        command: { execPath: process.execPath, args: ['-e', 'console.log("started"); setInterval(() => {}, 1000)'], cwd: root },
        onStreamChunk: () => entered.resolve(),
      });
      const queued = execution.executeProcess({
        opId: 'queued', name: 'queued', requiredResources: ['exclusive'], waitTimeoutMs: 5000,
        command: { execPath: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("unexpected", "x")'], cwd: root },
      });
      await Promise.allSettled([running, queued]);
      return { status: 'completed', checkpoint: 1 };
    } });
    create(); draining = runtime.drain(); await entered.promise;
    expect(await runtime.interrupt('a')).toMatchObject({ status: 'interrupted', checkpoint: 0, stepsUsed: 1 });
    await draining;
    expect(fs.existsSync(path.join(root, 'unexpected'))).toBe(false);
    expect(domain.getStore().getOperation('running')?.result?.status).toBe('cancelled');
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const stopped = events.find((event) => event.payload.transition === 'interrupted')!;
    const result = events.find((event) => event.type === 'OPERATION_RESULT_RECORDED' && event.operationId === 'running')!;
    expect(stopped.seq).toBeGreaterThan(result.seq);
  });

  it('does not notify the adapter when persisting the interrupt request fails', async () => {
    const entered = gate(); const release = gate(); releases.push(release.resolve);
    let signal!: AbortSignal;
    open({ step: async (_agent, execution) => {
      signal = execution.signal; entered.resolve(); await release.promise;
      return { status: 'completed', checkpoint: 1 };
    } });
    create(); draining = runtime.drain(); await entered.promise;
    const store = domain.getStore();
    const record = store.recordJournalEvent.bind(store);
    const spy = vi.spyOn(store, 'recordJournalEvent').mockImplementation((event) => {
      if (event.payload.transition === 'interrupt_requested') throw new Error('journal unavailable');
      return record(event);
    });
    try {
      await expect(runtime.interrupt('a')).rejects.toThrow('journal unavailable');
      expect(signal.aborted).toBe(false);
      expect(runtime.get('a')).toMatchObject({ status: 'running', reason: null });
    } finally { spy.mockRestore(); release.resolve(); }
    await draining;
    expect(runtime.get('a')).toMatchObject({ status: 'completed', checkpoint: 1 });
  });

  it('joins interruption during workspace reconstruction without binding a checkpoint', async () => {
    const entered = gate(); const release = gate(); releases.push(release.resolve);
    open(); create(); runtime.pause('a');
    const recovery = runtime.recoverCheckpoint('a', async () => {
      entered.resolve(); await release.promise; return undefined;
    });
    await entered.promise;
    const stopping = runtime.interrupt('a');
    expect(runtime.get('a')?.status).toBe('recovering');
    release.resolve();
    await recovery; await stopping;
    expect(runtime.get('a')?.status).toBe('interrupted');
  });
});
