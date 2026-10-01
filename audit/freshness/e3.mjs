#!/usr/bin/env node
// E3: what recording evidence costs.
//   1. synthetic trees of 2,000 / 20,000 / 100,000 files: full reset, one-pass reset, collecting the read set
//   2. a real repository (a copy, so the original's timestamps are not touched): overhead of one verification
//      command as a share of the command's own time
//   3. does a read advance atime when atime == mtime? (the two observations on record disagree)
// Usage: node audit/freshness/e3.mjs [--repo <dir> --command "npm run check"]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectReads, normalizeAll, normalizeOnePass, runWithEvidence } from './evidence.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-fresh-e3-')));
const time = (fn) => { const t = performance.now(); const value = fn(); return [performance.now() - t, value]; };
const ms = (n) => `${n.toFixed(0)} ms`;

try {
  console.log('1. synthetic trees (each file 1 byte; "after reading 1%" = the state a second command finds)');
  for (const count of [2_000, 20_000, 100_000]) {
    const root = path.join(tmp, `tree-${count}`);
    for (let i = 0; i < count; i++) {
      const dir = path.join(root, `d${i % 200}`, `s${i % 7}`);
      if (i < 1400) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    }
    const [fullCold] = time(() => normalizeAll(root));
    const [collectEmpty, none] = time(() => collectReads(root));
    // Read 1% of the files, as a command would.
    for (let i = 0; i < count; i += 100) fs.readFileSync(path.join(root, `d${i % 200}`, `s${i % 7}`, `f${i}.txt`));
    const [collect, reads] = time(() => collectReads(root));
    const [onePass, touched] = time(() => normalizeOnePass(root));
    for (let i = 0; i < count; i += 100) fs.readFileSync(path.join(root, `d${i % 200}`, `s${i % 7}`, `f${i}.txt`));
    const [fullWarm] = time(() => normalizeAll(root));
    const files = reads.filter((r) => !r.endsWith('/')).length;
    console.log(`  ${String(count).padStart(7)} files: full reset ${ms(fullCold)} (again after reading 1%: ${ms(fullWarm)}) | one-pass reset after reading 1%: ${ms(onePass)} (touched ${touched}) | collect ${ms(collect)} (${files} files read; ${none.filter((r) => !r.endsWith('/')).length} before any read)`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const repo = arg('repo');
  if (repo) {
    const command = (arg('command') ?? 'npm run check').split(' ');
    const copy = path.join(tmp, 'repo');
    // APFS clone: no data is copied, and the original keeps its timestamps.
    const cp = spawnSync('cp', ['-Rc', repo, copy]);
    if (cp.status !== 0) throw new Error(`cp failed: ${cp.stderr}`);
    const entries = Number(spawnSync('sh', ['-c', `find ${JSON.stringify(copy)} -type f | wc -l`], { encoding: 'utf8' }).stdout.trim());
    console.log(`\n2. real repository: ${path.basename(repo)} (${entries} files including node_modules), command: ${command.join(' ')}`);
    for (const normalize of ['all', 'one-pass', 'one-pass']) {
      const run = runWithEvidence(copy, command, { normalize });
      const o = run.overheadMs;
      console.log(`  reset=${normalize.padEnd(8)} exit ${run.exitCode} | command ${ms(run.commandMs)} | reset ${ms(o.normalize)} + collect ${ms(o.collect)} + hash ${ms(o.hash)} = ${ms(o.total)} (${(100 * o.total / run.commandMs).toFixed(1)}% of the command) | read set ${Object.keys(run.evidence.entries).length} entries`);
    }
  }

  console.log('\n3. does a read advance atime when atime == mtime?');
  const probe = path.join(tmp, 'probe.txt');
  fs.writeFileSync(probe, 'probe');
  const created = fs.statSync(probe, { bigint: true });
  console.log(`  new file: atime - mtime = ${created.atimeNs - created.mtimeNs} ns`);
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(probe, stamp, stamp);
  const equal = fs.statSync(probe, { bigint: true });
  fs.readFileSync(probe);
  const afterRead = fs.statSync(probe, { bigint: true });
  console.log(`  ${os.platform()} ${os.release()}: set atime == mtime (${equal.atimeNs === equal.mtimeNs}); after a read, atime advanced: ${afterRead.atimeNs > equal.atimeNs}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
