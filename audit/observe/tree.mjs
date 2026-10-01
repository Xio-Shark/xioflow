// Workspace state from outside: a git tree id over tracked + untracked files (the user's index is not touched),
// plus the list of ignored files with their sizes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function treeFingerprint(work) {
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-audit-index-')), 'index');
  try {
    const env = { GIT_INDEX_FILE: index };
    git(work, ['read-tree', 'HEAD'], env);
    git(work, ['add', '-A'], env);
    const tree = git(work, ['write-tree'], env).trim();
    const files = git(work, ['ls-files', '-z'], env).split('\0').filter(Boolean);
    return { tree, files };
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }
}

export function ignoredFiles(work) {
  return git(work, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']).split('\0').filter(Boolean)
    .map((rel) => ({ path: rel, bytes: fs.statSync(path.join(work, rel)).size }));
}
