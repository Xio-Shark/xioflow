import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { taskDefinitions, createTaskCase } from './task-cases.mjs';
import { TaskEpisode } from './task-episode.mjs';
import { TaskHost, ARMS } from './task-host.mjs';
import { solveReference } from './task-reference.mjs';
import { wireBytes } from './observation.mjs';

function episodeFor(t, id, arm = 'structured') {
  const episode = new TaskEpisode(id, arm);
  t.after(() => episode.close());
  return episode;
}

const specFor = (id) => taskDefinitions().find((spec) => spec.id === id);
const answer = (episode, id, arm = 'structured', options) => solveReference(episode, specFor(id), arm, options);
const submit = (episode, args) => episode.handle({ op: 'submit', args }).result;

test('all twelve tasks are reachable through all three arms; repository source is unchanged', () => {
  assert.equal(taskDefinitions('dev').length, 6);
  assert.equal(taskDefinitions('heldout').length, 6);
  const registry = new URL('../../spec/isa-v1/registry.json', import.meta.url);
  const before = fs.readFileSync(registry);
  for (const spec of taskDefinitions()) {
    for (const arm of ARMS) {
      const episode = new TaskEpisode(spec.id, arm);
      try {
        const submission = solveReference(episode, spec, arm);
        assert.equal(submit(episode, submission).passed, true, `${spec.id}/${arm}`);
        assert.equal(episode.finished, true);
        assert.throws(() => episode.handle({ op: 'describe' }), { code: 'episode_finished' });
      } finally { episode.close(); }
      assert.equal(episode.trace.cleaned, true);
    }
  }
  assert.deepEqual(fs.readFileSync(registry), before);
});

test('wrong object, duplicated IDs and omitted members are refused despite a current observed version', (t) => {
  for (const fault of ['wrong-object', 'duplicate', 'omission']) {
    const id = fault === 'wrong-object' ? 'dev-01' : 'dev-02';
    const episode = episodeFor(t, id);
    const submission = answer(episode, id);
    if (fault === 'wrong-object') submission.answer.id = 'unrelated-instance';
    if (fault === 'duplicate') submission.answer.ids.push(submission.answer.ids[0]);
    if (fault === 'omission') { submission.answer.ids.pop(); submission.answer.count -= 1; }
    const verdict = submit(episode, submission);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.checks.currentSourceVersion, true);
    assert.equal(verdict.checks.versionWasObserved, true);
    assert.equal(verdict.checks.answerMatches, false);
  }
});

test('a first page is not accepted as a complete set even with a plausible count', (t) => {
  const episode = episodeFor(t, 'dev-02');
  const response = episode.handle({ op: 'query', args: { where: { environment: 'prod', enabled: false }, select: ['id'], maxBytes: 400 } });
  assert.equal(response.status, 'ok');
  assert.equal(response.result.complete, false);
  const ids = response.result.rows.map((row) => row.values.id);
  const verdict = submit(episode, { version: response.result.version, answer: { ids, count: ids.length } });
  assert.equal(verdict.checks.answerMatches, false);
});

test('missing, null and empty string must remain distinct', (t) => {
  const episode = episodeFor(t, 'dev-05');
  const submission = answer(episode, 'dev-05');
  assert.ok(submission.answer.missing.length > 0 && submission.answer.null.length > 0 && submission.answer.empty.length > 0);
  submission.answer.null.push(...submission.answer.missing);
  submission.answer.missing = [];
  assert.equal(submit(episode, submission).passed, false);
});

test('the last actual failure is required, not an earlier failure or INFO mention', (t) => {
  const episode = episodeFor(t, 'dev-04');
  const submission = answer(episode, 'dev-04');
  submission.answer.code = 'E_DNS';
  submission.answer.message = '早期域名解析失败，稍后已恢复';
  assert.equal(submit(episode, submission).checks.answerMatches, false);
});

test('all arms reject stale submissions after the same first-data-read mutation', (t) => {
  for (const arm of ARMS) {
    const episode = episodeFor(t, 'dev-06', arm);
    const submission = answer(episode, 'dev-06', arm, { refresh: false });
    const changes = episode.trace.events.filter((event) => event.type === 'environment_change');
    assert.equal(changes.length, 1);
    const verdict = submit(episode, submission);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.checks.currentSourceVersion, false);
    assert.equal(verdict.checks.versionWasObserved, true);
  }
});

test('metadata alone is not data evidence, and a guessed current version is refused', (t) => {
  const reference = episodeFor(t, 'dev-01');
  const correct = answer(reference, 'dev-01');
  const episode = episodeFor(t, 'dev-01');
  const metadata = episode.handle({ op: 'describe' }).result;
  const verdict = submit(episode, { version: metadata.version, answer: correct.answer });
  assert.equal(verdict.checks.currentSourceVersion, true);
  assert.equal(verdict.checks.answerMatches, true);
  assert.equal(verdict.checks.versionWasObserved, false);
});

