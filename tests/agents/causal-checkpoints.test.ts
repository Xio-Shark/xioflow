import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph } from '../../src/index.js';
import type { AgentRuntimeOptions, AgentWorkspace } from '../../src/index.js';

describe('agent checkpoint causal branches', () => {
  let temp: string;
  let domain: ExecutionDomain;
  let runtime: AgentRuntime;
  let graph: WorkspaceCausalGraph;
  let workspace: AgentWorkspace;
  const open = (options: Partial<AgentRuntimeOptions> = {}) => {
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1,
      step: async (agent) => ({ status: 'ready', checkpoint: agent.stepsUsed }), ...options });
  };
  const node = (dependsOn: number[] = []) => graph.record({ txId: 'tx', actorId: 'a', dependsOn,
    observation: { kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'value' } });
  const create = (causalHeads?: number[] | null) => runtime.create({ id: 'a', runId: 'run',
    input: null, checkpoint: 'initial', workspace, causalHeads, maxSteps: 3 });
  beforeEach(async () => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-causal-checkpoint-')));
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'input'), 'value');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    workspace = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'tx', runId: 'run', root, forkPath: path.join(temp, 'fork') });
    graph = new WorkspaceCausalGraph(domain);
  });
  afterEach(() => {
    runtime?.close();
    domain.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('persists explicit branches, workspace bindings and restored context across reopen', async () => {
    const source = node();
    const sibling = node();
    let output = 0;
    open({ step: async () => {
      output = node([source.seq]).seq;
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'derived', causalHeads: [output] };
    } });
    const heads = [source.seq, source.seq];
    create(heads);
    heads.push(sibling.seq);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    const derived = runtime.checkpoints('a')[1];
    expect(runtime.checkpointCausalView('a', derived.seq)?.nodes.map((n) => n.seq)).toEqual([source.seq, output]);
    expect(derived.workspace).toEqual({ txId: workspace.txId, forkRoot: workspace.forkRoot });
    const next = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'restored', runId: 'run',
      root: path.join(temp, 'repo'), forkPath: path.join(temp, 'restored') });
    runtime.restoreCheckpoint('a', initial.seq, next);
    expect(runtime.get('a')).toMatchObject({ checkpoint: 'initial', causalHeads: [source.seq], stepsUsed: 1,
      workspace: { txId: 'restored' } });
    expect(runtime.checkpoints('a')[0].workspace?.txId).toBe('tx');
    runtime.restoreCheckpoint('a', runtime.checkpoints('a').at(-1)!.seq);
    runtime.close();
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpointCausalView('a', derived.seq)?.heads).toEqual([output]);
    expect(runtime.get('a')?.causalHeads).toEqual([source.seq]);
    expect(runtime.checkpointCausalView('a', initial.seq)?.nodes.map((n) => n.seq)).toEqual([source.seq]);
    const returned = runtime.checkpoints('a');
    returned[0].causalHeads!.push(output);
    expect(runtime.checkpoints('a')[0].causalHeads).toEqual([source.seq]);
    expect(runtime.checkpoints('a').at(-1)?.workspace?.txId).toBe('restored');
  });

  it('validates each candidate using its own causal branch', async () => {
    const source = node();
    const later = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'later', causalHeads: [later.seq] };
    }, validate: async (agent) => agent.causalHeads?.includes(later.seq) ? 'stale' : 'valid' });
    create([source.seq]);
    await runtime.drain();
    const saved = await runtime.findValidCheckpoint('a');
    expect(saved?.checkpoint).toBe('initial');
    expect(saved?.causalHeads).toEqual([source.seq]);
  });

  it('clears omitted evidence and distinguishes an explicit empty branch', async () => {
    open({ step: async () => { runtime.pause('a'); return { status: 'ready', checkpoint: 'untracked' }; } });
    create([]);
    const initial = runtime.checkpoints('a')[0];
    expect(runtime.checkpointCausalView('a', initial.seq)).toEqual({ heads: [], nodes: [] });
    await runtime.drain();
    expect(runtime.get('a')?.causalHeads).toBeNull();
    expect(runtime.checkpointCausalView('a', runtime.checkpoints('a')[1].seq)).toBeUndefined();
    runtime.restoreCheckpoint('a', initial.seq);
    expect(runtime.get('a')?.causalHeads).toEqual([]);
  });

  it('binds recovered heads atomically and preserves the prior branch on preparation failure', async () => {
    const source = node();
    const later = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'later', causalHeads: [later.seq] };
    } });
    create([source.seq]);
    await runtime.drain();
    await expect(runtime.recoverCheckpoint('a', async () => { throw new Error('replay failed'); })).rejects.toThrow('replay failed');
    expect(runtime.get('a')).toMatchObject({ checkpoint: 'later', causalHeads: [later.seq] });
    const restored = await runtime.recoverCheckpoint('a', async (saved) => {
      expect(saved.map((entry) => entry.causalHeads)).toEqual([[source.seq], [later.seq]]);
      return { seq: saved[0].seq };
    });
    expect(restored).toMatchObject({ checkpoint: 'initial', causalHeads: [source.seq], stepsUsed: 1, status: 'paused' });
    expect(runtime.checkpointCausalView('a', runtime.checkpoints('a').at(-1)!.seq)?.heads).toEqual([source.seq]);
  });

  it('rejects unknown heads before creation or checkpoint completion', async () => {
    open({ step: async () => ({ status: 'ready', checkpoint: 'invalid', causalHeads: [999999] }) });
    expect(() => create([999999])).toThrow('absent');
    expect(runtime.get('a')).toBeUndefined();
    create([node().seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 'initial', causalHeads: initial.causalHeads, stepsUsed: 1 });
    expect(runtime.checkpoints('a')).toHaveLength(1);
    expect(() => runtime.checkpointCausalView('a', 999999)).toThrow('No checkpoint');
  });

  it('routes transitive cross-agent impact while excluding independent and sibling branches', async () => {
    const source = node();
    const independent = node();
    const derived = graph.record({ txId: 'tx', actorId: 'producer', dependsOn: [source.seq],
      observation: { kind: 'observe', call: { tool: 'derive', args: {} }, resultHash: 'derived' } });
    const sibling = node([source.seq]);
    open({ step: async (agent) => {
      runtime.pause(agent.id);
      return { status: 'ready', checkpoint: 'derived', causalHeads: [derived.seq, independent.seq] };
    } });
    create([independent.seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    for (const [id, heads] of [['consumer', [derived.seq]], ['independent', [independent.seq]],
      ['empty', []], ['untracked', null]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: id,
        causalHeads: heads === null ? null : [...heads], maxSteps: 1 });
    }
    const before = domain.getStore().getJournalEvents(domain.domainId).length;
    const plan = runtime.planCausalRecovery([source.seq, source.seq]);
    expect(plan.changed).toEqual([source.seq]);
    expect(plan.affected.map((entry) => entry.agentId)).toEqual(['a', 'consumer']);
    expect(plan.affected[0]).toMatchObject({ invalidatedHeads: [derived.seq],
      invalidatedNodes: [source.seq, derived.seq], restartFrom: initial });
    expect(plan.affected[0].invalidatedNodes).not.toContain(sibling.seq);
    expect(plan.affected[1].restartFrom).toBeUndefined();
    expect(plan.unaffected).toEqual(['independent', 'empty']);
    expect(plan.untracked).toEqual(['untracked']);
    expect(domain.getStore().getJournalEvents(domain.domainId)).toHaveLength(before);
    plan.affected[0].restartFrom!.causalHeads!.push(source.seq);
    expect(runtime.checkpoints('a')[0]).toEqual(initial);
    const recovered = await runtime.recoverCheckpoint('a', async () => ({ seq: initial.seq }));
    expect(recovered).toMatchObject({ causalHeads: [independent.seq], stepsUsed: 1 });
    expect(runtime.planCausalRecovery([source.seq]).affected.map((entry) => entry.agentId)).toEqual(['consumer']);
  });

  it('selects the nearest unaffected tracked checkpoint and survives domain reopen', async () => {
    const changed = node();
    const stable = node();
    let steps = 0;
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: ++steps, causalHeads: steps === 1 ? [stable.seq] : [changed.seq] };
    } });
    create([]);
    await runtime.drain();
    const nearest = runtime.checkpoints('a').at(-1)!;
    runtime.resume('a');
    await runtime.drain();
    const before = runtime.planCausalRecovery([changed.seq]);
    expect(before.affected[0].restartFrom).toEqual(nearest);
    runtime.close();
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.planCausalRecovery([changed.seq])).toEqual(before);
  });

  it('does not use untracked history as a restart candidate and includes completed outputs', async () => {
    const changed = node();
    open({ step: async () => ({ status: 'completed', checkpoint: 'output', causalHeads: [changed.seq] }) });
    create();
    await runtime.drain();
    const plan = runtime.planCausalRecovery([changed.seq]);
    expect(plan.affected[0].agentId).toBe('a');
    expect(plan.affected[0].restartFrom).toBeUndefined();
    expect(runtime.get('a')?.status).toBe('completed');
    expect(runtime.planCausalRecovery([])).toEqual({ changed: [], affected: [], unaffected: ['a'], untracked: [] });
    expect(() => runtime.planCausalRecovery([999999])).toThrow('absent');
    expect(() => runtime.planCausalRecovery([NaN])).toThrow('absent');
  });
});
