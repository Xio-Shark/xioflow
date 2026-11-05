import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './observation.mjs';
import { accounted, reviewedCall } from './research-budget.mjs';

// Read-only evidence audit. It neither releases accounting holds nor reruns experiments.
const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name)));
const ledgerRoot = path.join(directory, 'results/model-20261103');
const ledgerBytes = fs.readFileSync(path.join(ledgerRoot, 'budget.json'));
const ledger = JSON.parse(ledgerBytes);
assert.equal(ledger.limitUsd, 5);
ledger.calls.forEach((call, index) => assert.equal(call.id, index + 1));
const history = read('results/model-20261103/historical-ledger.json');
assert.equal(digest(fs.readFileSync(path.join(ledgerRoot, history.file))), history.sha256);
assert.deepEqual(ledger.calls.slice(0, 541), read(`results/model-20261103/${history.file}`).calls);
assert.ok(accounted(ledger) <= ledger.limitUsd);
assert.equal(fs.existsSync(path.join(ledgerRoot, 'runner.lock')), false, 'An experiment is still active; do not remove its lock');
let checkedSources = 0;
function sources(hashes, snapshotFolder) {
  for (const [name, sha] of Object.entries(hashes)) {
    const file = snapshotFolder ? path.join(directory, snapshotFolder, 'source-snapshots', `${sha}.source`) : path.join(directory, name);
    assert.equal(digest(fs.readFileSync(file)), sha, `Source mismatch: ${name}`);
    checkedSources += 1;
  }
}
let cleanupRecords = 0;
function cleanup(trace) {
  assert.equal(trace.cleaned, true);
  for (const key of ['childrenClosed', 'portsClosed', 'directoryRemoved']) assert.equal(trace.cleanup[key], true, key);
  for (const key of ['timers', 'jobs', 'listeners']) assert.equal(trace.cleanup[key], 0, key);
  if ('activeCommands' in trace) assert.equal(trace.activeCommands, 0);
  if (trace.restoration) assert.ok(trace.restoration.restored || trace.restoration.reason === 'target_exited');
  cleanupRecords += 1;
}
for (const [name, count] of [['process-v1.json', 12], ['wait-mechanism-v1.json', 108], ['action-mechanism-v1.json', 24]]) {
  const result = read(`results/${name}`);
  sources(result.sourceHashes);
  assert.equal(result.modelRequests, 0);
  assert.equal(result.runs.length, count);
  for (const trace of result.runs) { assert.equal(trace.verdict.passed, true); cleanup(trace); }
}
const budgets = read('results/budget-ablation-v2.json');
sources(budgets.sourceHashes);
assert.equal(budgets.runs.length, 72);
const replay = read('results/plan-replay-v2.json');
sources(replay.sourceHashes, 'results/plan-replay-v2');
assert.equal(replay.runs.length, replay.summary.planned);
for (const run of replay.runs.filter((item) => item.available)) {
  assert.equal(digest(fs.readFileSync(path.join(directory, 'results/process-model-v1', run.originFile))), run.originSha256);
  if (run.applicable) cleanup(run.trace);
}
const trajectory = read('results/wait-trajectory-analysis.json');
sources(trajectory.sourceHashes, 'results/wait-analysis-v1');
assert.equal(trajectory.rows.length, trajectory.planned);
for (const row of trajectory.rows.filter((item) => item.attempted)) assert.equal(digest(fs.readFileSync(path.join(directory, 'results/process-model-v1', row.record))), row.sha256);
const summary = read('results/process-model-v1/summary.json');
sources(summary.analysisSourceHashes, 'results/process-model-v1/analysis');
assert.equal(summary.throughRequest, ledger.calls.at(-1)?.id, 'Regenerate the report from the current ledger');
assert.equal(summary.cumulativeAccountedUsd, accounted(ledger));
assert.equal(summary.attemptedFormal + summary.notAttemptedFormal, summary.plannedFormal);
let modelEpisodes = 0;
const assigned = [];
for (const phase of ['pilot', 'dev', 'heldout']) {
  const manifest = read(`results/process-model-v1/${phase}-manifest.json`);
  sources(manifest.sourceHashes, 'results/process-model-v1');
  for (const entry of manifest.planned) {
    const file = path.join(directory, 'results/process-model-v1', `${phase}-${entry.taskId}-${entry.arm}-${entry.repetition}.json`);
    if (!fs.existsSync(file)) continue;
    const record = JSON.parse(fs.readFileSync(file));
    sources(record.sourceHashes, 'results/process-model-v1');
    cleanup(record.trace);
    assigned.push(...record.modelCalls);
    modelEpisodes += 1;
  }
}
assert.equal(new Set(assigned).size, assigned.length);
assert.deepEqual(assigned.sort((a, b) => a - b), ledger.calls.filter((call) => call.experiment === 'wait-v1').map((call) => call.id));
const actionPlan = read('results/action-model-v1/plan.json');
sources(actionPlan.sourceHashes, 'results/action-model-v1');
assert.equal(actionPlan.planned.pilot.length, 6);
assert.equal(actionPlan.planned.dev.length + actionPlan.planned.heldout.length, 72);
const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n');
const active = processes.filter((line) => /^\s*\d+\s+(?:\S+\/)?node\s/.test(line) &&
  /(?:audit\/interaction\/)(?:process-service|action-command|process-model-runner|action-model-runner)\.mjs(?:\s|$)/.test(line));
assert.equal(active.length, 0, 'A research process is still active');
const tempDirectories = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('xio-process-'));
assert.equal(tempDirectories.length, 0, 'Research temporary directories remain; inspect ownership before cleanup');
assert.equal(digest(fs.readFileSync(path.join(ledgerRoot, 'budget.json'))), digest(ledgerBytes), 'Ledger changed during audit');
const unreviewed = ledger.calls.filter((call) => !reviewedCall(call, ledgerRoot)).map((call) => call.id);
console.log(JSON.stringify({ status: summary.status === 'PARTIAL' || unreviewed.length ? 'PASS WITH CONCERNS' : 'PASS',
  newModelRequests: 0, checkedSources, cleanupRecords, modelEpisodes, formalAttempted: summary.attemptedFormal,
  formalNotAttempted: summary.notAttemptedFormal, replayPassed: replay.summary.passed,
  unreviewedRequests: unreviewed, accountedUsd: accounted(ledger), throughRequest: ledger.calls.at(-1)?.id,
  activeResearchProcesses: active.length, temporaryDirectories: tempDirectories.length, ledgerUnchanged: true }, null, 2));
