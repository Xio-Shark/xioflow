import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import type { ObservationEntry, ObservationValidation } from '../../src/workspace/transactions.js';
import * as readTracking from '../../src/workspace/read-tracking.js';

/**
 * E1: three ways to decide whether agent A's work still stands after agent B committed first.
 * A's trajectory is "rename foo to bar" (grep, read, edit, read, edit); the agents are scripted tool-call logs.
 *   - file-level validation: what the kernel does (read set / write set per file);
 *   - observation replay: re-run A's read-only observations on the new base, first difference = divergence.
 * The file-level assertions pin today's behaviour; the replay helper is the reference for observation validation.
 */
type Step =
  | { tool: 'grep'; pattern: string; dir: string }
  | { tool: 'read'; path: string }
  | { tool: 'edit'; path: string; old: string; new: string }
  | { tool: 'write'; path: string; content: string };
type Recorded = Step & { seen: string };
type GrepStyle = 'with-line-numbers' | 'without-line-numbers';

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
const isObservation = (step: Step) => step.tool === 'grep' || step.tool === 'read';

function execute(step: Step, root: string, grepStyle: GrepStyle): string {
  if (step.tool === 'grep') {
    const out: string[] = [];
    for (const name of fs.readdirSync(path.join(root, step.dir)).sort()) {
      const rel = `${step.dir}/${name}`;
      fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
        if (line.includes(step.pattern)) out.push(grepStyle === 'with-line-numbers' ? `${rel}:${i + 1}:${line}` : `${rel}:${line}`);
      });
    }
    return out.join('\n');
  }
  if (step.tool === 'read') return fs.readFileSync(path.join(root, step.path), 'utf8');
  if (step.tool === 'write') {
    fs.writeFileSync(path.join(root, step.path), step.content);
    return 'ok';
  }
  const abs = path.join(root, step.path);
  const text = fs.readFileSync(abs, 'utf8');
  if (!text.includes(step.old)) throw new Error(`edit: "${step.old}" not found in ${step.path}`);
  fs.writeFileSync(abs, text.split(step.old).join(step.new));
  return 'ok';
}

/** Runs a trajectory and records a hash of what every step returned. */
function run(trajectory: Step[], root: string, grepStyle: GrepStyle = 'with-line-numbers'): Recorded[] {
  return trajectory.map((step) => ({ ...step, seen: sha(execute(step, root, grepStyle)) }));
}

/** Re-runs a recorded trajectory on another tree: mutations are applied, observations are compared. */
function replay(log: Recorded[], root: string, grepStyle: GrepStyle = 'with-line-numbers') {
  for (let i = 0; i < log.length; i++) {
    let now: string;
    try {
      now = sha(execute(log[i], root, grepStyle));
    } catch {
      return { divergedAt: i, preserved: i, reason: 'mutation_not_applicable' as const };
    }
    if (isObservation(log[i]) && now !== log[i].seen) return { divergedAt: i, preserved: i, reason: 'observation_changed' as const };
  }
  return { divergedAt: -1, preserved: log.length, reason: undefined };
}

const A: Step[] = [
  { tool: 'grep', pattern: 'foo', dir: 'src' },
  { tool: 'read', path: 'src/util.mjs' },
  { tool: 'edit', path: 'src/util.mjs', old: 'foo', new: 'bar' },
  { tool: 'read', path: 'src/c1.mjs' },
  { tool: 'edit', path: 'src/c1.mjs', old: 'foo', new: 'bar' },
];
const B_NEW_CALLER: Step[] = [{ tool: 'write', path: 'src/c3.mjs', content: "import { foo } from './util.mjs';\nconsole.log(foo());\n" }];
const B_UNRELATED_EDIT: Step[] = [
  { tool: 'read', path: 'src/c2.mjs' },
  { tool: 'edit', path: 'src/c2.mjs', old: 'x = 1', new: 'x = 2' },
];
const B_COMMENT_ABOVE: Step[] = [
  { tool: 'read', path: 'src/c1.mjs' },
  { tool: 'edit', path: 'src/c1.mjs', old: 'console.log', new: '// log the value\nconsole.log' },
];

