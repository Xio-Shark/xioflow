#!/usr/bin/env node
// Actual read/edit tools in kernel transactions; deterministic provider only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, recoverAgentWorkspace } from '../../dist/index.js';
import { loadXiocode } from '../lib/xiocode.mjs';
import { runXiocodeQuantum } from './xiocode-quantum.mjs';

const { observationValidation } = await loadXiocode('src/runtime/parallel-observations.ts');
const replayPolicy = process.argv[2] ?? 'deterministic';
assert.ok(['recheck', 'deterministic'].includes(replayPolicy), 'Use recheck or deterministic');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-edit-recovery-')));
const root = path.join(temp, 'repo');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'util.mjs'), 'export function foo() { return 1; }\n');
fs.writeFileSync(path.join(root, 'caller.mjs'), "import { foo } from './util.mjs';\nconsole.log(foo());\n");
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
git('add', '.'); git('commit', '-qm', 'base');
const domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'e7');
const supervisor = new ProcessSupervisor(domain);
const providerCalls = [];
let releaseB;
const aFinishedEdits = new Promise((resolve) => { releaseB = resolve; });
let paused = false;

function clientFor(id) {
  return { async complete(request) {
    providerCalls.push(id);
    const count = request.messages.filter((message) => message.role === 'tool').length;
    const calls = id === 'b' ? [
      ['read', { path: 'caller.mjs' }],
      ['edit', { path: 'caller.mjs', old_string: 'console.log', new_string: '// B keeps this comment\nconsole.log' }],
    ] : [
      ['read', { path: 'util.mjs' }],
      ['edit', { path: 'util.mjs', old_string: 'foo', new_string: 'bar' }],
      ['read', { path: 'caller.mjs' }],
      ['edit', { path: 'caller.mjs', old_string: 'foo', new_string: 'bar', replace_all: true }],
    ];
    if (count === calls.length) return { content: 'done', toolCalls: [] };
    assert.ok(count < calls.length);
    const [name, args] = calls[count];
    return { content: '', toolCalls: [{ id: `${id}-${count}`, name, arguments: args }] };
  } };
}

const agents = new AgentRuntime(domain, { maxConcurrentAgents: 2, step: async (agent) => {
  if (agent.id === 'b') await aFinishedEdits;
  let result;
  try { result = await runXiocodeQuantum(agent, clientFor(agent.id)); }
  catch (error) { releaseB(); throw error; }
  if (agent.id === 'a' && result.checkpoint.log.length === 4 && !paused) {
    paused = true; agents.pause('a'); releaseB();
  }
  if (agent.id === 'b' && result.status === 'completed') {
    assert.equal((await supervisor.commitWorkspaceTransaction(agent.workspace.txId)).status, 'committed');
  }
  return result;
} });

try {
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'parallel edits', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'e7', status: 'running', startedAt: new Date().toISOString() });
  const create = async (id) => {
    const workspace = await supervisor.beginWorkspaceTransaction({ txId: id, runId: 'run', root, forkPath: path.join(temp, id) });
    agents.create({ id, runId: 'run', workspace, input: { instruction: id === 'b' ? 'Add a comment above console.log.' : 'Rename foo to bar.' },
      checkpoint: { snapshot: null, log: [] }, maxSteps: 12 });
    return workspace;
  };
  const old = await create('a'); await create('b');
  await agents.drain();
  assert.equal(agents.get('a').status, 'paused', JSON.stringify(agents.get('a')));
  assert.equal(agents.get('b').status, 'completed', JSON.stringify(agents.get('b')));
  assert.ok(fs.readFileSync(path.join(root, 'caller.mjs'), 'utf8').includes('// B keeps'));

  const baseline = await create('baseline'); await agents.drain();
  assert.equal(agents.get('baseline').status, 'completed', JSON.stringify(agents.get('baseline')));
  const expected = ['util.mjs', 'caller.mjs'].map((name) => fs.readFileSync(path.join(baseline.forkRoot, name), 'utf8'));

  const recovered = await recoverAgentWorkspace(agents, supervisor, {
    agentId: 'a', recoveryId: 'recover-a', root, forkPath: path.join(temp, 'recovered'),
    replayPolicy,
    observations: (checkpoint) => observationValidation(checkpoint.log),
  });
  assert.equal(recovered.status, 'restored');
  const prefix = agents.get('a').checkpoint.log.length;
  assert.ok(prefix > 0 && prefix < 4, `expected partial reuse, got ${prefix}`);
  assert.equal(agents.get('a').stepsUsed, 4);
  await supervisor.abortWorkspaceTransaction(old.txId);
  agents.resume('a'); await agents.drain();
  assert.equal(agents.get('a').status, 'completed', JSON.stringify(agents.get('a')));
  const actual = ['util.mjs', 'caller.mjs'].map((name) => fs.readFileSync(path.join(recovered.transaction.forkRoot, name), 'utf8'));
  assert.deepEqual(actual, expected);
  assert.equal((await supervisor.commitWorkspaceTransaction(recovered.transaction.txId)).status, 'committed');
  await supervisor.abortWorkspaceTransaction(baseline.txId);
  assert.equal(execFileSync(process.execPath, [path.join(root, 'caller.mjs')], { encoding: 'utf8' }), '1\n');
  assert.ok(fs.readFileSync(path.join(root, 'caller.mjs'), 'utf8').includes('// B keeps'));
  domain.reportRunSucceeded('run');
  console.log(JSON.stringify({ experiment: 'e7-edit-transaction-recovery', replayPolicy, realModelCalls: 0,
    snapshotCaptures: store.getJournalEvents(domain.domainId).filter((event) => event.type === 'SNAPSHOT_CAPTURED' && event.operationId?.startsWith('recover-a-')).length,
    reusedObservations: prefix, recoveryAttempts: recovered.attempts, replayedToolCalls: recovered.replayedSteps,
    skippedCheckpoints: recovered.skippedCheckpoints,
    rejectedBoundaries: recovered.rejections.map(({ replay, source }) => ({ divergedAt: replay.divergedAt, reason: replay.reason, source })),
    baselineRequests: providerCalls.filter((id) => id === 'baseline').length,
    resumedRequests: providerCalls.filter((id) => id === 'a').length - 4,
    spentSteps: agents.get('a').stepsUsed, sameCodeAsRestart: true, preservesCompetingCommit: true,
  }, null, 2));
} finally {
  agents.close(); domain.close(); fs.rmSync(temp, { recursive: true, force: true });
}
