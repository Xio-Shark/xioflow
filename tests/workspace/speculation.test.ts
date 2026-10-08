import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, speculateWorkspace } from '../../src/index.js';

describe('workspace speculation', () => {
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
  });
  afterEach(() => {
    domain.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const options = () => ({ speculationId: 'race', runId: 'run', root, forkPath: path.join(temp, 'candidate') });

  it('executes concurrently on one baseline, chooses priority, and retains causal history after cleanup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bases: string[] = [];
    const result = await speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'preferred', execute: async (tx) => {
        bases.push(tx.baseSnapshotId);
        await gate;
        expect(fs.existsSync(path.join(tx.forkRoot, 'loser.txt'))).toBe(false);
        fs.writeFileSync(path.join(tx.forkRoot, 'winner.txt'), 'preferred');
        graph.record({ txId: tx.txId, actorId: 'preferred', dependsOn: [],
          observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'ok' },
          writes: [{ path: 'winner.txt', status: 'A' }] });
      } },
      { id: 'fast', execute: async (tx) => {
        bases.push(tx.baseSnapshotId);
        fs.writeFileSync(path.join(tx.forkRoot, 'loser.txt'), 'fast');
        release();
      } },
    ] });
    expect(result.status).toBe('committed');
    expect(result.winner).toBe('preferred');
    expect(new Set(bases).size).toBe(1);
    expect(result.candidates.map((c) => c.status)).toEqual(['committed', 'discarded']);
    expect(fs.readFileSync(path.join(root, 'winner.txt'), 'utf8')).toBe('preferred');
    expect(fs.existsSync(path.join(root, 'loser.txt'))).toBe(false);
    for (const i of [0, 1]) expect(fs.existsSync(`${options().forkPath}-${i}`)).toBe(false);
    expect(domain.getStore().getSnapshot(result.baseSnapshotId)).toBeNull();
    expect(graph.nodes()[0].txId).toBe('race-0');
    expect(domain.getStore().getJournalEvents(domain.domainId).some((e) => e.type === 'SPECULATION_FINISHED' && e.payload.winner === 'preferred')).toBe(true);
  });

  it('rejects an OCC-conflicted candidate and commits an independent fallback', async () => {
    const result = await speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'stale', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'stale');
        fs.writeFileSync(path.join(root, 'input.txt'), 'external');
      } },
      { id: 'independent', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'other.txt'), 'independent');
      } },
    ] });
    expect(result.winner).toBe('independent');
    expect(result.candidates.map((c) => c.status)).toEqual(['conflict', 'committed']);
    expect(result.candidates[0].commit).toMatchObject({ status: 'conflict' });
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('external');
    expect(fs.readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('independent');
    expect(fs.existsSync(`${options().forkPath}-0`)).toBe(false);
  });

  it('repairs only the selected causal branch and commits reused candidate outputs', async () => {
    let changed = 0;
    let stable = 0;
    let derived = 0;
    const executed: number[] = [];
    const repairCallback = vi.fn(async () => {});
    const result = await speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'preferred', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'OLD');
        changed = graph.record({ txId: tx.txId, actorId: 'preferred', dependsOn: [],
          observation: { kind: 'mutate', call: { tool: 'uppercase', args: {} }, resultHash: 'OLD' },
          writes: [{ path: 'input.txt', status: 'M' }] }).seq;
        fs.writeFileSync(path.join(tx.forkRoot, 'answer.txt'), 'answer:OLD');
        derived = graph.record({ txId: tx.txId, actorId: 'preferred', dependsOn: [changed],
          observation: { kind: 'mutate', call: { tool: 'derive', args: {} }, resultHash: 'answer:OLD' },
          writes: [{ path: 'answer.txt', status: 'A' }] }).seq;
        fs.writeFileSync(path.join(tx.forkRoot, 'stable.txt'), 'expensive independent result');
        stable = graph.record({ txId: tx.txId, actorId: 'preferred', dependsOn: [],
          observation: { kind: 'mutate', call: { tool: 'constant', args: {} }, resultHash: 'constant' },
          writes: [{ path: 'stable.txt', status: 'A' }] }).seq;
        fs.writeFileSync(path.join(root, 'input.txt'), 'new');
      }, repair: async (original, conflict) => {
        expect(conflict.status).toBe('conflict');
        expect(original.status).toBe('conflicted');
        return {
          changed: [changed], heads: [derived, stable], atSeq: graph.nodes().at(-1)!.seq,
          validateReuse: async (tx, unaffected) => {
            expect(unaffected.map((node) => node.seq)).toEqual([stable]);
            // This constant output has no inputs; retain it from the uncommitted fork.
            fs.copyFileSync(path.join(original.forkRoot, 'stable.txt'), path.join(tx.forkRoot, 'stable.txt'));
          },
          execute: async (source, tx, dependencies) => {
            executed.push(source.seq);
            if (source.seq === derived) {
              expect(dependencies[0].seq).not.toBe(changed);
              const value = `answer:${dependencies[0].observation.resultHash}`;
              fs.writeFileSync(path.join(tx.forkRoot, 'answer.txt'), value);
              return { actorId: 'repair', observation: { ...source.observation, resultHash: value }, writes: source.writes };
            }
            const value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8').toUpperCase();
            fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), value);
            return { actorId: 'repair', observation: { ...source.observation, resultHash: value }, writes: source.writes };
          },
          commitOptions: async (prepared) => { expect(prepared.reused.map((node) => node.seq)).toEqual([stable]); },
        };
      } },
      { id: 'sibling', execute: async (tx) => {
        graph.record({ txId: tx.txId, actorId: 'sibling', dependsOn: [],
          observation: { kind: 'observe', call: { tool: 'other', args: {} }, resultHash: 'other' } });
      }, repair: repairCallback },
    ] });
    expect(result.winner).toBe('preferred');
    expect(executed).toEqual([changed, derived]);
    expect(repairCallback).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ status: 'committed', commit: { status: 'conflict' },
      repair: { txId: 'race-0-repair', commit: { status: 'committed' } } });
    expect(graph.view(result.candidates[0].repair!.heads).nodes.map((node) => node.actorId)).toEqual(['preferred', 'repair', 'repair']);
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('NEW');
    expect(fs.readFileSync(path.join(root, 'answer.txt'), 'utf8')).toBe('answer:NEW');
    expect(fs.readFileSync(path.join(root, 'stable.txt'), 'utf8')).toBe('expensive independent result');
    for (const suffix of ['-0', '-1', '-0-repair']) expect(fs.existsSync(options().forkPath + suffix)).toBe(false);
    expect(domain.getStore().getSnapshot('race-0-repair-base')).toBeNull();
    expect(domain.getStore().getSnapshot(result.baseSnapshotId)).toBeNull();
    expect(domain.getStore().getJournalEvents(domain.domainId).some((e) => e.type === 'SPECULATION_REPAIR_PREPARED')).toBe(true);
  });

  it.each(['conflict', 'execute_error', 'evidence_error', 'commit_error'] as const)('handles repair %s without unsafe retry or leaked disposable forks', async (mode) => {
    let changed = 0;
    const repair = vi.fn(async () => ({
      changed: [changed], heads: [changed], atSeq: changed,
      validateReuse: async () => {},
      commitOptions: async () => { if (mode === 'evidence_error') throw new Error('evidence failed'); },
      execute: async () => {
        if (mode === 'execute_error') throw new Error('repair tool failed');
        const repairRoot = `${options().forkPath}-0-repair`;
        fs.writeFileSync(path.join(repairRoot, 'input.txt'), 'repaired');
        if (mode === 'conflict') fs.writeFileSync(path.join(root, 'input.txt'), 'changed again');
        return { actorId: 'repair', observation: {
          kind: 'mutate' as const, call: { tool: 'write', args: {} }, resultHash: 'repaired',
        }, writes: [{ path: 'input.txt', status: 'M' as const }] };
      },
    }));
    const originalCommit = supervisor.commitWorkspaceTransaction.bind(supervisor);
    const commit = vi.spyOn(supervisor, 'commitWorkspaceTransaction').mockImplementation(async (txId, opts) => {
      if (mode === 'commit_error' && txId.endsWith('-repair')) throw new Error('commit I/O error');
      return originalCommit(txId, opts);
    });
    const task = speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'stale', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'stale');
        changed = graph.record({ txId: tx.txId, actorId: 'stale', dependsOn: [],
          observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'stale' } }).seq;
        fs.writeFileSync(path.join(root, 'input.txt'), 'external');
      }, repair },
      { id: 'fallback', execute: async (tx) => { fs.writeFileSync(path.join(tx.forkRoot, 'fallback.txt'), 'ok'); } },
    ] });
    if (mode === 'conflict') {
      const result = await task;
      expect(result.winner).toBe('fallback');
      expect(result.candidates[0].repair?.commit?.status).toBe('conflict');
      expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('changed again');
    } else {
      await expect(task).rejects.toThrow(mode === 'commit_error' ? 'race-0-repair; retain its fork' : 'speculation or cleanup failed');
      expect(fs.existsSync(path.join(root, 'fallback.txt'))).toBe(false);
    }
    expect(repair).toHaveBeenCalledTimes(1);
    for (const suffix of ['-0', '-1']) expect(fs.existsSync(options().forkPath + suffix)).toBe(false);
    expect(fs.existsSync(`${options().forkPath}-0-repair`)).toBe(mode === 'commit_error');
    expect(domain.getStore().getSnapshot('race-0-repair-base') === null).toBe(mode !== 'commit_error');
    commit.mockRestore();
    if (mode === 'commit_error') await supervisor.abortWorkspaceTransaction('race-0-repair');
  });

  it('joins failed strategies before cleanup and reports no winner', async () => {
    const result = await speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'broken', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'leak.txt'), 'no');
        throw new Error('strategy failed');
      } },
      { id: 'conflicted', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'stale');
        fs.writeFileSync(path.join(root, 'input.txt'), 'external');
      } },
    ] });
    expect(result.status).toBe('no_winner');
    expect(result.winner).toBeUndefined();
    expect(result.candidates.map((c) => c.status)).toEqual(['failed', 'conflict']);
    expect(result.candidates[0].error).toBe('strategy failed');
    expect(fs.existsSync(path.join(root, 'leak.txt'))).toBe(false);
    for (const i of [0, 1]) expect(fs.existsSync(`${options().forkPath}-${i}`)).toBe(false);
  });

  it('preserves an uncertain commit for recovery and never attempts another winner', async () => {
    const commit = vi.spyOn(supervisor, 'commitWorkspaceTransaction').mockRejectedValue(new Error('I/O failure'));
    await expect(speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'one', execute: async () => {} }, { id: 'two', execute: async () => {} },
    ] })).rejects.toThrow('race-0; retain its fork');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${options().forkPath}-0`)).toBe(true);
    expect(fs.existsSync(`${options().forkPath}-1`)).toBe(false);
    expect(domain.getStore().getSnapshot('race-0-base')).toBeDefined();
    commit.mockRestore();
    await supervisor.abortWorkspaceTransaction('race-0');
  });

  it('cleans earlier forks if setup fails and validates strategy ids before forking', async () => {
    const execute = vi.fn(async () => {});
    await expect(speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'same', execute }, { id: 'same', execute },
    ] })).rejects.toThrow('unique');
    fs.mkdirSync(`${options().forkPath}-1`);
    fs.writeFileSync(`${options().forkPath}-1/keep`, 'occupied');
    await expect(speculateWorkspace(supervisor, { ...options(), strategies: [
      { id: 'one', execute }, { id: 'two', execute },
    ] })).rejects.toThrow('speculation or cleanup failed');
    expect(execute).not.toHaveBeenCalled();
    expect(fs.existsSync(`${options().forkPath}-0`)).toBe(false);
    expect(fs.readFileSync(`${options().forkPath}-1/keep`, 'utf8')).toBe('occupied');
  });
});
