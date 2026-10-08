import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph } from '../../src/index.js';
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
});
