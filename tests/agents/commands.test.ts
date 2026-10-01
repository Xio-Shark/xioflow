import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, type AgentExecution,
  type AgentCommandOptions, type AgentRuntimeOptions } from '../../src/index.js';

describe('agent-owned supervised commands', () => {
  let root: string;
  let domain: ExecutionDomain;
  let runtime: AgentRuntime | undefined;
  let draining: Promise<void> | undefined;
  let gates: string[];
  const command = (opId: string, script = 'process.stdout.write("ok")'): AgentCommandOptions => ({
    opId, name: opId, command: { execPath: process.execPath, args: ['-e', script], cwd: root, inheritEnv: false },
    timeoutMs: 5000, waitTimeoutMs: 5000,
  });
  const blocked = (opId: string, started: Set<string>): AgentCommandOptions => {
    const gate = path.join(root, `${opId}.release`);
    gates.push(gate);
    return {
      ...command(opId),
      command: { ...command(opId).command, args: ['-e',
        'const fs = require("node:fs"); console.log("started"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 10);', gate] },
      onStreamChunk: (_stream, chunk) => { if (chunk.toString().includes('started')) started.add(opId); },
    };
  };
  const open = (step: AgentRuntimeOptions['step']) => {
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 2, step });
    return runtime;
  };
  const create = (id: string) => runtime!.create({ id, runId: 'run', input: null, checkpoint: 0, maxSteps: 4 });
  const drain = () => (draining = runtime!.drain());
  const events = () => domain.getStore().getJournalEvents(domain.domainId);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agent-commands-')));
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'commands');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'commands', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    runtime = undefined; draining = undefined; gates = [];
  });
  afterEach(async () => {
    for (const gate of gates) fs.writeFileSync(gate, 'release');
    try { await draining; }
    finally { runtime?.close(); domain.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    { cap: 1, shared: false, parallel: 1 },
    { cap: 2, shared: false, parallel: 2 },
    { cap: 2, shared: true, parallel: 1 },
  ])('schedules two batches with cap=$cap shared=$shared and waits before checkpointing', async ({ cap, shared, parallel }) => {
    domain.setDomainBudget({ maxConcurrentOps: cap });
    const started = new Set<string>();
    const agents = open(async (agent, execution) => {
      for (let i = 0; i < 2; i++) {
        void execution.executeProcess({ ...blocked(`${agent.id}-${i}`, started), requiredResources: shared ? ['shared'] : [] });
        await Promise.resolve();
      }
      return { status: agent.id === 'a' ? 'ready' : 'completed', checkpoint: agent.stepsUsed };
    });
    create('a'); create('b');
    const pending = drain();
    await expect.poll(() => started.size).toBe(parallel);
    for (const id of ['a', 'b']) {
      expect(agents.get(id)).toMatchObject({ status: 'running', checkpoint: 0, stepsUsed: 1 });
      expect(agents.checkpoints(id)).toHaveLength(1);
    }
    expect(() => domain.reportRunSucceeded('run')).toThrow();
    expect(() => agents.close()).toThrow('drain');
    agents.pause('a');
    for (const gate of gates) fs.writeFileSync(gate, 'release');
    await pending;
    expect(started.size).toBe(4);
    expect(agents.get('a')).toMatchObject({ status: 'paused', checkpoint: 1, stepsUsed: 1 });
    expect(agents.get('b')).toMatchObject({ status: 'completed', checkpoint: 1, stepsUsed: 1 });
    const active = new Set<string>();
    let peak = 0;
    for (const event of events()) {
      if (event.type === 'OPERATION_INTENT_REGISTERED') active.add(event.operationId!);
      if (event.type === 'OPERATION_RESULT_RECORDED') active.delete(event.operationId!);
      peak = Math.max(peak, active.size);
    }
    expect(peak).toBe(parallel);
    expect(active.size).toBe(0);
    for (const id of ['a', 'b']) {
      const checkpoint = agents.checkpoints(id).at(-1)!.seq;
      const requests = events().filter((event) => event.type === 'AGENT_OPERATION_REQUESTED' && event.payload.agentId === id);
      expect(requests).toHaveLength(2);
      for (const requested of requests) {
        expect(requested).toMatchObject({ runId: 'run', payload: { agentId: id, step: 1 } });
        const result = events().find((event) => event.type === 'OPERATION_RESULT_RECORDED' && event.operationId === requested.operationId)!;
        expect(result.seq).toBeGreaterThan(requested.seq);
        expect(result.seq).toBeLessThan(checkpoint);
        expect(domain.getStore().getOperation(requested.operationId!)?.result?.status).toBe('succeeded');
      }
    }
  });

  it('waits for siblings after an adapter failure and retains every failure cause', async () => {
    const started = new Set<string>();
    const agents = open(async (_agent, execution) => {
      void execution.executeProcess(blocked('sibling', started));
      await execution.executeProcess({ ...command('bad'), confinement: 'missing-test-driver' }).catch(() => {});
      throw new Error('adapter failed');
    });
    create('a');
    const pending = drain();
    await expect.poll(() => started.size).toBe(1);
    expect(agents.get('a')).toMatchObject({ status: 'running', checkpoint: 0 });
    fs.writeFileSync(gates[0], 'release');
    await pending;
    expect(agents.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 0, stepsUsed: 1 });
    expect(agents.get('a')?.error).toContain('adapter failed');
    expect(agents.get('a')?.error).toContain('missing-test-driver');
    expect(domain.getStore().getOperation('sibling')?.status).toBe('done');
    expect(agents.checkpoints('a')).toHaveLength(1);
  });

  it('rejects expired contexts without submitting another operation', async () => {
    let saved!: AgentExecution;
    open(async (_agent, execution) => { saved = execution; return { status: 'completed', checkpoint: 1 }; });
    create('a'); await drain(); runtime!.close();
    const before = events().length;
    await expect(saved.executeProcess(command('late'))).rejects.toThrow('context is closed');
    expect(events()).toHaveLength(before);
    expect(domain.getStore().getOperation('late')).toBeNull();
  });

  it('joins and replays the same owned op after reopen, but rejects another agent', async () => {
    const options = command('once', 'require("node:fs").appendFileSync("count", "x")');
    const step: AgentRuntimeOptions['step'] = async (agent, execution) => {
      const results = await Promise.all([execution.executeProcess(options), execution.executeProcess(options)]);
      expect(results.every((result) => result.status === 'succeeded')).toBe(true);
      runtime!.pause(agent.id);
      return { status: 'ready', checkpoint: agent.stepsUsed };
    };
    open(step); create('a'); await drain();
    runtime!.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'commands');
    const agents = open(step);
    agents.resume('a'); await drain();
    expect(agents.get('a')).toMatchObject({ status: 'paused', stepsUsed: 2 });
    expect(fs.readFileSync(path.join(root, 'count'), 'utf8')).toBe('x');
    create('b'); await drain();
    expect(agents.get('b')).toMatchObject({ status: 'interrupted', checkpoint: 0 });
    expect(agents.get('b')?.error).toContain('belongs to agent "a"');
    expect(events().filter((event) => event.type === 'AGENT_OPERATION_REQUESTED').every((event) => event.payload.agentId === 'a')).toBe(true);
  });

  it('reserves ownership before an operation leaves the resource wait queue', async () => {
    domain.setDomainBudget({ maxConcurrentOps: 1 });
    const started = new Set<string>();
    const agents = open(async (agent, execution) => {
      if (agent.id === 'a') {
        void execution.executeProcess(blocked('hold', started));
        void execution.executeProcess(command('queued'));
      } else {
        await execution.executeProcess(command('queued'));
      }
      return { status: 'completed', checkpoint: 1 };
    });
    create('a'); create('b'); const pending = drain();
    await expect.poll(() => agents.get('b')?.status).toBe('interrupted');
    expect(agents.get('b')?.error).toContain('belongs to agent "a"');
    expect(domain.getStore().getOperation('queued')).toBeNull();
    expect(events().find((event) => event.type === 'AGENT_OPERATION_REQUESTED' && event.operationId === 'queued')?.payload.agentId).toBe('a');
    for (const gate of gates) fs.writeFileSync(gate, 'release');
    await pending;
    expect(agents.get('a')?.status).toBe('completed');
    expect(domain.getStore().getOperation('queued')?.result?.status).toBe('succeeded');
  });

  it('does not claim an existing operation submitted outside the runtime', async () => {
    const options = command('unowned');
    await new ProcessSupervisor(domain).executeProcess({ ...options, runId: 'run' });
    open(async (_agent, execution) => {
      await execution.executeProcess(options);
      return { status: 'completed', checkpoint: 1 };
    });
    create('a'); await drain();
    expect(runtime!.get('a')?.error).toContain('has no agent ownership');
    expect(events().filter((event) => event.type === 'AGENT_OPERATION_REQUESTED')).toHaveLength(0);
  });

  it('rejects an empty operation id before it can corrupt the ownership journal', async () => {
    open(async (_agent, execution) => {
      await execution.executeProcess(command(''));
      return { status: 'completed', checkpoint: 1 };
    });
    create('a'); await drain();
    expect(runtime!.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 0 });
    expect(runtime!.get('a')?.error).toContain('opId');
    expect(events().filter((event) => event.type === 'AGENT_OPERATION_REQUESTED')).toHaveLength(0);
  });

  it('passes cancellation through the existing stop pipeline before saving its result', async () => {
    const started = new Set<string>();
    const abort = new AbortController();
    open(async (_agent, execution) => {
      const result = await execution.executeProcess({ ...blocked('cancelled', started), abortSignal: abort.signal });
      return { status: 'completed', checkpoint: { outcome: result.status } };
    });
    create('a'); const pending = drain();
    await expect.poll(() => started.size).toBe(1);
    abort.abort(); await pending;
    expect(runtime!.get('a')).toMatchObject({ status: 'completed', checkpoint: { outcome: 'cancelled' } });
    expect(domain.getStore().getOperation('cancelled')?.result).toMatchObject({ status: 'cancelled', terminationReason: 'user_cancelled' });
    expect(domain.getStore().getUnfinishedOperations(domain.domainId)).toHaveLength(0);
  });
});
