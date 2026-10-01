#!/usr/bin/env node
// Self-check of evidence.mjs (todolist 1.3). Usage: node audit/freshness/selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceStatus, runWithEvidence } from './evidence.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-fresh-')));
try {
  fs.mkdirSync(path.join(root, 'src'));
  for (const name of ['a', 'b', 'c', 'unused']) fs.writeFileSync(path.join(root, 'src', `${name}.mjs`), `export const ${name} = '${name}';\n`);
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(root, 'check.mjs'), "import { a } from './src/a.mjs';\nimport { b } from './src/b.mjs';\nif (a + b !== 'ab') process.exit(1);\n");
  const argv = [process.execPath, 'check.mjs'];

  for (const normalize of ['all', 'one-pass']) {
    const first = runWithEvidence(root, argv, { normalize });
    const second = runWithEvidence(root, argv, { normalize });
    assert.equal(first.exitCode, 0);
    assert.deepEqual(Object.keys(first.evidence.entries), ['check.mjs', 'src/a.mjs', 'src/b.mjs'], `read set with ${normalize}`);
    assert.equal(first.evidence.digest, second.evidence.digest, 'the same command twice reads the same set');
    assert.deepEqual(evidenceStatus(root, first.evidence), { status: 'fresh' });
  }

  const evidence = runWithEvidence(root, argv).evidence;
  fs.writeFileSync(path.join(root, 'README.md'), '# changed\n');
  fs.writeFileSync(path.join(root, 'src/unused.mjs'), "export const unused = 'changed';\n");
  assert.deepEqual(evidenceStatus(root, evidence), { status: 'fresh' }, 'changes outside the read set leave the evidence fresh');
  fs.writeFileSync(path.join(root, 'src/b.mjs'), "export const b = 'B';\n");
  assert.deepEqual(evidenceStatus(root, evidence), { status: 'stale', changed: ['src/b.mjs'] });
  fs.rmSync(path.join(root, 'src/a.mjs'));
  assert.deepEqual(evidenceStatus(root, evidence).changed, ['src/a.mjs', 'src/b.mjs'], 'a deleted dependency is a change');
  assert.equal(evidenceStatus(root, { tracking: 'unobserved' }).status, 'unknown');
  console.log('selfcheck: evidence.mjs ok (read set 3 of 6 files; fresh / stale / unknown as expected; both reset strategies agree)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