describe('E1: file-level validation vs observation replay', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;

  function makeRepo(name: string): string {
    const repo = path.join(tempDir, name);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/util.mjs'), 'export function foo() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(repo, 'src/c1.mjs'), "import { foo } from './util.mjs';\nconsole.log(foo());\n");
    fs.writeFileSync(path.join(repo, 'src/c2.mjs'), 'export const x = 1;\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'tester@test.local');
    git('config', 'user.name', 'Tester');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return repo;
  }

  /** "Does it still run?": every caller module executes without error. */
  function brokenCallers(repo: string): string[] {
    return fs.readdirSync(path.join(repo, 'src')).filter((f) => /^c\d\.mjs$/.test(f))
      .filter((f) => spawnSync(process.execPath, [path.join(repo, 'src', f)]).status !== 0);
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-obs-test-')));
    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'obs-domain');
    supervisor = new ProcessSupervisor(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** File-level: both agents work in their own fork, B commits first, then A. */
  async function fileLevel(name: string, b: Step[]) {
    const repo = makeRepo(name);
    const txA = await supervisor.beginWorkspaceTransaction({ txId: `${name}-A`, runId: 'run', root: repo, forkPath: path.join(tempDir, `fork-${name}-A`) });
    const txB = await supervisor.beginWorkspaceTransaction({ txId: `${name}-B`, runId: 'run', root: repo, forkPath: path.join(tempDir, `fork-${name}-B`) });
    run(A, txA.forkRoot);
    run(b, txB.forkRoot);
    expect((await supervisor.commitWorkspaceTransaction(`${name}-B`)).status).toBe('committed');
    const result = await supervisor.commitWorkspaceTransaction(`${name}-A`);
    return { repo, result, readTracking: txA.readTracking };
  }

  /** Observation replay: A recorded on the old base, B already in the main workspace, A's log replayed there. */
  function observationLevel(name: string, b: Step[], grepStyle: GrepStyle = 'with-line-numbers') {
    const log = run(A, makeRepo(`${name}-recorded`), grepStyle);
    const main = makeRepo(`${name}-main`);
    run(b, main, grepStyle);
    return { main, ...replay(log, main, grepStyle) };
  }

  it('S1 phantom read (B adds a new caller of foo): both methods stop A', async () => {
    const { result, readTracking } = await fileLevel('s1', B_NEW_CALLER);
    if (readTracking === 'atime') {
      expect(result.status).toBe('conflict');
      expect(result.status === 'conflict' && result.conflicts).toEqual([{ path: 'src/', kind: 'read_write', otherTxId: 's1-B' }]);
    }
    expect(observationLevel('s1', B_NEW_CALLER)).toMatchObject({ divergedAt: 0, preserved: 0, reason: 'observation_changed' });
  });

  it('S2 false conflict (B edits a file A only grepped, no foo in it): file-level discards A, replay commits it with no model call', async () => {
    const { result, readTracking } = await fileLevel('s2', B_UNRELATED_EDIT);
    if (readTracking === 'atime') {
      // Today's behaviour, which observation validation is meant to change.
      expect(result.status).toBe('conflict');
      expect(result.status === 'conflict' && result.conflicts).toEqual([{ path: 'src/c2.mjs', kind: 'read_write', otherTxId: 's2-B' }]);
    }
    const replayed = observationLevel('s2', B_UNRELATED_EDIT);
    expect(replayed).toMatchObject({ divergedAt: -1, preserved: A.length });
    // All of A's edits were applied mechanically on top of B's, and the result runs.
    expect(fs.readFileSync(path.join(replayed.main, 'src/util.mjs'), 'utf8')).toContain('export function bar()');
    expect(fs.readFileSync(path.join(replayed.main, 'src/c2.mjs'), 'utf8')).toBe('export const x = 2;\n');
    expect(brokenCallers(replayed.main)).toEqual([]);
  });

  it('S3 same file (B inserts a comment line in a file A edits): write_write at file level; the divergence point depends on how grep prints', async () => {
    const { result } = await fileLevel('s3', B_COMMENT_ABOVE);
    expect(result.status).toBe('conflict');
    expect(result.status === 'conflict' && result.conflicts.map((c) => c.kind)).toContain('write_write');

    // D-O2: grep output with line numbers diverges at the very first step (the inserted line shifts a number);
    // without them the grep result is unchanged and A keeps its first three steps, diverging at the read of c1.mjs.
    expect(observationLevel('s3n', B_COMMENT_ABOVE, 'with-line-numbers')).toMatchObject({ divergedAt: 0, preserved: 0, reason: 'observation_changed' });
    expect(observationLevel('s3p', B_COMMENT_ABOVE, 'without-line-numbers')).toMatchObject({ divergedAt: 3, preserved: 3, reason: 'observation_changed' });
  });

  it('a replayed edit whose anchor text is gone reports mutation_not_applicable instead of guessing', () => {
    const log = run(A, makeRepo('s4-recorded'));
    const main = makeRepo('s4-main');
    // Same observations up to the edit of util.mjs would be required; here an observation-free log isolates the mutation.
    const mutationsOnly = log.filter((step) => !isObservation(step));
    fs.writeFileSync(path.join(main, 'src/util.mjs'), 'export function renamedAlready() {\n  return 1;\n}\n');
    expect(replay(mutationsOnly, main)).toMatchObject({ divergedAt: 0, preserved: 0, reason: 'mutation_not_applicable' });
  });
});

