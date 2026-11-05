import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(directory, '../../spec/isa-v1/registry.json');
const before = fs.readFileSync(source);
const document = JSON.parse(before);
const requests = [
  { id: 1, op: 'describe' },
  { id: 2, op: 'query', args: { where: { op: 'proc.inspect' }, select: ['op', 'observation', 'drivers'] } },
  { id: 3, op: 'query', args: { where: { atomicity: 'pure' }, select: ['op'], maxBytes: 65536 } },
  { id: 4, op: 'setEnabled', args: { ref: 'r0', value: true } },
];
const child = spawnSync(process.execPath, [path.join(directory, 'session.mjs'), source, 'opcodes'], {
  input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`, encoding: 'utf8', timeout: 5000,
});
assert.equal(child.status, 0, child.stderr);
const responses = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
assert.equal(responses.length, requests.length);
assert.equal(responses[0].result.version, digest(before));
assert.equal(responses[0].result.records, document.opcodes.length);
assert.deepEqual(responses[1].result.rows[0].values, Object.fromEntries(['drivers', 'observation', 'op'].map((field) => [field, document.opcodes.find((entry) => entry.op === 'proc.inspect')[field]])));
assert.deepEqual(responses[2].result.rows.map((row) => row.values.op), document.opcodes.filter((entry) => entry.atomicity === 'pure').map((entry) => entry.op));
assert.equal(responses[3].error.code, 'unsupported_operation');
assert.deepEqual(fs.readFileSync(source), before);
const result = { status: 'PASS', source: 'spec/isa-v1/registry.json', sourceSha256: digest(before), sourceUnchanged: true,
  evidenceClass: 'real-repository-readonly-transport-no-model', requests, responses };
fs.mkdirSync(path.join(directory, 'results'), { recursive: true });
fs.writeFileSync(path.join(directory, 'results/repository-smoke.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, source: result.source, sourceUnchanged: result.sourceUnchanged, records: responses[0].result.records,
  inspected: responses[1].result.rows[0].values, pureOperations: responses[2].result.rows.map((row) => row.values.op) }, null, 2));
