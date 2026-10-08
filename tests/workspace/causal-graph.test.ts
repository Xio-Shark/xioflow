import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, prepareWorkspaceRepair, prepareWorkspaceBranchRepair } from '../../src/index.js';
import type { CausalStep } from '../../src/index.js';
import { replayObservationLog } from '../../src/workspace/observation-replay.js';

describe('workspace causal history', () => {
  let temp: string;
  let root: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  let graph: WorkspaceCausalGraph;
  beforeEach(async () => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-causal-')));
    root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'input.txt'), 'old');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    supervisor = new ProcessSupervisor(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    graph = new WorkspaceCausalGraph(domain);
    for (const txId of ['a', 'b']) {
      await supervisor.beginWorkspaceTransaction({ txId, runId: 'run', root, forkPath: path.join(temp, txId) });
    }
  });
  afterEach(() => {
    domain.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const step = (txId: string, dependsOn: number[] = [], resultHash = 'old'): CausalStep => ({
    txId, actorId: `agent-${txId}`, dependsOn,
    observation: { kind: 'observe', call: { tool: 'read', args: { path: 'input.txt' } }, resultHash },
  });

  it('tracks cross-agent causes and isolates recomputation to a diamond-shaped dependent subgraph', () => {
    const source = graph.record(step('a'));
    const independent = graph.record(step('b', [], 'unrelated'));
    const left = graph.record(step('a', [source.seq]));
    const right = graph.record(step('b', [source.seq]));
    const output = graph.record({ ...step('b', [left.seq, right.seq]),
      observation: { kind: 'mutate', call: { tool: 'write', args: { path: 'output.txt' } }, resultHash: 'ok' },
      writes: [{ status: 'A', path: 'output.txt' }],
    });
    expect(graph.ancestors(output.seq).map((n) => n.seq)).toEqual([source.seq, left.seq, right.seq]);
    const plan = graph.planRecomputation([source.seq]);
    expect(plan.invalidated.map((n) => n.seq)).toEqual([source.seq, left.seq, right.seq, output.seq]);
    expect(plan.unaffected.map((n) => n.seq)).toEqual([independent.seq]);
    expect(output).toMatchObject({ actorId: 'agent-b', txId: 'b', runId: 'run', baseSnapshotId: 'b-base' });
    expect(graph.planRecomputation([source.seq], left.seq).invalidated.map((n) => n.seq)).toEqual([source.seq, left.seq]);
    expect(graph.planRecomputation([]).unaffected).toHaveLength(5);
  });

  it('persists history across domain reopen and adapts to actual observation replay', async () => {
    const entry = graph.record(step('a'));
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    graph = new WorkspaceCausalGraph(domain);
    expect(graph.nodes()).toEqual([entry]);
    const observations = { log: graph.observationLog('a'), replay: async (_entry: unknown, dir: string) => fs.readFileSync(path.join(dir, 'input.txt'), 'utf8') };
    expect(await replayObservationLog(observations, path.join(temp, 'b'))).toMatchObject({ status: 'matched' });
    fs.writeFileSync(path.join(temp, 'b', 'input.txt'), 'changed');
    expect(await replayObservationLog(observations, path.join(temp, 'b'))).toMatchObject({ status: 'diverged', divergedAt: 0 });
    expect(graph.planRecomputation([entry.seq]).invalidated).toEqual([entry]);
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('old');
  });

  it('retains file-change provenance after the transaction commits and its fork is removed', async () => {
    const read = graph.record(step('a'));
    fs.writeFileSync(path.join(temp, 'a', 'output.txt'), 'derived from old');
    const edit = graph.record({ ...step('a', [read.seq]),
      observation: { kind: 'mutate', call: { tool: 'write', args: { path: 'output.txt' } }, resultHash: 'ok' },
      writes: [{ path: 'output.txt', status: 'A' }],
    });
    const committed = await supervisor.commitWorkspaceTransaction('a');
    expect(committed.status).toBe('committed');
    expect(committed.writeSet).toEqual(edit.writes);
    expect(fs.existsSync(path.join(temp, 'a'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe('derived from old');
    expect(graph.ancestors(edit.seq)).toEqual([read]);
    expect(graph.planRecomputation([read.seq]).invalidated).toEqual([read, edit]);
  });

  it('rejects unknown or future dependencies, invalid evidence and closed transactions without appending', async () => {
    expect(() => graph.record(step('a', [99999]))).toThrow('existing nodes');
    expect(() => graph.record(step('missing'))).toThrow('open workspace');
    expect(() => graph.record(step('a', [], ' '))).toThrow('nonempty');
    expect(() => graph.record({ ...step('a'), writes: [{ path: 'x', status: 'A' }] })).toThrow('cannot declare writes');
    await supervisor.abortWorkspaceTransaction('a');
    expect(() => graph.record(step('a'))).toThrow('open workspace');
    await supervisor.commitWorkspaceTransaction('b');
    expect(() => graph.record(step('b'))).toThrow('open workspace');
    expect(graph.nodes()).toEqual([]);
    expect(() => graph.ancestors(999)).toThrow('Unknown');
    expect(() => graph.planRecomputation([999])).toThrow('absent');
    expect(() => graph.nodes(-1)).toThrow('Invalid');
  });

  it('detaches caller data and rejects noncausal journal references', () => {
    const input = step('a');
    const saved = graph.record(input);
    input.observation.resultHash = 'tampered';
    saved.dependsOn.push(999);
    expect(graph.nodes()[0].observation.resultHash).toBe('old');
    expect(graph.nodes()[0].dependsOn).toEqual([]);
    const begun = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'TX_BEGUN')!;
    expect(() => graph.record(step('b', [begun.seq]))).toThrow('existing nodes');
    expect(() => graph.planRecomputation([graph.nodes()[0].seq], begun.seq)).toThrow('absent');
  });

  it('repairs only affected tools, remaps dependencies and commits real files through OCC', async () => {
    const source = graph.record(step('a'));
    const independent = graph.record(step('b', [], 'stable'));
    fs.writeFileSync(path.join(temp, 'a', 'output.txt'), 'old');
    const output = graph.record({ ...step('a', [source.seq, independent.seq]),
      observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'old' },
      writes: [{ path: 'output.txt', status: 'A' }],
    });
    await supervisor.commitWorkspaceTransaction('a');
    fs.writeFileSync(path.join(root, 'input.txt'), 'new');
    const calls: number[] = [];
    const repaired = await prepareWorkspaceRepair(supervisor, {
      txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'),
      changed: [source.seq], atSeq: output.seq,
      validateReuse: async (tx, unaffected) => {
        expect(unaffected.map((node) => node.seq)).toEqual([independent.seq]);
        expect(fs.readFileSync(path.join(tx.forkRoot, 'output.txt'), 'utf8')).toBe('old');
      },
      execute: async (node, tx, dependencies) => {
        calls.push(node.seq);
        const resultHash = node.seq === source.seq
          ? fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8')
          : dependencies[0].observation.resultHash;
        if (node.seq === output.seq) {
          expect(dependencies[0].seq).not.toBe(source.seq);
          expect(dependencies[1].seq).toBe(independent.seq);
          fs.writeFileSync(path.join(tx.forkRoot, 'output.txt'), resultHash);
        }
        return { actorId: node.actorId, observation: { ...node.observation, resultHash }, writes: node.writes };
      },
    });
    expect(calls).toEqual([source.seq, output.seq]);
    expect(repaired.reused).toEqual([independent]);
    expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe('old');
    expect((await supervisor.commitWorkspaceTransaction('repair')).status).toBe('committed');
    expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe('new');
    const event = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'CAUSAL_REPAIR_PREPARED');
    expect(event?.payload.replacements).toEqual(repaired.replacements.map(({ sourceSeq, node }) => ({ sourceSeq, replacementSeq: node.seq })));
    expect(graph.nodes(output.seq)).toEqual([source, independent, output]);
  });

  it.each(['reuse', 'execute'])('discards fork writes when %s fails and never runs downstream nodes', async (failure) => {
    const source = graph.record(step('a'));
    const output = graph.record(step('a', [source.seq]));
    const calls: number[] = [];
    await expect(prepareWorkspaceRepair(supervisor, {
      txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'),
      changed: [source.seq], atSeq: output.seq,
      validateReuse: async () => { if (failure === 'reuse') throw new Error('invalid reuse'); },
      execute: async (node, tx) => {
        calls.push(node.seq);
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'partial');
        throw new Error('tool failed');
      },
    })).rejects.toThrow(failure === 'reuse' ? 'invalid reuse' : 'tool failed');
    expect(calls).toEqual(failure === 'reuse' ? [] : [source.seq]);
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(temp, 'repair'))).toBe(false);
    expect(domain.getStore().getSnapshot('repair-base')).toBeNull();
    expect(graph.nodes()).toEqual([source, output]);
  });

  it('rejects missing changed evidence before creating a transaction', async () => {
    const source = graph.record(step('a'));
    for (const changed of [[], [999999]]) {
      await expect(prepareWorkspaceRepair(supervisor, {
        txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'), changed, atSeq: source.seq,
        validateReuse: async () => {}, execute: async () => { throw new Error('must not execute'); },
      })).rejects.toThrow();
    }
    expect(fs.existsSync(path.join(temp, 'repair'))).toBe(false);
  });


  it('retains OCC conflict checks after repair and preserves concurrent workspace writes', async () => {
    const source = graph.record(step('a'));
    const repaired = await prepareWorkspaceRepair(supervisor, {
      txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'),
      changed: [source.seq], atSeq: source.seq, validateReuse: async () => {},
      execute: async (_node, tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'output.txt'), 'repaired');
        return { actorId: 'repair-agent', observation: {
          kind: 'mutate', call: { tool: 'write', args: { path: 'output.txt' } }, resultHash: 'repaired',
        }, writes: [{ path: 'output.txt', status: 'A' }] };
      },
    });
    fs.writeFileSync(path.join(root, 'output.txt'), 'concurrent');
    expect((await supervisor.commitWorkspaceTransaction(repaired.transaction.txId)).status).toBe('conflict');
    expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe('concurrent');
    await supervisor.abortWorkspaceTransaction(repaired.transaction.txId);
  });

  it('recomputes diamond joins once with new upstream evidence and preserves historical lineage', async () => {
    const source = graph.record(step('a'));
    const left = graph.record(step('a', [source.seq]));
    const right = graph.record(step('b', [source.seq]));
    const join = graph.record(step('b', [left.seq, right.seq]));
    const calls: number[] = [];
    const repaired = await prepareWorkspaceRepair(supervisor, {
      txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'),
      changed: [source.seq, left.seq], atSeq: join.seq, validateReuse: async () => {},
      execute: async (node, tx, dependencies) => {
        calls.push(node.seq);
        expect(dependencies.every((dependency) => dependency.txId === tx.txId)).toBe(true);
        // Callback arguments are detached from the executor's dependency mapping.
        for (const dependency of dependencies) dependency.seq = 999999;
        node.dependsOn.push(999999);
        return { actorId: 'repair-agent', observation: { ...node.observation, resultHash: 'new' } };
      },
    });
    expect(calls).toEqual([source.seq, left.seq, right.seq, join.seq]);
    expect(repaired.replacements[3].node.dependsOn).toEqual(repaired.replacements.slice(1, 3).map(({ node }) => node.seq));
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    const reopened = new WorkspaceCausalGraph(domain);
    expect(reopened.ancestors(repaired.replacements[3].node.seq)).toEqual(repaired.replacements.slice(0, 3).map(({ node }) => node));
    expect(reopened.nodes(join.seq)).toEqual([source, left, right, join]);
  });

  it('selects inclusive branch ancestry across agents without admitting sibling results', () => {
    const source = graph.record(step('a'));
    const selected = graph.record(step('b', [source.seq]));
    const sibling = graph.record(step('a', [source.seq]));
    const independent = graph.record(step('b'));
    const heads = [selected.seq, independent.seq, selected.seq];
    const view = graph.view(heads);
    expect(view.heads).toEqual([selected.seq, independent.seq]);
    expect(view.nodes).toEqual([source, selected, independent]);
    expect(graph.planRecomputation([source.seq], independent.seq, heads)).toEqual({
      invalidated: [source, selected], unaffected: [independent],
    });
    expect(() => graph.planRecomputation([sibling.seq], independent.seq, heads)).toThrow('absent');
    expect(() => graph.view(heads, selected.seq)).toThrow('absent');
    expect(() => graph.view([1.5])).toThrow('absent');
    expect(graph.view([])).toEqual({ heads: [], nodes: [] });
    view.nodes[0].dependsOn.push(sibling.seq);
    view.heads.push(sibling.seq);
    expect(graph.view([selected.seq], selected.seq).nodes).toEqual([source, selected]);
  });

  it('repairs two committed generations without replaying old or abandoned branches', async () => {
    const source = graph.record(step('a'));
    fs.writeFileSync(path.join(temp, 'a', 'stable.txt'), 'stable');
    const stable = graph.record({ ...step('a', [], 'stable'), observation: {
      kind: 'mutate', call: { tool: 'stable', args: {} }, resultHash: 'stable',
    }, writes: [{ path: 'stable.txt', status: 'A' }] });
    fs.writeFileSync(path.join(temp, 'a', 'output.txt'), 'old');
    const output = graph.record({ ...step('a', [source.seq]), observation: {
      kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'old',
    }, writes: [{ path: 'output.txt', status: 'A' }] });
    const abandoned = graph.record(step('b', [source.seq]));
    await supervisor.abortWorkspaceTransaction('b');
    expect((await supervisor.commitWorkspaceTransaction('a')).status).toBe('committed');
    let heads = [output.seq, stable.seq];
    let changed = source.seq;
    const generations: number[][] = [];
    for (const value of ['second', 'third']) {
      fs.writeFileSync(path.join(root, 'input.txt'), value);
      const previousView = graph.view(heads);
      const calls: number[] = [];
      const txId = `repair-${value}`;
      const repaired = await prepareWorkspaceRepair(supervisor, {
        txId, runId: 'run', root, forkPath: path.join(temp, txId), heads,
        changed: [changed], atSeq: graph.nodes().at(-1)!.seq,
        validateReuse: async (tx, nodes) => {
          expect(nodes).toEqual([stable]);
          expect(fs.readFileSync(path.join(tx.forkRoot, 'stable.txt'), 'utf8')).toBe('stable');
        },
        execute: async (node, tx, dependencies) => {
          calls.push(node.seq);
          const resultHash = node.observation.kind === 'observe'
            ? fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8')
            : dependencies[0].observation.resultHash;
          if (node.observation.kind === 'mutate') fs.writeFileSync(path.join(tx.forkRoot, 'output.txt'), resultHash);
          return { actorId: node.actorId, observation: { ...node.observation, resultHash }, writes: node.writes };
        },
      });
      expect(calls).toEqual(previousView.nodes.filter((node) => node.seq !== stable.seq).map((node) => node.seq));
      expect(calls).toHaveLength(2);
      expect(calls).not.toContain(abandoned.seq);
      expect(repaired.heads).toEqual([repaired.replacements[1].node.seq, stable.seq]);
      expect(graph.view(repaired.heads).nodes).toHaveLength(3);
      expect((await supervisor.commitWorkspaceTransaction(txId)).status).toBe('committed');
      expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe(value);
      expect(fs.readFileSync(path.join(root, 'stable.txt'), 'utf8')).toBe('stable');
      const event = domain.getStore().getJournalEvents(domain.domainId)
        .find((entry) => entry.type === 'CAUSAL_REPAIR_PREPARED' && entry.payload.txId === txId)!;
      expect(event.payload.sourceHeads).toEqual(heads);
      expect(event.payload.heads).toEqual(repaired.heads);
      heads = repaired.heads;
      changed = repaired.replacements[0].node.seq;
      generations.push([...heads]);
    }
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    graph = new WorkspaceCausalGraph(domain);
    const event = domain.getStore().getJournalEvents(domain.domainId)
      .find((entry) => entry.type === 'CAUSAL_REPAIR_PREPARED' && entry.payload.txId === 'repair-third')!;
    expect(graph.view(event.payload.heads as number[]).nodes.map((node) => node.observation.resultHash))
      .toEqual(['stable', 'third', 'third']);
    expect(graph.view(generations[0]).nodes.map((node) => node.observation.resultHash))
      .toEqual(['stable', 'second', 'second']);
    expect(graph.view([output.seq, stable.seq], output.seq).nodes).toEqual([source, stable, output]);
  });

  it('rejects changed evidence outside selected heads before creating repair state', async () => {
    const source = graph.record(step('a'));
    const other = graph.record(step('b'));
    for (const heads of [[], [other.seq], [999999]]) {
      await expect(prepareWorkspaceRepair(supervisor, {
        txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'),
        heads, changed: [source.seq], atSeq: other.seq,
        validateReuse: async () => { throw new Error('must not validate'); },
        execute: async () => { throw new Error('must not execute'); },
      })).rejects.toThrow('absent');
    }
    expect(domain.getStore().getJournalEvents(domain.domainId)
      .some((event) => event.payload.txId === 'repair')).toBe(false);
    expect(fs.existsSync(path.join(temp, 'repair'))).toBe(false);
  });

  it('shares cross-agent ancestors once and durably distributes branch heads over two generations', async () => {
    const source = graph.record(step('a'));
    const left = graph.record({ ...step('a', [source.seq]), observation: {
      kind: 'mutate', call: { tool: 'write', args: { path: 'left.txt' } }, resultHash: 'old',
    }, writes: [{ path: 'left.txt', status: 'A' }] });
    const right = graph.record({ ...step('b', [source.seq, left.seq]), observation: {
      kind: 'mutate', call: { tool: 'write', args: { path: 'right.txt' } }, resultHash: 'old',
    }, writes: [{ path: 'right.txt', status: 'A' }] });
    const stable = graph.record(step('b', [], 'stable'));
    const sibling = graph.record(step('a', [source.seq]));
    let changed = source.seq;
    let branches = [
      { id: 'agent-b', heads: [right.seq] },
      { id: 'agent-a', heads: [left.seq, left.seq] },
      { id: 'stable', heads: [stable.seq] },
      { id: 'empty', heads: [] as number[] },
    ];
    for (const value of ['new', 'newer']) {
      fs.writeFileSync(path.join(root, 'input.txt'), value);
      const expected = graph.planRecomputation([changed], undefined, branches.flatMap(b => b.heads));
      const calls: number[] = [];
      const selected = structuredClone(branches);
      const repair = await prepareWorkspaceBranchRepair(supervisor, {
        txId: value, runId: 'run', root, forkPath: path.join(temp, value),
        atSeq: graph.nodes().at(-1)!.seq, changed: [changed], branches: selected,
        validateReuse: async (_tx, nodes) => {
          expect(nodes).toEqual([stable]);
          // Neither callback nor caller mutation may change the frozen distribution.
          selected[0].heads.length = 0;
          selected[1].id = 'tampered';
          nodes[0].seq = -1;
        },
        execute: async (node, tx, dependencies) => {
          calls.push(node.seq);
          const resultHash = dependencies.length ? dependencies[0].observation.resultHash
            : fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8');
          expect(dependencies.every(d => d.txId === tx.txId)).toBe(true);
          if (node.observation.kind === 'mutate') {
            fs.writeFileSync(path.join(tx.forkRoot, node.observation.call.args.path as string), resultHash);
          }
          return { actorId: node.actorId, observation: { ...node.observation, resultHash }, writes: node.writes };
        },
      });
      expect(calls).toEqual(expected.invalidated.map(n => n.seq));
      expect(calls).toHaveLength(3);
      expect(calls).not.toContain(sibling.seq);
      const [newSource, newLeft, newRight] = repair.replacements.map(r => r.node);
      expect(newRight.dependsOn).toEqual([newSource.seq, newLeft.seq]);
      expect(repair.branches).toEqual([
        { id: 'agent-b', sourceHeads: branches[0].heads, heads: [newRight.seq] },
        { id: 'agent-a', sourceHeads: [...new Set(branches[1].heads)], heads: [newLeft.seq] },
        { id: 'stable', sourceHeads: [stable.seq], heads: [stable.seq] },
        { id: 'empty', sourceHeads: [], heads: [] },
      ]);
      expect(fs.existsSync(path.join(root, 'right.txt'))).toBe(value === 'newer');
      expect((await supervisor.commitWorkspaceTransaction(value)).status).toBe('committed');
      expect(fs.readFileSync(path.join(root, 'left.txt'), 'utf8')).toBe(value);
      expect(fs.readFileSync(path.join(root, 'right.txt'), 'utf8')).toBe(value);
      domain.close();
      domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
      graph = new WorkspaceCausalGraph(domain);
      supervisor = new ProcessSupervisor(domain);
      const event = domain.getStore().getJournalEvents(domain.domainId)
        .find(e => e.type === 'CAUSAL_REPAIR_PREPARED' && e.payload.txId === value)!;
      expect(event.payload.branches).toEqual(repair.branches);
      expect(graph.view(repair.branches[1].heads).nodes).toEqual([newSource, newLeft]);
      branches = repair.branches.map(({ id, heads }) => ({ id, heads }));
      changed = newSource.seq;
    }
  });

  it('aborts all shared branch writes on downstream failure without publishing a distribution', async () => {
    const source = graph.record(step('a'));
    const left = graph.record(step('a', [source.seq]));
    const right = graph.record(step('b', [source.seq]));
    const calls: number[] = [];
    await expect(prepareWorkspaceBranchRepair(supervisor, {
      txId: 'shared-fail', runId: 'run', root, forkPath: path.join(temp, 'shared-fail'),
      atSeq: right.seq, changed: [source.seq],
      branches: [{ id: 'b', heads: [right.seq] }, { id: 'a', heads: [left.seq] }],
      validateReuse: async () => {},
      execute: async (node, tx) => {
        calls.push(node.seq);
        fs.writeFileSync(path.join(tx.forkRoot, 'partial.txt'), 'partial');
        if (node.seq === right.seq) throw new Error('downstream failed');
        return { actorId: node.actorId, observation: node.observation };
      },
    })).rejects.toThrow('downstream failed');
    expect(calls).toEqual([source.seq, left.seq, right.seq]);
    expect(fs.existsSync(path.join(root, 'partial.txt'))).toBe(false);
    expect(fs.existsSync(path.join(temp, 'shared-fail'))).toBe(false);
    expect(domain.getStore().getSnapshot('shared-fail-base')).toBeNull();
    const events = domain.getStore().getJournalEvents(domain.domainId).filter(e => e.payload.txId === 'shared-fail');
    expect(events.some(e => e.type === 'TX_ABORTED')).toBe(true);
    expect(events.some(e => e.type === 'CAUSAL_REPAIR_PREPARED')).toBe(false);
    expect(graph.nodes().filter(n => n.txId === 'shared-fail')).toHaveLength(2);
  });

  it('rejects malformed branch selections before opening a shared transaction', async () => {
    const source = graph.record(step('a'));
    for (const branches of [[], [{ id: ' ', heads: [source.seq] }],
      [{ id: 'a', heads: [source.seq] }, { id: 'a', heads: [] }],
      [{ id: 'a', heads: [] }], [{ id: 'a', heads: [999999] }]]) {
      await expect(prepareWorkspaceBranchRepair(supervisor, {
        txId: 'invalid-shared', runId: 'run', root, forkPath: path.join(temp, 'invalid-shared'),
        atSeq: source.seq, changed: [source.seq], branches,
        validateReuse: async () => { throw new Error('must not validate'); },
        execute: async () => { throw new Error('must not execute'); },
      })).rejects.toThrow(/identities|absent/);
    }
    expect(domain.getStore().getJournalEvents(domain.domainId)
      .some(e => e.payload.txId === 'invalid-shared')).toBe(false);
  });

  it('keeps OCC conflicts for a prepared shared world', async () => {
    const source = graph.record(step('a'));
    const repair = await prepareWorkspaceBranchRepair(supervisor, {
      txId: 'shared-conflict', runId: 'run', root, forkPath: path.join(temp, 'shared-conflict'),
      atSeq: source.seq, changed: [source.seq],
      branches: [{ id: 'a', heads: [source.seq] }, { id: 'b', heads: [source.seq] }],
      validateReuse: async () => {},
      execute: async (node, tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'shared');
        return { actorId: node.actorId, observation: {
          kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'shared',
        } };
      },
    });
    expect(repair.replacements).toHaveLength(1);
    expect(repair.branches[0].heads).toEqual(repair.branches[1].heads);
    fs.writeFileSync(path.join(root, 'input.txt'), 'concurrent');
    expect((await supervisor.commitWorkspaceTransaction(repair.transaction.txId)).status).toBe('conflict');
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('concurrent');
    await supervisor.abortWorkspaceTransaction(repair.transaction.txId);
  });

});
