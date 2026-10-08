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
    expect(result.winners).toEqual(['preferred']);
    expect(new Set(bases).size).toBe(1);
    expect(result.candidates.map((c) => c.status)).toEqual(['committed', 'discarded']);
    expect(fs.readFileSync(path.join(root, 'winner.txt'), 'utf8')).toBe('preferred');
    expect(fs.existsSync(path.join(root, 'loser.txt'))).toBe(false);
    for (const i of [0, 1]) expect(fs.existsSync(`${options().forkPath}-${i}`)).toBe(false);
    expect(domain.getStore().getSnapshot(result.baseSnapshotId)).toBeNull();
    expect(graph.nodes()[0].txId).toBe('race-0');
    expect(domain.getStore().getJournalEvents(domain.domainId).some((e) => e.type === 'SPECULATION_FINISHED' && e.payload.winner === 'preferred')).toBe(true);
  });

  it('merges compatible outputs in priority order and rejects overlapping writes', async () => {
    const result = await speculateWorkspace(supervisor, { ...options(), commitPolicy: 'all_valid', strategies: [
      { id: 'first', execute: async (tx) => { fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'first'); } },
      { id: 'overlap', execute: async (tx) => { fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'overlap'); } },
      { id: 'independent', execute: async (tx) => { fs.writeFileSync(path.join(tx.forkRoot, 'other.txt'), 'other'); } },
      { id: 'failed', execute: async () => { throw new Error('rejected'); } },
    ] });
    expect(result.winners).toEqual(['first', 'independent']);
    expect(result.winner).toBe('first');
    expect(result.candidates.map((c) => c.status)).toEqual(['committed', 'conflict', 'committed', 'failed']);
    expect(result.candidates[1].commit).toMatchObject({ conflicts: [
      { path: 'input.txt', kind: 'write_write', otherTxId: 'race-0' },
    ] });
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('other');
    const events = domain.getStore().getJournalEvents(domain.domainId);
    expect(events.filter((e) => e.type === 'SPECULATION_CANDIDATE_COMMITTED').map((e) => e.payload.txId))
      .toEqual(['race-0', 'race-2']);
    expect(events.find((e) => e.type === 'SPECULATION_STARTED')?.payload.commitPolicy).toBe('all_valid');
    expect(events.find((e) => e.type === 'SPECULATION_FINISHED')?.payload.winners).toEqual(result.winners);
    for (const i of [0, 1, 2, 3]) expect(fs.existsSync(`${options().forkPath}-${i}`)).toBe(false);
    expect(domain.getStore().getSnapshot(result.baseSnapshotId)).toBeNull();
  });

  it('revalidates observations against earlier winners even with disjoint writes', async () => {
    let tracked = false;
    const result = await speculateWorkspace(supervisor, { ...options(), commitPolicy: 'all_valid', strategies: [
      { id: 'update', execute: async (tx) => { fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'new'); } },
      { id: 'derived', execute: async (tx) => {
        tracked = tx.readTracking === 'atime';
        const value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8');
        fs.writeFileSync(path.join(tx.forkRoot, 'derived.txt'), value);
        return { observations: { closedWorld: true, log: [
          { kind: 'observe', call: { tool: 'read', args: {} }, resultHash: value },
        ], replay: async (_entry, replayRoot) => fs.readFileSync(path.join(replayRoot, 'input.txt'), 'utf8') } };
      } },
    ] });
    if (!tracked) {
      expect(result.candidates[1].commit).toMatchObject({ validation: 'write_only', readSet: null });
      return;
    }
    expect(result.winners).toEqual(['update']);
    expect(result.candidates[1].commit).toMatchObject({ status: 'conflict', observation: {
      attempted: true, reason: 'observation_changed', divergedAt: 0,
    } });
    expect(fs.existsSync(path.join(root, 'derived.txt'))).toBe(false);
  });

  it('repairs a later agent against the world committed by an earlier winner', async () => {
    let head = 0;
    const result = await speculateWorkspace(supervisor, { ...options(), commitPolicy: 'all_valid', strategies: [
      { id: 'update', execute: async (tx) => { fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'new'); } },
      { id: 'uppercase', execute: async (tx) => {
        fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), 'OLD');
        head = graph.record({ txId: tx.txId, actorId: 'uppercase', dependsOn: [],
          observation: { kind: 'mutate', call: { tool: 'uppercase', args: {} }, resultHash: 'OLD' },
          writes: [{ path: 'input.txt', status: 'M' }] }).seq;
      }, repair: async (_original, conflict) => {
        expect(conflict.conflicts).toContainEqual({ path: 'input.txt', kind: 'write_write', otherTxId: 'race-0' });
        return { changed: [head], heads: [head], atSeq: head, validateReuse: async () => {},
          execute: async (source, tx) => {
            const value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8').toUpperCase();
            fs.writeFileSync(path.join(tx.forkRoot, 'input.txt'), value);
            return { actorId: 'uppercase', observation: { ...source.observation, resultHash: value }, writes: source.writes };
          },
        };
      } },
    ] });
    expect(result.winners).toEqual(['update', 'uppercase']);
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('NEW');
    expect(result.candidates[1]).toMatchObject({ status: 'committed', commit: { status: 'conflict' },
      repair: { txId: 'race-1-repair', commit: { status: 'committed' } } });
    expect(graph.view(result.candidates[1].repair!.heads).nodes[0].observation.resultHash).toBe('NEW');
    expect(domain.getStore().getJournalEvents(domain.domainId)
      .filter((e) => e.type === 'SPECULATION_CANDIDATE_COMMITTED').map((e) => e.payload.txId))
      .toEqual(['race-0', 'race-1-repair']);
    for (const suffix of ['-0', '-1', '-1-repair']) expect(fs.existsSync(options().forkPath + suffix)).toBe(false);
    expect(domain.getStore().getSnapshot('race-1-repair-base')).toBeNull();
  });

  it('preserves earlier winners and stops the batch after an uncertain later commit', async () => {
    const originalCommit = supervisor.commitWorkspaceTransaction.bind(supervisor);
    const commit = vi.spyOn(supervisor, 'commitWorkspaceTransaction').mockImplementation(async (txId, opts) => {
      if (txId === 'race-1') throw new Error('I/O failure');
      return originalCommit(txId, opts);
    });
    try {
      await expect(speculateWorkspace(supervisor, { ...options(), commitPolicy: 'all_valid', strategies:
        ['first', 'uncertain', 'later'].map((id) => ({ id, execute: async (tx) => {
          fs.writeFileSync(path.join(tx.forkRoot, `${id}.txt`), id);
        } })),
      })).rejects.toThrow('race-1; retain its fork');
      expect(commit).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('first');
      expect(fs.existsSync(path.join(root, 'later.txt'))).toBe(false);
      expect(fs.existsSync(`${options().forkPath}-1`)).toBe(true);
      for (const i of [0, 2]) expect(fs.existsSync(`${options().forkPath}-${i}`)).toBe(false);
      expect(domain.getStore().getSnapshot('race-0-base')).not.toBeNull();
      expect(domain.getStore().getJournalEvents(domain.domainId)
        .filter((e) => e.type === 'SPECULATION_CANDIDATE_COMMITTED').map((e) => e.payload.strategyId)).toEqual(['first']);
    } finally {
      commit.mockRestore();
      await supervisor.abortWorkspaceTransaction('race-1');
    }
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

  it.each(['first_valid', 'all_valid'] as const)('repairs only the selected causal branch with %s', async (commitPolicy) => {
    let changed = 0;
    let stable = 0;
    let derived = 0;
    const executed: number[] = [];
    const repairCallback = vi.fn(async () => {});
    const result = await speculateWorkspace(supervisor, { ...options(), commitPolicy, strategies: [
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
    expect(result.winners).toEqual(commitPolicy === 'all_valid' ? ['preferred', 'sibling'] : ['preferred']);
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
    expect(result.winners).toEqual([]);
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
