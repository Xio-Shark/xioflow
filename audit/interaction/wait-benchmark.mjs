import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ProcessEpisode, referenceProcess } from './process-episode.mjs';
import { WAIT_ARMS } from './process-host.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(directory, 'results/wait-mechanism-v1.json');
if (fs.existsSync(output)) throw new Error('Refuse to overwrite wait mechanism result');
const sources = ['process-service.mjs', 'process-fixture.mjs', 'process-host.mjs', 'process-grader.mjs', 'process-episode.mjs', 'wait-benchmark.mjs', 'WAIT-PROTOCOL.md'];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const result = { protocol: 'wait-v1/mechanism', modelRequests: 0, intervalMs: 50, freshnessBudgetMs: 200,
  sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])), runs: [] };
for (let repetition = 0; repetition < 3; repetition += 1) {
  for (const split of ['dev', 'heldout']) for (let index = 1; index <= 6; index += 1) {
    const id = `${split}-${String(index).padStart(2, '0')}`;
    const order = [...WAIT_ARMS.slice(repetition), ...WAIT_ARMS.slice(0, repetition)];
    for (const arm of order) {
      const episode = await ProcessEpisode.create(id, arm, { intervalMs: 50, dropHints: index === 6 });
      let trace;
      try {
        await referenceProcess(episode, { intervalMs: 50 });
        trace = episode.trace;
        const target = episode.fixture.target;
        const terminalChange = trace.changes.findLast((event) => event.instanceId === target.instanceId &&
          (episode.fixture.spec.expected === 'exited' ? event.type === 'exit' : event.type === 'ready' && event.state.ready));
        assert.ok(terminalChange, 'Missing actual terminal fact');
        const sample = trace.samples.find((observation) => observation.capturedAt >= terminalChange.at && observation.rows.some((row) =>
          row.instanceId === target.instanceId && (episode.fixture.spec.expected === 'exited' ? !row.alive : row.ready && row.configCurrent)));
        assert.ok(sample, 'Missing observation of terminal fact');
        trace.detectionMs = sample.capturedAt - terminalChange.at;
        trace.freshnessPassed = trace.detectionMs <= result.freshnessBudgetMs;
        trace.repetition = repetition;
      } finally {
        await episode.close();
        if (trace) { trace.cleaned = episode.trace.cleaned; trace.cleanup = episode.trace.cleanup; }
      }
      assert.equal(trace.verdict.passed, true);
      result.runs.push(trace);
    }
  }
}
result.summary = WAIT_ARMS.map((arm) => {
  const runs = result.runs.filter((run) => run.arm === arm);
  return { arm, runs: runs.length, passed: runs.filter((run) => run.verdict.passed).length,
    scans: runs.reduce((sum, run) => sum + run.metrics.scans, 0), notifications: runs.reduce((sum, run) => sum + run.metrics.notifications, 0),
    detectionP50Ms: percentile(runs.map((run) => run.detectionMs), 0.5), detectionP95Ms: percentile(runs.map((run) => run.detectionMs), 0.95),
    freshnessViolations: runs.filter((run) => !run.freshnessPassed).length };
});
result.allCleaned = result.runs.every((run) => run.cleaned);
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
assert.equal(result.allCleaned, true);
console.log(JSON.stringify({ status: result.summary.every((row) => row.freshnessViolations === 0) ? 'PASS' : 'PASS WITH CONCERNS', ...result, runs: result.runs.length }, null, 2));
