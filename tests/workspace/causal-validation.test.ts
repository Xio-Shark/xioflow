import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, validateWorkspaceCausalBranches, prepareWorkspaceBranchRepair, listWorkspaceCausalValidations, prepareWorkspaceCausalRefresh, refreshWorkspaceCausalBranches, planWorkspaceCausalRefresh } from '../../src/index.js';
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

  it.each(['old', 'new'])('reuses shared baseline evidence for %s inputs and preserves repair plans', async (value) => {
    const input = graph.record(step('a'));
    const output = (txId: string) => graph.record({ ...step(txId, [input.seq]), observation: {
      kind: 'mutate', call: { tool: 'write', args: { path: `${txId}.txt` } }, resultHash: 'ok',
    } });
    const branches = [{ id: 'left', heads: [output('a').seq] }, { id: 'right', heads: [output('b').seq] }];
    fs.writeFileSync(path.join(root, 'input.txt'), value);
    const replay = vi.fn(async (entry, dir: string) => {
      if (entry.kind === 'observe') return fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
      fs.writeFileSync(path.join(dir, entry.call.args.path), 'output');
      return 'ok';
    });
    const plain = await validateWorkspaceCausalBranches(supervisor, { ...options(branches), replay });
    replay.mockClear();
    const reused = await validateWorkspaceCausalBranches(supervisor, { ...options(branches),
      txId: 'cached', replayReuse: 'baseline_observations', replay });
    expect(reused.branches).toEqual(plain.branches);
    expect(reused.plan).toEqual(plain.plan);
    expect(reused.changed).toEqual(plain.changed);
    expect(reused.reusedSteps).toBe(1);
    expect(reused.replayedSteps).toBe(plain.replayedSteps - 1);
    expect(replay).toHaveBeenCalledTimes(reused.replayedSteps);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    expect(listWorkspaceCausalValidations(domain).at(-1)).toEqual(reused);
  });

  it.each([false, true])('never reuses or caches observations after mutations (writer first: %s)', async (writerFirst) => {
    const mutation = graph.record({ ...step('a'), observation: {
      kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'ok',
    } });
    const input = graph.record(step('b'));
    const branches = [{ id: 'reader', heads: [input.seq] }, { id: 'writer', heads: [mutation.seq, input.seq] }];
    if (writerFirst) branches.reverse();
    const result = await validateWorkspaceCausalBranches(supervisor, { ...options(branches),
      replayReuse: 'baseline_observations', replay: async (entry, dir) => {
        if (entry.kind === 'mutate') {
          fs.writeFileSync(path.join(dir, 'input.txt'), 'modified');
          return 'ok';
        }
        return fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
      },
    });
    expect(result.branches.find(branch => branch.id === 'reader')?.status).toBe('matched');
    expect(result.branches.find(branch => branch.id === 'writer')?.status).toBe('changed');
    expect(result).toMatchObject({ replayedSteps: 3, reusedSteps: 0, changed: [input.seq] });
  });

  it('does not cache tool errors or conflate distinct nodes with identical calls', async () => {
    const input = graph.record(step('a'));
    const other = graph.record(step('b'));
    const replay = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue('old');
    const result = await validateWorkspaceCausalBranches(supervisor, {
      ...options([{ id: 'failure', heads: [input.seq] }, { id: 'retry', heads: [input.seq] },
        { id: 'other', heads: [other.seq] }, { id: 'reuse', heads: [input.seq] }]),
      replayReuse: 'baseline_observations', replay,
    });
    expect(result.branches.map(branch => branch.status)).toEqual(['failed', 'matched', 'matched', 'matched']);
    expect(result).toMatchObject({ replayedSteps: 3, reusedSteps: 1, changed: [] });
  });

  it('scopes reused evidence to one baseline and reads legacy reports without reuse fields', async () => {
    const input = graph.record(step('a'));
    const settings = { ...options([{ id: 'one', heads: [input.seq] }, { id: 'two', heads: [input.seq] }]),
      replayReuse: 'baseline_observations' as const };
    const first = await validateWorkspaceCausalBranches(supervisor, settings);
    fs.writeFileSync(path.join(root, 'input.txt'), 'new');
    const second = await validateWorkspaceCausalBranches(supervisor, { ...settings, txId: 'second' });
    expect(first.changed).toEqual([]);
    expect(second).toMatchObject({ changed: [input.seq], replayedSteps: 1, reusedSteps: 1 });
    const { seq: _seq, plan: _plan, replayReuse: _reuse, reusedSteps: _steps, ...legacy } = first;
    domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: 'run',
      type: 'CAUSAL_VALIDATION_COMPLETED', payload: { version: 1, report: legacy }, timestamp: new Date().toISOString() });
    expect(listWorkspaceCausalValidations(domain).at(-1)).toMatchObject({ replayReuse: 'none', reusedSteps: 0 });
    await expect(validateWorkspaceCausalBranches(supervisor, { ...settings, replayReuse: 'invalid' as never }))
      .rejects.toThrow('reuse policy');
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

  it('persists baseline identity and frozen branch reports across pruning and reopening', async () => {
    const input = graph.record(step('a'));
    const settings = options([{ id: 'one', heads: [input.seq] }]);
    const result = await validateWorkspaceCausalBranches(supervisor, {
      ...settings, replay: async (_entry, dir) => {
        settings.branches[0].heads.length = 0;
        fs.writeFileSync(path.join(root, 'input.txt'), 'later');
        return fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
      },
    });
    expect(result.baseline.treeFingerprint).toMatch(/^[a-f0-9]+$/);
    expect(result.baseline.coverage).toBe('worktree_non_ignored');
    expect(domain.getStore().getSnapshot(result.baseline.id)).toBeNull();
    expect(result.sourceBranches).toEqual([{ id: 'one', heads: [input.seq] }]);
    expect(result.branches[0].status).toBe('matched');
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    expect(listWorkspaceCausalValidations(domain)).toEqual([result]);
    expect(listWorkspaceCausalValidations(domain, { atSeq: result.seq - 1 })).toEqual([]);
    expect(listWorkspaceCausalValidations(domain, { atSeq: result.seq, runId: 'run' })).toEqual([result]);
    expect(listWorkspaceCausalValidations(domain, { runId: 'other' })).toEqual([]);
    expect(() => listWorkspaceCausalValidations(domain, { atSeq: -1 })).toThrow('sequence');
    const queried = listWorkspaceCausalValidations(domain)[0];
    queried.sourceBranches[0].heads.length = 0;
    expect(listWorkspaceCausalValidations(domain)[0]).toEqual(result);
  });

  it.each([0, 1, 4])('selects and publishes using reuse cost %s', async (reuseCost) => {
    fs.writeFileSync(path.join(root, 'stable.txt'), 'stable');
    const stable = graph.record({ ...step('a'), observation: {
      kind: 'observe', call: { tool: 'read', args: { path: 'stable.txt' } }, resultHash: 'stable',
    } });
    const input = graph.record(step('a'));
    const outputs = ['a', 'b'].map(txId => graph.record({ ...step(txId, [stable.seq, input.seq]),
      observation: { kind: 'mutate', call: { tool: 'write', args: { path: `${txId}.txt` } }, resultHash: 'old' },
    }));
    // An unselected sibling must never enter full recomputation.
    const sibling = graph.record(step('b'));
    fs.writeFileSync(path.join(root, 'input.txt'), 'new');
    const replay = vi.fn(async (entry: CausalStep['observation'], dir: string) => {
      if (entry.kind === 'observe') return fs.readFileSync(path.join(dir, String(entry.call.args.path)), 'utf8');
      const value = fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
      fs.writeFileSync(path.join(dir, String(entry.call.args.path)), value);
      return value;
    });
    const executed: number[] = [];
    const full = reuseCost > 1;
    const result = await refreshWorkspaceCausalBranches(supervisor, {
      ...options(outputs.map((node, i) => ({ id: String(i), heads: [node.seq] }))), replay,
      costModel: () => ({ execute: 1, reuse: reuseCost, replay: 2 }),
      repair: { txId: 'adaptive', forkPath: path.join(temp, 'adaptive'),
        validateReuse: async (_tx, nodes) => {
          expect(nodes.map(node => node.seq)).toEqual(full ? [] : [stable.seq]);
        },
        execute: async (source, tx, dependencies) => {
          executed.push(source.seq);
          if (source.observation.kind === 'mutate') {
            expect(dependencies.map(node => node.observation.resultHash)).toEqual(['stable', 'new']);
          }
          return { actorId: source.actorId, observation: {
            ...source.observation, resultHash: await replay(source.observation, tx.forkRoot),
          } };
        },
      },
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected publication');
    expect(result.decision).toEqual({ strategy: full ? 'full' : 'incremental',
      incremental: { execution: 3, reuseValidation: reuseCost, commitReplay: 8, total: 11 + reuseCost },
      full: { execution: 4, reuseValidation: 0, commitReplay: 8, total: 12 },
    });
    expect(executed).toEqual(full ? [stable.seq, input.seq, ...outputs.map(node => node.seq)]
      : [input.seq, ...outputs.map(node => node.seq)]);
    expect(executed).not.toContain(sibling.seq);
    expect(result.commit).toMatchObject({ validation: 'observations' });
    expect(replay.mock.calls.slice(-4).map(([entry]) => entry.call.args.path))
      .toEqual(['stable.txt', 'input.txt', 'a.txt', 'b.txt']);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('new');
    expect(result.repair.branches.map(branch => branch.sourceHeads)).toEqual(outputs.map(node => [node.seq]));
    expect(fs.existsSync(path.join(temp, 'adaptive'))).toBe(false);
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal');
    expect(domain.getStore().getJournalEvents(domain.domainId)
      .find(event => event.type === 'CAUSAL_VALIDATION_REPAIR_PREPARED')?.payload)
      .toMatchObject({ validationSeq: result.validation.seq, txId: 'adaptive', decision: result.decision });
  });

  it.each([-1, NaN, Infinity, Number.MAX_VALUE])('rejects invalid or overflowing costs before allocating repair: %s', async (cost) => {
    const input = graph.record(step('a'));
    fs.writeFileSync(path.join(root, 'input.txt'), 'new');
    const execute = vi.fn();
    await expect(prepareWorkspaceCausalRefresh(supervisor, {
      ...options([{ id: 'a', heads: [input.seq] }]),
      costModel: () => ({ execute: cost, reuse: cost, replay: cost }),
      repair: { txId: 'invalid-cost', forkPath: path.join(temp, 'invalid-cost'),
        execute, validateReuse: async () => {} },
    })).rejects.toThrow(/cost/);
    expect(execute).not.toHaveBeenCalled();
    expect(domain.getStore().getJournalEvents(domain.domainId)
      .some(event => event.type === 'TX_BEGUN' && event.payload.txId === 'invalid-cost')).toBe(false);
  });

  it('isolates estimator mutations and accounts for weighted full-union replay', () => {
    const first = graph.record(step('a'));
    const second = graph.record(step('b'));
    const plan = graph.planRecomputation([first.seq], second.seq, [first.seq, second.seq]);
    const saved = structuredClone(plan);
    const estimate = vi.fn((node) => {
      const execute = node.seq === first.seq ? 10 : 20;
      node.dependsOn.push(999);
      node.observation.resultHash = 'tampered';
      return { execute, reuse: 30, replay: 5 };
    });
    expect(planWorkspaceCausalRefresh(plan, estimate)).toEqual({ strategy: 'full',
      incremental: { execution: 10, reuseValidation: 30, commitReplay: 10, total: 50 },
      full: { execution: 30, reuseValidation: 0, commitReplay: 10, total: 40 },
    });
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(plan).toEqual(saved);
  });

  it('automatically prepares shared changes once and links the repair to its durable probe', async () => {
    const input = graph.record(step('a'));
    const output = (txId: string) => graph.record({ ...step(txId, [input.seq]), observation: {
      kind: 'mutate', call: { tool: 'write', args: { path: `${txId}.txt` } }, resultHash: 'old',
    } });
    const left = output('a');
    const right = output('b');
    fs.writeFileSync(path.join(root, 'input.txt'), 'new');
    const executed: number[] = [];
    const result = await prepareWorkspaceCausalRefresh(supervisor, {
      ...options([{ id: 'left', heads: [left.seq] }, { id: 'right', heads: [right.seq] }]),
      repair: { txId: 'refresh', forkPath: path.join(temp, 'refresh'),
        validateReuse: async (_tx, unaffected) => { expect(unaffected).toEqual([]); },
        execute: async (source, tx, dependencies) => {
          executed.push(source.seq);
          const value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8');
          if (source.observation.kind === 'mutate') {
            expect(dependencies[0].observation.resultHash).toBe('new');
            fs.writeFileSync(path.join(tx.forkRoot, String(source.observation.call.args.path)), value);
          }
          return { actorId: source.actorId, observation: { ...source.observation, resultHash: value } };
        },
      },
    });
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') throw new Error('Expected repair');
    expect(executed).toEqual([input.seq, left.seq, right.seq]);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
    expect(result.repair.transaction.baseSnapshotId).not.toBe(result.validation.baseline.id);
    const link = domain.getStore().getJournalEvents(domain.domainId)
      .find((event) => event.type === 'CAUSAL_VALIDATION_REPAIR_PREPARED')!;
    expect(link.payload).toEqual({ version: 1, validationSeq: result.validation.seq, txId: 'refresh' });
    expect(await supervisor.commitWorkspaceTransaction('refresh', {
      observationPolicy: 'always',
      observations: { closedWorld: true,
        log: graph.view(result.repair.heads).nodes.map((node) => node.observation),
        replay: async (entry, dir) => {
          const value = fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
          if (entry.kind === 'mutate') fs.writeFileSync(path.join(dir, String(entry.call.args.path)), value);
          return value;
        },
      },
    })).toMatchObject({ status: 'committed', validation: 'observations' });
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('new');
  });

  it.each(['stable', 'reused_changed', 'commit_error'] as const)(
    'coordinates shared publication and resource ownership: %s', async (mode) => {
      fs.writeFileSync(path.join(root, 'stable.txt'), 'stable');
      const reused = graph.record({ ...step('a', [], 'stable'), observation: {
        kind: 'observe', call: { tool: 'read', args: { path: 'stable.txt' } }, resultHash: 'stable',
      } });
      const input = graph.record(step('a'));
      const outputs = ['a', 'b'].map((txId) => graph.record({ ...step(txId, [input.seq, reused.seq]),
        observation: { kind: 'mutate', call: { tool: 'write', args: { path: `${txId}.txt` } }, resultHash: 'old' },
      }));
      fs.writeFileSync(path.join(root, 'input.txt'), 'new');
      const replayed: string[] = [];
      const settings = {
        ...options(outputs.map((node, i) => ({ id: String(i), heads: [node.seq] }))),
        replayReuse: 'baseline_observations' as const,
        replay: async (entry: CausalStep['observation'], dir: string) => {
          const file = String(entry.call.args.path);
          replayed.push(file);
          if (entry.kind === 'observe') return fs.readFileSync(path.join(dir, file), 'utf8');
          const value = fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
          fs.writeFileSync(path.join(dir, file), value);
          return value;
        },
        repair: { txId: 'publish', forkPath: path.join(temp, 'publish'),
          validateReuse: async (_tx: unknown, nodes: readonly { seq: number }[]) => {
            expect(nodes.map(node => node.seq)).toEqual([reused.seq]);
          },
          execute: async (source: CausalStep, tx: { forkRoot: string }) => {
            const value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8');
            if (source.observation.kind === 'mutate') {
              fs.writeFileSync(path.join(tx.forkRoot, String(source.observation.call.args.path)), value);
              if (mode === 'reused_changed') fs.writeFileSync(path.join(root, 'stable.txt'), 'changed');
            }
            return { actorId: source.actorId, observation: { ...source.observation, resultHash: value } };
          },
        },
      };
      if (mode === 'commit_error') {
        const spy = vi.spyOn(supervisor, 'commitWorkspaceTransaction').mockRejectedValueOnce(new Error('disk error'));
        await expect(refreshWorkspaceCausalBranches(supervisor, settings)).rejects.toThrow('retain its fork');
        spy.mockRestore();
        expect(fs.existsSync(path.join(temp, 'publish'))).toBe(true);
        const begun = domain.getStore().getJournalEvents(domain.domainId)
          .find(event => event.type === 'TX_BEGUN' && event.payload.txId === 'publish')!;
        expect(domain.getStore().getSnapshot(String(begun.payload.baseSnapshotId))).not.toBeNull();
        expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
        return;
      }
      const result = await refreshWorkspaceCausalBranches(supervisor, settings);
      expect(result.status).toBe(mode === 'stable' ? 'committed' : 'conflict');
      if (result.status !== 'committed' && result.status !== 'conflict') throw new Error('Expected commit outcome');
      expect(result.validation).toMatchObject({ replayedSteps: 2, reusedSteps: 2 });
      expect(result.repair.reused.map(node => node.seq)).toEqual([reused.seq]);
      expect(fs.existsSync(path.join(temp, 'publish'))).toBe(false);
      expect(domain.getStore().getSnapshot(result.repair.transaction.baseSnapshotId)).toBeNull();
      if (mode === 'stable') {
        expect(result.commit).toMatchObject({ validation: 'observations' });
        expect(result.repair.transaction.status).toBe('committed');
        expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('new');
        expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('new');
        expect(replayed.slice(-4)).toEqual(['stable.txt', 'input.txt', 'a.txt', 'b.txt']);
        const events = domain.getStore().getJournalEvents(domain.domainId);
        expect(events.some(event => event.type === 'CAUSAL_VALIDATION_REPAIR_PREPARED'
          && event.payload.validationSeq === result.validation.seq && event.payload.txId === 'publish')).toBe(true);
        expect(events.some(event => event.type === 'TX_COMMITTED' && event.payload.txId === 'publish')).toBe(true);
      } else {
        expect(result.commit).toMatchObject({ observation: { reason: 'observation_changed', divergedAt: 0 } });
        expect(result.repair.transaction.status).toBe('aborted');
        expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
      }
    });

  it.each(['unchanged', 'failed'] as const)('does not allocate a repair for %s probes', async (status) => {
    const input = graph.record(step('a'));
    const independent = graph.record(step('b'));
    const execute = vi.fn();
    const validateReuse = vi.fn();
    const costModel = vi.fn();
    let calls = 0;
    const result = await refreshWorkspaceCausalBranches(supervisor, {
      ...options([{ id: 'left', heads: [input.seq] }, { id: 'right', heads: [independent.seq] }]),
      costModel,
      replay: async () => {
        if (status === 'unchanged') return 'old';
        if (++calls === 1) return 'new';
        throw new Error('offline');
      },
      repair: { txId: 'refresh', forkPath: path.join(temp, 'refresh'), execute, validateReuse },
    });
    expect(result.status).toBe(status);
    expect(execute).not.toHaveBeenCalled();
    expect(validateReuse).not.toHaveBeenCalled();
    expect(costModel).not.toHaveBeenCalled();
    expect(listWorkspaceCausalValidations(domain)).toEqual([result.validation]);
    expect(domain.getStore().getJournalEvents(domain.domainId)
      .some((event) => event.payload.txId === 'refresh')).toBe(false);
  });

  it('preserves the probe and reclaims failed repair resources', async () => {
    const input = graph.record(step('a'));
    await expect(prepareWorkspaceCausalRefresh(supervisor, {
      ...options([{ id: 'one', heads: [input.seq] }]), replay: async () => 'new',
      repair: { txId: 'refresh', forkPath: path.join(temp, 'refresh'),
        validateReuse: async () => { throw new Error('missing reusable output'); }, execute: vi.fn() },
    })).rejects.toThrow('missing reusable output');
    expect(listWorkspaceCausalValidations(domain)[0].changed).toEqual([input.seq]);
    expect(fs.existsSync(path.join(temp, 'refresh'))).toBe(false);
    const events = domain.getStore().getJournalEvents(domain.domainId);
    expect(events.some((event) => event.type === 'TX_ABORTED' && event.payload.txId === 'refresh')).toBe(true);
    expect(events.some((event) => event.type === 'CAUSAL_VALIDATION_REPAIR_PREPARED')).toBe(false);
  });


  it('aborts a prepared repair if its durable validation link cannot be recorded', async () => {
    const input = graph.record(step('a'));
    const store = domain.getStore();
    const record = store.recordJournalEvent.bind(store);
    const spy = vi.spyOn(store, 'recordJournalEvent').mockImplementation((event) => {
      if (event.type === 'CAUSAL_VALIDATION_REPAIR_PREPARED') throw new Error('journal unavailable');
      return record(event);
    });
    try {
      await expect(prepareWorkspaceCausalRefresh(supervisor, {
        ...options([{ id: 'one', heads: [input.seq] }]), replay: async () => 'new',
        repair: { txId: 'refresh', forkPath: path.join(temp, 'refresh'),
          validateReuse: async () => {},
          execute: async (source) => ({ actorId: source.actorId,
            observation: { ...source.observation, resultHash: 'new' } }),
        },
      })).rejects.toThrow('journal unavailable');
      expect(listWorkspaceCausalValidations(domain)).toHaveLength(1);
      const events = store.getJournalEvents(domain.domainId);
      const begun = events.find((event) => event.type === 'TX_BEGUN' && event.payload.txId === 'refresh')!;
      expect(store.getSnapshot(begun.payload.baseSnapshotId as string)).toBeNull();
      expect(events.some((event) => event.type === 'TX_ABORTED' && event.payload.txId === 'refresh')).toBe(true);
      expect(fs.existsSync(path.join(temp, 'refresh'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

});
