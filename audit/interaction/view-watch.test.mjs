import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ObservedView } from './view-watch.mjs';
import { createWatchFixture, serviceView } from './watch-fixture.mjs';

async function until(predicate, message) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(10);
  }
}

function setup(t, options) {
  const fixture = createWatchFixture();
  const observer = new ObservedView(fixture.file, serviceView, options);
  t.after(() => { observer.close(); fixture.cleanup(); });
  return { fixture, observer };
}

test('server-side polling removes unchanged notifications without removing reads', { timeout: 3000 }, async (t) => {
  const { observer } = setup(t, { mode: 'server-poll', pollMs: 10 });
  await until(() => observer.metrics.readAttempts >= 4, 'poller did not read');
  assert.equal(observer.messages.length, 1);
  assert.equal(observer.latest.status, 'ok');
});

test('agent polling exposes each observed result including identical values', { timeout: 3000 }, async (t) => {
  const { observer } = setup(t, { mode: 'agent-poll', pollMs: 10 });
  await until(() => observer.metrics.readAttempts >= 4, 'poller did not read');
  assert.equal(observer.messages.length, observer.metrics.readAttempts);
  assert.equal(new Set(observer.messages.map((message) => message.viewVersion)).size, 1);
});

test('real directory events observe successive atomic file replacements', { timeout: 3000 }, async (t) => {
  const { fixture, observer } = setup(t, { mode: 'watch-view', reconcileMs: 10000 });
  for (const enabled of [true, false, true]) {
    fixture.records[0].enabled = enabled;
    fixture.replace();
    await until(() => observer.latest.view?.[0].enabled === enabled, 'replacement was not observed through fs.watch');
  }
  assert.equal(observer.metrics.reconciliations, 0);
  assert.ok(observer.messages.slice(1).every((message) => message.cause === 'event'));
});

test('irrelevant source changes update source evidence without waking the caller', { timeout: 3000 }, async (t) => {
  const { fixture, observer } = setup(t, { mode: 'watch-view', reconcileMs: 10000 });
  const previous = observer.latest.sourceVersion;
  fixture.records[20].notes = 'unrelated diagnostic changed';
  fixture.replace();
  await until(() => observer.latest.sourceVersion !== previous, 'source version was not refreshed');
  assert.equal(observer.messages.length, 1);
  assert.deepEqual(observer.latest.view, serviceView(fixture.records));
});

test('periodic reconciliation catches a change when event hints are deliberately dropped', { timeout: 3000 }, async (t) => {
  const { fixture, observer } = setup(t, { mode: 'watch-view', reconcileMs: 60, acceptHint: () => false });
  fixture.records[0].enabled = true;
  fixture.replace();
  await until(() => observer.latest.view?.[0].enabled === true && observer.metrics.suppressedHints > 0, 'missed hints were not reconciled');
  assert.equal(observer.messages.at(-1).cause, 'reconcile');
  assert.ok(observer.metrics.reconciliations > 0);
});

test('invalid data becomes unavailable and recovery to the same old value is visible', { timeout: 3000 }, async (t) => {
  const { fixture, observer } = setup(t, { mode: 'watch-view', reconcileMs: 80 });
  fixture.replace('{bad json');
  await until(() => observer.latest.status === 'unavailable', 'invalid data was hidden');
  assert.equal(observer.latest.code, 'invalid_source');
  assert.equal(observer.latest.view, undefined);
  fixture.replace();
  await until(() => observer.latest.status === 'ok', 'recovery was hidden');
  assert.deepEqual(observer.messages.map((message) => message.status), ['ok', 'unavailable', 'ok']);
});

test('closing releases the watcher and timers and prevents later reads', { timeout: 3000 }, async (t) => {
  const { fixture, observer } = setup(t, { mode: 'watch-view', reconcileMs: 10 });
  observer.close();
  const before = observer.metrics;
  fixture.records[0].enabled = true;
  fixture.replace();
  await delay(50);
  assert.deepEqual(observer.metrics, before);
  assert.equal(observer.metrics.closed, true);
  observer.close();
});

test('a broken projection fails instead of becoming an empty successful view', (t) => {
  const fixture = createWatchFixture();
  t.after(fixture.cleanup);
  assert.throws(() => new ObservedView(fixture.file, () => { throw new Error('projection bug'); }), /projection bug/);
});
