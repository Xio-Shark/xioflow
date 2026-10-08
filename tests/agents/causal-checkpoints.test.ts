import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, prepareWorkspaceRepair, forkAgentCheckpoint, compareAgentCheckpoints, compareAgentCheckpointFiles, recoverAgentCausalBatch } from '../../src/index.js';
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

  it('compares reconstructed files after source disposal without changing agents or live files', async () => {
    open({ step: async () => {
      fs.unlinkSync(path.join(workspace.forkRoot, 'input'));
      fs.writeFileSync(path.join(workspace.forkRoot, '新文件\n.bin'), Buffer.from([0, 255, 1]));
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'edited', causalHeads: [] };
    } });
    create([]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    const edited = runtime.checkpoints('a').at(-1)!;
    const supervisor = new ProcessSupervisor(domain);
    await supervisor.abortWorkspaceTransaction('tx');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'future');
    const usage = runtime.getRunUsage('run');
    const source = runtime.get('a');
    const result = await compareAgentCheckpointFiles(runtime, supervisor, {
      left: { sourceAgentId: 'a', checkpointSeq: initial.seq, txId: 'compare-left',
        forkPath: path.join(temp, 'compare-left'), replayPolicy: 'deterministic',
        observations: () => ({ closedWorld: true, log: [], replay: async () => '' }) },
      right: { sourceAgentId: 'a', checkpointSeq: edited.seq, txId: 'compare-right',
        forkPath: path.join(temp, 'compare-right'), replayPolicy: 'deterministic',
        observations: () => ({ closedWorld: true,
          log: [{ kind: 'mutate', call: { tool: 'edit', args: {} }, resultHash: 'ok' }],
          replay: async (_, root) => {
            expect(fs.readFileSync(path.join(root, 'input'), 'utf8')).toBe('value');
            fs.unlinkSync(path.join(root, 'input'));
            fs.writeFileSync(path.join(root, '新文件\n.bin'), Buffer.from([0, 255, 1]));
            return 'ok';
          } }) },
    });
    expect(result).toMatchObject({ status: 'compared', replayedSteps: { left: 0, right: 1 },
      files: [{ status: 'D', path: 'input' }, { status: 'A', path: '新文件\n.bin' }] });
    expect(runtime.get('a')).toEqual(source);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(fs.readFileSync(path.join(temp, 'repo', 'input'), 'utf8')).toBe('future');
    for (const side of ['left', 'right']) expect(fs.existsSync(path.join(temp, `compare-${side}`))).toBe(false);
    expect(domain.getStore().getSnapshot('tx-base')).toBeDefined();
  });

  it('compares different baselines within a subdirectory and excludes outside changes', async () => {
    open();
    const supervisor = new ProcessSupervisor(domain);
    const root = path.join(temp, 'repo', 'nested');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'data'), 'old');
    fs.writeFileSync(path.join(root, 'link'), 'regular');
    const refs = [];
    for (const name of ['before', 'after']) {
      if (name === 'after') {
        fs.writeFileSync(path.join(root, 'data'), 'new');
        fs.unlinkSync(path.join(root, 'link'));
        fs.symlinkSync('data', path.join(root, 'link'));
        fs.writeFileSync(path.join(temp, 'repo', 'input'), 'outside change');
      }
      const tx = await supervisor.beginWorkspaceTransaction({ txId: name, runId: 'run', root,
        forkPath: path.join(temp, name) });
      runtime.create({ id: name, runId: 'run', input: null, checkpoint: name,
        workspace: tx, causalHeads: [], maxSteps: 1 });
      refs.push({ sourceAgentId: name, checkpointSeq: runtime.checkpoints(name)[0].seq,
        txId: `compare-${name}`, forkPath: path.join(temp, `compare-${name}`), replayPolicy: 'deterministic' as const,
        observations: () => ({ closedWorld: true as const, log: [], replay: async () => '' }) });
      await supervisor.abortWorkspaceTransaction(name);
    }
    const result = await compareAgentCheckpointFiles(runtime, supervisor, { left: refs[0], right: refs[1] });
    expect(result).toMatchObject({ status: 'compared',
      files: [{ status: 'M', path: 'data' }, { status: 'T', path: 'link' }] });
  });

  it.each(['left', 'right'] as const)('reports %s replay divergence and cleans every prepared fork', async (side) => {
    open(); create([]);
    const checkpointSeq = runtime.checkpoints('a')[0].seq;
    const options = (name: 'left' | 'right') => ({ sourceAgentId: 'a', checkpointSeq,
      txId: `compare-${name}`, forkPath: path.join(temp, `compare-${name}`), replayPolicy: 'deterministic' as const,
      observations: () => ({ closedWorld: true as const,
        log: [{ kind: 'observe' as const, call: { tool: 'read', args: {} }, resultHash: 'value' }],
        replay: async () => name === side ? 'changed' : 'value' }) });
    const result = await compareAgentCheckpointFiles(runtime, new ProcessSupervisor(domain), {
      left: options('left'), right: options('right') });
    expect(result).toMatchObject({ status: 'diverged', side, replay: { divergedAt: 0 } });
    for (const name of ['left', 'right']) expect(fs.existsSync(path.join(temp, `compare-${name}`))).toBe(false);
    expect(runtime.getRunUsage('run').agentsCreated).toBe(1);
  });

  it('compares identical reconstructed worlds and rejects an invalid second log with cleanup', async () => {
    open(); create([]);
    const checkpointSeq = runtime.checkpoints('a')[0].seq;
    const options = (name: string) => ({ sourceAgentId: 'a', checkpointSeq, txId: name,
      forkPath: path.join(temp, name), replayPolicy: 'deterministic' as const,
      observations: () => ({ closedWorld: true as const, log: [], replay: async () => '' }) });
    const supervisor = new ProcessSupervisor(domain);
    expect(await compareAgentCheckpointFiles(runtime, supervisor, {
      left: options('same-left'), right: options('same-right') })).toMatchObject({ status: 'compared', files: [] });
    await expect(compareAgentCheckpointFiles(runtime, supervisor, {
      left: options('bad-left'), right: { ...options('bad-right'), observations: () => ({ closedWorld: true,
        log: [{ kind: 'mutate', call: { tool: 'write', args: {} } }], replay: async () => '' }) },
    })).rejects.toThrow('result hashes');
    expect(fs.existsSync(path.join(temp, 'bad-left'))).toBe(false);
    expect(fs.existsSync(path.join(temp, 'bad-right'))).toBe(false);
  });

  it('compares cross-agent branches with shared evidence, divergence roots and declared writes', async () => {
    const shared = node();
    const left = node([shared.seq]);
    const right = node([shared.seq]); // Identical hashes are still different executions.
    const output = graph.record({ txId: 'tx', actorId: 'b', dependsOn: [right.seq],
      observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'output' },
      writes: [{ status: 'M', path: 'input' }] });
    const sibling = node();
    open(); create([left.seq]);
    const branchWorkspace = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'branch',
      runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'branch') });
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: 'alternative',
      workspace: branchWorkspace, causalHeads: [output.seq], maxSteps: 1 });
    const refs = { left: { agentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq },
      right: { agentId: 'b', checkpointSeq: runtime.checkpoints('b')[0].seq } };
    const count = domain.getStore().getJournalEvents(domain.domainId).length;
    const result = compareAgentCheckpoints(runtime, refs.left, refs.right);
    expect(result.context).toEqual([{ kind: 'changed', path: '', before: 'initial', after: 'alternative' }]);
    expect(result.evidence).toEqual({ status: 'compared', leftHeads: [left.seq], rightHeads: [output.seq],
      shared: [shared], leftOnly: [left], rightOnly: [right, output], leftRoots: [left.seq], rightRoots: [right.seq] });
    expect(JSON.stringify(result.evidence)).not.toContain(`"seq":${sibling.seq}`);
    expect(domain.getStore().getJournalEvents(domain.domainId)).toHaveLength(count);
    result.left.saved.checkpoint = 'tampered';
    if (result.evidence.status === 'compared') result.evidence.shared[0].observation.resultHash = 'tampered';
    expect(runtime.checkpoints('a')[0].checkpoint).toBe('initial');
    expect(graph.nodes()[0].observation.resultHash).toBe('value');
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(compareAgentCheckpoints(runtime, refs.left, refs.right).evidence).toMatchObject({
      shared: [shared], rightOnly: [right, output] });
  });

  it('compares selected historical context with stable JSON pointers and atomic arrays', () => {
    open();
    const before = JSON.parse('{"nested":{"a/b~c":1},"removed":null,"array":[1],"same":{"a":1,"b":2},"__proto__":1}');
    const after = JSON.parse('{"nested":{"a/b~c":2},"added":null,"array":[1,2],"same":{"b":2,"a":1},"__proto__":2}');
    runtime.create({ id: 'a', runId: 'run', input: null, checkpoint: before, causalHeads: [], maxSteps: 1 });
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: after, causalHeads: [], maxSteps: 1 });
    const left = { agentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq };
    const right = { agentId: 'b', checkpointSeq: runtime.checkpoints('b')[0].seq };
    expect(compareAgentCheckpoints(runtime, left, right).context).toEqual([
      { kind: 'changed', path: '/__proto__', before: 1, after: 2 },
      { kind: 'added', path: '/added', after: null },
      { kind: 'changed', path: '/array', before: [1], after: [1, 2] },
      { kind: 'changed', path: '/nested/a~1b~0c', before: 1, after: 2 },
      { kind: 'removed', path: '/removed', before: null },
    ]);
    expect(compareAgentCheckpoints(runtime, left, left)).toMatchObject({ context: [], evidence: {
      status: 'compared', shared: [], leftOnly: [], rightOnly: [], leftRoots: [], rightRoots: [] } });
    expect(() => compareAgentCheckpoints(runtime, left, { ...right, checkpointSeq: left.checkpointSeq })).toThrow('No checkpoint');
  });

  it.each([undefined, null])('keeps missing provenance distinct from an explicitly empty branch (%s)', (heads) => {
    open(); create(heads);
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: 'initial', causalHeads: [], maxSteps: 1 });
    const result = compareAgentCheckpoints(runtime,
      { agentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq },
      { agentId: 'b', checkpointSeq: runtime.checkpoints('b')[0].seq });
    expect(result.context).toEqual([]);
    expect(result.evidence).toEqual({ status: 'untracked', left: null, right: { heads: [], nodes: [] } });
  });

  it('compares an ancestor checkpoint without including later or sibling observations', async () => {
    const source = node();
    let output = 0;
    open({ step: async () => {
      output = node([source.seq]).seq;
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'derived', causalHeads: [output] };
    } });
    create([source.seq]);
    const first = runtime.checkpoints('a')[0];
    await runtime.drain();
    const last = runtime.checkpoints('a').at(-1)!;
    node([output]);
    const result = compareAgentCheckpoints(runtime, { agentId: 'a', checkpointSeq: first.seq },
      { agentId: 'a', checkpointSeq: last.seq });
    expect(result.evidence).toMatchObject({ status: 'compared', shared: [source], leftOnly: [],
      rightOnly: [{ seq: output }], leftRoots: [], rightRoots: [output] });
    expect(result.left.saved.stepsUsed).toBe(0);
    expect(result.right.saved.stepsUsed).toBe(1);
  });

  it('forks an old checkpoint from its historical baseline after live changes and source disposal', async () => {
    const source = node();
    const output = graph.record({ txId: 'tx', actorId: 'a', dependsOn: [source.seq],
      observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'derived' },
      writes: [{ status: 'M', path: 'input' }] });
    open({ step: async () => {
      fs.writeFileSync(path.join(workspace.forkRoot, 'input'), 'derived');
      runtime.pause('a');
      return { status: 'ready', checkpoint: { answer: 'derived' }, causalHeads: [output.seq] };
    } });
    create([source.seq]);
    await runtime.drain();
    const saved = runtime.checkpoints('a').at(-1)!;
    const original = runtime.get('a');
    const usage = runtime.getRunUsage('run');
    const supervisor = new ProcessSupervisor(domain);
    await supervisor.abortWorkspaceTransaction('tx');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'future');
    const result = await forkAgentCheckpoint(runtime, supervisor, {
      sourceAgentId: 'a', checkpointSeq: saved.seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: (checkpoint) => {
        expect(checkpoint).toEqual(saved);
        return { closedWorld: true, log: [source.observation, output.observation],
          replay: async (entry, root) => {
            if (entry.kind === 'mutate') fs.writeFileSync(path.join(root, 'input'), 'derived');
            return fs.readFileSync(path.join(root, 'input'), 'utf8');
          } };
      },
    });
    expect(result.status).toBe('forked');
    if (result.status !== 'forked') throw new Error('Expected fork');
    expect(result).toMatchObject({ replayedSteps: 2, agent: { id: 'debug', status: 'ready',
      checkpoint: { answer: 'derived' }, causalHeads: [output.seq], stepsUsed: 0, runId: 'run' } });
    expect(fs.readFileSync(path.join(result.transaction.forkRoot, 'input'), 'utf8')).toBe('derived');
    expect(fs.readFileSync(path.join(temp, 'repo', 'input'), 'utf8')).toBe('future');
    expect(runtime.get('a')).toEqual(original);
    expect(runtime.getRunUsage('run')).toMatchObject({ stepsUsed: usage.stepsUsed, agentsCreated: usage.agentsCreated + 1 });
    expect(domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'AGENT_CHECKPOINT_FORK_PREPARED')?.payload)
      .toMatchObject({ sourceAgentId: 'a', checkpointSeq: saved.seq, agentId: 'debug', txId: 'debug-tx', replayedSteps: 2 });
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.get('debug')).toMatchObject({ status: 'paused', checkpoint: saved.checkpoint, causalHeads: saved.causalHeads });
    expect(runtime.checkpointCausalView('debug', runtime.checkpoints('debug')[0].seq)?.heads).toEqual([output.seq]);
    const comparison = compareAgentCheckpoints(runtime, { agentId: 'a', checkpointSeq: saved.seq },
      { agentId: 'debug', checkpointSeq: runtime.checkpoints('debug')[0].seq });
    expect(comparison).toMatchObject({ context: [], evidence: { status: 'compared', leftOnly: [], rightOnly: [] } });
    expect(comparison.left.saved.workspace?.txId).toBe('tx');
    expect(comparison.right.saved.workspace?.txId).toBe('debug-tx');
  });

  it.each(['hash', 'throw'])('discards a divergent historical replay (%s) and retains the source baseline', async (failure) => {
    const source = node();
    open(); create([source.seq]);
    const saved = runtime.checkpoints('a')[0];
    const baseline = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'TX_BEGUN')!.payload.baseSnapshotId as string;
    const result = await forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
      sourceAgentId: 'a', checkpointSeq: saved.seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [source.observation], replay: async (_entry, root) => {
        fs.writeFileSync(path.join(root, 'input'), 'dirty');
        if (failure === 'throw') throw new Error('adapter failed');
        return 'different';
      } }),
    });
    expect(result).toMatchObject({ status: 'diverged', replay: { divergedAt: 0, matchedSteps: 0,
      ...(failure === 'throw' ? { error: 'adapter failed' } : {}) } });
    expect(runtime.get('debug')).toBeUndefined();
    expect(fs.existsSync(path.join(temp, 'debug'))).toBe(false);
    expect(domain.getStore().getSnapshot(baseline)).toBeDefined();
    expect(fs.readFileSync(path.join(workspace.forkRoot, 'input'), 'utf8')).toBe('value');
  });

  it('cleans a matched fork if agent creation exhausts the shared Run budget', async () => {
    const source = node();
    open({ runBudget: { maxAgents: 1, maxSteps: 10, maxPendingCommands: 1 } });
    create([source.seq]);
    await expect(forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
      sourceAgentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [source.observation], replay: async () => 'value' }),
    })).rejects.toThrow('Run agent budget exhausted');
    expect(runtime.get('debug')).toBeUndefined();
    expect(fs.existsSync(path.join(temp, 'debug'))).toBe(false);
    expect(runtime.getRunUsage('run').agentsCreated).toBe(1);
  });

  it('does not fall back to the live world when the historical snapshot was pruned', async () => {
    const source = node();
    open(); create([source.seq]);
    const supervisor = new ProcessSupervisor(domain);
    const baseline = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'TX_BEGUN')!.payload.baseSnapshotId as string;
    await supervisor.abortWorkspaceTransaction('tx');
    await supervisor.pruneSnapshots([baseline], { runId: 'run' });
    let replayed = false;
    await expect(forkAgentCheckpoint(runtime, supervisor, {
      sourceAgentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [source.observation], replay: async () => {
        replayed = true; return 'value';
      } }),
    })).rejects.toThrow('base snapshot');
    expect(replayed).toBe(false);
    expect(runtime.get('debug')).toBeUndefined();
    expect(fs.existsSync(path.join(temp, 'debug'))).toBe(false);
  });

  it('replays the selected historical checkpoint and isolates recorded hashes from adapter mutation', async () => {
    const source = node();
    open({ step: async () => { runtime.pause('a'); return { status: 'ready', checkpoint: 'later', causalHeads: [] }; } });
    create([source.seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    const result = await forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
      sourceAgentId: 'a', checkpointSeq: initial.seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: (checkpoint) => {
        expect(checkpoint.checkpoint).toBe('initial');
        return { closedWorld: true, log: [source.observation], replay: async (entry) => {
          entry.resultHash = 'changed'; return 'changed';
        } };
      },
    });
    expect(result).toMatchObject({ status: 'diverged', replay: { divergedAt: 0 } });
    expect(runtime.get('a')?.checkpoint).toBe('later');
  });

  it('rejects incomplete replay evidence before allocating a historical fork', async () => {
    const source = node();
    open(); create([source.seq]);
    const options = { sourceAgentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq,
      agentId: 'debug', txId: 'debug-tx', forkPath: path.join(temp, 'debug'), maxSteps: 2,
      replayPolicy: 'deterministic' as const,
      observations: () => ({ closedWorld: true as const,
        log: [{ kind: 'mutate' as const, call: { tool: 'write', args: {} } }], replay: async () => undefined }) };
    await expect(forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), options)).rejects.toThrow('result hashes');
    expect(fs.existsSync(options.forkPath)).toBe(false);
    await expect(forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), { ...options, checkpointSeq: 999999 }))
      .rejects.toThrow('No checkpoint');
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

  it('repairs a batch with real causal recomputation and preserves independent agents and budgets', async () => {
    const source = node();
    const derived = node([source.seq]);
    const stable = node();
    open();
    for (const [id, heads] of [['first', [derived.seq]], ['second', [source.seq]],
      ['stable', [stable.seq]], ['unknown', null]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', maxSteps: 2,
        causalHeads: heads === null ? null : [...heads] });
      runtime.pause(id);
    }
    const usage = runtime.getRunUsage('run');
    const untouched = runtime.get('stable');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'updated');
    const executed: number[] = [];
    const batch = await recoverAgentCausalBatch(runtime, [source.seq, source.seq], async (impact) => {
      const result = await prepareWorkspaceRepair(new ProcessSupervisor(domain), {
        txId: `batch-${impact.agentId}`, runId: 'run', root: path.join(temp, 'repo'),
        forkPath: path.join(temp, `batch-${impact.agentId}`), atSeq: impact.checkpoint.seq,
        heads: impact.checkpoint.causalHeads!, changed: [source.seq],
        validateReuse: async () => {},
        execute: async (entry, tx) => {
          executed.push(entry.seq);
          return { actorId: impact.agentId, observation: { ...entry.observation,
            resultHash: fs.readFileSync(path.join(tx.forkRoot, 'input'), 'utf8') } };
        },
      });
      // Host mutation must not corrupt the retained impact snapshot.
      impact.invalidatedNodes.length = 0;
      return { checkpoint: 'updated', causalHeads: result.heads, workspace: result.transaction };
    });
    expect(batch.plan.changed).toEqual([source.seq]);
    expect(batch.plan.affected[0].invalidatedNodes).toEqual([source.seq, derived.seq]);
    expect(batch.plan.unaffected).toEqual(['stable']);
    expect(batch.plan.untracked).toEqual(['unknown']);
    expect(batch.outcomes.map(({ status }) => status)).toEqual(['repaired', 'repaired']);
    expect(executed).toEqual([source.seq, derived.seq, source.seq]);
    expect(runtime.planCausalRecovery([source.seq]).affected).toEqual([]);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(runtime.get('stable')).toEqual(untouched);
    const saved = runtime.checkpoints('first').at(-1)!;
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpoints('first').at(-1)).toEqual(saved);
    expect(runtime.get('second')).toMatchObject({ checkpoint: 'updated', status: 'paused' });
  });

  it('reports binding failures and declined recovery while continuing the batch', async () => {
    const source = node();
    open();
    for (const id of ['bad', 'declined', 'good']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      runtime.pause(id);
    }
    let discarded = 0;
    const batch = await recoverAgentCausalBatch(runtime, [source.seq], async ({ agentId }) => {
      if (agentId === 'declined') return undefined;
      return { checkpoint: 'new', causalHeads: agentId === 'bad' ? [999999] : [], workspace,
        discard: async () => { discarded++; } };
    });
    expect(batch.outcomes[0]).toMatchObject({ agentId: 'bad', status: 'failed', error: expect.any(Error) });
    expect(batch.outcomes[1]).toMatchObject({ agentId: 'declined', status: 'skipped', reason: 'not_repaired' });
    expect(batch.outcomes[2]).toMatchObject({ agentId: 'good', status: 'repaired' });
    expect(discarded).toBe(1);
    expect(runtime.get('bad')).toMatchObject({ status: 'paused', checkpoint: 'old' });
    expect(runtime.get('declined')).toMatchObject({ status: 'paused', checkpoint: 'old' });
  });

  it('skips active and terminal agents and detects checkpoint changes during an earlier preparation', async () => {
    const source = node();
    open({ step: async () => ({ status: 'completed', checkpoint: 'done', causalHeads: [source.seq] }) });
    runtime.create({ id: 'done', runId: 'run', input: null, checkpoint: null, maxSteps: 1, causalHeads: [source.seq] });
    await runtime.drain();
    for (const id of ['first', 'stale', 'active']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      if (id !== 'active') runtime.pause(id);
    }
    const called: string[] = [];
    const batch = await recoverAgentCausalBatch(runtime, [source.seq], async ({ agentId }) => {
      called.push(agentId);
      runtime.restoreCheckpoint('stale', runtime.checkpoints('stale')[0].seq);
      return { checkpoint: 'new', causalHeads: [], workspace };
    });
    expect(called).toEqual(['first']);
    expect(batch.outcomes.map((entry) => entry.status === 'skipped' ? entry.reason : entry.status))
      .toEqual(['not_stopped', 'repaired', 'checkpoint_changed', 'not_stopped']);
    await expect(recoverAgentCausalBatch(runtime, [999999], async () => undefined)).rejects.toThrow('absent');
    expect(await recoverAgentCausalBatch(runtime, [], async () => { throw new Error('unexpected'); }))
      .toMatchObject({ outcomes: [] });
  });

  it('reports interrupted preparation without publishing context and continues to another agent', async () => {
    const source = node();
    open();
    for (const id of ['first', 'second']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      runtime.pause(id);
    }
    let stopping: Promise<unknown> | undefined;
    let discarded = 0;
    const batch = await recoverAgentCausalBatch(runtime, [source.seq], async ({ agentId }) => {
      if (agentId === 'first') stopping = runtime.interrupt(agentId);
      return { checkpoint: 'new', causalHeads: [], workspace, discard: async () => { discarded++; } };
    });
    await stopping;
    expect(batch.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'not_repaired' });
    expect(batch.outcomes[1]).toMatchObject({ status: 'repaired' });
    expect(discarded).toBe(1);
    expect(runtime.get('first')).toMatchObject({ status: 'interrupted', checkpoint: 'old' });
  });

  it('binds an actual incremental repair with rebuilt context and reopens its history', async () => {
    const source = node();
    const stable = node();
    const derived = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'old context', causalHeads: [derived.seq, stable.seq] };
    } });
    create([]);
    await runtime.drain();
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'updated');
    const impact = runtime.planCausalRecovery([source.seq]).affected[0];
    const executed: number[] = [];
    const repaired = await runtime.recoverCausalCheckpoint('a', impact.checkpoint.seq, async (saved) => {
      expect(runtime.get('a')?.status).toBe('recovering');
      expect(() => runtime.resume('a')).toThrow();
      const result = await prepareWorkspaceRepair(new ProcessSupervisor(domain), {
        txId: 'repair', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'repair'),
        atSeq: saved.seq, heads: saved.causalHeads!, changed: [source.seq],
        validateReuse: async (tx, unaffected) => {
          expect(unaffected.map((entry) => entry.seq)).toEqual([stable.seq]);
          expect(fs.readFileSync(path.join(tx.forkRoot, 'input'), 'utf8')).toBe('updated');
        },
        execute: async (entry, tx) => {
          executed.push(entry.seq);
          const value = fs.readFileSync(path.join(tx.forkRoot, 'input'), 'utf8');
          return { actorId: 'a', observation: { ...entry.observation, resultHash: value } };
        },
      });
      return { checkpoint: { results: result.replacements.map(({ node }) => node.observation.resultHash) },
        causalHeads: result.heads, workspace: result.transaction };
    });
    expect(executed).toEqual([source.seq, derived.seq]);
    expect(repaired).toMatchObject({ checkpoint: { results: ['updated', 'updated'] }, stepsUsed: 1,
      status: 'paused', workspace: { txId: 'repair' }, validatedWorkspaceVersion: null });
    const saved = runtime.checkpoints('a').at(-1)!;
    expect(saved.causalHeads).toContain(stable.seq);
    expect(saved.causalHeads).not.toContain(derived.seq);
    expect(runtime.planCausalRecovery([source.seq]).affected).toEqual([]);
    expect(runtime.planCausalRecovery([saved.causalHeads![0]]).affected[0].checkpoint.seq).toBe(saved.seq);
    expect(runtime.checkpointCausalView('a', impact.checkpoint.seq)?.heads).toEqual([derived.seq, stable.seq]);
    const event = domain.getStore().getJournalEvent(domain.domainId, saved.seq)!;
    expect(event.payload).toMatchObject({ transition: 'causal_repaired', checkpointRef: impact.checkpoint.seq });
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpoints('a').at(-1)).toEqual(saved);
    expect(runtime.get('a')).toEqual(repaired);
    runtime.restoreCheckpoint('a', saved.seq);
    expect(runtime.get('a')?.checkpoint).toEqual(saved.checkpoint);
  });

  it('rejects stale plans before preparation and preserves context on invalid binding', async () => {
    open(); create([node().seq]); runtime.pause('a');
    const saved = runtime.checkpoints('a')[0];
    let called = false;
    await expect(runtime.recoverCausalCheckpoint('a', saved.seq + 1, async () => {
      called = true; return undefined;
    })).rejects.toThrow('replan');
    expect(called).toBe(false);
    let discarded = 0;
    await expect(runtime.recoverCausalCheckpoint('a', saved.seq, async () => ({
      checkpoint: 'bad', causalHeads: [999999], workspace,
      discard: async () => { discarded++; },
    }))).rejects.toThrow('absent');
    expect(discarded).toBe(1);
    expect(runtime.get('a')).toMatchObject({ status: 'paused', checkpoint: saved.checkpoint, causalHeads: saved.causalHeads });
    expect(runtime.checkpoints('a')).toEqual([saved]);
    await expect(runtime.recoverCausalCheckpoint('a', saved.seq, async () => { throw new Error('rebuild failed'); }))
      .rejects.toThrow('rebuild failed');
    expect(await runtime.recoverCausalCheckpoint('a', saved.seq, async () => undefined)).toBeUndefined();
    expect(runtime.checkpoints('a')).toEqual([saved]);
  });

  it('joins interruption and discards a prepared causal context without publishing it', async () => {
    open(); create([node().seq]); runtime.pause('a');
    const saved = runtime.checkpoints('a')[0];
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let discarded = 0;
    const pending = runtime.recoverCausalCheckpoint('a', saved.seq, async () => {
      entered(); await gate;
      return { checkpoint: 'new', causalHeads: [], workspace, discard: async () => { discarded++; } };
    });
    await started;
    const stopping = runtime.interrupt('a');
    release();
    expect(await pending).toBeUndefined();
    await stopping;
    expect(discarded).toBe(1);
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: saved.checkpoint, causalHeads: saved.causalHeads });
    expect(runtime.checkpoints('a')).toEqual([saved]);
  });

  it('rejects untracked contexts and terminal agents before preparation', async () => {
    open({ step: async () => ({ status: 'completed', checkpoint: 'done', causalHeads: [] }) });
    create(); runtime.pause('a');
    let called = false;
    const prepare = async () => { called = true; return undefined; };
    await expect(runtime.recoverCausalCheckpoint('a', runtime.checkpoints('a')[0].seq, prepare)).rejects.toThrow('tracked');
    runtime.create({ id: 'done', runId: 'run', input: null, checkpoint: null, causalHeads: [], maxSteps: 1 });
    await runtime.drain();
    await expect(runtime.recoverCausalCheckpoint('done', runtime.checkpoints('done').at(-1)!.seq, prepare)).rejects.toThrow('Cannot recover');
    expect(called).toBe(false);
  });

});
