#!/usr/bin/env node
// E3: the same frozen workloads under two commit rules.
//   --arm files         file-level validation only (what parallel_edit did before): a changed file the worker read
//                       or wrote is a conflict
//   --arm observations  on a file-level conflict the kernel replays the worker's log on the current workspace and
//                       commits when every observation is unchanged (no resume: a real difference stays a conflict)
// Each arm is its own set of model runs. After a group finishes, the merged workspace is type-checked.
//
// Usage: node audit/observation/e3.mjs --arm files|observations [--groups U1,S1] [--reps 5] [--provider p] [--model m]
// The API key is read from the environment variable the provider names in ~/.xiocode/config.toml; it is never
// written to disk or printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadXiocode, openModel, XIOCODE_ROOT } from '../lib/xiocode.mjs';
import { PINNED_COMMIT, WORKLOADS } from './workloads.mjs';

const { createWorkerRunner, runParallelEdit } = await loadXiocode('src/runtime/parallel-edit.ts');
const { KernelSession } = await loadXiocode('src/runtime/process/kernel-session.ts');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const arm = option('arm');
if (arm !== 'files' && arm !== 'observations') throw new Error('--arm files|observations is required');
const groupIds = option('groups')?.split(',');
const reps = Number(option('reps', '1'));
const WORKER_TIMEOUT_MS = 10 * 60_000;
const { client, model, modelId, providerName, registration } = await openModel({ provider: option('provider'), model: option('model') });

const outRoot = path.resolve(option('out', path.join(import.meta.dirname, '../results/observation', new Date().toISOString().slice(0, 10), 'e3')), arm);
fs.mkdirSync(outRoot, { recursive: true });

/** Type-checks the merged workspace with xiocode's own compiler and dependencies. */
function typecheck(workspace) {
  fs.symlinkSync(path.join(XIOCODE_ROOT, 'node_modules'), path.join(workspace, 'node_modules'));
  const run = spawnSync(path.join(XIOCODE_ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--noEmit'], { cwd: workspace, encoding: 'utf8', timeout: 120_000 });
  const errors = (run.stdout ?? '').split('\n').filter((line) => /error TS\d+/.test(line));
  return { passed: run.status === 0, exit: run.status, errorCount: errors.length, firstErrors: errors.slice(0, 5).map((line) => line.slice(0, 240)) };
}

async function runGroup(group, rep) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-e3-')));
  const workspace = path.join(sandbox, 'ws');
  execFileSync('git', ['clone', '-q', '--local', XIOCODE_ROOT, workspace]);
  execFileSync('git', ['checkout', '-q', '--detach', PINNED_COMMIT], { cwd: workspace });
  const kernel = await KernelSession.open({ sessionId: `e3-${group.id}-${rep}`, workspaceRoot: workspace, domainPath: path.join(sandbox, 'domain') });
  const started = Date.now();
  try {
    const worker = createWorkerRunner({ getClient: () => client, getModel: () => model, getProviderApi: () => registration.api, maxTurns: 40 });
    const runWorker = (input) => worker({ ...input, signal: AbortSignal.timeout(WORKER_TIMEOUT_MS) });
    const port = {
      beginTransaction: (name) => kernel.beginTransaction(name),
      // The file-level arm drops the observation log, which is all it takes to get the old behaviour.
      commitTransaction: (txId, baseSnapshotId, options) => kernel.commitTransaction(txId, baseSnapshotId, arm === 'observations' ? options : undefined),
      abortTransaction: (txId, baseSnapshotId, reason) => kernel.abortTransaction(txId, baseSnapshotId, reason),
    };
    const reports = await runParallelEdit(group.tasks, port, runWorker);
    const wallMs = Date.now() - started;
    kernel.close();
    const changed = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).split('\n').filter(Boolean).length;
    return {
      arm, group: group.id, category: group.category, rep, provider: providerName, model: modelId, wallMs,
      changedFiles: changed,
      typecheck: typecheck(workspace),
      tasks: reports.map((report) => ({
        name: report.name, status: report.status, validation: report.validation ?? null, observation: report.observation ?? null,
        writeSet: report.writeSet, conflicts: report.conflicts, lostTo: report.lostTo,
        steps: report.observations?.length ?? 0,
        // Which call the replay stopped at (tool and arguments only; results are not stored).
        divergedStep: report.observation?.attempted && 'divergedAt' in report.observation ? (({ kind, tool, args }) => ({ kind, tool, args }))(report.observations[report.observation.divergedAt]) : null,
        usage: report.usage ?? null,
        summary: report.summary.slice(0, 300),
      })),
    };
  } finally {
    kernel.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

for (const group of WORKLOADS.filter((g) => !groupIds || groupIds.includes(g.id))) {
  for (let rep = 1; rep <= reps; rep++) {
    const file = path.join(outRoot, `${group.id}-${modelId}-${rep}.json`);
    if (fs.existsSync(file)) { console.log(`${arm} ${group.id} #${rep}: already recorded, skipped`); continue; }
    let record;
    try {
      record = await runGroup(group, rep);
    } catch (err) {
      record = { arm, group: group.id, category: group.category, rep, provider: providerName, model: modelId, runnerError: String(err?.message ?? err) };
    }
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const brief = record.tasks?.map((t) => `${t.name}=${t.status}${t.validation === 'observations' ? '(by observations)' : ''}${t.status === 'conflict' ? `(${t.conflicts.map((c) => c.kind).join('+')}${t.observation ? `; ${t.observation.attempted ? `diverged at ${t.observation.divergedAt + 1}/${t.steps}` : t.observation.reason}` : ''})` : ''}`).join(' | ');
    console.log(`${arm} ${group.id} #${rep} (${Math.round((record.wallMs ?? 0) / 1000)}s): ${brief ?? `runner error: ${record.runnerError}`}${record.typecheck ? ` | typecheck ${record.typecheck.passed ? 'ok' : `FAILED (${record.typecheck.errorCount} errors)`}` : ''}`);
  }
}