test('old row references cannot be reused after refresh and row reordering', (t) => {
  const episode = episodeFor(t, 'dev-06');
  const old = episode.handle({ op: 'query', args: { where: { name: 'billing-api', environment: 'prod' }, select: ['id'] } }).result;
  episode.handle({ op: 'refresh' });
  const reply = episode.handle({ op: 'readText', args: { ref: old.rows[0].ref, version: old.version, field: 'notes' } });
  assert.equal(reply.error.code, 'invalid_version');
});

test('malformed requests and writes fail explicitly without poisoning later reads', (t) => {
  const episode = episodeFor(t, 'dev-01');
  assert.equal(episode.handleLine('{bad').error.code, 'invalid_json');
  assert.equal(episode.handle(null).error.code, 'invalid_request');
  assert.equal(episode.handle({ op: 'query', args: null }).error.code, 'invalid_args');
  assert.equal(episode.handle({ op: 'query' }).error.code, 'invalid_args');
  assert.equal(episode.handle({ op: 'full' }).error.code, 'unsupported_operation');
  assert.equal(episode.handle({ op: 'setEnabled', args: { value: true } }).error.code, 'unsupported_operation');
  assert.equal(episode.handle({ op: 'help', args: [] }).error.code, 'invalid_args');
  assert.equal(episode.handle({ op: 'describe' }).status, 'ok');
  assert.equal(submit(episode, { answer: {} }).checks.submissionShape, false);
  assert.equal(episode.finished, true);
});

test('full and jq enforce the same explicit result budget without clipping', (t) => {
  for (const arm of ['full', 'jq']) {
    const episode = episodeFor(t, 'dev-06', arm);
    const args = arm === 'jq' ? { program: '.' } : {};
    assert.equal(episode.handle({ op: arm, args: { ...args, maxBytes: 256 } }).error.code, 'budget_too_small');
    assert.equal(episode.trace.events.filter((event) => event.type === 'environment_change').length, 0);
    assert.equal(episode.handle({ op: arm, args: { ...args, maxBytes: null } }).error.code, 'invalid_budget');
    const response = episode.handle({ op: arm, args: { ...args, maxBytes: 65536 } });
    assert.equal(response.status, 'ok');
    assert.ok(wireBytes(response.result) <= 65536);
    assert.equal(episode.trace.events.filter((event) => event.type === 'environment_change').length, 1);
  }
});

test('jq errors remain errors, and jq does not inherit arbitrary host environment values', (t) => {
  const fixture = createTaskCase('dev-01');
  t.after(() => fixture.cleanup());
  const host = new TaskHost(fixture.file, { arm: 'jq' });
  const previous = process.env.XIO_TASK_TEST_SECRET;
  process.env.XIO_TASK_TEST_SECRET = 'synthetic-marker';
  try {
    assert.deepEqual(host.call('jq', { program: 'env | has("XIO_TASK_TEST_SECRET")' }).values, [false]);
  } finally {
    if (previous === undefined) delete process.env.XIO_TASK_TEST_SECRET;
    else process.env.XIO_TASK_TEST_SECRET = previous;
  }
  assert.throws(() => host.call('jq', { program: '.[[' }), { code: 'jq_failed' });
  assert.equal(host.call('jq', { program: 'length' }).values[0], 72);
});

test('JSONL CLI exposes the protocol, preserves errors and records an unfinished episode as failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-task-cli-test-'));
  try {
    const trace = path.join(directory, 'trace.json');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./task-session.mjs', import.meta.url)), 'dev-01', 'structured', '--trace', trace], {
      input: '{bad\n{"id":1,"op":"describe"}\n', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 1, child.stderr);
    const replies = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(replies[0].type, 'ready');
    assert.deepEqual(Object.keys(replies[0].task).sort(), ['answerShape', 'goal', 'id', 'source', 'split', 'submission']);
    assert.equal(replies[1].error.code, 'invalid_json');
    assert.equal(replies[2].result.records, 72);
    const record = JSON.parse(fs.readFileSync(trace));
    assert.equal(record.verdict.reason, 'no_submission');
    assert.equal(record.cleaned, true);
    assert.equal(record.metrics.errors, 1);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('JSONL CLI accepts a data-derived answer and exits without waiting for client EOF', { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./task-session.mjs', import.meta.url)), 'dev-01', 'full'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  const lines = readline.createInterface({ input: child.stdout });
  let verdict;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for await (const line of lines) {
    const response = JSON.parse(line);
    if (response.type === 'ready') child.stdin.write(`${JSON.stringify({ id: 1, op: 'full', args: { maxBytes: 65536 } })}\n`);
    else if (response.id === 1) {
      assert.equal(response.status, 'ok');
      const row = response.result.records.find((record) => record.name === 'billing-api' && record.environment === 'prod');
      child.stdin.write(`${JSON.stringify({ id: 2, op: 'submit', args: { version: response.result.version,
        answer: { id: row.id, port: row.port, owner: row.owner } } })}\n`);
    } else if (response.id === 2) verdict = response.result;
  }
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(verdict.passed, true);
});
