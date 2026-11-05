import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveCost, usageCost, mayReserve } from './model-budget.mjs';

test('pending and failed requests retain their reserved cost across a restart', () => {
  const ledger = { limitUsd: 5, calls: [{ reservedUsd: 2 }, { reservedUsd: 1, accountedUsd: 0.5 }] };
  assert.equal(mayReserve(ledger, 2.5), true);
  assert.equal(mayReserve(ledger, 2.50001), false);
  assert.equal(mayReserve(ledger, NaN), false);
});

test('cache discounts are ignored conservatively and larger reported costs dominate', () => {
  assert.deepEqual(usageCost({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1000 } }),
    { conservativeUsd: 0.0009, providerReportedUsd: null, accountedUsd: 0.0009 });
  assert.equal(usageCost({ prompt_tokens: 1, completion_tokens: 1, cost: 0.25 }).accountedUsd, 0.25);
  assert.ok(reserveCost({ text: '中文🧪'.repeat(100) }, 2048) > usageCost({ prompt_tokens: 1000, completion_tokens: 2048 }).accountedUsd);
});

test('absent, fractional and negative usage never becomes zero-cost success', () => {
  for (const usage of [undefined, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 },
    { prompt_tokens: 1, completion_tokens: 1, cost: -1 }]) assert.throws(() => usageCost(usage));
});
