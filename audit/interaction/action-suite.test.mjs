import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ActionEpisode, referenceAction, gradeAction, ACTION_ARMS } from './action-episode.mjs';

test('all twelve action tasks complete through both actual CLI and object interfaces', async () => {
  for (const split of ['dev', 'heldout']) for (let index = 1; index <= 6; index += 1) for (const arm of ACTION_ARMS) {
    const episode = await ActionEpisode.create(`${split}-${String(index).padStart(2, '0')}`, arm);
    try { assert.equal((await referenceAction(episode)).passed, true, `${split}/${index}/${arm}`); }
    finally { await episode.close(); }
    assert.equal(episode.trace.activeCommands, 0);
    assert.equal(episode.trace.cleaned, true);
    assert.equal(episode.trace.restoration.restored || episode.trace.restoration.reason === 'target_exited', true);
  }
});

test('wrong instance actions leave the decoy file and actual runtime unchanged in both interfaces', async () => {
  for (const arm of ACTION_ARMS) {
    const episode = await ActionEpisode.create('dev-01', arm);
    try {
      const decoy = episode.fixture.decoy;
      const before = fs.readFileSync(decoy.configFile);
      const response = arm === 'object'
        ? await episode.handle('set_config', { instanceId: decoy.instanceId, expectedRevision: 1, setting: 42 })
        : await episode.handle('run_command', { argv: ['config-set', '--instance', decoy.instanceId, '--expected-revision', '1', '--setting', '42'] });
      assert.equal(response.error.code, 'wrong_instance');
      assert.deepEqual(fs.readFileSync(decoy.configFile), before);
      const state = await (await fetch(`${decoy.url}/state`)).json();
      assert.equal(state.setting, 999);
    } finally { await episode.close(); }
  }
});

test('competing and repeated writes cannot silently overwrite a changed revision', async () => {
  const episode = await ActionEpisode.create('dev-01', 'object');
  try {
    const args = { instanceId: episode.fixture.target.instanceId, expectedRevision: 1, setting: 44 };
    const results = await Promise.allSettled([episode.coordinator.act('set_config', args), episode.coordinator.act('set_config', { ...args, setting: 45 })]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'stale_revision');
    const actual = JSON.parse(fs.readFileSync(episode.fixture.target.configFile));
    assert.deepEqual(actual, { revision: 2, setting: 44 });
    await episode.coordinator.act('reload', { instanceId: args.instanceId, expectedRevision: 2 });
    await episode.coordinator.act('reload', { instanceId: args.instanceId, expectedRevision: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(episode.fixture.target.configFile)), actual);
  } finally { await episode.close(); }
});

test('accepted reload without an effect is rejected as applied by independent grading', async () => {
  const episode = await ActionEpisode.create('dev-06', 'object');
  try {
    const target = episode.fixture.target;
    const written = await episode.handle('set_config', { instanceId: target.instanceId, expectedRevision: 1, setting: episode.fixture.spec.desiredSetting });
    const receipt = await episode.handle('reload', { instanceId: target.instanceId, expectedRevision: written.revision });
    assert.equal(receipt.accepted, true);
    const sample = await episode.handle('inspect', { where: { environment: 'prod' } });
    assert.equal(sample.rows[0].configCurrent, false);
    const submission = { outcome: 'applied', instanceId: target.instanceId, evidenceId: sample.evidenceId };
    assert.equal((await gradeAction(episode.fixture, submission, episode.host.evidence, episode.coordinator.attempts)).passed, false);
    assert.equal((await episode.handle('submit', { ...submission, outcome: 'blocked' })).passed, true);
  } finally { await episode.close(); }
});

test('blocked without a real failure and an action receipt used as evidence are rejected', async () => {
  const episode = await ActionEpisode.create('dev-01', 'object');
  try {
    const sample = await episode.handle('inspect');
    const target = episode.fixture.target;
    const submission = { outcome: 'blocked', instanceId: target.instanceId, evidenceId: sample.evidenceId };
    assert.equal((await gradeAction(episode.fixture, submission, episode.host.evidence, [])).passed, false);
    assert.equal((await gradeAction(episode.fixture, { ...submission, outcome: 'applied', evidenceId: 'write-receipt' }, episode.host.evidence, [])).passed, false);
  } finally { await episode.close(); }
});

test('CLI errors are visible and its subprocess is gone after completion', async () => {
  const episode = await ActionEpisode.create('dev-01', 'command');
  try {
    assert.equal((await episode.handle('run_command', { argv: ['arbitrary-shell-command'] })).error.code, 'command_usage');
    assert.equal(episode.coordinator.commands.size, 0);
    assert.equal((await episode.handle('run_command', { argv: 'config-set' })).error.code, 'invalid_argv');
  } finally { await episode.close(); }
});

test('cancelled CLI is reaped and cleanup restores any completed partial write', async () => {
  const episode = await ActionEpisode.create('dev-01', 'command');
  const command = episode.coordinator.command(['config-set', '--instance', episode.fixture.target.instanceId, '--expected-revision', '1', '--setting', '88']);
  const rejected = assert.rejects(command, /Fixture CLI failed/);
  await episode.close();
  await rejected;
  assert.equal(episode.trace.cleaned, true);
  assert.equal(episode.trace.activeCommands, 0);
  assert.equal(episode.trace.restoration.restored, true);
});
