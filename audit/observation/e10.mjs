#!/usr/bin/env node
// E10: Early Cutoff recovery + tree-fingerprint command dedup. Deterministic, no model calls.
// Part A replays a scripted rename trajectory (one tool call per model response) on a fork of the
// workspace after a concurrent change, and counts how many steps the agent must redo.
// Part B runs the same real `tsc --noEmit` in K identical transaction forks, naive vs deduplicated.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ExecutionDomain, ProcessSupervisor, replayObservationLog, computeDiscoverySetCutoff, computeSymbolSliceCutoffHash,
} from '../../dist/index.js';
import { createRenameFixture, applyCompetingChange, checkRenameFixture } from './rename-fixture.mjs';

const TRIALS = Number(process.env.E10_TRIALS ?? 3);
const K = Number(process.env.E10_FORKS ?? 4);
const tscBin = path.resolve(import.meta.dirname, '../../node_modules/typescript/bin/tsc');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function gitInit(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'fixture');
}

function setup(name) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xf-e10-${name}-`)));
  const domain = ExecutionDomain.acquire(path.join(temp, 'domain'), `e10-${name}`);
  const supervisor = new ProcessSupervisor(domain);
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'e10', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'e10', status: 'running', startedAt: new Date().toISOString() });
  return { temp, domain, supervisor, close: () => { domain.close(); fs.rmSync(temp, { recursive: true, force: true }); } };
}

// ---- scripted tools ----
const globOut = (root) => fs.readdirSync(root).filter((f) => f.endsWith('.mjs')).sort().join('\n');
function exec(step, root) {
  if (step.tool === 'glob') return globOut(root);
  const abs = path.join(root, step.args.path);
  const text = fs.readFileSync(abs, 'utf8');
  if (step.tool === 'read') return text;
  if (!text.includes('foo')) throw new Error(`edit: foo not found in ${step.args.path}`);
  fs.writeFileSync(abs, text.split('foo').join('bar'));
  return undefined;
}

/** The agent: glob, then read + edit every file that mentions foo. Returns the recorded log. */
function agentRun(root, delta) {
  const log = []; const rawGlob = new Map();
  const record = (tool, args) => {
    const out = exec({ tool, args }, root);
    const entry = { kind: tool === 'edit' ? 'mutate' : 'observe', call: { tool, args } };
    if (out !== undefined) entry.resultHash = sha(out);
    if (tool === 'read') entry.cutoffHash = computeSymbolSliceCutoffHash(out, ['foo']);
    if (tool === 'glob') rawGlob.set(log.length, out);
    log.push(entry);
    return out;
  };
  const files = delta ?? record('glob', {}).split('\n');
  for (const file of files) {
    if (record('read', { path: file }).includes('foo')) record('edit', { path: file });
  }
  return { log, rawGlob };
}

async function partA(scenario, mode) {
  const env = setup(`a-${scenario}-${mode}`);
  try {
    const root = path.join(env.temp, 'repo'); fs.mkdirSync(root);
    createRenameFixture(root, scenario); gitInit(root);
    // Agent A works in its own fork; then a concurrent agent changes main.
    const txA = await env.supervisor.beginWorkspaceTransaction({ txId: 'a', runId: 'run', root, forkPath: path.join(env.temp, 'fork-a') });
    const { log, rawGlob } = agentRun(txA.forkRoot);
    applyCompetingChange(root, scenario);
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'concurrent');

    const start = performance.now();
    const tx = await env.supervisor.beginWorkspaceTransaction({ txId: 'r', runId: 'run', root, forkPath: path.join(env.temp, 'fork-r') });
    let added = [];
    const replay = async (entry, r) => {
      const out = exec(entry.call, r);
      if (out === undefined) return undefined;
      return mode === 'linear' ? sha(out)
        : { resultHash: sha(out), ...(entry.call.tool === 'read' ? { cutoffHash: computeSymbolSliceCutoffHash(out, ['foo']) } : {}) };
    };
    const canCutoff = mode === 'linear' ? undefined : async (entry, { index }, r) => {
      if (entry.call.tool !== 'glob') return false;
      const diff = computeDiscoverySetCutoff(rawGlob.get(index), globOut(r));
      if (diff.isSuperset) added = diff.added; // the host must hand the delta to the resumed agent
      return diff.isSuperset;
    };
    const result = await replayObservationLog({ log, replay, canCutoff }, tx.forkRoot);
    const reconstructionMs = performance.now() - start;

    // Resume: reuse the matched prefix, redo the rest. Baseline assumes a checkpoint after every step (its best case).
    let redoSteps;
    let finalRoot = tx.forkRoot;
    if (result.status === 'matched') {
      redoSteps = agentRun(tx.forkRoot, added).log.length;
    } else {
      await env.supervisor.abortWorkspaceTransaction('r');
      const fresh = await env.supervisor.beginWorkspaceTransaction({ txId: 'f', runId: 'run', root, forkPath: path.join(env.temp, 'fork-f') });
      const full = agentRun(fresh.forkRoot).log.length;
      redoSteps = full - result.matchedSteps;
      finalRoot = fresh.forkRoot;
    }
    const check = checkRenameFixture(finalRoot, scenario, env.temp);
    return { scenario, mode, recordedSteps: log.length, status: result.status, matchedSteps: result.matchedSteps,
      cutoffSteps: result.cutoffSteps ?? 0, redoSteps, reconstructionMs: +reconstructionMs.toFixed(1), passed: check.passed };
  } finally { env.close(); }
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

// ---- Part B ----
function tsFixture(root, files = 60) {
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], target: 'es2022', module: 'es2022', moduleResolution: 'bundler' }, include: ['src'] }));
  fs.mkdirSync(path.join(root, 'src'));
  for (let i = 0; i < files; i++) {
    const prev = i === 0 ? '' : `import { f${i - 1} } from './m${i - 1}.js';\n`;
    fs.writeFileSync(path.join(root, 'src', `m${i}.ts`), `${prev}export interface S${i} { a: number; b: string; c: readonly S${i}[] }\n` +
      `export function f${i}(x: S${i}): number { return x.c.reduce((n, y) => n + f${i}(y), x.a${i === 0 ? '' : ` + f${i - 1}({ a: 1, b: '', c: [] })`}); }\n`);
  }
}

async function partB(mode) {
  const env = setup(`b-${mode}`);
  try {
    const root = path.join(env.temp, 'repo'); fs.mkdirSync(root);
    tsFixture(root); gitInit(root);
    const forks = [];
    for (let i = 0; i < K; i++) forks.push(await env.supervisor.beginWorkspaceTransaction({ txId: `t${i}`, runId: 'run', root, forkPath: path.join(env.temp, `fork-${i}`) }));
    const command = (r) => ({ execPath: process.execPath, args: [tscBin, '-p', 'tsconfig.json'], cwd: r });
    let seq = 0;
    const runOne = (tx) => mode === 'naive'
      ? env.supervisor.executeProcess({ runId: 'run', opId: `naive-${seq++}`, name: 'tsc', command: command(tx.forkRoot) })
      : env.supervisor.executeWorkspaceCommand({ runId: 'run', name: 'tsc', workspaceRoot: tx.forkRoot, command: command(tx.forkRoot) });
    const round = async () => {
      const t = performance.now();
      const results = await Promise.all(forks.map(runOne));
      for (const r of results) assert.equal(r.exitCode, 0, r.stdout ?? r.stderr);
      return { ms: performance.now() - t, spawned: results.filter((r) => !r.replayed).length };
    };
    const first = await round();   // K agents verify the same tree concurrently
    const second = await round();  // they verify again with no change in between
    return { mode, forks: K, round1Ms: +first.ms.toFixed(0), round1Spawned: first.spawned, round2Ms: +second.ms.toFixed(0), round2Spawned: second.spawned };
  } finally { env.close(); }
}

const a = [];
for (const scenario of ['new-caller', 'comment']) for (const mode of ['linear', 'early-cutoff']) a.push(await partA(scenario, mode));
console.table(a);

const b = { naive: [], dedup: [] };
for (let t = 0; t < TRIALS; t++) for (const mode of ['naive', 'dedup']) b[mode].push(await partB(mode));
const summary = Object.entries(b).map(([mode, rows]) => ({ mode, trials: rows.length, forks: K,
  round1MedianMs: median(rows.map((r) => r.round1Ms)), round1Spawned: rows[0].round1Spawned,
  round2MedianMs: median(rows.map((r) => r.round2Ms)), round2Spawned: rows[0].round2Spawned }));
console.table(summary);

const out = path.resolve(import.meta.dirname, '../results/e10.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.cpus()[0]?.model} x${os.cpus().length}`, node: process.version, partA: a, partB: { raw: b, summary } }, null, 2));
console.log(`wrote ${out}`);
