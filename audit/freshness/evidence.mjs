// Evidence with observed dependencies: run a verification command, record which files under `root` it read
// (from access times, no privileges) together with their content hashes, and later say whether that evidence
// still describes the tree: fresh (nothing it read has changed), stale (lists what changed), or unknown.
//
// What the read set covers is `content_reads`: file contents that were read and directories that were listed.
// A file that was only stat'ed, a dependency outside `root`, and anything a long-running helper process read on
// the command's behalf are not in it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SKIP_TOP = new Set(['.git']);
const ATIME_MARGIN_S = 2;
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function walk(dir, visit, rel = '') {
  visit(dir, rel, fs.lstatSync(dir));
  for (const name of fs.readdirSync(dir)) {
    if (!rel && SKIP_TOP.has(name)) continue;
    const abs = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) walk(abs, visit, childRel);
    else visit(abs, childRel, st);
  }
}
const reset = (abs, st) => fs.utimesSync(abs, st.mtimeMs / 1000 - ATIME_MARGIN_S, st.mtimeMs / 1000);

/** Full reset: every entry's atime is moved before its mtime (what the kernel's transactions do today). */
export function normalizeAll(root) {
  const dirs = [];
  let touched = 0;
  walk(root, (abs, _rel, st) => {
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) dirs.push([abs, st]);
    else { reset(abs, st); touched++; }
  });
  for (const [abs, st] of dirs.reverse()) { reset(abs, st); touched++; }
  return touched;
}

/**
 * One-pass reset: only entries whose atime is not already before their mtime are touched (the ones read since
 * the last reset, and new files whose two times are equal). Entries with atime == mtime are reset too, so the
 * result does not depend on whether the filesystem advances atime in that case.
 */
export function normalizeOnePass(root) {
  const dirs = [];
  let touched = 0;
  walk(root, (abs, _rel, st) => {
    if (st.isSymbolicLink()) return;
    // Every directory is reset: this walk lists it, which is a read.
    if (st.isDirectory()) dirs.push([abs, st]);
    else if (st.atimeMs >= st.mtimeMs) { reset(abs, st); touched++; }
  });
  for (const [abs, st] of dirs.reverse()) { reset(abs, st); touched++; }
  return touched;
}

/** Entries read since the last reset: files as `a/b.txt`, listed directories as `a/` (root: `./`). */
export function collectReads(root) {
  const reads = [];
  walk(root, (_abs, rel, st) => {
    if (st.isSymbolicLink()) return;
    if (st.atimeMs > st.mtimeMs) reads.push(st.isDirectory() ? `${rel || '.'}/` : rel);
  });
  return reads.sort();
}

function fingerprint(root, entry) {
  const abs = path.join(root, entry);
  try {
    if (entry.endsWith('/')) return sha(fs.readdirSync(abs).filter((name) => !(entry === './' && SKIP_TOP.has(name))).sort().join('\n'));
    return sha(fs.readFileSync(abs));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

/**
 * Runs `argv` in `root` and returns its result with the evidence of what it read.
 * `normalize` picks the reset strategy ('one-pass' by default).
 */
export function runWithEvidence(root, argv, { env = process.env, normalize = 'one-pass', timeoutMs = 600_000 } = {}) {
  const t0 = performance.now();
  (normalize === 'all' ? normalizeAll : normalizeOnePass)(root);
  const t1 = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const t2 = performance.now();
  const reads = collectReads(root);
  const t3 = performance.now();
  const entries = Object.fromEntries(reads.map((entry) => [entry, fingerprint(root, entry)]));
  const t4 = performance.now();
  return {
    exitCode: result.status, stdout: result.stdout, stderr: result.stderr,
    commandMs: t2 - t1,
    overheadMs: { normalize: t1 - t0, collect: t3 - t2, hash: t4 - t3, total: (t1 - t0) + (t4 - t2) },
    evidence: { tracking: 'atime', scope: 'content_reads', entries, digest: sha(JSON.stringify(entries)) },
  };
}

/** fresh: every file the command read has the same content and every directory it listed has the same entries. */
export function evidenceStatus(root, evidence) {
  if (!evidence || evidence.tracking !== 'atime') return { status: 'unknown', reason: 'reads were not observed' };
  const changed = Object.entries(evidence.entries).filter(([entry, hash]) => fingerprint(root, entry) !== hash).map(([entry]) => entry);
  return changed.length > 0 ? { status: 'stale', changed } : { status: 'fresh' };
}
