import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { ExecutionDomain, ProcessSupervisor } from '../../src/index.js';
import { artifactPath, artifactStem, createArtifact, recordArtifactCreated, writeArtifact } from '../../src/artifacts.js';
import { setupStreamDrainer } from '../../src/supervisor/drainer.js';
import { ignoredManifestPath, readIgnoredManifest } from '../../src/snapshot/ignored-manifest.js';
import type { SnapshotDriver } from '../../src/types.js';
import { evaluateReadEvidence, readEvidencePath, ReadTracker } from '../../src/supervisor/read-evidence.js';

describe('artifact ownership and path boundaries', () => {
  let root: string;
  let artifacts: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-artifact-safety-'));
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'artifact-safety');
    supervisor = new ProcessSupervisor(domain);
    artifacts = path.join(domain.domainPath, 'artifacts');
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const command = (cwd: string, output = 'hello') => ({
    execPath: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(output)})`], cwd,
  });
  const processOp = (opId: string, output = 'hello') => supervisor.executeProcess({
    runId: 'run', opId, name: 'write output', command: command(root, output), maxOutputBytes: 100,
  });

  it.each(['../victim', '../../victim', '/absolute/victim', 'nested/child', 'back\\slash', 'x'.repeat(300)])(
    'treats %s as an opaque ID while preserving an outside victim', async (opId) => {
      const victim = path.join(domain.domainPath, 'victim-stdout.log');
      fs.writeFileSync(victim, 'user data');
      const result = await processOp(opId, 'output'.repeat(100));
      assert(result.kind === 'process');
      expect(result.status).toBe('succeeded');
      expect(result.spillError).toBeUndefined();
      expect(path.dirname(result.stdoutRef!)).toBe(artifacts);
      expect(fs.readFileSync(result.stdoutRef!, 'utf8')).toBe('output'.repeat(100));
      expect(fs.readFileSync(victim, 'utf8')).toBe('user data');
      expect(supervisor.pruneArtifacts().retained).toContain(result.stdoutRef);
    },
  );

  it('does not delete the outside file when a traversal ID has untruncated output', async () => {
    const victim = path.join(domain.domainPath, 'victim-stdout.log');
    fs.writeFileSync(victim, 'user data');
    expect((await processOp('../victim')).status).toBe('succeeded');
    expect(fs.readFileSync(victim, 'utf8')).toBe('user data');
    expect(fs.readdirSync(artifacts)).toEqual([]);
  });

  it('preserves ordinary filenames and reserves the encoded namespace', () => {
    expect(artifactStem('simple-op_1')).toBe('simple-op_1');
    expect(artifactStem(artifactStem('../victim'))).not.toBe(artifactStem('../victim'));
  });

  it('removes only its own partial artifact and preserves errors when fsync and close fail', () => {
    const file = artifactPath(artifacts, 'write-failure', '-ignored.manifest');
    const syncError = new Error('injected fsync failure');
    const closeError = new Error('injected close failure');
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw syncError; });
    const closeFile = fs.closeSync.bind(fs);
    const close = vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => { closeFile(fd); throw closeError; });
    try {
      let failure: unknown;
      try { writeArtifact(file, 'partial data'); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([syncError, closeError]);
      expect((failure as AggregateError).cause).toBe(syncError);
      expect(fs.existsSync(file)).toBe(false);
    } finally { sync.mockRestore(); close.mockRestore(); }
  });

  it.each(['file', 'symlink', 'hardlink'])('does not overwrite or clean up a pre-existing %s', async (kind) => {
    fs.mkdirSync(artifacts);
    const victim = path.join(root, 'victim');
    const spill = artifactPath(artifacts, 'existing', '-stdout.log');
    fs.writeFileSync(victim, 'user data');
    if (kind === 'symlink') fs.symlinkSync(victim, spill);
    else if (kind === 'hardlink') fs.linkSync(victim, spill);
    else fs.writeFileSync(spill, 'user data');
    const before = fs.lstatSync(spill);
    const result = await processOp('existing');
    assert(result.kind === 'process');
    expect(result.stdout).toBe('hello');
    expect(result.stdoutSpillError).toMatch(/EEXIST/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('user data');
    expect(fs.readFileSync(spill, 'utf8')).toBe('user data');
    expect(fs.lstatSync(spill).ino).toBe(before.ino);
    expect(supervisor.pruneArtifacts().retained).toContain(spill);
    expect(fs.readFileSync(spill, 'utf8')).toBe('user data');
  });

  it('reports a symlink artifact directory and never writes or prunes through it', async () => {
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    const victim = path.join(external, 'directory-link-stdout.log');
    fs.writeFileSync(victim, 'user data');
    fs.symlinkSync(external, artifacts, 'dir');
    const result = await processOp('directory-link');
    assert(result.kind === 'process');
    expect(result.spillError).toMatch(/Artifact directory must be a real directory/);
    expect(() => supervisor.pruneArtifacts()).toThrow(/Artifact directory/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('user data');
    expect(fs.readdirSync(external)).toEqual(['directory-link-stdout.log']);
  });

  it('does not unlink a file substituted after the drainer created its spill', async () => {
    const stream = new PassThrough();
    const spill = artifactPath(artifacts, 'replacement', '-stdout.log');
    const drainer = setupStreamDrainer(stream, 100, spill);
    fs.unlinkSync(spill);
    fs.writeFileSync(spill, 'replacement data');
    stream.end('short output');
    await drainer.finishPromise;
    expect(drainer.getResult().spillError).toMatch(/Artifact was replaced before cleanup/);
    expect(fs.readFileSync(spill, 'utf8')).toBe('replacement data');
  });

  it('keeps encoded active-operation artifacts protected during pruning', () => {
    const opId = '../active';
    domain.getStore().registerOperationIntent({
      id: opId, runId: 'run', kind: 'process', name: 'active', inputFingerprint: 'test', requiredResources: [], status: 'active',
    }, domain.domainId);
    fs.mkdirSync(artifacts);
    const files = ['-stdout.log', '-stderr.log', '-reads.json.gz'].map((suffix) => artifactPath(artifacts, opId, suffix));
    for (const file of files) fs.writeFileSync(file, 'in progress');
    expect(supervisor.pruneArtifacts().retained.sort()).toEqual(files.sort());
  });

  it.each([false, true])('only prunes a journal-owned orphan when its file identity is unchanged (replaced=%s)', (replaced) => {
    const opId = 'owned-orphan';
    const store = domain.getStore();
    store.registerOperationIntent({
      id: opId, runId: 'run', kind: 'process', name: 'orphan', inputFingerprint: 'test', requiredResources: [], status: 'active',
    }, domain.domainId);
    const spill = artifactPath(artifacts, opId, '-stdout.log');
    const created = createArtifact(spill, (artifact) => recordArtifactCreated(domain, opId, artifact));
    fs.writeFileSync(created.fd, 'orphaned output');
    fs.closeSync(created.fd);
    store.recordOperationResult(opId, {
      kind: 'process', status: 'failed', exitCode: 1, signal: null, stdout: '', stderr: '', isTruncated: false,
      identityVerification: 'cannot_determine', durationMs: 0, completedAt: new Date().toISOString(),
    });
    if (replaced) {
      fs.renameSync(spill, path.join(root, 'old-inode'));
      fs.writeFileSync(spill, 'user replacement');
    }
    // 归属事实来自持久化 journal，重启后仍可判断；文件名相同不能覆盖 inode 判断。
    domain.close();
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'artifact-safety');
    supervisor = new ProcessSupervisor(domain);
    const result = supervisor.pruneArtifacts();
    expect(replaced ? result.retained : result.deleted).toContain(spill);
    expect(fs.existsSync(spill)).toBe(replaced);
    if (replaced) expect(fs.readFileSync(spill, 'utf8')).toBe('user replacement');
  });

  it('cleans only the just-created spill if persisting its ownership fails', async () => {
    const store = domain.getStore();
    const record = store.recordEventAndTransitionState.bind(store);
    const spy = vi.spyOn(store, 'recordEventAndTransitionState').mockImplementation((event) => {
      if (event.type === 'ARTIFACT_CREATED') throw new Error('ownership journal unavailable');
      return record(event);
    });
    try {
      const result = await processOp('journal-failure');
      assert(result.kind === 'process');
      expect(result.stdoutSpillError).toContain('ownership journal unavailable');
      expect(result.stdoutRef).toBeUndefined();
      expect(fs.readdirSync(artifacts)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('encodes read-evidence IDs and reports collisions without replacing evidence', () => {
    const evidenceRoot = path.join(root, 'tracked');
    fs.mkdirSync(evidenceRoot);
    const tracker = new ReadTracker();
    const session = tracker.open('../reads', { roots: [evidenceRoot] });
    try {
      session.begin();
      const first = session.collect(artifacts);
      expect(first.ref).toBe(readEvidencePath(artifacts, '../reads'));
      expect(path.dirname(first.ref!)).toBe(artifacts);
      const before = fs.readFileSync(first.ref!);
      const second = session.collect(artifacts);
      expect(second).toMatchObject({ tracking: 'failed', error: expect.stringMatching(/EEXIST/) });
      expect(fs.readFileSync(first.ref!)).toEqual(before);
    } finally {
      session.close();
    }
  });

  it('does not follow a substituted read-evidence symlink', () => {
    const evidenceRoot = path.join(root, 'tracked');
    fs.mkdirSync(evidenceRoot);
    const session = new ReadTracker().open('evidence-link', { roots: [evidenceRoot] });
    try {
      session.begin();
      const evidence = session.collect(artifacts);
      const victim = path.join(root, 'evidence-victim');
      fs.renameSync(evidence.ref!, victim);
      fs.symlinkSync(victim, evidence.ref!);
      expect(evaluateReadEvidence(evidence)).toEqual({ status: 'unknown', reason: 'evidence_unreadable' });
      expect(session.collect(artifacts)).toMatchObject({ tracking: 'failed', error: expect.stringMatching(/EEXIST/) });
      expect(fs.lstatSync(evidence.ref!).isSymbolicLink()).toBe(true);
    } finally {
      session.close();
    }
  });

  it('does not reuse a legacy evidence path that escaped artifacts through its operation ID', () => {
    const evidenceRoot = path.join(root, 'tracked');
    fs.mkdirSync(evidenceRoot);
    const opId = '../legacy';
    const session = new ReadTracker().open(opId, { roots: [evidenceRoot] });
    try {
      session.begin();
      const evidence = session.collect(artifacts);
      const legacyRef = path.join(domain.domainPath, 'legacy-reads.json.gz');
      fs.renameSync(evidence.ref!, legacyRef);
      const store = domain.getStore();
      store.registerOperationIntent({
        id: opId, runId: 'run', kind: 'process', name: 'legacy', inputFingerprint: 'test', requiredResources: [], status: 'active',
      }, domain.domainId);
      store.recordOperationResult(opId, {
        kind: 'process', status: 'succeeded', exitCode: 0, signal: null, stdout: '', stderr: '',
        isTruncated: false, identityVerification: 'cannot_determine',
        durationMs: 0, completedAt: new Date().toISOString(), readEvidence: { ...evidence, ref: legacyRef },
      });
      expect(supervisor.evidenceStatus(opId)).toEqual({ status: 'unknown', reason: 'evidence_unreadable' });
      expect(fs.existsSync(legacyRef)).toBe(true);
    } finally {
      session.close();
    }
  });

  function repository(): string {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'ignored contents');
    return repo;
  }

  it('does not delete a pre-existing manifest when snapshot creation fails', async () => {
    const repo = repository();
    fs.mkdirSync(artifacts);
    const manifest = ignoredManifestPath(domain.domainPath, 'snapshot-collision');
    fs.writeFileSync(manifest, 'user data');
    await expect(supervisor.captureSnapshot({ runId: 'run', opId: 'snapshot-collision', roots: [repo], trackIgnored: 'manifest' }))
      .rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('user data');
    expect(domain.getStore().getOperation('snapshot-collision')?.result?.status).toBe('failed');
  });

  it('never writes or cleans up an outside manifest for a traversal snapshot ID', async () => {
    const repo = repository();
    const victim = path.join(domain.domainPath, 'snapshot-ignored.manifest');
    fs.writeFileSync(victim, 'user data');
    await expect(supervisor.captureSnapshot({ runId: 'run', opId: '../snapshot', roots: [repo], trackIgnored: 'manifest' }))
      .rejects.toThrow(); // Git rejects traversal in a ref name; manifest handling must still remain safe.
    expect(fs.readFileSync(victim, 'utf8')).toBe('user data');
    expect(fs.readdirSync(artifacts)).toEqual([]);
  });

  it('keeps nested snapshot IDs within artifacts through capture, retention and prune', async () => {
    const repo = repository();
    const result = await supervisor.captureSnapshot({ runId: 'run', opId: 'nested/snapshot', roots: [repo], trackIgnored: 'manifest' });
    const manifest = ignoredManifestPath(domain.domainPath, result.snapshot!.id);
    expect(path.dirname(manifest)).toBe(artifacts);
    expect(supervisor.pruneArtifacts().retained).toContain(manifest);
    expect(await supervisor.pruneSnapshots([result.snapshot!.id])).toEqual(['nested/snapshot']);
    expect(fs.existsSync(manifest)).toBe(false);
  });

  it('keeps a snapshot manifest when pruning runs while the driver is capturing', async () => {
    const repo = repository();
    const driver = supervisor.getSnapshotDriver();
    const capture = driver.capture.bind(driver);
    const manifest = ignoredManifestPath(domain.domainPath, 'capturing');
    const spy = vi.spyOn(driver, 'capture').mockImplementation(async (roots, options) => {
      expect(domain.getStore().getOperation('capturing')?.status).toBe('active');
      expect(supervisor.pruneArtifacts().retained).toContain(manifest);
      expect(fs.existsSync(manifest)).toBe(true);
      return capture(roots, options);
    });
    try {
      const result = await supervisor.captureSnapshot({ runId: 'run', opId: 'capturing', roots: [repo], trackIgnored: 'manifest' });
      expect(result.status).toBe('succeeded');
      expect(fs.existsSync(manifest)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves a committed snapshot and its manifest if releasing resources fails', async () => {
    const repo = repository();
    const spy = vi.spyOn(domain, 'internalReleaseResources').mockImplementation(() => { throw new Error('release unavailable'); });
    try {
      await expect(supervisor.captureSnapshot({ runId: 'run', opId: 'committed', roots: [repo], trackIgnored: 'manifest' }))
        .rejects.toThrow('release unavailable');
      const snapshot = domain.getStore().getSnapshot('committed');
      expect(snapshot?.ignoredManifestDigest).toBeTruthy();
      expect(domain.getStore().getOperation('committed')).toMatchObject({ status: 'done', result: { status: 'succeeded' } });
      expect(readIgnoredManifest(domain.domainPath, 'committed', snapshot!.ignoredManifestDigest!)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  function portableSnapshots(): SnapshotDriver {
    return {
      name: 'portable-test', coverage: 'worktree_non_ignored',
      capture: async (roots, options) => ({
        id: options!.id!, domainId: domain.domainId, opId: options!.opId!, driver: 'portable-test', roots,
        coverage: 'worktree_non_ignored', treeFingerprint: 'test', createdAt: new Date().toISOString(),
      }),
      fingerprint: async () => 'test', restore: async () => ({ unrestoredPaths: [] }),
      listIgnored: async (roots) => [path.join(roots[0], 'ignored.txt')],
      prune: vi.fn(async () => {}),
    };
  }

  it.each(['旧快照', 'snapshot with spaces'])('reads and safely prunes a digest-verified legacy manifest for %s', async (opId) => {
    const repo = repository();
    const driver = portableSnapshots();
    supervisor = new ProcessSupervisor(domain, undefined, driver);
    const result = await supervisor.captureSnapshot({ runId: 'run', opId, roots: [repo], trackIgnored: 'manifest' });
    const legacy = path.join(artifacts, `${opId}-ignored.manifest`);
    fs.renameSync(ignoredManifestPath(domain.domainPath, opId), legacy);
    expect(readIgnoredManifest(domain.domainPath, opId, result.snapshot!.ignoredManifestDigest!)).toHaveLength(1);
    expect(supervisor.pruneArtifacts().retained).toContain(legacy);
    expect(await supervisor.pruneSnapshots([opId])).toEqual([opId]);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(driver.prune).toHaveBeenCalledWith([opId], { repoRoot: undefined });
  });

  it('does not delete a legacy manifest whose content no longer matches the snapshot digest', async () => {
    const repo = repository();
    const driver = portableSnapshots();
    supervisor = new ProcessSupervisor(domain, undefined, driver);
    const opId = '旧 快照';
    const result = await supervisor.captureSnapshot({ runId: 'run', opId, roots: [repo], trackIgnored: 'manifest' });
    const legacy = path.join(artifacts, `${opId}-ignored.manifest`);
    fs.renameSync(ignoredManifestPath(domain.domainPath, opId), legacy);
    fs.writeFileSync(legacy, 'user replacement');
    expect(readIgnoredManifest(domain.domainPath, opId, result.snapshot!.ignoredManifestDigest!)).toBeNull();
    await expect(supervisor.pruneSnapshots([opId])).rejects.toThrow(/Ignored manifest changed/);
    expect(driver.prune).not.toHaveBeenCalled();
    expect(fs.readFileSync(legacy, 'utf8')).toBe('user replacement');
    expect(domain.getStore().getSnapshot(opId)).toBeTruthy();
  });

  it('refuses to prune a manifest replaced with a symlink', async () => {
    const repo = repository();
    const result = await supervisor.captureSnapshot({ runId: 'run', opId: 'snapshot-link', roots: [repo], trackIgnored: 'manifest' });
    const manifest = ignoredManifestPath(domain.domainPath, result.snapshot!.id);
    const victim = path.join(root, 'manifest-victim');
    fs.renameSync(manifest, victim);
    fs.symlinkSync(victim, manifest);
    await expect(supervisor.pruneSnapshots([result.snapshot!.id])).rejects.toThrow(/ELOOP/);
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.lstatSync(manifest).isSymbolicLink()).toBe(true);
    expect(domain.getStore().getSnapshot(result.snapshot!.id)).toBeTruthy();
  });

  it('encodes service IDs before spilling stderr', async () => {
    const victim = path.join(domain.domainPath, 'service#1.stderr.log');
    fs.writeFileSync(victim, 'user data');
    const handle = await supervisor.startService({
      serviceId: '../service', runId: 'run', artifactsDir: artifacts, maxStderrBytes: 100,
      command: { execPath: process.execPath, args: ['-e', 'process.stderr.write("s".repeat(300))'], cwd: root },
    });
    await handle.onInstanceExit;
    const result = domain.getStore().getOperation(handle.currentInstanceOpId)?.result;
    expect(result?.kind).toBe('process');
    if (result?.kind !== 'process') throw new Error('Expected process result');
    expect(path.dirname(result.stderrRef!)).toBe(artifacts);
    expect(fs.readFileSync(victim, 'utf8')).toBe('user data');
  });
});
