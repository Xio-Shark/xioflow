import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionDomain } from '../domain.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';

const exec = promisify(execFile);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface FileCoverage {
  readonly paths: readonly string[];
  readonly excluded: readonly string[];
  readonly symlinks: 'reject';
  readonly externalReads: 'unsupported';
  readonly externalWrites: 'unsupported';
}

interface WorldStateRecord {
  schemaVersion: 1;
  worldId: string;
  root: string;
  adapter: { id: string; version: string };
  coverage: FileCoverage;
  manifestHash: string;
  snapshotId: string;
  fingerprint: string;
}

function normalizeCoverage(coverage: FileCoverage): FileCoverage {
  if (coverage.symlinks !== 'reject' || coverage.externalReads !== 'unsupported'
      || coverage.externalWrites !== 'unsupported') throw new Error('Unsupported world coverage semantics');
  const normalize = (paths: readonly string[]) => {
    if (!Array.isArray(paths)) throw new Error('Coverage paths must be arrays');
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.includes('\\') || p.includes('\0')
          || path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)
          || p.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
        throw new Error(`Invalid coverage path: ${p}`);
      }
    }
    if (new Set(paths).size !== paths.length) throw new Error('Duplicate coverage path');
    return [...paths].sort();
  };
  const paths = normalize(coverage.paths);
  const excluded = normalize(coverage.excluded);
  if (paths.some(p => excluded.some(e => p === e || p.startsWith(`${e}/`) || e.startsWith(`${p}/`)))) {
    throw new Error('Overlapping coverage and exclusions');
  }
  return { paths, excluded, symlinks: 'reject', externalReads: 'unsupported', externalWrites: 'unsupported' };
}

async function canonicalDestination(p: string): Promise<string> {
  try { return await fs.realpath(p); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(p);
    if (parent === p) throw error;
    return path.join(await canonicalDestination(parent), path.basename(p));
  }
}

async function git(root: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, timeout: 15000, maxBuffer: 50 * 1024 * 1024 })).stdout;
}

async function checkBaseline(root: string, snapshotId: string, fingerprint: string, coverage: FileCoverage,
  commitHash: string | undefined) {
  // Materialize uses the private ref, while restore uses the saved commit. Both must
  // identify the same immutable object, even if another commit has the same tree.
  const ref = `refs/xioflow/snapshots/${snapshotId}`;
  const commit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  if (commit !== commitHash) throw new Error('World baseline commit identity mismatch');
  const tree = (await git(root, ['rev-parse', '--verify', `${commit}^{tree}`])).trim();
  if (tree !== fingerprint) throw new Error('World baseline fingerprint mismatch');
  // Reading the complete tree also detects missing tree objects. Blob existence is checked below.
  const entries = new Map<string, { mode: string; object: string }>();
  for (const entry of (await git(root, ['ls-tree', '-r', '-t', '-z', tree])).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, , object] = entry.slice(0, tab).split(' ');
    entries.set(entry.slice(tab + 1), { mode, object });
  }
  for (const p of coverage.paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = entries.get(parts.slice(0, i).join('/'));
      if (ancestor && ancestor.mode !== '040000') throw new Error(`Invalid baseline ancestor: ${p}`);
    }
    const entry = entries.get(p);
    if (entry && entry.mode !== '100644' && entry.mode !== '100755') {
      throw new Error(`Coverage requires an exact regular file path: ${p}`);
    }
    if (entry) await git(root, ['cat-file', '-e', `${entry.object}^{blob}`]);
  }
  return entries;
}

