import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain, type AgentRuntimeOptions, type AgentExecution } from '../../src/index.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('agent runtime shutdown barrier', () => {
  let root: string;
  let domain: ExecutionDomain;
  let runtime: AgentRuntime;
  const pending: Promise<unknown>[] = [];
  const releases: (() => void)[] = [];
  const open = (options: Partial<AgentRuntimeOptions> = {}) => (runtime = new AgentRuntime(domain, {
    maxConcurrentAgents: 2, step: async () => ({ status: 'completed', checkpoint: 1 }), ...options,
  }));
  const create = (id = 'a') => runtime.create({ id, runId: 'run', input: null, checkpoint: 0, maxSteps: 3 });
  const hold = () => { const value = gate(); releases.push(value.resolve); return value; };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agent-shutdown-'));
    domain = ExecutionDomain.acquire(root, 'shutdown');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'shutdown', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(pending.splice(0));
    runtime?.close(); domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stops admission synchronously and pauses ready agents without dispatch', async () => {
    const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
    open({ step }); create(); create('paused'); runtime.pause('paused');
    const checkpoint = runtime.checkpoints('a')[0].seq;
    const draining = runtime.drain(); pending.push(draining);
    const shutdown = runtime.shutdown(); pending.push(shutdown);
    expect(runtime.shutdown()).toBe(shutdown);
    expect(() => create('late')).toThrow('shutting down');
    expect(() => runtime.resume('paused')).toThrow('shutting down');
    expect(() => runtime.restoreCheckpoint('paused', checkpoint)).toThrow('shutting down');
    expect(() => runtime.drain()).toThrow('shutting down');
    expect(() => runtime.close()).toThrow('shutdown');
    await shutdown;
    expect(step).not.toHaveBeenCalled();
    expect(() => runtime.list()).toThrow('closed');
    open();
    expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: 'shutdown', checkpoint: 0, stepsUsed: 0 });
    expect(runtime.get('paused')).toMatchObject({ status: 'paused', reason: 'requested' });
    expect(domain.getStore().getRun('run')?.status).toBe('running');
  });

  it('cancels validation without charging a step or releasing ownership early', async () => {
    const entered = gate(); const release = hold(); let signal!: AbortSignal;
    const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
    open({ step, validate: async (_agent, cancellation) => {
      signal = cancellation; entered.resolve(); await release.promise; return 'valid';
    } });
    create(); pending.push(runtime.drain()); await entered.promise;
    let settled = false;
    const shutdown = runtime.shutdown(); pending.push(shutdown);
    void shutdown.then(() => { settled = true; });
    await expect.poll(() => signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(() => new AgentRuntime(domain, { maxConcurrentAgents: 1, step })).toThrow('already');
    release.resolve(); await shutdown;
    expect(step).not.toHaveBeenCalled();
    open(); expect(runtime.get('a')).toMatchObject({ status: 'interrupted', stepsUsed: 0, checkpoint: 0 });
  });

  it('waits for an adapter that ignores cancellation and rejects late commands', async () => {
    const entered = gate(); const release = hold(); let context!: AgentExecution;
    open({ maxConcurrentAgents: 1, step: async (_agent, execution) => {
      context = execution; entered.resolve(); await release.promise;
      return { status: 'completed', checkpoint: 99 };
    } });
    create(); create('queued'); pending.push(runtime.drain()); await entered.promise;
    const shutdown = runtime.shutdown(); pending.push(shutdown);
    await expect.poll(() => context.signal.aborted).toBe(true);
    await expect(context.executeProcess({ opId: 'late', name: 'late',
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: root },
    })).rejects.toThrow();
    expect(domain.getStore().getOperation('late')).toBeNull();
    expect(runtime.get('a')).toMatchObject({ status: 'running', checkpoint: 0 });
    release.resolve(); await shutdown;
    open();
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', stepsUsed: 1, checkpoint: 0 });
    expect(runtime.checkpoints('a')).toHaveLength(1);
    expect(runtime.get('queued')).toMatchObject({ status: 'paused', reason: 'shutdown', stepsUsed: 0 });
  });

  it('settles running and queued commands before closing', async () => {
    domain.setDomainBudget({ maxConcurrentOps: 1 });
    const started = gate();
    open({ step: async (_agent, execution) => {
      const running = execution.executeProcess({ opId: 'running', name: 'running', timeoutMs: 5000,
        command: { execPath: process.execPath, args: ['-e', 'console.log("started"); setInterval(() => {}, 1000)'], cwd: root },
        requiredResources: ['exclusive'], onStreamChunk: () => started.resolve(),
      });
      const queued = execution.executeProcess({ opId: 'queued', name: 'queued', waitTimeoutMs: 5000,
        command: { execPath: process.execPath, args: ['-e', 'require("fs").writeFileSync("unexpected", "x")'], cwd: root },
        requiredResources: ['exclusive'],
      });
      await Promise.allSettled([running, queued]);
      return { status: 'completed', checkpoint: 1 };
    } });
    create(); pending.push(runtime.drain()); await started.promise;
    const shutdown = runtime.shutdown(); pending.push(shutdown); await shutdown;
    expect(fs.existsSync(path.join(root, 'unexpected'))).toBe(false);
    expect(domain.getStore().getOperation('running')?.result?.status).toBe('cancelled');
    expect(domain.isResourceLocked('exclusive')).toBe(false);
    open(); expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 0 });
  });

  it('waits for reconstruction and permits its final binding, but not resumption', async () => {
    const entered = gate(); const release = hold();
    open(); create(); runtime.pause('a');
    const recovery = runtime.recoverCheckpoint('a', async (checkpoints) => {
      entered.resolve(); await release.promise; return { seq: checkpoints[0].seq };
    });
    pending.push(recovery); await entered.promise;
    const shutdown = runtime.shutdown(); pending.push(shutdown);
    const prepare = vi.fn(async () => undefined);
    await expect(runtime.recoverCheckpoint('a', prepare)).rejects.toThrow('shutting down');
    await expect(runtime.findValidCheckpoint('a')).rejects.toThrow('shutting down');
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.get('a')?.status).toBe('recovering');
    release.resolve(); await recovery; await shutdown;
    open(); expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: 'restored', stepsUsed: 0 });
  });

  it('waits for failed recovery cleanup and propagates its errors', async () => {
    const entered = gate(); const release = hold();
    open(); create(); runtime.pause('a');
    const recovery = runtime.recoverCheckpoint('a', async () => ({ seq: -1, discard: async () => {
      entered.resolve(); await release.promise; throw new Error('discard failed');
    } }));
    const recovering = recovery.catch((error: unknown) => error); pending.push(recovering);
    await entered.promise;
    const shutdown = runtime.shutdown();
    const stopped = shutdown.catch((error: unknown) => error); pending.push(stopped);
    expect(runtime.get('a')?.status).toBe('recovering');
    release.resolve();
    const recoveryError = await recovering;
    expect(recoveryError).toBeInstanceOf(AggregateError);
    const error = await stopped;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(recoveryError);
    expect((recoveryError as AggregateError).errors.map(String)).toContain('Error: discard failed');
    expect(() => runtime.list()).toThrow('closed');
    open(); expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: 'requested' });
  });

  it('reports a journal failure but still waits for and interrupts independent work', async () => {
    const entered = gate(); const release = hold(); let signal!: AbortSignal;
    open({ maxConcurrentAgents: 1, step: async (_agent, execution) => {
      signal = execution.signal; entered.resolve(); await release.promise;
      return { status: 'completed', checkpoint: 1 };
    } });
    create('active'); create('queued'); pending.push(runtime.drain()); await entered.promise;
    const store = domain.getStore(); const record = store.recordJournalEvent.bind(store);
    const spy = vi.spyOn(store, 'recordJournalEvent').mockImplementation((event) => {
      if (event.payload.transition === 'shutdown_requested') throw new Error('shutdown journal failed');
      return record(event);
    });
    const shutdown = runtime.shutdown();
    const stopped = shutdown.catch((error: unknown) => error); pending.push(stopped);
    await expect.poll(() => signal.aborted).toBe(true);
    expect(runtime.get('active')?.status).toBe('running');
    release.resolve(); const error = await stopped;
    expect(String(error)).toContain('shutdown journal failed');
    spy.mockRestore(); open();
    expect(runtime.get('active')?.status).toBe('interrupted');
    expect(runtime.get('queued')?.status).toBe('paused');
  });

  it('is idempotent for an empty or already closed runtime', async () => {
    open(); await runtime.shutdown(); await runtime.shutdown(); runtime.close();
    open(); runtime.close(); await runtime.shutdown();
  });

  it('does not start a step when validation resolves just before shutdown', async () => {
    const entered = gate();
    let validate!: (value: 'valid') => void;
    const verdict = new Promise<'valid'>((resolve) => { validate = resolve; });
    const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
    open({ step, validate: () => { entered.resolve(); return verdict; } });
    create(); pending.push(runtime.drain()); await entered.promise;
    validate('valid');
    const shutdown = runtime.shutdown(); pending.push(shutdown); await shutdown;
    expect(step).not.toHaveBeenCalled();
    open(); expect(runtime.get('a')?.stepsUsed).toBe(0);
  });

  it('joins reconstruction when shutdown is requested inside its callback', async () => {
    const release = hold(); const entered = gate();
    let shutdown!: Promise<void>;
    open(); create(); runtime.pause('a');
    const recovery = runtime.recoverCheckpoint('a', async () => {
      shutdown = runtime.shutdown(); pending.push(shutdown);
      entered.resolve(); await release.promise; return undefined;
    });
    pending.push(recovery); await entered.promise;
    expect(runtime.get('a')?.status).toBe('recovering');
    expect(() => runtime.close()).toThrow('shutdown');
    release.resolve(); await recovery; await shutdown;
    open(); expect(runtime.get('a')).toMatchObject({ status: 'paused', reason: 'requested' });
  });

  it('joins an active checkpoint search without validating more candidates', async () => {
    const entered = gate(); const release = hold(); let searching = false; let calls = 0;
    open({
      step: async (agent) => ({ status: 'ready', checkpoint: agent.stepsUsed }),
      validate: async () => {
        if (!searching) return 'valid';
        calls++; entered.resolve(); await release.promise; return 'stale';
      },
    });
    create(); await runtime.drain(); searching = true;
    const search = runtime.findValidCheckpoint('a'); pending.push(search); await entered.promise;
    let settled = false;
    const shutdown = runtime.shutdown(); pending.push(shutdown);
    void shutdown.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(runtime.get('a')?.status).toBe('paused');
    release.resolve(); expect(await search).toBeUndefined(); await shutdown;
    expect(calls).toBe(1);
  });
});
