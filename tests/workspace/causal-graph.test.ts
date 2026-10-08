import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, prepareWorkspaceRepair } from '../../src/index.js';
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

});
