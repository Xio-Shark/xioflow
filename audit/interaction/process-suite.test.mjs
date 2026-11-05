import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ProcessFixture, processTask, atomicJson, sleep } from './process-fixture.mjs';
import { ProcessHost } from './process-host.mjs';
import { ProcessEpisode, referenceProcess } from './process-episode.mjs';
import { gradeProcess } from './process-grader.mjs';

test('all twelve real process tasks reach independently checked terminal states', async () => {
  for (const split of ['dev', 'heldout']) for (let index = 1; index <= 6; index += 1) {
    const id = `${split}-${String(index).padStart(2, '0')}`;
    const episode = await ProcessEpisode.create(id, 'agent-poll');
    try { assert.equal((await referenceProcess(episode)).passed, true, id); }
    finally { await episode.close(); }
    assert.equal(episode.trace.cleaned, true);
    assert.equal(episode.trace.cleanup.portsClosed, true);
  }
});

test('log-ready and wrong-environment evidence do not prove target readiness', async () => {
  const episode = await ProcessEpisode.create('dev-02', 'agent-poll', { tickMs: 500 });
  try {
    const snapshot = await episode.handle('inspect');
    const target = snapshot.rows.find((row) => row.environment === 'prod');
    const decoy = snapshot.rows.find((row) => row.environment !== 'prod');
    const log = await episode.handle('read_logs', { instanceId: target.instanceId });
    assert.match(log.text, /historical/);
    for (const row of [target, decoy]) {
      const result = await gradeProcess(episode.fixture, { outcome: 'ready', instanceId: row.instanceId, evidenceId: snapshot.evidenceId }, episode.host.evidence);
      assert.equal(result.passed, false);
    }
  } finally { await episode.close(); }
});

test('old configuration evidence is refused even after new configuration becomes ready', async () => {
  const fixture = await ProcessFixture.create({ ...processTask('dev-03'), kind: 'never' });
  const host = new ProcessHost(fixture, 'agent-poll');
  try {
    await fixture.control(fixture.target, 'ready', { value: true });
    const old = await host.call('inspect', { where: { environment: 'prod' } });
    atomicJson(fixture.target.configFile, { revision: 2, setting: 51 });
    await fixture.control(fixture.target, 'reload');
    const submission = { outcome: 'ready', instanceId: fixture.target.instanceId, evidenceId: old.evidenceId };
    assert.equal((await gradeProcess(fixture, submission, host.evidence)).passed, false);
    const current = await host.call('inspect', { where: { environment: 'prod' } });
    assert.equal((await gradeProcess(fixture, { ...submission, evidenceId: current.evidenceId }, host.evidence)).passed, true);
  } finally { host.close(); await fixture.close(); }
});

test('retired instance and invented evidence cannot establish current readiness', async () => {
  const episode = await ProcessEpisode.create('dev-05', 'agent-poll');
  try {
    const old = await episode.handle('inspect', { where: { environment: 'prod' } });
    await sleep(400);
    assert.notEqual(episode.fixture.target.instanceId, old.rows[0].instanceId);
    const submission = { outcome: 'ready', instanceId: old.rows[0].instanceId, evidenceId: old.evidenceId };
    assert.equal((await gradeProcess(episode.fixture, submission, episode.host.evidence)).passed, false);
    assert.equal((await gradeProcess(episode.fixture, { ...submission, evidenceId: 'invented' }, episode.host.evidence)).passed, false);
  } finally { await episode.close(); }
});

test('timeout and unavailability are explicit facts and distinct from exit', async () => {
  const spec = { ...processTask('dev-01'), kind: 'never', expected: 'timeout' };
  const fixture = await ProcessFixture.create(spec, { deadlineMs: 100 });
  const host = new ProcessHost(fixture, 'agent-poll', { onObservation: () => fixture.start() });
  try {
    const sample = await host.call('inspect');
    const submission = { outcome: 'timeout', instanceId: fixture.target.instanceId, evidenceId: sample.evidenceId };
    assert.equal((await gradeProcess(fixture, submission, host.evidence)).passed, false);
    await sleep(110);
    assert.equal((await gradeProcess(fixture, submission, host.evidence)).passed, true);
    fixture.spec.expected = 'unavailable';
    await fixture.control(fixture.target, 'unavailable', { value: true });
    const unavailable = await host.call('inspect');
    assert.equal((await gradeProcess(fixture, { ...submission, outcome: 'unavailable', evidenceId: unavailable.evidenceId }, host.evidence)).passed, true);
    assert.equal((await gradeProcess(fixture, { ...submission, outcome: 'exited', evidenceId: unavailable.evidenceId }, host.evidence)).passed, false);
  } finally { host.close(); await fixture.close(); }
});

test('event wait converges despite deliberately dropped hints', async () => {
  const episode = await ProcessEpisode.create('heldout-06', 'event-view', { dropHints: true, intervalMs: 30 });
  try { assert.equal((await referenceProcess(episode)).passed, true); }
  finally { await episode.close(); }
  assert.equal(episode.host.metrics.activeTimers, 0);
  assert.equal(episode.host.metrics.activeWatchers, 0);
});

test('closing an active wait cancels its timer and watcher', async () => {
  const fixture = await ProcessFixture.create({ ...processTask('dev-01'), kind: 'never' });
  const host = new ProcessHost(fixture, 'event-view');
  const initial = await host.call('inspect');
  const pending = host.call('watch', { after: initial.evidenceId, until: { ready: true }, maxWaitMs: 10000 });
  const rejected = assert.rejects(pending, /host_closed/);
  await sleep(30);
  host.close();
  await rejected;
  const cleanup = await fixture.close();
  assert.equal(cleanup.directoryRemoved, true);
  assert.equal(host.metrics.activeWatchers, 0);
  assert.equal(host.metrics.activeTimers, 0);
});

test('partial startup failure and repeated close release actual children and directories', async () => {
  await assert.rejects(ProcessFixture.create(processTask('dev-01'), { failStart: true }), (error) => {
    assert.equal(error.cleanup.childrenClosed, true);
    assert.equal(error.cleanup.directoryRemoved, true);
    return /injected_partial_start_failure/.test(error.message);
  });
  const fixture = await ProcessFixture.create(processTask('dev-01'));
  const first = await fixture.close();
  assert.deepEqual(await fixture.close(), first);
  assert.equal(fs.existsSync(fixture.directory), false);
});

test('invalid predicates, unknown instance access and unsupported writes fail visibly', async () => {
  const episode = await ProcessEpisode.create('dev-01', 'agent-poll');
  try {
    assert.equal((await episode.handle('inspect', { where: { hiddenOracle: true } })).error.code, 'invalid_predicate');
    assert.equal((await episode.handle('read_logs', { instanceId: '../../other' })).error.code, 'unknown_instance');
    assert.equal((await episode.handle('write', { setting: 42 })).error.code, 'unsupported_operation');
  } finally { await episode.close(); }
});

test('internal samples that were never returned are not submittable evidence', async () => {
  const fixture = await ProcessFixture.create({ ...processTask('dev-01'), kind: 'never' });
  const host = new ProcessHost(fixture, 'server-poll');
  try {
    await fixture.control(fixture.target, 'ready', { value: true });
    const internal = await host.capture({ environment: 'prod' });
    assert.equal((await gradeProcess(fixture, { outcome: 'ready', instanceId: fixture.target.instanceId,
      evidenceId: internal.evidenceId }, host.evidence)).passed, false);
  } finally { host.close(); await fixture.close(); }
});
