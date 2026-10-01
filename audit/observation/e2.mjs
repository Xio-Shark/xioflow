#!/usr/bin/env node
// E2: how many of the file-level conflicts of xiocode's parallel_edit are false conflicts?
// Runs each workload group with real worker agents on a clean clone of xiocode (behaviour unchanged: file-level
// validation decides). Whenever a worker's commit is refused, its recorded observations are replayed right then
// on a fork of the workspace as it is at that moment: if every observation comes out the same and every edit
// still applies, the refusal was a false conflict; otherwise the index of the first difference is recorded.
//
// Usage: node audit/observation/e2.mjs [--groups U1,S1] [--reps 5] [--provider deepseek] [--model deepseek-flash]
// The API key is read from the environment variable the provider names in ~/.xiocode/config.toml; it is never
// written to disk or printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadXiocode, openModel, XIOCODE_ROOT } from '../lib/xiocode.mjs';
import { PINNED_COMMIT, WORKLOADS } from './workloads.mjs';

const { createBuiltinTools } = await loadXiocode('src/runtime/index.ts');
const { createWorkerRunner, runParallelEdit } = await loadXiocode('src/runtime/parallel-edit.ts');
const { hashObservation, resultText } = await loadXiocode('src/runtime/parallel-observations.ts');
const { KernelSession } = await loadXiocode('src/runtime/process/kernel-session.ts');
const { WorkspacePathPolicy } = await loadXiocode('src/runtime/workspace-path-policy.ts');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const groupIds = option('groups')?.split(',');
const reps = Number(option('reps', '1'));
const WORKER_TIMEOUT_MS = 10 * 60_000;
const { client, model, modelId, providerName, registration } = await openModel({ provider: option('provider'), model: option('model') });

const outRoot = path.resolve(option('out', path.join(import.meta.dirname, '../results/observation', new Date().toISOString().slice(0, 10), 'e2')));
fs.mkdirSync(outRoot, { recursive: true });

/** Replays a worker's log in `root`. Observations are compared, edits are applied. */
async function replay(log, root) {
  const pathPolicy = await WorkspacePathPolicy.create({ workspaceRoot: root, cwd: root });
  const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, pathPolicy, grepOutline: false });
  const here = (value) => (typeof value === 'string' ? value.split('<root>').join(root)
    : Array.isArray(value) ? value.map(here)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, here(v)])) : value);
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    const result = await tools.find((t) => t.name === entry.tool).execute(`replay-${i}`, here(entry.args));
    if (entry.kind === 'mutate') {
      if (result.isError === true && !entry.isError) return { divergedAt: i, reason: 'mutation_not_applicable', tool: entry.tool };
    } else if (hashObservation(entry.tool, resultText(result), root) !== entry.resultHash) {
      return { divergedAt: i, reason: 'observation_changed', tool: entry.tool };
    }
  }
  return { divergedAt: -1 };
}

async function runGroup(group, rep) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-e2-')));
  const workspace = path.join(sandbox, 'ws');
  execFileSync('git', ['clone', '-q', '--local', XIOCODE_ROOT, workspace]);
  execFileSync('git', ['checkout', '-q', '--detach', PINNED_COMMIT], { cwd: workspace });
  const kernel = await KernelSession.open({ sessionId: `e2-${group.id}-${rep}`, workspaceRoot: workspace, domainPath: path.join(sandbox, 'domain') });
  const started = Date.now();
  const logs = new Map();
  const names = new Map();
  const verdicts = new Map();
  const finishedAt = new Map();
  try {
    const worker = createWorkerRunner({ getClient: () => client, getModel: () => model, getProviderApi: () => registration.api, maxTurns: 40 });
    const runWorker = async (input) => {
      const outcome = await worker({ ...input, signal: AbortSignal.timeout(WORKER_TIMEOUT_MS) });
      logs.set(input.task.name, outcome.observations ?? []);
      finishedAt.set(input.task.name, Date.now() - started);
      return outcome;
    };
    const port = {
      async beginTransaction(name) {
        const tx = await kernel.beginTransaction(name);
        names.set(tx.txId, name);
        return tx;
      },
      async commitTransaction(txId, baseSnapshotId) {
        const result = await kernel.commitTransaction(txId, baseSnapshotId);
        if (result.status === 'conflict') {
          // The workspace as it is right now, in a throwaway fork.
          const name = names.get(txId);
          const probe = await kernel.beginTransaction(`replay-${name}`);
          try {
            verdicts.set(name, await replay(logs.get(name) ?? [], probe.forkRoot));
          } finally {
            await kernel.abortTransaction(probe.txId, probe.baseSnapshotId, 'replay probe');
          }
        }
        return result;
      },
      abortTransaction: (txId, baseSnapshotId, reason) => kernel.abortTransaction(txId, baseSnapshotId, reason),
    };
    const reports = await runParallelEdit(group.tasks, port, runWorker);
    return {
      group: group.id, category: group.category, rep, provider: providerName, model: modelId, wallMs: Date.now() - started,
      tasks: reports.map((report) => {
        const log = report.observations ?? [];
        const verdict = verdicts.get(report.name);
        return {
          name: report.name, status: report.status, finishedAtMs: finishedAt.get(report.name) ?? null,
          writeSet: report.writeSet, conflicts: report.conflicts, lostTo: report.lostTo,
          steps: log.length, observations: log.filter((e) => e.kind === 'observe').length, mutations: log.filter((e) => e.kind === 'mutate').length,
          tools: log.map((e) => `${e.kind === 'observe' ? 'o' : 'm'}:${e.tool}`),
          usage: report.usage ?? null,
          replay: verdict ?? null,
          falseConflict: report.status === 'conflict' ? verdict?.divergedAt === -1 : null,
          summary: report.summary.slice(0, 300),
        };
      }),
    };
  } finally {
    kernel.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

for (const group of WORKLOADS.filter((g) => !groupIds || groupIds.includes(g.id))) {
  for (let rep = 1; rep <= reps; rep++) {
    const file = path.join(outRoot, `${group.id}-${modelId}-${rep}.json`);
    if (fs.existsSync(file)) { console.log(`${group.id} #${rep}: already recorded, skipped`); continue; }
    let record;
    try {
      record = await runGroup(group, rep);
    } catch (err) {
      record = { group: group.id, category: group.category, rep, provider: providerName, model: modelId, runnerError: String(err?.message ?? err) };
    }
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const brief = record.tasks?.map((t) => `${t.name}=${t.status}${t.status === 'conflict' ? `(${t.conflicts.map((c) => c.kind).join('+')}; ${t.falseConflict ? 'FALSE conflict' : `diverged at ${t.replay?.divergedAt + 1}/${t.steps}`})` : ''} steps=${t.steps} in=${t.usage?.inputTokens ?? '?'} out=${t.usage?.outputTokens ?? '?'}`).join(' | ');
    console.log(`${group.id} #${rep} (${Math.round((record.wallMs ?? 0) / 1000)}s): ${brief ?? `runner error: ${record.runnerError}`}`);
  }
}
