import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { computeTreeCommandFingerprint } from '../../src/supervisor/fingerprint.js';
import {
  computeDiscoverySetCutoff,
  computeSymbolSliceCutoffHash,
  replayObservationLog,
} from '../../src/workspace/observation-replay.js';
import type { ObservationEntry } from '../../src/workspace/transactions.js';

const observe = (hash: string, cutoffHash?: string): ObservationEntry => ({
  kind: 'observe', call: { tool: 'glob', args: {} }, resultHash: hash, ...(cutoffHash ? { cutoffHash } : {}),
});
const mutate: ObservationEntry = { kind: 'mutate', call: { tool: 'edit', args: {} } };

describe('early cutoff', () => {
  it('keeps the strict behaviour when the host offers no cutoff evidence', async () => {
    const result = await replayObservationLog({ log: [observe('old'), mutate], replay: async () => 'new' }, '/fork');
    expect(result).toEqual({ status: 'diverged', matchedSteps: 0, divergedAt: 0, reason: 'observation_changed' });
  });

  it('continues past a drifted step when the replayed cutoff hash matches the recorded one', async () => {
    const replay = vi.fn(async (entry: ObservationEntry) =>
      entry.kind === 'observe' ? { resultHash: 'new-raw', cutoffHash: 'same-slice' } : undefined);
    const result = await replayObservationLog({ log: [observe('old-raw', 'same-slice'), mutate], replay }, '/fork');
    expect(result).toEqual({ status: 'matched', matchedSteps: 2, cutoffSteps: 1, cutoffIndices: [0] });
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it('diverges when the cutoff hash also changed', async () => {
    const result = await replayObservationLog({
      log: [observe('old-raw', 'slice-a'), mutate],
      replay: async () => ({ resultHash: 'new-raw', cutoffHash: 'slice-b' }),
    }, '/fork');
    expect(result).toMatchObject({ status: 'diverged', divergedAt: 0, reason: 'observation_changed' });
  });

  it('asks canCutoff only for drifted steps and honours its verdict', async () => {
    const canCutoff = vi.fn(async (_e: ObservationEntry, r: { index: number }) => r.index === 1);
    const result = await replayObservationLog({
      log: [observe('a'), observe('b'), observe('c')],
      replay: async (entry) => (entry.resultHash === 'a' ? 'a' : 'drift'),
      canCutoff,
    }, '/fork');
    expect(result).toEqual({
      status: 'diverged', matchedSteps: 2, divergedAt: 2, reason: 'observation_changed', cutoffSteps: 1, cutoffIndices: [1],
    });
    expect(canCutoff).toHaveBeenCalledTimes(2);
  });

  it('never cuts off a mutation that no longer applies', async () => {
    const result = await replayObservationLog({
      log: [mutate], replay: async () => { throw new Error('old text missing'); }, canCutoff: async () => true,
    }, '/fork');
    expect(result).toMatchObject({ status: 'diverged', reason: 'mutation_not_applicable', error: 'old text missing' });
  });
});

describe('cutoff helpers', () => {
  it('ignores comments and formatting but not code changes', () => {
    const base = "export function foo(n) { return n * 2; }\n";
    expect(computeSymbolSliceCutoffHash(`// concurrent comment\n${base}`)).toBe(computeSymbolSliceCutoffHash(base));
    expect(computeSymbolSliceCutoffHash(base.replace('* 2', '* 3'))).not.toBe(computeSymbolSliceCutoffHash(base));
    expect(computeSymbolSliceCutoffHash("const s = '// not a comment';")).not.toBe(computeSymbolSliceCutoffHash('const s = \'\';'));
  });

  it('only hashes the slice that mentions the symbol', () => {
    const a = 'function foo() {\n  return 1;\n}\nfunction other() {\n  return 1;\n}\n';
    const b = a.replace('function other() {\n  return 1;', 'function other() {\n  return 2;');
    expect(computeSymbolSliceCutoffHash(a, ['foo'])).toBe(computeSymbolSliceCutoffHash(b, ['foo']));
    expect(computeSymbolSliceCutoffHash(a, ['other'])).not.toBe(computeSymbolSliceCutoffHash(b, ['other']));
  });

  it('classifies discovery output as additive superset or not', () => {
    expect(computeDiscoverySetCutoff('a.mjs\nb.mjs', 'a.mjs\nb.mjs\nc.mjs')).toEqual({
      isSuperset: true, unchanged: ['a.mjs', 'b.mjs'], added: ['c.mjs'], removed: [],
    });
    expect(computeDiscoverySetCutoff('a.mjs\nb.mjs', 'a.mjs').isSuperset).toBe(false);
  });
});

describe('tree-fingerprint command deduplication', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-tree-cmd-')));
    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'tree-cmd-domain');
    supervisor = new ProcessSupervisor(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('is independent of the fork path but bound to the tree', () => {
    const command = (root: string) => ({ execPath: process.execPath, args: [path.join(root, 'a.mjs')], cwd: root });
    const a = computeTreeCommandFingerprint({ treeFingerprint: 't1', command: command('/x/fork-a'), workspaceRoot: '/x/fork-a' });
    const b = computeTreeCommandFingerprint({ treeFingerprint: 't1', command: command('/x/fork-b'), workspaceRoot: '/x/fork-b' });
    const c = computeTreeCommandFingerprint({ treeFingerprint: 't2', command: command('/x/fork-b'), workspaceRoot: '/x/fork-b' });
    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it('runs one process for identical trees in two forks and reruns after the tree changes', async () => {
    const repo = path.join(tempDir, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'check.mjs'), "console.log('ok');\n");
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.local');
    git('config', 'user.name', 'T');
    git('add', '-A');
    git('commit', '-qm', 'base');

    const txA = await supervisor.beginWorkspaceTransaction({ txId: 'A', runId: 'run', root: repo, forkPath: path.join(tempDir, 'fork-A') });
    const txB = await supervisor.beginWorkspaceTransaction({ txId: 'B', runId: 'run', root: repo, forkPath: path.join(tempDir, 'fork-B') });
    const check = (root: string) => supervisor.executeWorkspaceCommand({
      runId: 'run', name: 'check', workspaceRoot: root,
      command: { execPath: process.execPath, args: ['check.mjs'], cwd: root },
    });

    const [first, joined] = await Promise.all([check(txA.forkRoot), check(txB.forkRoot)]);
    expect(first.treeCommandFingerprint).toBe(joined.treeCommandFingerprint);
    expect([first.replayed ?? false, joined.replayed ?? false].sort()).toEqual([false, true]);
    expect((await check(txB.forkRoot)).replayed).toBe(true);

    fs.writeFileSync(path.join(txB.forkRoot, 'check.mjs'), "console.log('changed');\n");
    const rerun = await check(txB.forkRoot);
    expect(rerun.treeFingerprint).not.toBe(first.treeFingerprint);
    expect(rerun.replayed ?? false).toBe(false);

    await supervisor.abortWorkspaceTransaction('A');
    await supervisor.abortWorkspaceTransaction('B');
  });
});
