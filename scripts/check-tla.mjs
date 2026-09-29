#!/usr/bin/env node
/**
 * Model-checks every spec/tla/<Module>_<variant>.cfg with TLC.
 *
 *   node scripts/check-tla.mjs
 *
 * Needs `java` on PATH. The TLA+ tools jar is pinned to a stable release and its
 * sha256 is verified; TLA2TOOLS_JAR points at an existing copy instead of
 * downloading. Fails unless TLC reports "No error has been found" for every model.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TLA_VERSION = 'v1.7.4';
const TLA_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specDir = path.join(repoRoot, 'spec/tla');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function resolveJar() {
  if (process.env.TLA2TOOLS_JAR) return process.env.TLA2TOOLS_JAR;
  const jar = path.join(os.homedir(), '.cache/xioflow', `tla2tools-${TLA_VERSION}.jar`);
  if (!fs.existsSync(jar)) {
    fs.mkdirSync(path.dirname(jar), { recursive: true });
    const url = `https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar`;
    console.error(`downloading ${url}`);
    execFileSync('curl', ['-fsSL', '-o', `${jar}.tmp`, url], { stdio: 'inherit' });
    fs.renameSync(`${jar}.tmp`, jar);
  }
  const actual = sha256(jar);
  if (actual !== TLA_SHA256) {
    throw new Error(`${jar} has sha256 ${actual}, expected ${TLA_SHA256} (TLA+ tools ${TLA_VERSION})`);
  }
  return jar;
}

const jar = resolveJar();
const configs = fs.readdirSync(specDir).filter((f) => f.endsWith('.cfg')).sort();
if (configs.length === 0) throw new Error(`no TLC configs in ${specDir}`);

let failed = 0;
for (const cfg of configs) {
  const module = cfg.replace(/_[^_]+\.cfg$/, '').replace(/\.cfg$/, '');
  const metadir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-tlc-'));
  const run = spawnSync(
    'java',
    ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-config', cfg, '-workers', 'auto', '-cleanup', '-metadir', metadir, `${module}.tla`],
    { cwd: specDir, encoding: 'utf8' }
  );
  fs.rmSync(metadir, { recursive: true, force: true });
  const out = `${run.stdout}${run.stderr}`;
  const states = /(\d+) distinct states found/.exec(out)?.[1] ?? '?';
  if (run.status === 0 && out.includes('No error has been found')) {
    console.log(`PASS ${cfg}: ${states} distinct states`);
  } else {
    failed += 1;
    console.log(`FAIL ${cfg} (exit ${run.status})\n${out}`);
  }
}
for (const trace of fs.readdirSync(specDir).filter((f) => f.includes('_TTrace_'))) {
  fs.rmSync(path.join(specDir, trace));
}
process.exit(failed === 0 ? 0 : 1);
