import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ExecutionDomain, ProcessSupervisor } from '../../src/index.js';
import { normalizeAccessTimesOnePass } from '../../src/supervisor/read-evidence.js';
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
  function check(opId: string, extra: { statCaches?: 'ruled_out'; exit?: number; script?: string; track?: boolean } = {}) {
    return supervisor.executeProcess({
      runId: 'run', opId, name: 'check',
      command: { execPath: process.execPath, args: ['-e', extra.script ?? CHECK], cwd: repo, envWhiteList: { EXIT: String(extra.exit ?? 0) }, inheritEnv: false },
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

  it('answers fresh from the read set once the caller has ruled stat caches out', async () => {
    await check('c6', { statCaches: 'ruled_out' });
    fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
    const status = supervisor.evidenceStatus('c6');
    if (!atime) return expect(status).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
    expect(status).toEqual({ status: 'fresh', basis: 'reads_unchanged' });
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 9}\n');
    expect(supervisor.evidenceStatus('c6')).toMatchObject({ status: 'stale', changed: [path.join(repo, 'data.json')] });
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
    const slow = check('c11-slow', { script: "const fs=require('fs');setTimeout(()=>{fs.readFileSync('data.json')},700)" });
    await new Promise((r) => setTimeout(r, 250));
    const second = await check('c11-second');
    const first = await slow;
    expect(second.readEvidence).toMatchObject({ tracking: 'unobserved', reason: 'roots_busy' });
    // Without a read set the answer can only rest on "nothing changed at all".
    expect(supervisor.evidenceStatus('c11-second')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });
    fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
    expect(supervisor.evidenceStatus('c11-second')).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
    if (!atime) return;
    // The first command's evidence is intact: the second one did not reset the access times under it.
    expect(first.readEvidence!.tracking).toBe('atime');
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 7}\n');
    expect(supervisor.evidenceStatus('c11-slow')).toMatchObject({ status: 'stale', changed: [path.join(repo, 'data.json')] });
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
