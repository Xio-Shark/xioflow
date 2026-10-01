#!/usr/bin/env node
// Deterministic mechanism experiment, not a model/token benchmark.
// Build first: pnpm build; node audit/observation/e4.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replayObservationLog } from '../../dist/workspace/observation-replay.js';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const stages = ['a', 'b', 'c'];
const initial = { a: '1', b: '2', c: '3', unrelated: 'untouched' };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-prefix-'));

function workspace(name, inputs) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(root);
  for (const [key, value] of Object.entries(inputs)) fs.writeFileSync(path.join(root, `${key}.txt`), value);
  return root;
}

function execute(entry, root) {
  const { tool, args } = entry.call;
  if (tool === 'read') return fs.readFileSync(path.join(root, args.file), 'utf8');
  if (tool === 'write') {
    fs.writeFileSync(path.join(root, args.file), args.text);
    return 'written';
  }
  throw new Error(`Unknown fixture tool: ${tool}`);
}

// One scripted decision reads an input and writes a result that depends on ALL
// observations so far. Checkpoints exist only between decisions, not mid-turn.
function run(root, start = 0, context = []) {
  const log = [];
  const checkpoints = [{ offset: start * 2, context: [...context] }];
  for (let i = start; i < stages.length; i++) {
    const read = { kind: 'observe', call: { tool: 'read', args: { file: `${stages[i]}.txt` } } };
    const value = execute(read, root);
    log.push({ ...read, resultHash: sha(value) });
    context.push(value);
    const write = { kind: 'mutate', call: { tool: 'write', args: { file: `${stages[i]}.out`, text: context.join(',') } } };
    log.push({ ...write, resultHash: sha(execute(write, root)) });
    checkpoints.push({ offset: (i + 1) * 2, context: [...context] });
  }
  return { log, checkpoints, decisions: stages.length - start };
}

function tree(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
}

try {
  const original = workspace('original', initial);
  const recorded = run(original);
  const cases = [
    { name: 'unchanged', changes: {}, expectedPrefix: 6 },
    { name: 'unrelated', changes: { unrelated: 'changed' }, expectedPrefix: 6 },
    { name: 'early', changes: { a: '10' }, expectedPrefix: 0 },
    { name: 'middle', changes: { b: '20' }, expectedPrefix: 2 },
    { name: 'late', changes: { c: '30' }, expectedPrefix: 4 },
    { name: 'multiple', changes: { b: '20', c: '30' }, expectedPrefix: 2 },
    { name: 'middle-coarse-checkpoints', changes: { b: '20' }, expectedPrefix: 2, checkpoints: [0, 4, 6] },
  ];
  const rows = [];
  for (const scenario of cases) {
    const inputs = { ...initial, ...scenario.changes };
    const baselineRoot = workspace(`${scenario.name}-baseline`, inputs);
    const baseline = run(baselineRoot);
    const validationRoot = workspace(`${scenario.name}-validation`, inputs);
    let validationCalls = 0;
    const replay = async (entry, root) => sha(execute(entry, root));
    const result = await replayObservationLog({
      log: recorded.log,
      replay: async (entry, root) => { validationCalls++; return replay(entry, root); },
    }, validationRoot);
    assert.equal(result.matchedSteps, scenario.expectedPrefix);
    const checkpoint = recorded.checkpoints.findLast((c) => c.offset <= result.matchedSteps
      && (!scenario.checkpoints || scenario.checkpoints.includes(c.offset)));

    // Never resume on the validation fork: a divergent tool may have mutated it.
    // Reconstruct only a fully checked prefix from the SAME current input state.
    // A fully matched fork is already reconstructed; do not repeat its tools.
    const recoveredRoot = result.status === 'matched' ? validationRoot : workspace(`${scenario.name}-recovered`, inputs);
    const prefix = result.status === 'matched' ? [] : recorded.log.slice(0, checkpoint.offset);
    if (result.status === 'diverged') {
      const rebuilt = await replayObservationLog({ log: prefix, replay }, recoveredRoot);
      assert.deepEqual(rebuilt, { status: 'matched', matchedSteps: checkpoint.offset });
    }
    const resumed = run(recoveredRoot, checkpoint.offset / 2, [...checkpoint.context]);
    assert.deepEqual(tree(recoveredRoot), tree(baselineRoot));
    for (const [key, value] of Object.entries(scenario.changes)) {
      assert.equal(fs.readFileSync(path.join(recoveredRoot, `${key}.txt`), 'utf8'), value);
    }
    rows.push({
      scenario: scenario.name,
      matchedSteps: result.matchedSteps,
      checkpointOffset: checkpoint.offset,
      baselineDecisions: baseline.decisions,
      resumedDecisions: resumed.decisions,
      reusedDecisions: checkpoint.offset / 2,
      baselineToolCalls: baseline.log.length,
      validationToolCalls: validationCalls,
      reconstructionToolCalls: prefix.length,
      resumedToolCalls: resumed.log.length,
      totalRecoveryToolCalls: validationCalls + prefix.length + resumed.log.length,
      sameFinalTree: true,
    });
  }
  console.log(JSON.stringify({ experiment: 'e4-scripted-prefix-recovery', realModelCalls: 0, rows }, null, 2));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
