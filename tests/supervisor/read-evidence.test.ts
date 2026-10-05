import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ExecutionDomain, ProcessSupervisor } from '../../src/index.js';
import { evaluateReadEvidence, normalizeAccessTimesOnePass, ReadTracker } from '../../src/supervisor/read-evidence.js';
import { probeReadTracking } from '../../src/workspace/read-tracking.js';

/**
 * A verification command's result carries what it read. Later the kernel says whether that result still
 * describes the workspace: fresh, stale (with the changed dependencies) or unknown.
 */
describe('read evidence', () => {
  let tempDir: string;
  let repo: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  let atime: boolean;

  function open() {
    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'evidence-domain');
    supervisor = new ProcessSupervisor(domain);
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-evidence-')));
    repo = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repo, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 3}\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'unrelated\n');
    fs.writeFileSync(path.join(repo, 'fixtures/a.txt'), 'a\n');
    atime = probeReadTracking(tempDir) === 'atime';
    open();
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A "test command": reads data.json, lists fixtures/, and exits with `exit`. */
  const CHECK = "const fs=require('fs');JSON.parse(fs.readFileSync('data.json','utf8'));fs.readdirSync('fixtures');process.exit(Number(process.env.EXIT||0))";
  function check(opId: string, extra: { statCaches?: 'ruled_out'; exit?: number; script?: string; track?: boolean; onReady?: () => void } = {}) {
    return supervisor.executeProcess({
      runId: 'run', opId, name: 'check',
      command: { execPath: process.execPath, args: ['-e', extra.script ?? CHECK], cwd: repo, envWhiteList: { EXIT: String(extra.exit ?? 0) }, inheritEnv: false },
      ...(extra.onReady ? { onStreamChunk: extra.onReady } : {}),
      ...(extra.track === false ? {} : { trackReads: { roots: [repo], ...(extra.statCaches ? { statCaches: extra.statCaches } : {}) } }),
    });
  }

  it('records what the command read and answers fresh while nothing in the roots changed', async () => {
    const result = await check('c1');
    expect(result.status).toBe('succeeded');
    expect(result.readEvidence).toMatchObject({ scope: 'content_reads', statCaches: 'possible', roots: [repo] });
    expect(fs.existsSync(result.readEvidence!.ref!)).toBe(true);
    expect(supervisor.evidenceStatus('c1')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });
    if (!atime) return;
    expect(result.readEvidence!.tracking).toBe('atime');
    const file = JSON.parse(zlib.gunzipSync(fs.readFileSync(result.readEvidence!.ref!)).toString('utf8'));
    expect(Object.keys(file.roots[0].reads).sort()).toEqual(['data.json', 'fixtures/']);
  });

  it('includes equal-timestamp reads in persisted evidence', () => {
    const session = new ReadTracker().open('equal-time', { roots: [repo] });
    try {
      session.begin();
      for (const entry of ['data.json', 'fixtures']) {
        const file = path.join(repo, entry);
        const mtime = fs.statSync(file).mtimeMs / 1000;
        fs.utimesSync(file, mtime, mtime);
      }
      const evidence = session.collect(path.join(tempDir, 'artifacts'));
      expect(evidence.tracking).toBe(atime ? 'atime' : 'unobserved');
      const file = JSON.parse(zlib.gunzipSync(fs.readFileSync(evidence.ref!)).toString('utf8'));
      expect(file.roots[0].reads === null ? null : Object.keys(file.roots[0].reads).sort())
        .toEqual(atime ? ['data.json', 'fixtures/'] : null);
    } finally {
      session.close();
    }
  });

  it('answers stale and names the file when something the command read has changed', async () => {
    await check('c2');
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 4}\n');
    const status = supervisor.evidenceStatus('c2');
    if (!atime) return expect(status).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
    expect(status).toEqual({ status: 'stale', changed: [path.join(repo, 'data.json')], truncated: false });
  });

  it('answers stale when a directory the command listed gained an entry', async () => {
    await check('c3');
    fs.writeFileSync(path.join(repo, 'fixtures/b.txt'), 'b\n');
    if (!atime) return;
    expect(supervisor.evidenceStatus('c3')).toEqual({ status: 'stale', changed: [`${path.join(repo, 'fixtures')}/`], truncated: false });
  });

  it('a file that was read and rewritten with the same content does not make the evidence stale', async () => {
    await check('c4');
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 3}\n');
    if (!atime) return;
    expect(supervisor.evidenceStatus('c4')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });
  });

  it('answers unknown, not fresh, when only files outside the read set changed and stat caches were not ruled out', async () => {
    await check('c5');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    const status = supervisor.evidenceStatus('c5');
    // new.txt is a new entry of the root directory, which the command did not list.
    expect(status).toEqual({
      status: 'unknown',
      reason: atime ? 'changed_outside_read_set' : 'reads_unobserved',
      changedOutside: [path.join(repo, 'new.txt'), path.join(repo, 'other.txt')],
      truncated: false,
    });
  });

  it('uses the recorded read set once the caller has ruled stat caches out', async () => {
    const result = await check('c6', { statCaches: 'ruled_out' });
    const recorded = JSON.parse(zlib.gunzipSync(fs.readFileSync(result.readEvidence!.ref!)).toString('utf8'));
    const reads = recorded.roots[0].reads;
    if (atime) expect(reads).toHaveProperty('data.json');
    const otherWasRead = reads !== null && Object.hasOwn(reads, 'other.txt');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
    const status = supervisor.evidenceStatus('c6');
    if (!atime) return expect(status).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
    // Atime is shared filesystem evidence, not exact attribution to this command.
    expect(status).toEqual(otherWasRead
      ? { status: 'stale', changed: [path.join(repo, 'other.txt')], truncated: false }
      : { status: 'fresh', basis: 'reads_unchanged' });
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 9}\n');
    expect(supervisor.evidenceStatus('c6')).toEqual({
      status: 'stale', truncated: false,
      changed: ['data.json', ...(otherWasRead ? ['other.txt'] : [])].map((name) => path.join(repo, name)),
    });
  });

  it('evaluates a fixed read-set fixture independently of filesystem atime attribution', () => {
    const hash = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
    const roots = [{
      root: repo,
      reads: { 'data.json': hash(fs.readFileSync(path.join(repo, 'data.json'))) },
      tree: Object.fromEntries(['data.json', 'other.txt', 'fixtures/a.txt'].map((name) => {
        const st = fs.statSync(path.join(repo, name), { bigint: true });
        return [name, `${st.size}:${st.mtimeNs}`];
      })),
    }];
    const ref = path.join(tempDir, 'fixed-evidence.json.gz');
    fs.writeFileSync(ref, zlib.gzipSync(JSON.stringify({ version: 1, opId: 'fixture', statCaches: 'ruled_out', roots })));
    const evidence = {
      ref, tracking: 'atime' as const, scope: 'content_reads' as const, statCaches: 'ruled_out' as const,
      roots: [repo], digest: hash(JSON.stringify(roots.map((root) => [root.root, root.reads]))),
    };
    fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
    expect(evaluateReadEvidence(evidence)).toEqual({ status: 'fresh', basis: 'reads_unchanged' });
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 9}\n');
    expect(evaluateReadEvidence(evidence)).toEqual({ status: 'stale', changed: [path.join(repo, 'data.json')], truncated: false });
  });

  it('a failing command carries evidence too', async () => {
    const result = await check('c7', { exit: 3 });
    expect(result).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(supervisor.evidenceStatus('c7')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });
  });

  it('answers unknown for a command that was not tracked, and throws for an operation that does not exist', async () => {
    const result = await check('c8', { track: false });
    expect(result.readEvidence).toBeUndefined();
    expect(supervisor.evidenceStatus('c8')).toEqual({ status: 'unknown', reason: 'not_tracked' });
    expect(() => supervisor.evidenceStatus('nope')).toThrow(/does not exist/);
  });

  it('answers unknown when the evidence file is gone or was altered', async () => {
    const result = await check('c9');
    const ref = result.readEvidence!.ref!;
    const altered = JSON.parse(zlib.gunzipSync(fs.readFileSync(ref)).toString('utf8'));
    altered.roots[0].reads = {};
    fs.writeFileSync(ref, zlib.gzipSync(JSON.stringify(altered)));
    if (atime) expect(supervisor.evidenceStatus('c9')).toEqual({ status: 'unknown', reason: 'evidence_unreadable' });
    fs.rmSync(ref);
    expect(supervisor.evidenceStatus('c9')).toEqual({ status: 'unknown', reason: 'evidence_missing' });
  });

  it('keeps answering after a restart, and pruneArtifacts does not remove evidence that a result refers to', async () => {
    const result = await check('c10');
    expect(supervisor.pruneArtifacts().deleted).not.toContain(path.basename(result.readEvidence!.ref!));
    domain.close();
    open();
    expect(supervisor.evidenceStatus('c10')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 5}\n');
    if (atime) expect(supervisor.evidenceStatus('c10').status).toBe('stale');
    // Replaying the same operation returns the recorded result, evidence included, without running again.
    const replayed = await check('c10');
    expect(replayed.readEvidence).toEqual(result.readEvidence);
  });

  it('does not observe a second command on a root that is already being observed, and says so', async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const release = path.join(tempDir, 'release');
    const slow = check('c11-slow', { onReady: ready, script:
      `const fs=require('fs');console.log('ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.readFileSync('data.json');process.exit(0)}},10);setTimeout(()=>process.exit(1),5000)` });
    await started;
    const second = await check('c11-second', { script: "const fs=require('fs');fs.readFileSync('data.json');fs.readFileSync('other.txt')" });
    fs.writeFileSync(release, 'release');
    const first = await slow;
    expect(first.status).toBe('succeeded');
    expect(second.readEvidence).toMatchObject({ tracking: 'unobserved', reason: 'roots_busy' });
    // Without a read set the answer can only rest on "nothing changed at all".
    expect(supervisor.evidenceStatus('c11-second')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });
    fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
    expect(supervisor.evidenceStatus('c11-second')).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
    if (!atime) return;
    // Atime cannot attribute reads: the first session conservatively includes
    // the overlapping command's reads instead of claiming an exact per-process set.
    expect(first.readEvidence!.tracking).toBe('atime');
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 7}\n');
    expect(supervisor.evidenceStatus('c11-slow')).toMatchObject({ status: 'stale', changed: [path.join(repo, 'data.json'), path.join(repo, 'other.txt')] });
  });

  it('rejects roots that are not existing absolute directories before anything runs', async () => {
    await expect(supervisor.executeProcess({
      runId: 'run', opId: 'c12', name: 'check',
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: repo },
      trackReads: { roots: [path.join(repo, 'missing')] },
    })).rejects.toThrow(/trackReads: root/);
    expect(domain.getStore().getOperation('c12')).toBeFalsy();
  });

  it('the one-pass reset only touches files that were read since the last reset', () => {
    if (!atime) return;
    normalizeAccessTimesOnePass(repo);
    fs.readFileSync(path.join(repo, 'data.json'));
    const before = fs.statSync(path.join(repo, 'other.txt'), { bigint: true }).ctimeNs;
    normalizeAccessTimesOnePass(repo);
    // other.txt was not read: no utimes call, so its change time did not move.
    expect(fs.statSync(path.join(repo, 'other.txt'), { bigint: true }).ctimeNs).toBe(before);
    const data = fs.statSync(path.join(repo, 'data.json'));
    expect(data.atimeMs).toBeLessThan(data.mtimeMs);
  });
});
