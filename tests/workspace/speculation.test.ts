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
