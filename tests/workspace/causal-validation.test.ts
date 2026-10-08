import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, validateWorkspaceCausalBranches, prepareWorkspaceBranchRepair } from '../../src/index.js';
import type { CausalStep } from '../../src/index.js';

describe('workspace causal validation', () => {
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

  const options = (branches: { id: string; heads: number[] }[]) => ({
    txId: 'validate', runId: 'run', root, forkPath: path.join(temp, 'validation'),
    atSeq: graph.nodes().at(-1)!.seq, branches, closedWorld: true as const,
    replayPolicy: 'deterministic' as const,
    replay: async (_entry: unknown, dir: string) => fs.readFileSync(path.join(dir, 'input.txt'), 'utf8'),
  });

  it('detects shared changes, deduplicates seeds and feeds the existing repair executor', async () => {
    const input = graph.record(step('a'));
    const left = graph.record(step('a', [input.seq]));
    const right = graph.record(step('b', [input.seq]));
    const sibling = graph.record(step('b'));
    fs.writeFileSync(path.join(root, 'input.txt'), 'new');
    const branches = [{ id: 'left', heads: [left.seq] }, { id: 'right', heads: [right.seq] }];
    const result = await validateWorkspaceCausalBranches(supervisor, options(branches));
    expect(result.changed).toEqual([input.seq]);
    expect(result.replayedSteps).toBe(2);
    expect(result.branches.map((branch) => branch.status)).toEqual(['changed', 'changed']);
    expect(result.plan.invalidated.map((node) => node.seq)).toEqual([input.seq, left.seq, right.seq]);
    expect(result.plan.unaffected).toEqual([]);
    expect(result.plan.invalidated.map((node) => node.seq)).not.toContain(sibling.seq);
    expect(fs.existsSync(path.join(temp, 'validation', '0'))).toBe(false);
    const repair = await prepareWorkspaceBranchRepair(supervisor, {
      txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'),
      atSeq: result.atSeq, changed: result.changed, branches,
      validateReuse: async (_tx, unaffected) => { expect(unaffected).toEqual([]); },
      execute: async (node, tx) => ({ actorId: node.actorId,
        observation: { ...node.observation, resultHash: fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8') } }),
    });
    expect(repair.replacements).toHaveLength(3);
    expect((await supervisor.commitWorkspaceTransaction(repair.transaction.txId)).status).toBe('committed');
  });

  it('isolates mutation effects and freezes one world baseline across branches', async () => {
    const mutation = graph.record({ ...step('a'), observation: {
      kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'ok',
    } });
    const read = graph.record(step('a', [mutation.seq], 'modified'));
    const independent = graph.record(step('b'));
    const settings = options([{ id: 'writer', heads: [read.seq] }, { id: 'reader', heads: [independent.seq] }]);
    const result = await validateWorkspaceCausalBranches(supervisor, { ...settings,
      replay: async (entry, dir) => {
        if (entry.kind === 'mutate') {
          fs.writeFileSync(path.join(dir, 'input.txt'), 'modified');
          fs.writeFileSync(path.join(root, 'input.txt'), 'concurrent');
          return 'ok';
        }
        return fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
      },
    });
    expect(result.branches.map((branch) => branch.status)).toEqual(['matched', 'matched']);
    expect(result.changed).toEqual([]);
    expect(result.replayedSteps).toBe(3);
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('concurrent');
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const begun = events.filter((event) => event.type === 'TX_BEGUN' && String(event.payload.txId).startsWith('validate'));
    expect(new Set(begun.map((event) => event.payload.baseSnapshotId)).size).toBe(1);
    expect(events.filter((event) => event.type === 'TX_ABORTED')).toHaveLength(2);
  });

  it('separates callback errors from changed evidence and still validates other branches', async () => {
    const input = graph.record(step('a'));
    const independent = graph.record(step('b'));
    let calls = 0;
    const result = await validateWorkspaceCausalBranches(supervisor, {
      ...options([{ id: 'failed', heads: [input.seq] }, { id: 'healthy', heads: [independent.seq] }]),
      replay: async () => { if (++calls === 1) throw new Error('tool unavailable'); return 'old'; },
    });
    expect(result.branches).toEqual([
      { id: 'failed', status: 'failed', matchedSteps: 0, seq: input.seq, error: 'tool unavailable' },
      { id: 'healthy', status: 'matched', matchedSteps: 1 },
    ]);
    expect(result.changed).toEqual([]);
    expect(result.plan.invalidated).toEqual([]);
    expect(fs.existsSync(path.join(temp, 'validation', '1'))).toBe(false);
  });

  it('discards divergent mutations before checking siblings and supports empty tracked branches', async () => {
    const mutation = graph.record({ ...step('a'), observation: {
      kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'old-result',
    } });
    const downstream = graph.record(step('a', [mutation.seq]));
    const independent = graph.record(step('b'));
    const result = await validateWorkspaceCausalBranches(supervisor, {
      ...options([{ id: 'writer', heads: [downstream.seq] }, { id: 'reader', heads: [independent.seq] },
        { id: 'empty', heads: [] }]),
      replay: async (entry, dir) => {
        if (entry.kind === 'mutate') {
          fs.writeFileSync(path.join(dir, 'input.txt'), 'dirty');
          return 'new-result';
        }
        return fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
      },
    });
    expect(result.changed).toEqual([mutation.seq]);
    expect(result.plan.invalidated.map((node) => node.seq)).toEqual([mutation.seq, downstream.seq]);
    expect(result.plan.unaffected.map((node) => node.seq)).toEqual([independent.seq]);
    expect(result.branches.map((branch) => branch.status)).toEqual(['changed', 'matched', 'matched']);
    expect(result.branches[2].matchedSteps).toBe(0);
    expect(result.replayedSteps).toBe(2);
    expect(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')).toBe('old');
  });

  it('rejects incomplete replay declarations and unknown heads before allocating transactions', async () => {
    const input = graph.record(step('a'));
    const settings = options([{ id: 'one', heads: [input.seq] }]);
    const count = domain.getStore().getJournalEvents(domain.domainId).length;
    await expect(validateWorkspaceCausalBranches(supervisor, { ...settings, closedWorld: false as never })).rejects.toThrow('closed-world');
    await expect(validateWorkspaceCausalBranches(supervisor, { ...settings, branches: [{ id: 'one', heads: [999999] }] })).rejects.toThrow('absent');
    await expect(validateWorkspaceCausalBranches(supervisor, { ...settings, branches: [...settings.branches, ...settings.branches] })).rejects.toThrow('unique');
    expect(domain.getStore().getJournalEvents(domain.domainId)).toHaveLength(count);
  });
});