/**
 * The kernel interface: commit with the transaction's observation log. File-level validation still runs first;
 * observations are replayed only when it reports a conflict on something this transaction read but did not write.
 */
describe('commit with observation validation', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;

  function makeRepo(name: string): string {
    const repo = path.join(tempDir, name);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/util.mjs'), 'export function foo() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(repo, 'src/c1.mjs'), "import { foo } from './util.mjs';\nconsole.log(foo());\n");
    fs.writeFileSync(path.join(repo, 'src/c2.mjs'), 'export const x = 1;\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'tester@test.local');
    git('config', 'user.name', 'Tester');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return repo;
  }

  function open() {
    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'obs-domain');
    supervisor = new ProcessSupervisor(domain);
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-obs-commit-')));
    open();
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** What a host hands to commit: its log, and how to re-run one entry in another directory. */
  function observations(log: Recorded[]): ObservationValidation {
    const entries: ObservationEntry[] = log.map(({ seen, ...step }) => ({
      kind: isObservation(step) ? 'observe' : 'mutate',
      call: { tool: step.tool, args: step as unknown as Record<string, unknown> },
      ...(isObservation(step) ? { resultHash: seen } : {}),
    }));
    return {
      log: entries,
      closedWorld: true,
      replay: async (entry, root) => sha(execute(entry.call.args as unknown as Step, root, 'with-line-numbers')),
    };
  }

  /** A and B each in a fork; B commits first; A commits with its observation log. */
  async function race(name: string, b: Step[], a: Step[] = A) {
    const repo = makeRepo(name);
    const txA = await supervisor.beginWorkspaceTransaction({ txId: `${name}-A`, runId: 'run', root: repo, forkPath: path.join(tempDir, `fork-${name}-A`) });
    const txB = await supervisor.beginWorkspaceTransaction({ txId: `${name}-B`, runId: 'run', root: repo, forkPath: path.join(tempDir, `fork-${name}-B`) });
    const log = run(a, txA.forkRoot);
    run(b, txB.forkRoot);
    expect((await supervisor.commitWorkspaceTransaction(`${name}-B`)).status).toBe('committed');
    return { repo, txA, log };
  }
  const events = (type: string) => domain.getStore().getJournalEvents(domain.domainId).filter((e) => e.type === type);
  const leftovers = () => fs.readdirSync(tempDir).filter((name) => name.startsWith('fork-'));

  async function unobserved(name: string) {
    const repo = makeRepo(name);
    // Exercise noatime semantics on every CI filesystem.
    const probe = vi.spyOn(readTracking, 'probeReadTracking').mockReturnValue('unobserved');
    try {
      const tx = await supervisor.beginWorkspaceTransaction({
        txId: name, runId: 'run', root: repo, forkPath: path.join(tempDir, `fork-${name}`),
      });
      return { repo, tx, log: run(A, tx.forkRoot) };
    } finally {
      probe.mockRestore();
    }
  }

  async function publication(tx: { baseSnapshotId: string; forkRoot: string }) {
    const base = domain.getStore().getSnapshot(tx.baseSnapshotId)!;
    return {
      coverage: 'complete' as const,
      outputFingerprint: await supervisor.getSnapshotDriver().fingerprint([tx.forkRoot], { against: base }),
      accept: vi.fn(async (_root: string) => true),
    };
  }

  it.each(['unknown', 'tampered', 'rejected', 'throws', 'mutates'] as const)(
    'rejects publication %s before changing the main workspace', async mode => {
      const { repo, tx, log } = await unobserved(`publication-${mode}`);
      const gate = await publication(tx);
      const before = fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8');
      if (mode === 'tampered') fs.appendFileSync(path.join(tx.forkRoot, 'src/util.mjs'), '// corrupt');
      if (mode === 'rejected') gate.accept.mockImplementation(async () => false);
      if (mode === 'throws') gate.accept.mockImplementation(async () => { throw new Error('oracle unavailable'); });
      if (mode === 'mutates') gate.accept.mockImplementation(async root => {
        fs.appendFileSync(path.join(root, 'src/util.mjs'), '// illegal oracle write'); return true;
      });
      const reason = mode === 'unknown' ? 'coverage_unknown' : mode === 'rejected' ? 'acceptance_rejected'
        : mode === 'throws' ? 'validation_failed' : 'output_changed';
      await expect(supervisor.commitWorkspaceTransaction(tx.txId, {
        observations: observations(log), publication: { ...gate, coverage: mode === 'unknown' ? 'unknown' : 'complete' },
      })).rejects.toMatchObject({ reason });
      expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toBe(before);
      expect(events('TX_COMMITTING')).toHaveLength(0);
      expect(events('TX_PUBLICATION_REJECTED').at(-1)?.payload).toMatchObject({ txId: tx.txId, reason });
      expect(leftovers()).toEqual([`fork-publication-${mode}`]);
      if (mode === 'unknown' || mode === 'tampered') expect(gate.accept).not.toHaveBeenCalled();
    });

  it('accepts the actual replay output and records its publication seal', async () => {
    const { repo, tx, log } = await unobserved('publication-valid');
    const gate = await publication(tx);
    gate.accept.mockImplementation(async root => {
      expect(root).not.toBe(tx.forkRoot);
      return fs.readFileSync(path.join(root, 'src/util.mjs'), 'utf8').includes('function bar()');
    });
    expect(await supervisor.commitWorkspaceTransaction(tx.txId, {
      observations: observations(log), publication: gate,
    })).toMatchObject({ status: 'committed', validation: 'observations' });
    expect(events('TX_COMMITTING').at(-1)?.payload.publication).toMatchObject({
      sourceFingerprint: expect.any(String), snapshotId: expect.any(String),
    });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('function bar()');
    expect(leftovers()).toEqual([]);
  });

  it('refuses a corrupted sealed source after reopening an interrupted commit', async () => {
    const { repo, tx, log } = await unobserved('publication-recovery');
    const gate = await publication(tx);
    const store = domain.getStore();
    const record = store.recordJournalEvent.bind(store);
    const interrupted = vi.spyOn(store, 'recordJournalEvent').mockImplementation(event => {
      const seq = record(event);
      if (event.type === 'TX_COMMITTING') throw new Error('simulated crash');
      return seq;
    });
    await expect(supervisor.commitWorkspaceTransaction(tx.txId, {
      observations: observations(log), publication: gate,
    })).rejects.toThrow('simulated crash');
    interrupted.mockRestore();
    const source = events('TX_COMMITTING').at(-1)!.payload.sourceRoot as string;
    fs.appendFileSync(path.join(source, 'src/util.mjs'), '// corrupt after crash');
    supervisor = new ProcessSupervisor(domain);
    await expect(supervisor.commitWorkspaceTransaction(tx.txId)).rejects.toMatchObject({ reason: 'output_changed' });
    expect(events('TX_COMMITTED')).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('function foo()');
  });

  it('always replays without file conflicts and commits from the verified fork on noatime', async () => {
    const { repo, tx, log } = await unobserved('always-valid');
    const validation = observations(log);
    const replay = vi.fn(validation.replay);
    const result = await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: { ...validation, replay },
    });
    expect(result).toMatchObject({ status: 'committed', validation: 'observations', readSet: null });
    expect(replay).toHaveBeenCalledTimes(A.length);
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('function bar()');
    expect(events('TX_COMMITTING').at(-1)?.payload).toMatchObject({ validation: 'observations' });
    expect(leftovers()).toEqual([]);
    expect(domain.getStore().listSnapshots(domain.domainId).filter((s) => s.id.includes('replay'))).toEqual([]);
  });

  it('detects a changed phantom observation even when file OCC has no read evidence', async () => {
    const { repo, tx, log } = await unobserved('always-stale');
    run(B_NEW_CALLER, repo);
    const result = await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: observations(log),
    });
    expect(result).toMatchObject({ status: 'conflict', conflicts: [], readSet: null,
      observation: { attempted: true, divergedAt: 0, reason: 'observation_changed' } });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('function foo()');
    expect(events('TX_COMMITTING')).toEqual([]);
    await supervisor.abortWorkspaceTransaction(tx.txId);
    expect(leftovers()).toEqual([]);
  });

  it('rejects a world change during mandatory replay without any initial file conflict', async () => {
    const { repo, tx, log } = await unobserved('always-race');
    const validation = observations(log);
    const result = await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: { ...validation, replay: async (entry, root) => {
        fs.writeFileSync(path.join(repo, 'src/c2.mjs'), 'changed during replay');
        return validation.replay(entry, root);
      } },
    });
    expect(result).toMatchObject({ status: 'conflict', conflicts: [],
      observation: { attempted: true, reason: 'workspace_changed' } });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('function foo()');
    await supervisor.abortWorkspaceTransaction(tx.txId);
    expect(leftovers()).toEqual([]);
  });

  it('requires complete evidence before allocating a replay and leaves invalid requests retryable', async () => {
    const { tx, log } = await unobserved('always-invalid');
    const validation = observations(log);
    const missingHash = structuredClone(validation.log);
    delete missingHash[0].resultHash;
    for (const evidence of [undefined, { ...validation, closedWorld: false as never },
      { ...validation, log: missingHash }]) {
      await expect(supervisor.commitWorkspaceTransaction(tx.txId, {
        observationPolicy: 'always', observations: evidence,
      })).rejects.toThrow('closed-world log with hashes');
    }
    expect(events('TX_REPLAY_STARTED')).toEqual([]);
    expect((await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: validation,
    })).status).toBe('committed');
  });

  it('never downgrades mandatory validation when a process escaped the observation log', async () => {
    const { tx, log } = await unobserved('always-process');
    await supervisor.executeProcess({
      runId: 'run', opId: 'always-proc', name: 'agent-shell',
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: tx.forkRoot },
      requiredResources: [`workspace:write:${tx.forkRoot}`],
    });
    const result = await supervisor.commitWorkspaceTransaction(tx.txId, {
      observationPolicy: 'always', observations: observations(log),
    });
    expect(result).toMatchObject({ status: 'conflict', conflicts: [],
      observation: { attempted: false, reason: 'not_closed_world' } });
    expect(events('TX_REPLAY_STARTED')).toEqual([]);
    await supervisor.abortWorkspaceTransaction(tx.txId);
  });

  it('keeps write conflicts even with mandatory observation validation', async () => {
    const { txA, log } = await race('always-ww', B_COMMENT_ABOVE);
    const replay = vi.fn(observations(log).replay);
    const result = await supervisor.commitWorkspaceTransaction(txA.txId, {
      observationPolicy: 'always', observations: { ...observations(log), replay },
    });
    expect(result).toMatchObject({ status: 'conflict',
      observation: { attempted: false, reason: 'write_conflict' } });
    expect(replay).not.toHaveBeenCalled();
    await supervisor.abortWorkspaceTransaction(txA.txId);
  });

  it('recovers a mandatory replay commit after restart without replaying the tools again', async () => {
    const { repo, tx, log } = await unobserved('always-crash');
    const rmSync = fs.rmSync;
    const failure = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (file === path.join(repo, 'src/c1.mjs')) throw new Error('injected apply failure');
      return rmSync(file, options);
    });
    try {
      await expect(supervisor.commitWorkspaceTransaction(tx.txId, {
        observationPolicy: 'always', observations: observations(log),
      })).rejects.toThrow('injected apply failure');
    } finally {
      failure.mockRestore();
    }
    domain.close();
    open();
    expect(await supervisor.commitWorkspaceTransaction(tx.txId)).toMatchObject({
      status: 'committed', validation: 'observations',
    });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('function bar()');
    expect(events('TX_REPLAY_STARTED')).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it('commits when every observation is unchanged, although a file the transaction read was changed', async () => {
    const { repo, txA, log } = await race('same', B_UNRELATED_EDIT);
    if (txA.readTracking !== 'atime') return;
    const result = await supervisor.commitWorkspaceTransaction('same-A', { observations: observations(log) });
    expect(result).toMatchObject({ status: 'committed', validation: 'observations' });
    // A's edits were replayed on top of B's change.
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function bar()');
    expect(fs.readFileSync(path.join(repo, 'src/c1.mjs'), 'utf8')).toContain('bar()');
    expect(fs.readFileSync(path.join(repo, 'src/c2.mjs'), 'utf8')).toBe('export const x = 2;\n');
    expect(result.writeSet.map((w) => w.path).sort()).toEqual(['src/c1.mjs', 'src/util.mjs']);
    expect(events('TX_COMMITTED').at(-1)?.payload).toMatchObject({ txId: 'same-A', validation: 'observations' });
    expect(leftovers()).toEqual([]);
    expect(domain.getStore().listSnapshots(domain.domainId).filter((s) => s.id.includes('replay'))).toEqual([]);
  });

  it('keeps the conflict and names the first difference when an observation changed (phantom read)', async () => {
    const { repo, txA, log } = await race('phantom', B_NEW_CALLER);
    if (txA.readTracking !== 'atime') return;
    const result = await supervisor.commitWorkspaceTransaction('phantom-A', { observations: observations(log) });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.conflicts).toEqual([{ path: 'src/', kind: 'read_write', otherTxId: 'phantom-B' }]);
    expect(result.observation).toEqual({ attempted: true, divergedAt: 0, reason: 'observation_changed' });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function foo()');
    expect(events('TX_CONFLICTED').at(-1)?.payload).toMatchObject({ observation: { divergedAt: 0, reason: 'observation_changed' } });
    await supervisor.abortWorkspaceTransaction('phantom-A');
    expect(leftovers()).toEqual([]);
  });

  it('does not try observations when both sides wrote the same file', async () => {
    const { txA, log } = await race('ww', B_COMMENT_ABOVE);
    const result = await supervisor.commitWorkspaceTransaction('ww-A', { observations: observations(log) });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.conflicts.map((c) => c.kind)).toContain('write_write');
    expect(result.observation).toEqual({ attempted: false, reason: 'write_conflict' });
    void txA;
  });

  it('reports a replayed edit that cannot be applied as mutation_not_applicable', async () => {
    const { repo, txA, log } = await race('gone', B_UNRELATED_EDIT);
    if (txA.readTracking !== 'atime') return;
    const validation = observations(log);
    const result = await supervisor.commitWorkspaceTransaction('gone-A', {
      observations: {
        ...validation,
        // The host's replay of the first edit fails (as an edit whose anchor text is gone would).
        replay: async (entry, root) => {
          if (entry.kind === 'mutate') throw new Error('edit: anchor not found');
          return validation.replay(entry, root);
        },
      },
    });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.observation).toEqual({ attempted: true, divergedAt: 2, reason: 'mutation_not_applicable' });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function foo()');
  });

  it('compares what a mutation returned when the host recorded a hash for it', async () => {
    const { repo, txA, log } = await race('seen', B_UNRELATED_EDIT);
    if (txA.readTracking !== 'atime') return;
    const validation = observations(log);
    // The first edit's return value showed the agent something (say, a list of references) that is different now.
    const firstEdit = validation.log.findIndex((entry) => entry.kind === 'mutate');
    validation.log[firstEdit].resultHash = 'what-the-agent-saw-then';
    const result = await supervisor.commitWorkspaceTransaction('seen-A', { observations: validation });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.observation).toEqual({ attempted: true, divergedAt: firstEdit, reason: 'observation_changed' });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function foo()');
  });

  it('does not apply when the workspace changed while the observations were being replayed', async () => {
    const { repo, txA, log } = await race('moved', B_UNRELATED_EDIT);
    if (txA.readTracking !== 'atime') return;
    const validation = observations(log);
    let wrote = false;
    const result = await supervisor.commitWorkspaceTransaction('moved-A', {
      observations: {
        ...validation,
        replay: async (entry, root) => {
          // Someone edits the workspace directly while the replay is under way.
          if (!wrote) fs.writeFileSync(path.join(repo, 'src/c1.mjs'), '// edited by hand during the replay\n');
          wrote = true;
          return validation.replay(entry, root);
        },
      },
    });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.observation).toEqual({ attempted: true, reason: 'workspace_changed' });
    // Neither the hand edit was overwritten nor anything of A applied.
    expect(fs.readFileSync(path.join(repo, 'src/c1.mjs'), 'utf8')).toBe('// edited by hand during the replay\n');
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function foo()');
    await supervisor.abortWorkspaceTransaction('moved-A');
    expect(leftovers()).toEqual([]);
    expect(domain.getStore().listSnapshots(domain.domainId).filter((s) => s.id.includes('replay'))).toEqual([]);
  });

  it('falls back to the file-level conflict when a process ran inside the fork (not a closed world)', async () => {
    const { txA, log } = await race('open', B_UNRELATED_EDIT);
    if (txA.readTracking !== 'atime') return;
    // A shell command in the fork can read anything; the log no longer covers what the agent saw.
    await supervisor.executeProcess({
      runId: 'run', opId: 'open-proc', name: 'agent-shell',
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: txA.forkRoot },
      requiredResources: [`workspace:write:${txA.forkRoot}`],
    });
    const result = await supervisor.commitWorkspaceTransaction('open-A', { observations: observations(log) });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.observation).toEqual({ attempted: false, reason: 'not_closed_world' });
    expect(events('TX_VALIDATION_DOWNGRADED').at(-1)?.payload).toMatchObject({ txId: 'open-A', operationId: 'open-proc' });
  });

  it('says which evidence a conflict-free commit rests on', async () => {
    const repo = makeRepo('plain');
    const tx = await supervisor.beginWorkspaceTransaction({ txId: 'plain-A', runId: 'run', root: repo, forkPath: path.join(tempDir, 'fork-plain-A') });
    const log = run(A, tx.forkRoot);
    const result = await supervisor.commitWorkspaceTransaction('plain-A', { observations: observations(log) });
    expect(result).toMatchObject({ status: 'committed', validation: tx.readTracking === 'atime' ? 'files' : 'write_only' });
    expect(domain.getStore().listSnapshots(domain.domainId).filter((s) => s.id.includes('replay'))).toEqual([]);
  });

  it('finishes an observation-validated commit that was interrupted after TX_COMMITTING', async () => {
    const { repo, txA, log } = await race('crash', B_UNRELATED_EDIT);
    if (txA.readTracking !== 'atime') return;
    // Inject the apply failure directly: root bypasses chmod-based permission failures.
    const rmSync = fs.rmSync;
    const failure = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (file === path.join(repo, 'src/c1.mjs')) throw Object.assign(new Error('EACCES: injected apply failure'), { code: 'EACCES' });
      return rmSync(file, options);
    });
    try {
      await expect(supervisor.commitWorkspaceTransaction('crash-A', { observations: observations(log) })).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      failure.mockRestore();
    }
    expect(events('TX_COMMITTING').at(-1)?.payload).toMatchObject({ txId: 'crash-A', validation: 'observations' });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function foo()');
    domain.close();
    open();

    const result = await supervisor.commitWorkspaceTransaction('crash-A');
    expect(result).toMatchObject({ status: 'committed', validation: 'observations' });
    expect(fs.readFileSync(path.join(repo, 'src/util.mjs'), 'utf8')).toContain('export function bar()');
    expect(fs.readFileSync(path.join(repo, 'src/c2.mjs'), 'utf8')).toBe('export const x = 2;\n');
    expect(leftovers()).toEqual([]);
  });
});