/** Internal openWorld foundation; deliberately not exported from the package until the handle is complete. */
export async function openWorldState(options: {
  root: string;
  statePath: string;
  adapter: { readonly id: string; readonly version: string; declareCoverage(root: string): Promise<FileCoverage> };
}) {
  const root = await fs.realpath(options.root);
  const statePath = await canonicalDestination(path.resolve(options.statePath));
  if (statePath === root || statePath.startsWith(root + path.sep)) {
    throw new Error('World statePath must be outside the worktree');
  }
  const driver = new GitShadowSnapshotDriver();
  if ((await driver.assertGitRepo(root)).repoRoot !== root) throw new Error('World root must be the Git worktree root');
  const adapter = { id: options.adapter.id, version: options.adapter.version };
  if (!adapter.id || !adapter.version) throw new Error('Adapter identity and version are required');
  const domain = ExecutionDomain.acquire(statePath, 'world');
  try {
    const coverage = normalizeCoverage(await options.adapter.declareCoverage(root));
    const manifestHash = hash({ adapter, coverage });
    const store = domain.getStore();
    const events = store.getJournalEvents(domain.domainId);
    const created = events.filter(event => event.type === 'WORLD_CREATED');
    if (created.length > 1) throw new Error('Ambiguous world identity');
    let record: WorldStateRecord;
    let atSeq: number;
    if (created.length) {
      const event = created[0];
      record = event.payload as unknown as WorldStateRecord;
      atSeq = event.seq;
      if (record.schemaVersion !== 1 || record.root !== root || record.manifestHash !== manifestHash
          || hash({ adapter: record.adapter, coverage: record.coverage }) !== manifestHash) {
        throw new Error('World root, adapter or coverage mismatch');
      }
      const snapshot = store.getSnapshot(record.snapshotId);
      if (!snapshot || snapshot.domainId !== domain.domainId || snapshot.driver !== driver.name
          || snapshot.opId !== record.worldId || snapshot.coverage !== 'worktree_non_ignored'
          || snapshot.treeFingerprint !== record.fingerprint || snapshot.roots.length !== 1
          || snapshot.roots[0] !== root) throw new Error('World baseline metadata missing or inconsistent');
      await checkBaseline(root, record.snapshotId, record.fingerprint, coverage, snapshot.commitHash);
    } else {
      if (events.length) throw new Error('World initialization incomplete; retained evidence requires recovery');
      const worldId = randomUUID();
      const snapshotId = `world-${worldId}-base`;
      const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
        domainId: domain.domainId, type, payload, timestamp: new Date().toISOString(),
      });
      // An interrupted capture must never silently allocate a different world on reopen.
      append('WORLD_INITIALIZING', { worldId, snapshotId, root, adapter, coverage, manifestHash });
      const snapshot = await captureCoveredSnapshot(root, coverage, snapshotId, domain.domainId, worldId);
      record = { schemaVersion: 1, worldId, root, adapter, coverage, manifestHash,
        snapshotId, fingerprint: snapshot.treeFingerprint };
      atSeq = store.transaction(() => {
        store.recordSnapshot(snapshot);
        return append('WORLD_CREATED', { ...record });
      });
    }
    // Keep caller mutation from changing the persisted version represented by this handle.
    Object.freeze(record.coverage.paths);
    Object.freeze(record.coverage.excluded);
    Object.freeze(record.coverage);
    Object.freeze(record.adapter);
    return { domain, state: Object.freeze({ ...record, atSeq }), close: () => domain.close() };
  } catch (error) {
    domain.close();
    throw error;
  }
}

async function captureCoveredSnapshot(root: string, coverage: FileCoverage, snapshotId: string,
  domainId: string, worldId: string) {
  const driver = new GitShadowSnapshotDriver();
  // Inspect ancestors without following symlinks, including for declared absent paths.
  for (const p of coverage.paths) {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      try {
        const stat = await fs.lstat(path.join(root, ...parts.slice(0, i)));
        if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) {
          throw new Error(`Coverage requires regular files without symlink ancestors: ${p}`);
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        break;
      }
    }
  }
  const snapshot = await driver.capture([root], { id: snapshotId, domainId, opId: worldId });
  const entries = await checkBaseline(root, snapshotId, snapshot.treeFingerprint, coverage, snapshot.commitHash);
  for (const p of coverage.paths) {
    if (!entries.has(p)) {
      try { await fs.lstat(path.join(root, p)); }
      catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`Declared file is absent from snapshot coverage: ${p}`);
    }
  }
  return snapshot;
}

/** Capture a fresh bounded version without replacing the handle's original baseline. */
export async function captureWorldRevision(world: Awaited<ReturnType<typeof openWorldState>>) {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  const snapshotId = `world-${state.worldId}-${randomUUID()}`;
  const store = domain.getStore();
  const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
    domainId: domain.domainId, type, payload: { worldId: state.worldId, snapshotId, ...payload },
    timestamp: new Date().toISOString(),
  });
  append('WORLD_VERSION_STARTED', {});
  try {
    const snapshot = await captureCoveredSnapshot(state.root, state.coverage, snapshotId, domain.domainId, state.worldId);
    const record = { ...state, snapshotId, fingerprint: snapshot.treeFingerprint };
    const atSeq = store.transaction(() => {
      store.recordSnapshot(snapshot);
      return append('WORLD_VERSION_CREATED', { ...record });
    });
    return { ...world, state: Object.freeze({ ...record, atSeq }) };
  } catch (error) {
    append('WORLD_VERSION_FAILED', { reason: error instanceof Error ? error.message : String(error), resources: 'retained' });
    throw error;
  }
}
