import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { FileObservation, wireBytes, digest } from './observation.mjs';
import { makeRecords, withFixture, WORKLOADS } from './fixtures.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const adaptive = process.argv.slice(2).includes('--adaptive');
assert.ok(process.argv.slice(2).every((argument) => argument === '--adaptive'), 'Only --adaptive is supported');
const arms = adaptive ? ['full', 'jq', 'structured', 'adaptive'] : ['full', 'jq', 'structured'];
const repetitions = 3;
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const round = (number) => Number(number.toFixed(3));

function jqFilter(workload) {
  const predicate = Object.entries(workload.where).map(([key, value]) => `.value[${JSON.stringify(key)}] == ${JSON.stringify(value)}`).join(' and ');
  const fields = workload.readText ? [...workload.select, 'notes'] : workload.select;
  const projection = fields.map((key) => `${JSON.stringify(key)}: .value[${JSON.stringify(key)}]`).join(', ');
  return `[to_entries[] | select(${predicate}) | {ref: ("r" + (.key | tostring)), values: {${projection}}}]`;
}

function runTrial(workload, arm, trial, stale = false) {
  const records = makeRecords(workload.count, workload.noteSize);
  const expectedIndices = records.flatMap((record, index) => Object.entries(workload.where).every(([key, value]) => record[key] === value) ? [index] : []);
  return withFixture(records, ({ file }) => {
    const metrics = { workload: workload.name, arm, trial, stale, requestBytes: 0, responseBytes: 0, calls: 0, exchanges: [] };
    const begin = performance.now();
    const observation = new FileObservation(file, { writable: true });
    metrics.captureMs = performance.now() - begin;
    metrics.sourceBytes = fs.statSync(file).size;
    metrics.sourceSha256 = observation.version;
    const exchange = (request, response) => {
      const requestBytes = wireBytes(request);
      const responseBytes = wireBytes(response);
      metrics.requestBytes += requestBytes;
      metrics.responseBytes += responseBytes;
      metrics.calls += 1;
      metrics.exchanges.push({ operation: request.op, requestBytes, responseBytes, responseSha256: digest(JSON.stringify(response)) });
      return response;
    };
    exchange({ op: 'observe', file: 'records.json' }, observation.describe());
    const workBegin = performance.now();
    let selected;
    let text;
    if (arm === 'full') {
      const reply = exchange({ op: 'full', version: observation.version }, observation.full());
      selected = reply.records.flatMap((row, index) => Object.entries(workload.where).every(([key, value]) => row[key] === value)
        ? [{ ref: `r${index}`, values: Object.fromEntries(workload.select.map((key) => [key, row[key]])) }] : []);
      if (workload.readText) text = reply.records[Number(selected[0].ref.slice(1))].notes;
    } else if (arm === 'jq') {
      const filter = jqFilter(workload);
      const output = execFileSync('jq', ['-c', filter], { input: observation.sourceText(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5000 });
      const reply = exchange({ op: 'jq', version: observation.version, filter }, { version: observation.version, rows: JSON.parse(output) });
      selected = reply.rows;
      if (workload.readText) text = selected[0].values.notes;
    } else {
      selected = [];
      let cursor;
      let maxBytes = 2048;
      do {
        const args = { where: workload.where, select: workload.select, maxBytes, ...(cursor ? { cursor } : {}) };
        const reply = exchange({ op: 'query', version: observation.version, args }, observation.query(args));
        assert.ok(wireBytes(reply) <= args.maxBytes);
        selected.push(...reply.rows);
        cursor = reply.nextCursor;
        if (arm === 'adaptive' && cursor) {
          const remaining = reply.matchedCount - reply.offset - reply.rows.length;
          maxBytes = Math.min(65536, Math.max(2048, Math.ceil(512 + remaining * wireBytes(reply.rows) / reply.rows.length)));
        }
      } while (cursor);
      if (workload.readText) {
        text = '';
        maxBytes = 2048;
        do {
          const args = { version: observation.version, ref: selected[0].ref, field: 'notes', maxBytes, ...(cursor ? { cursor } : {}) };
          const reply = exchange({ op: 'readText', args }, observation.readText(args));
          assert.ok(wireBytes(reply) <= args.maxBytes);
          text += reply.text;
          cursor = reply.nextCursor;
          if (arm === 'adaptive' && cursor) {
            const returned = [...reply.text].length;
            const remaining = reply.totalCodePoints - reply.offset - returned;
            maxBytes = Math.min(65536, Math.max(2048, Math.ceil(512 + remaining * wireBytes(reply.text) / returned)));
          }
        } while (cursor);
      }
    }
    assert.deepEqual(selected.map((row) => row.ref), expectedIndices.map((index) => `r${index}`));
    for (let index = 0; index < selected.length; index += 1) {
      for (const key of workload.select) assert.deepEqual(selected[index].values[key], records[expectedIndices[index]][key]);
    }
    if (workload.readText) assert.equal(text, records[expectedIndices[0]].notes);
    const expected = structuredClone(records);
    if (workload.update) {
      assert.equal(selected.length, 1);
      if (stale) {
        expected[0].notes = 'external modification after observation';
        fs.writeFileSync(file, `${JSON.stringify(expected)}\n`);
      }
      const args = { version: observation.version, ref: selected[0].ref, value: true };
      let result;
      if (stale) {
        assert.throws(() => observation.setEnabled(args), (error) => {
          assert.equal(error.code, 'stale_observation');
          result = { status: 'rejected', code: error.code };
          return true;
        });
      } else {
        result = observation.setEnabled(args);
        expected[expectedIndices[0]].enabled = true;
      }
      exchange({ op: 'setEnabled', args }, result);
    }
    metrics.operationMs = performance.now() - workBegin;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
    metrics.verified = true;
    metrics.totalBytes = metrics.requestBytes + metrics.responseBytes;
    return metrics;
  });
}

// Deliberately fail if the strong baseline cannot execute; no substitute baseline.
const jqVersion = execFileSync('jq', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
const trials = [];
for (const workload of WORKLOADS) {
  for (let trial = 0; trial < repetitions; trial += 1) {
    const order = [...arms.slice(trial), ...arms.slice(0, trial)];
    for (const arm of order) trials.push(runTrial(workload, arm, trial));
  }
}
for (const arm of arms) trials.push(runTrial(WORKLOADS[1], arm, 0, true));
const summaries = WORKLOADS.flatMap((workload) => arms.map((arm) => {
  const samples = trials.filter((trial) => trial.workload === workload.name && trial.arm === arm && !trial.stale);
  assert.equal(new Set(samples.map((sample) => sample.totalBytes)).size, 1);
  return { workload: workload.name, arm, trials: samples.length, bytes: samples[0].totalBytes, calls: samples[0].calls,
    medianCaptureMs: round(median(samples.map((sample) => sample.captureMs))),
    medianOperationMs: round(median(samples.map((sample) => sample.operationMs))), verified: samples.every((sample) => sample.verified) };
}));
const sourceFiles = ['observation.mjs', 'fixtures.mjs', 'benchmark.mjs'];
const result = {
  protocol: adaptive ? 'RFC-SI-001/mechanism-v2-adaptive' : 'RFC-SI-001/mechanism-v1', date: '2026-11-03', recordedAt: new Date().toISOString(),
  evidenceClass: 'deterministic-fixtures-real-files-no-model',
  environment: { node: process.version, platform: process.platform, arch: process.arch, jq: jqVersion },
  sourceHashes: Object.fromEntries(sourceFiles.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])),
  limitations: [
    'Correct query and projection are supplied; no task-discovery or LLM-success inference.',
    'All arms share describe and a version guard; jq is not denied freshness protection.',
    'Serialized JSON message bytes are not tokens. Prompt/tool-schema costs are excluded.',
    'Three timing samples per cell are descriptive; jq process startup is included.',
    'Updates assume a single writer during check-and-rename. No production/CAS claim.',
    'Adaptive granularity is a deterministic exhaustive-reader policy, not model decision evidence.',
  ], summaries, trials,
};
fs.mkdirSync(path.join(directory, 'results'), { recursive: true });
fs.writeFileSync(path.join(directory, 'results/mechanism.json'), `${JSON.stringify(result, null, 2)}\n`);
const table = summaries.map((row) => `| ${row.workload} | ${row.arm} | ${row.bytes} | ${row.calls} | ${row.medianOperationMs} | ${row.verified ? 'PASS' : 'FAIL'} |`).join('\n');
const report = `# System interaction mechanism results\n\n2026-11-03 · RFC-SI-001 · deterministic fixtures on real files; no model calls.\n\n` +
  `The same caller-supplied predicate, projected fields, snapshot metadata and version guard are available to every arm. All modifications were independently checked against the entire expected document.\n\n` +
  `| Workload | Arm | Request + response bytes | Calls | Median operation ms | State check |\n| --- | --- | ---: | ---: | ---: | --- |\n${table}\n\n` +
  `## Failure checks\n\nAll ${arms.length} arms rejected a deliberately stale observation and preserved the external edit. The structured adapter additionally reports complete match counts and continuations. This is not a capability missing from all possible shell programs: the jq baseline intentionally shares the same freshness guard.\n\n` +
  `## Interpretation\n\nFiltering reduces transferred bytes compared with full output, but jq is the important baseline. Protocol metadata and continuation requests are real costs. Dense retrieval and complete long-text consumption measure this cost rather than assuming progressive disclosure always helps.\n\n` +
  `No Agent accuracy, token savings or production performance is established. The query was supplied by the experiment, not discovered by a model. Three local timing samples are descriptive; compare their operation scope before using them. All source hashes, trials and per-exchange byte counts are in [the raw result](results/mechanism.json).\n\n` +
  `## Reproduce\n\n\`node --test audit/interaction/observation.test.mjs\`\n\n\`node audit/interaction/benchmark.mjs${adaptive ? ' --adaptive' : ''}\`\n`;
fs.writeFileSync(path.join(directory, 'REPORT.md'), report);
console.log(JSON.stringify({ status: 'PASS', trials: trials.length, staleRefusals: arms.length, summaries }, null, 2));
