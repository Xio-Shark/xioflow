// One process per run. Reuses xiocode's loop, checkpoints, tools and observation adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadXiocode } from '../lib/xiocode.mjs';
import { replayObservationLog } from '../../dist/workspace/observation-replay.js';
import { createSumClient } from './sum-client.mjs';

const { runAgentLoop } = await loadXiocode('src/runtime/agent-loop.ts');
const { ExtensionHost } = await loadXiocode('src/runtime/extension-host.ts');
const { createBuiltinTools } = await loadXiocode('src/runtime/tools/builtin.ts');
const { toObservationEntry, observationValidation } = await loadXiocode('src/runtime/parallel-observations.ts');

const [mode, root, savedPath, outputPath] = process.argv.slice(2);
assert.ok(['record', 'baseline', 'blind', 'validated'].includes(mode));
const prompt = 'Read a.txt and b.txt, then write their sum to result.txt.';
const log = [];
const checkpoints = [];
const counts = { providerRequests: 0, agentToolCalls: 0, validationToolCalls: 0, reconstructionToolCalls: 0 };
const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, grepOutline: false });
const host = new ExtensionHost();
for (const tool of tools.filter((tool) => ['read', 'write'].includes(tool.name))) host.registerTool(tool);

const client = createSumClient(() => { counts.providerRequests++; });

let resumeFrom;
let restoredOffset = 0;
if (mode === 'blind' || mode === 'validated') {
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.notEqual(saved.pid, process.pid);
  let matchedSteps = saved.log.length;
  if (mode === 'validated') {
    // Only reads were performed before this fixture's pause, so validation may
    // inspect this root without applying a divergent mutation. E4 covers writes.
    assert.ok(saved.log.every((entry) => entry.kind === 'observe'));
    const validation = observationValidation(saved.log);
    const replay = validation.replay;
    const result = await replayObservationLog({
      ...validation,
      replay: async (entry, target) => { counts.validationToolCalls++; return replay(entry, target); },
    }, root);
    matchedSteps = result.matchedSteps;
  }
  const selected = saved.checkpoints.findLast((checkpoint) => checkpoint.offset <= matchedSteps);
  assert.ok(selected);
  restoredOffset = selected.offset;
  resumeFrom = selected.snapshot;
  log.push(...saved.log.slice(0, restoredOffset));
  // Rehydrate read-before-edit state in THIS tool instance, not merely in the
  // separate validation adapter. Fixture paths are relative and portable.
  for (const entry of log) {
    const tool = tools.find((candidate) => candidate.name === entry.tool);
    assert.ok(tool);
    const result = await tool.execute(`restore-${counts.reconstructionToolCalls++}`, entry.args);
    assert.notEqual(result.isError, true);
  }
}

const pause = new Error('fixture pause at provider boundary');
try {
  const result = await runAgentLoop(prompt, {
    host, client, model: 'deterministic-fixture', maxTurns: 8,
    systemPrompt: 'Follow the assigned file task.', parallelToolCalls: false,
    ...(resumeFrom ? { resumeFrom } : {}),
    onToolEnd(call, result) {
      counts.agentToolCalls++;
      assert.notEqual(result.isError, true);
      const entry = toObservationEntry(call, result, root);
      assert.ok(entry);
      log.push(entry);
    },
    onCheckpoint(snapshot) {
      if (snapshot.phase !== 'awaiting_provider') return;
      checkpoints.push({ offset: log.length, snapshot });
      if (mode === 'record' && log.length === 2) {
        fs.writeFileSync(savedPath, JSON.stringify({ version: 1, pid: process.pid, log, checkpoints }), { mode: 0o600 });
        throw pause;
      }
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.messages.filter((message) => message.role === 'user').length, 1);
  fs.writeFileSync(outputPath, JSON.stringify({
    mode, pid: process.pid, restoredOffset, ...counts,
    content: fs.readFileSync(path.join(root, 'result.txt'), 'utf8'),
  }));
} catch (error) {
  if (error !== pause) throw error;
  fs.writeFileSync(outputPath, JSON.stringify({ mode, pid: process.pid, status: 'paused', ...counts }));
}
