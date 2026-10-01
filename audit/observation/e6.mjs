#!/usr/bin/env node
// Kernel owns scheduling/checkpoints; xiocode supplies one model/tool quantum.
// Fixture inputs a.txt/b.txt are read-only, result.txt is write-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain } from '../../dist/index.js';
import { replayObservationLog } from '../../dist/workspace/observation-replay.js';
import { loadXiocode } from '../lib/xiocode.mjs';
import { createSumClient } from './sum-client.mjs';
import { runXiocodeQuantum } from './xiocode-quantum.mjs';

const { observationValidation } = await loadXiocode('src/runtime/parallel-observations.ts');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-kernel-agents-')));
let domain;
let runtime;
let paused = false;
const providerCalls = [];
const counts = { validationToolCalls: 0 };

async function step(agent) {
  const client = createSumClient(() => { providerCalls.push(agent.id); });
  const result = await runXiocodeQuantum(agent, client);
  // Pause A after two reads while B is allowed to finish.
  if (agent.id === 'a' && result.checkpoint.log.length === 2 && !paused) {
    paused = true;
    runtime.pause('a');
  }
  return result;
}

async function validate(agent) {
  // This workload never writes its input files. General edit trajectories need
  // transaction-fork replay, not filtering arbitrary mutation logs like this.
  const reads = agent.checkpoint.log.filter((entry) => entry.kind === 'observe');
  assert.ok(reads.every((entry) => ['a.txt', 'b.txt'].includes(entry.args.path)));
  const validation = observationValidation(reads);
  const replay = validation.replay;
  const result = await replayObservationLog({ ...validation, replay: async (entry, root) => {
    counts.validationToolCalls++;
    return replay(entry, root);
  } }, agent.input.root);
  return result.status === 'matched' ? 'valid' : 'stale';
}

function open() {
  domain = ExecutionDomain.acquire(path.join(sandbox, 'domain'), 'e6');
  runtime = new AgentRuntime(domain, { maxConcurrentAgents: 2, step, validate });
}

try {
  open();
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'two agents', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'e6', status: 'running', startedAt: new Date().toISOString() });
  for (const id of ['a', 'b']) {
    const root = path.join(sandbox, id);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'A=1\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B=2\n');
    runtime.create({ id, runId: 'run', maxSteps: 8, input: { root, instruction: 'Read both inputs and write their sum.' }, checkpoint: { snapshot: null, log: [] } });
  }
  await runtime.drain();
  assert.equal(runtime.get('a').status, 'paused');
  assert.equal(runtime.get('a').stepsUsed, 2);
  assert.equal(runtime.get('b').status, 'completed');
  assert.equal(fs.readFileSync(path.join(sandbox, 'b/result.txt'), 'utf8'), 'sum=3\n');

  runtime.close(); domain.close(); open();
  fs.writeFileSync(path.join(sandbox, 'a/b.txt'), 'B=20\n');
  const before = providerCalls.length;
  runtime.resume('a'); await runtime.drain();
  assert.equal(runtime.get('a').reason, 'evidence_stale');
  assert.equal(providerCalls.length, before);
  assert.equal(runtime.get('a').stepsUsed, 2);

  const valid = await runtime.findValidCheckpoint('a');
  assert.ok(valid);
  assert.equal(valid.checkpoint.log.length, 1);
  runtime.restoreCheckpoint('a', valid.seq);
  assert.equal(runtime.get('a').stepsUsed, 2);
  runtime.resume('a'); await runtime.drain();
  assert.equal(runtime.get('a').status, 'completed');
  assert.equal(runtime.get('a').stepsUsed, 5);
  assert.equal(fs.readFileSync(path.join(sandbox, 'a/result.txt'), 'utf8'), 'sum=21\n');
  domain.reportRunSucceeded('run');
  console.log(JSON.stringify({ experiment: 'e6-kernel-owned-agents', realModelCalls: 0,
    providerCalls, ...counts, agents: runtime.list().map(({ id, status, stepsUsed }) => ({ id, status, stepsUsed })),
    staleDispatchBlocked: true, restoredBudgetPreserved: true,
  }, null, 2));
} finally {
  runtime?.close(); domain?.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
}
