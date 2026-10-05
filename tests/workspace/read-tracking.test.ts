import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectReadSet, normalizeAccessTimes, probeReadTracking } from '../../src/workspace/read-tracking.js';

describe('access-time read tracking', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-atime-'));
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'read.txt'), 'read');
    fs.writeFileSync(path.join(root, 'unread.txt'), 'unread');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records files and directory listings even when atime equals mtime', () => {
    normalizeAccessTimes(root);
    // Deterministically reproduce a read within the filesystem timestamp tick.
    for (const entry of ['read.txt', 'dir']) {
      const file = path.join(root, entry);
      const mtime = fs.statSync(file).mtimeMs / 1000;
      fs.utimesSync(file, mtime, mtime);
    }
    expect(collectReadSet(root)).toEqual(['dir/', 'read.txt']);
  });

  it('does not classify normalized entries or a stat-only access as reads', () => {
    normalizeAccessTimes(root);
    fs.statSync(path.join(root, 'unread.txt'));
    expect(collectReadSet(root)).toEqual([]);
  });

  it('skips git metadata and does not change symlink targets', () => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git/index'), 'index');
    fs.symlinkSync('.git/index', path.join(root, 'link'));
    const before = fs.statSync(path.join(root, '.git/index'), { bigint: true });
    normalizeAccessTimes(root);
    expect(fs.statSync(path.join(root, '.git/index'), { bigint: true }).atimeNs).toBe(before.atimeNs);
    expect(collectReadSet(root)).toEqual([]);
  });

  it.each(['equal', 'unchanged'] as const)('probes actual atime advancement when the read timestamp is %s', (mode) => {
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (typeof file === 'number') throw new Error('Expected an atime probe path, not a file descriptor');
      const before = fs.statSync(file);
      const value = readFileSync(file, options);
      const mtime = before.mtimeMs / 1000;
      fs.utimesSync(file, mode === 'equal' ? mtime : before.atimeMs / 1000, mtime);
      return value;
    });
    expect(probeReadTracking(root)).toBe(mode === 'equal' ? 'atime' : 'unobserved');
    expect(fs.readdirSync(root).some((name) => name.startsWith('.xioflow-atime-probe-'))).toBe(false);
  });
});
