import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { digest } from './observation.mjs';
import { writeJson, snapshotSources } from './research-budget.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, 'results/process-model-v1');
const output = path.join(directory, 'results/wait-trajectory-analysis.json');
if (fs.existsSync(output)) throw new Error('Refuse to overwrite trajectory analysis');
const rows = [];
for (const phase of ['dev', 'heldout']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, `${phase}-manifest.json`)));
  for (const planned of manifest.planned) {
    const file = `${phase}-${planned.taskId}-${planned.arm}-${planned.repetition}.json`;
    if (!fs.existsSync(path.join(root, file))) {
      rows.push({ phase, ...planned, record: file, attempted: false, analysable: false, reason: 'source_episode_not_attempted' });
      continue;
    }
    const record = JSON.parse(fs.readFileSync(path.join(root, file)));
    const target = record.trace.verdict.actual?.instanceId;
    const terminal = record.trace.events.find((event) => event.op === 'submit')?.args.outcome;
    const sufficient = record.trace.events.findIndex((event) => event.response.rows?.some((state) => state.instanceId === target &&
      (terminal === 'exited' ? !state.alive : state.ready && state.configCurrent)));
    rows.push({ phase, ...planned, record: file, sha256: digest(fs.readFileSync(path.join(root, file))),
      attempted: true, passed: record.trace.verdict.passed, analysable: record.trace.verdict.passed && sufficient >= 0,
      extraObservationCalls: sufficient < 0 ? null : record.trace.events.slice(sufficient + 1).filter((event) => ['inspect', 'watch'].includes(event.op)).length,
      totalModelCalls: record.modelCalls.length });
  }
}
assert.equal(rows.length, 108);
const summary = ['agent-poll', 'server-poll', 'event-view'].map((arm) => {
  const group = rows.filter((row) => row.arm === arm && row.analysable);
  return { arm, analysed: group.length, withAdditionalObservation: group.filter((row) => row.extraObservationCalls > 0).length,
    additionalObservationCalls: group.reduce((sum, row) => sum + row.extraObservationCalls, 0) };
});
const result = { evidenceClass: 'posthoc-returned-state-analysis', futureChangesKnownOnlyToController: true,
  planned: rows.length, attempted: rows.filter((row) => row.attempted).length,
  notAttempted: rows.filter((row) => !row.attempted).length,
  interpretation: 'Additional observation after goal facts first held is not automatically an error or avoidable in arbitrary systems',
  sourceHashes: snapshotSources(directory, path.join(directory, 'results/wait-analysis-v1'), ['trajectory-analysis.mjs', 'observation.mjs', 'research-budget.mjs']), summary, rows };
writeJson(output, result, { immutable: true });
console.log(JSON.stringify({ status: result.notAttempted ? 'PASS WITH CONCERNS' : 'PASS', planned: rows.length,
  attempted: result.attempted, notAttempted: result.notAttempted, summary }, null, 2));
