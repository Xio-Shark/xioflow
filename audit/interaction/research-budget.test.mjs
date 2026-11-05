import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchBudget, accounted, writeJson } from './research-budget.mjs';
import { digest } from './observation.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-research-budget-'));
  writeJson(path.join(root, 'budget.json'), { limitUsd: 5, calls: [{ id: 1, state: 'settled', accountedUsd: 0.55, reservedUsd: 0.6 }] });
  return root;
}
const payload = { max_tokens: 2048, messages: [{ role: 'user', content: 'hello' }] };
test('cumulative batch ceiling includes pending reservations and survives recovery', () => {
  const root = fixture();
  let budget;
  try {
    budget = new ResearchBudget(root, { capUsd: 0.56, experiment: 'test' });
    const first = budget.reserve(payload, { phase: 'pilot', taskId: 'test' });
    assert.ok(accounted(budget.ledger) > 0.55);
    assert.throws(() => budget.reserve({ ...payload, messages: [{ content: 'x'.repeat(20000) }] }, {}), /reservation refused/);
    first.state = 'unknown-charge-reserved'; first.failureClass = 'provider_empty_response'; first.accountedUsd = first.reservedUsd;
    budget.save(); budget.close();
    budget = new ResearchBudget(root, { capUsd: 0.56, experiment: 'test' });
    assert.equal(budget.ledger.calls.length, 2);
    assert.ok(accounted(budget.ledger) > 0.55);
  } finally { budget?.close(); fs.rmSync(root, { recursive: true }); }
});
test('one global lock prevents concurrent old/new runners and is not stolen', () => {
  const root = fixture();
  const first = new ResearchBudget(root, { capUsd: 1.55, experiment: 'test' });
  try {
    assert.throws(() => new ResearchBudget(root, { capUsd: 1.55, experiment: 'other' }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(root, 'runner.lock'), 'utf8').trim(), String(process.pid));
  } finally { first.close(); fs.rmSync(root, { recursive: true }); }
});
test('unknown prior charges block requests without erasing ledger or leaking lock', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'budget.json');
    const ledger = JSON.parse(fs.readFileSync(file));
    ledger.calls.push({ id: 2, state: 'unknown-charge', reservedUsd: 0.01 }); writeJson(file, ledger);
    const before = fs.readFileSync(file);
    assert.throws(() => new ResearchBudget(root, { capUsd: 1.55, experiment: 'test' }), /Unreviewed/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(path.join(root, 'runner.lock')), false);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('a reviewed timeout is bound to the exact request digest and full reservation', () => {
  const root = fixture();
  let budget;
  try {
    budget = new ResearchBudget(root, { capUsd: 1.55, experiment: 'wait-v1' });
    const request = { payload: { ...payload, model: 'cline-pass/deepseek-v4.1-flash-1017', temperature: 0 } };
    const call = budget.reserve(request.payload, {});
    Object.assign(call, { state: 'unknown-charge-reserved', accountedUsd: call.reservedUsd, failureClass: 'reviewed_request_timeout',
      elapsedMs: 45004, error: 'The operation was aborted due to timeout' });
    fs.mkdirSync(path.join(root, 'reviews'));
    const file = path.join(root, 'request.json'); writeJson(file, request);
    writeJson(path.join(root, 'reviews', `request-${call.id}.json`), { callId: call.id, requestFile: 'request.json',
      requestSha256: digest(fs.readFileSync(file)), reservationUsd: call.reservedUsd, decision: 'reserve-in-full-no-retry' });
    budget.save(); budget.close();
    budget = new ResearchBudget(root, { capUsd: 1.55, experiment: 'wait-v1' });
    assert.equal(budget.ledger.calls[1].accountedUsd, call.reservedUsd);
    budget.close();
    fs.appendFileSync(file, ' ');
    assert.throws(() => new ResearchBudget(root, { capUsd: 1.55, experiment: 'wait-v1' }), /Unreviewed/);
  } finally { budget?.close(); fs.rmSync(root, { recursive: true }); }
});
