#!/usr/bin/env node
// Local persistence benchmark. No model/network calls; fixed growing JSON history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ExecutionDomain } from '../../dist/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-journal-size-'));
const steps = 60;
const input = { instruction: 'fixed instruction '.repeat(1024) };
let singleCopyDataBytes = Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(JSON.stringify({ history: [] }));
const domain = ExecutionDomain.acquire(root, 'size');
const store = domain.getStore();
const legacyControl = process.argv.includes('--legacy-control');
if (legacyControl) {
  // Same scheduler and SQLite store, but materialize each state as the former
  // full-payload encoding. This trace has no restore references during dispatch.
  const record = store.recordJournalEvent.bind(store);
  let prior;
  store.recordJournalEvent = (event) => {
    if (event.type !== 'AGENT_STATE' || event.payload.version !== 2) return record(event);
    assert.equal(event.payload.checkpointRef, undefined);
    const { payload } = event;
    prior = { ...payload.state,
      input: Object.hasOwn(payload, 'input') ? payload.input : prior.input,
      checkpoint: Object.hasOwn(payload, 'checkpoint') ? payload.checkpoint : prior.checkpoint,
    };
    return record({ ...event, payload: { version: 1, transition: payload.transition, state: prior } });
  };
}
store.saveTask({ id: 'task', domainId: domain.domainId, name: 'size', createdAt: new Date().toISOString() });
store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'size', status: 'running', startedAt: new Date().toISOString() });
let agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async (agent) => {
  const checkpoint = { history: [...agent.checkpoint.history, { text: `${agent.stepsUsed}:` + 'x'.repeat(4096) }] };
  singleCopyDataBytes += Buffer.byteLength(JSON.stringify(checkpoint));
  return { status: agent.stepsUsed === steps ? 'completed' : 'ready', checkpoint };
} });
try {
  const start = performance.now();
  agents.create({ id: 'a', runId: 'run', input, checkpoint: { history: [] }, maxSteps: steps });
  await agents.drain();
  const elapsedMs = performance.now() - start;
  const events = store.getJournalEvents(domain.domainId).filter((event) => event.type === 'AGENT_STATE');
  const journalBytes = events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload)), 0);
  agents.close();
  agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async () => { throw new Error('must not rerun'); } });
  assert.equal(agents.get('a').checkpoint.history.length, steps);
  assert.deepEqual(agents.get('a').input, input);
  const checkpoints = agents.checkpoints('a');
  assert.equal(checkpoints.length, steps + 1);
  for (let i = 0; i <= steps; i++) {
    assert.deepEqual(checkpoints[i].checkpoint.history,
      Array.from({ length: i }, (_, index) => ({ text: `${index + 1}:` + 'x'.repeat(4096) })));
  }
  domain.reportRunSucceeded('run');
  console.log(JSON.stringify({ experiment: 'e9-agent-journal-size', encoding: legacyControl ? 'legacy-control' : 'compact', steps, stateEvents: events.length,
    journalBytes, singleCopyDataBytes, amplification: journalBytes / singleCopyDataBytes, elapsedMs,
    restoredHistory: agents.get('a').checkpoint.history.length }, null, 2));
} finally { agents.close(); domain.close(); fs.rmSync(root, { recursive: true, force: true }); }
