import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openWorldState, type FileCoverage } from '../../src/world/state.js';
import { SqliteStore } from '../../src/store/sqlite.js';

const exec = promisify(execFile);
describe('persistent world state', () => {
  let temp: string;
  let root: string;
  let statePath: string;
  const handles: Awaited<ReturnType<typeof openWorldState>>[] = [];
  let coverage: FileCoverage;
  const adapter = () => ({ id: 'files', version: '1', declareCoverage: async () => coverage });
  const open = async (overrides = {}) => {
    const handle = await openWorldState({ root, statePath, adapter: adapter(), ...overrides });
    handles.push(handle);
    return handle;
  };
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xio-world-state-'));
    root = path.join(temp, 'repo');
    statePath = path.join(temp, 'state');
    await fs.mkdir(root);
    await exec('git', ['init', '-b', 'main'], { cwd: root });
    await fs.writeFile(path.join(root, 'input.txt'), 'original');
    coverage = { paths: ['input.txt', 'absent.txt'], excluded: ['cache'], symlinks: 'reject',
      externalReads: 'unsupported', externalWrites: 'unsupported' };
  });
  afterEach(async () => {
    for (const handle of handles.splice(0)) if (!handle.domain.isClosed()) handle.close();
    await fs.rm(temp, { recursive: true, force: true });
  });

  it('reopens the same frozen identity and journal cutoff despite current file changes', async () => {
    const first = await open();
    const state = first.state;
    const events = first.domain.getStore().getJournalEvents('world');
    first.close();
    await fs.writeFile(path.join(root, 'input.txt'), 'changed');
    await fs.writeFile(path.join(root, 'absent.txt'), 'new');
    coverage = { ...coverage, paths: [...coverage.paths].reverse() };
    const reopened = await open();
    expect(reopened.state).toEqual(state);
    expect(reopened.domain.getStore().getJournalEvents('world')).toEqual(events);
    const snapshot = reopened.domain.getStore().getSnapshot(state.snapshotId)!;
    expect((await exec('git', ['show', `${snapshot.commitHash}:input.txt`], { cwd: root })).stdout).toBe('original');
    expect(await fs.readFile(path.join(root, 'input.txt'), 'utf8')).toBe('changed');
    expect(Object.isFrozen(reopened.state.coverage.paths)).toBe(true);
  });

  it('rejects a second writer and releases the lease on failed reopen', async () => {
    const first = await open();
    await expect(open()).rejects.toThrow();
    first.close();
    await expect(open({ adapter: { ...adapter(), version: '2' } })).rejects.toThrow('mismatch');
    expect((await open()).state.worldId).toBe(first.state.worldId);
  });

  it.each(['metadata', 'ref', 'changed-ref'])('rejects %s baseline damage without recapturing', async damage => {
    const first = await open();
    const state = first.state;
    first.close();
    const store = new SqliteStore(path.join(statePath, 'domain.db'));
    const events = store.getJournalEvents('world');
    if (damage === 'metadata') store.deleteSnapshot(state.snapshotId);
    store.close();
    if (damage === 'ref') await exec('git', ['update-ref', '-d', `refs/xioflow/snapshots/${state.snapshotId}`], { cwd: root });
    if (damage === 'changed-ref') {
      await fs.writeFile(path.join(root, 'input.txt'), 'tampered');
      await exec('git', ['add', '.'], { cwd: root });
      await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'other'], { cwd: root });
      await exec('git', ['update-ref', `refs/xioflow/snapshots/${state.snapshotId}`, 'HEAD'], { cwd: root });
    }
    await expect(open()).rejects.toThrow();
    const after = new SqliteStore(path.join(statePath, 'domain.db'));
    expect(after.getJournalEvents('world')).toEqual(events);
    after.close();
  });

  it.each(['../outside', '/absolute', 'a//b', 'a/./b', '.git/config', 'a\\b', 'input.txt'])('rejects ambiguous path %s', async invalid => {
    coverage = { ...coverage, paths: ['input.txt', invalid] };
    await expect(open()).rejects.toThrow(/coverage path/i);
  });

  it('rejects changed coverage, exclusions, and a different root', async () => {
    const first = await open();
    first.close();
    coverage = { ...coverage, excluded: ['other'] };
    await expect(open()).rejects.toThrow('mismatch');
    coverage = { ...coverage, excluded: ['cache'], paths: ['input.txt'] };
    await expect(open()).rejects.toThrow('mismatch');
    const other = path.join(temp, 'other');
    await fs.mkdir(other);
    await exec('git', ['init'], { cwd: other });
    await expect(open({ root: other })).rejects.toThrow('mismatch');
  });

  it('rejects symlink ancestors even for absent declared files', async () => {
    await fs.symlink(temp, path.join(root, 'link'));
    coverage = { ...coverage, paths: ['link/missing'] };
    await expect(open()).rejects.toThrow('symlink');
  });

  it('rejects directories and overlapping exclusions', async () => {
    await fs.mkdir(path.join(root, 'directory'));
    coverage = { ...coverage, paths: ['directory'] };
    await expect(open()).rejects.toThrow('regular files');
    coverage = { ...coverage, paths: ['cache/data'] };
    await expect(open()).rejects.toThrow('Overlapping');
  });

  it('does not silently cover ignored files or replace incomplete initialization', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), 'input.txt\n');
    await expect(open()).rejects.toThrow('absent from snapshot');
    await expect(open()).rejects.toThrow('initialization incomplete');
    expect(await fs.readFile(path.join(root, 'input.txt'), 'utf8')).toBe('original');
  });

  it('rejects metadata inside the worktree including through a parent symlink', async () => {
    await fs.symlink(root, path.join(temp, 'alias'));
    await expect(open({ statePath: path.join(temp, 'alias', 'state') })).rejects.toThrow('outside');
    await expect(fs.stat(path.join(root, 'state'))).rejects.toThrow();
  });
});
