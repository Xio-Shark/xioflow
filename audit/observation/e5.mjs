#!/usr/bin/env node
// Existing agent runner + real built-in tools, fresh process on each resume.
// No real model/API call. Build xioflow first; XIOCODE_ROOT selects the checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agent-resume-')));
const worker = path.join(import.meta.dirname, 'e5-worker.mjs');
const saved = path.join(sandbox, 'checkpoint.json');

function workspace(name, a, b) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), `A=${a}\n`);
  fs.writeFileSync(path.join(root, 'b.txt'), `B=${b}\n`);
  return root;
}

function run(mode, root) {
  const output = path.join(sandbox, `${path.basename(root)}.json`);
  const result = spawnSync(process.execPath, [worker, mode, root, saved, output], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

try {
  const recorded = run('record', workspace('record', 1, 2));
  assert.equal(recorded.status, 'paused');
  assert.equal(recorded.providerRequests, 2);
  const rows = [];
  for (const scenario of [
    { name: 'unchanged', a: 1, b: 2, expectedOffset: 2 },
    { name: 'second-observation-changed', a: 1, b: 20, expectedOffset: 1 },
    { name: 'first-observation-changed', a: 10, b: 2, expectedOffset: 0 },
  ]) {
    const results = {};
    for (const mode of ['baseline', 'blind', 'validated']) {
      results[mode] = run(mode, workspace(`${scenario.name}-${mode}`, scenario.a, scenario.b));
    }
    assert.equal(results.validated.content, results.baseline.content);
    assert.equal(results.validated.restoredOffset, scenario.expectedOffset);
    assert.equal(results.baseline.content, `sum=${scenario.a + scenario.b}\n`);
    const blindCorrect = results.blind.content === results.baseline.content;
    assert.equal(blindCorrect, scenario.name === 'unchanged');
    rows.push({ scenario: scenario.name, blindCorrect, validatedCorrect: true, results });
  }
  console.log(JSON.stringify({ experiment: 'e5-existing-runner-checkpoint', realModelCalls: 0, recorded, rows }, null, 2));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
