#!/usr/bin/env node
// E2: which test files have to be re-run after a change? Observed-read evidence against pytest-testmon.
// For every mutation the truth comes from execution: the test files that pass before and fail after.
//   recall    = flipped test files that the selector marks / all flipped test files
//   precision = flipped test files that the selector marks / all test files it marks
// Two evidence configurations: Python's bytecode cache as it is by default (warm), and with the cache out of
// the way (PYTHONPYCACHEPREFIX pointing at an empty directory), so the interpreter reads sources.
// Usage: node audit/freshness/e2.mjs --python <venv>/bin/python --libs <dir with clones> [--only tomli,idna]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runWithEvidence } from './evidence.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const python = arg('python');
const libsDir = arg('libs');
const only = arg('only')?.split(',');
const outDir = path.resolve(arg('out', path.join(import.meta.dirname, '../results/freshness', new Date().toISOString().slice(0, 10), 'e2')));
const SOURCE_MUTATIONS = Number(arg('source', '30'));
const DATA_MUTATIONS = Number(arg('data', '10'));
fs.mkdirSync(outDir, { recursive: true });

// Pinned clones (tag in parentheses is what was checked out; the commit is recorded in the result).
const LIBS = {
  tomli: { pythonPath: 'src', source: 'src/tomli', tests: 'tests' },
  toolz: { pythonPath: '.', source: 'toolz', tests: 'toolz', sourceExclude: /\/tests\// },
  idna: { pythonPath: '.', source: 'idna', tests: 'tests' },
  'markdown-it-py': { pythonPath: '.', source: 'markdown_it', tests: 'tests' },
  pyflakes: { pythonPath: '.', source: 'pyflakes', tests: 'pyflakes/test', sourceExclude: /\/test\// },
  packaging: { pythonPath: 'src', source: 'src/packaging', tests: 'tests' },
};

function rng(seed) { // mulberry32: the same mutations on every run
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (list, random) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const OPERATORS = [
  [/ == /, ' != '], [/ != /, ' == '], [/ < /, ' >= '], [/ > /, ' <= '], [/ \+ /, ' - '], [/ and /, ' or '], [/ or /, ' and '],
  [/\bTrue\b/, 'False'], [/\bFalse\b/, 'True'], [/\bnot /, ''], [/^(\s*)return (?!None\b).+$/, '$1return None'],
];
function sourceMutations(root, lib, random) {
  const files = spawnSync('git', ['ls-files', `${lib.source}/*.py`, `${lib.source}/**/*.py`], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .filter((f, i, all) => all.indexOf(f) === i && !(lib.sourceExclude?.test(`/${f}`)) && !/(^|\/)(test_|conftest)/.test(f));
  const candidates = [];
  for (const file of files) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('"""') || trimmed.startsWith("'")) return;
      for (const [pattern, replacement] of OPERATORS) {
        if (pattern.test(line)) candidates.push({ kind: 'source', file, line: index, mutated: line.replace(pattern, replacement) });
      }
    });
  }
  return shuffle(candidates, random);
}
function dataMutations(root, lib, random) {
  const files = spawnSync('git', ['ls-files', lib.tests, lib.source], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .filter((f) => !/\.(py|pyc|pyi)$/.test(f) && !/(^|\/)(\.git|__pycache__)/.test(f) && fs.statSync(path.join(root, f)).size > 0);
  return shuffle(files, random).map((file) => ({ kind: 'data', file }));
}

function applyMutation(root, mutation) {
  const abs = path.join(root, mutation.file);
  const original = fs.readFileSync(abs);
  if (mutation.kind === 'source') {
    const lines = original.toString('utf8').split('\n');
    lines[mutation.line] = mutation.mutated;
    fs.writeFileSync(abs, lines.join('\n'));
  } else {
    // Change the content without changing what kind of file it is: drop the last third.
    fs.writeFileSync(abs, original.subarray(0, Math.max(1, Math.floor(original.length * 2 / 3))));
  }
  return () => fs.writeFileSync(abs, original);
}

const failedFiles = (output) => new Set([...output.matchAll(/^(?:FAILED|ERROR) ([^\s:]+\.py)/gm)].map((m) => m[1]));

for (const [name, lib] of Object.entries(LIBS)) {
  if (only && !only.includes(name)) continue;
  const resultFile = path.join(outDir, `${name}.json`);
  if (fs.existsSync(resultFile)) { console.log(`${name}: already recorded, skipped`); continue; }
  const source = path.join(libsDir, name);
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xf-fresh-e2-${name}-`)));
  const root = path.join(scratch, 'repo');
  fs.cpSync(source, root, { recursive: true });
  const emptyCache = path.join(scratch, 'pycache-prefix');
  fs.mkdirSync(emptyCache);
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const baseEnv = { PATH: process.env.PATH, HOME: scratch, LANG: 'en_US.UTF-8', PYTHONPATH: path.join(root, lib.pythonPath), PYTHONHASHSEED: '0' };
  const noCacheEnv = { ...baseEnv, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: emptyCache };
  let suiteTimeoutMs = 900_000;
  const pytest = (args, env) => spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: suiteTimeoutMs, killSignal: 'SIGKILL' });
  const started = Date.now();
  try {
    const collected = pytest(['--collect-only', lib.tests], noCacheEnv).stdout;
    const testFiles = [...new Set([...collected.matchAll(/^([^\s:]+\.py)::/gm)].map((m) => m[1]))].sort();
    const baselineStarted = Date.now();
    const baselineRun = pytest(['--tb=no', '-rfE', lib.tests], noCacheEnv);
    // A mutant can loop forever; one that runs far longer than the unmodified suite is dropped and counted.
    suiteTimeoutMs = Math.max(60_000, 20 * (Date.now() - baselineStarted));
    const failingAtBaseline = failedFiles(baselineRun.stdout);
    const usable = testFiles.filter((f) => !failingAtBaseline.has(f));
    console.log(`${name}@${commit}: ${testFiles.length} test files (${failingAtBaseline.size} already failing, left out), baseline suite: ${baselineRun.stdout.trim().split('\n').pop()}`);

    // Evidence per test file, in both configurations.
    const readSets = { warm: {}, nocache: {} };
    const overhead = [];
    for (const file of usable) {
      const argv = [python, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', file];
      const nocache = runWithEvidence(root, argv, { env: noCacheEnv });
      readSets.nocache[file] = new Set(Object.keys(nocache.evidence.entries));
      overhead.push({ commandMs: nocache.commandMs, overheadMs: nocache.overheadMs.total });
      runWithEvidence(root, argv, { env: baseEnv }); // writes __pycache__
      readSets.warm[file] = new Set(Object.keys(runWithEvidence(root, argv, { env: baseEnv }).evidence.entries));
    }

    // testmon's own dependency database, from a full run on the unmodified tree.
    const testmonData = path.join(scratch, 'testmondata');
    const testmonEnv = { ...baseEnv, TESTMON_DATAFILE: testmonData };
    // testmon needs pytest's cache plugin loaded (it reads the --lf option); its cache goes outside the repository.
    const testmonArgs = ['-m', 'pytest', '-q', '-o', `cache_dir=${path.join(scratch, 'pytest-cache')}`, '--testmon'];
    const testmonRun = (args, env) => spawnSync(python, [...testmonArgs, ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 900_000 });
    const testmonBaseline = testmonRun([lib.tests], testmonEnv);
    if (!fs.existsSync(testmonData)) throw new Error(`testmon did not write its data file:\n${testmonBaseline.stdout.slice(-600)}${testmonBaseline.stderr.slice(-600)}`);

    const random = rng(20260930);
    const planned = [];
    for (const mutation of sourceMutations(root, lib, random)) {
      if (planned.filter((m) => m.kind === 'source').length >= SOURCE_MUTATIONS) break;
      const restore = applyMutation(root, mutation);
      const compiles = spawnSync(python, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(root, mutation.file)]).status === 0;
      restore();
      if (compiles) planned.push(mutation);
    }
    planned.push(...dataMutations(root, lib, random).slice(0, DATA_MUTATIONS));

    const mutations = [];
    for (const mutation of planned) {
      const restore = applyMutation(root, mutation);
      try {
        const truthRun = pytest(['--tb=no', '-rfE', lib.tests], noCacheEnv);
        if (truthRun.error || truthRun.status === null) {
          mutations.push({ ...mutation, mutated: undefined, timedOut: true, flipped: [], testmon: [], warm: [], nocache: [] });
          continue;
        }
        const truth = failedFiles(truthRun.stdout);
        const flipped = usable.filter((f) => truth.has(f));
        const trial = `${testmonData}.trial`;
        fs.copyFileSync(testmonData, trial);
        for (const suffix of ['-wal', '-shm']) if (fs.existsSync(testmonData + suffix)) fs.copyFileSync(testmonData + suffix, trial + suffix);
        const selection = testmonRun(['--collect-only', lib.tests], { ...baseEnv, TESTMON_DATAFILE: trial }).stdout;
        const testmon = [...new Set([...selection.matchAll(/^([^\s:]+\.py)::/gm)].map((m) => m[1]))].filter((f) => usable.includes(f));
        const selected = (config) => usable.filter((f) => readSets[config][f].has(mutation.file));
        mutations.push({ ...mutation, mutated: undefined, flipped, testmon, warm: selected('warm'), nocache: selected('nocache') });
      } finally {
        restore();
      }
    }

    const record = { lib: name, commit, testFiles: usable.length, failingAtBaseline: [...failingAtBaseline], wallMs: Date.now() - started, overhead, mutations };
    fs.writeFileSync(resultFile, `${JSON.stringify(record, null, 2)}\n`);
    const source = mutations.filter((m) => m.kind === 'source');
    console.log(`${name}: ${source.length} source + ${mutations.length - source.length} data mutations, ${mutations.filter((m) => m.flipped.length > 0).length} flip at least one test file, ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
