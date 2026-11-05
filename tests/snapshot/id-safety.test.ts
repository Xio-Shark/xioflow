import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitShadowSnapshotDriver } from '../../src/snapshot/git-shadow.js';

describe('snapshot IDs are opaque Git ref keys', () => {
  let root: string;
  let repo: string;
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-snapshot-id-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'snapshot bytes\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each(['op:program.snapshot', '../../heads/main', 'with whitespace', 'with\nnewline', 'snap..invalid', 'snap.lock'])(
    'captures, materializes and prunes %j without treating it as a ref path', async (id) => {
      const driver = new GitShadowSnapshotDriver();
      const head = git(['rev-parse', 'HEAD']);
      const snapshot = await driver.capture([repo], { id });
      expect(snapshot.id).toBe(id);
      const refs = git(['for-each-ref', '--format=%(refname)', 'refs/xioflow/encoded-snapshots']).split('\n');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatch(/^refs\/xioflow\/encoded-snapshots\/[a-f0-9]{64}$/u);
      const reopened = new GitShadowSnapshotDriver();
      const fork = path.join(root, 'fork');
      await reopened.materialize(id, fork, { repoRoot: repo });
      expect(fs.readFileSync(path.join(fork, 'file.txt'), 'utf8')).toBe('snapshot bytes\n');
      await reopened.dematerialize(fork);
      await reopened.prune([id], { repoRoot: repo });
      expect(git(['for-each-ref', 'refs/xioflow/encoded-snapshots'])).toBe('');
      expect(git(['rev-parse', 'HEAD'])).toBe(head);
    },
  );

  it('preserves the ref path for existing ordinary snapshot IDs', async () => {
    const driver = new GitShadowSnapshotDriver();
    await driver.capture([repo], { id: 'legacy-snapshot_1.0' });
    expect(git(['show-ref', '--verify', 'refs/xioflow/snapshots/legacy-snapshot_1.0'])).not.toBe('');
    await driver.prune(['legacy-snapshot_1.0']);
    expect(git(['for-each-ref', 'refs/xioflow/snapshots'])).toBe('');
  });
});
