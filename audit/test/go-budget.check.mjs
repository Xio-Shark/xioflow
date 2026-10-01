import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoExperimentBudget } from '../lib/go-budget.mjs';

const endpoint = 'https://opencode.ai/zen/go/v1/chat/completions';
const request = { body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: false, max_tokens: 1024 }) };
test('the cumulative cap survives reopening and stops BEFORE the next network call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-budget-'));
  let calls = 0;
  const fetch = async () => { calls++; return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } }); };
  let budget = new GoExperimentBudget(path.join(dir, 'budget.db'), fetch);
  try {
    for (let i = 0; i < 100; i++) await budget.fetch('test', endpoint, request);
    budget.close(); budget = new GoExperimentBudget(path.join(dir, 'budget.db'), fetch);
    for (let i = 0; i < 100; i++) await budget.fetch('test', endpoint, request);
    await assert.rejects(budget.fetch('test', endpoint, request), /budget exhausted/);
    assert.equal(calls, 200);
    assert.equal(budget.report()[0].reservedUsd, 10);
  } finally { budget.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lost responses keep their reservation; invalid endpoints never make a request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-budget-'));
  let calls = 0;
  const budget = new GoExperimentBudget(path.join(dir, 'budget.db'), async () => { calls++; throw new Error('lost response'); });
  try {
    await assert.rejects(budget.fetch('test', 'https://example.com/', request), /approved/);
    assert.equal(calls, 0);
    await assert.rejects(budget.fetch('test', endpoint, request), /lost response/);
    assert.equal(budget.report()[0].reservedUsd, 0.05);
    assert.equal(budget.report()[0].unaccountedRequests, 1);
  } finally { budget.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing usage does not become a zero-cost success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-budget-'));
  const budget = new GoExperimentBudget(path.join(dir, 'budget.db'), async () => Response.json({ choices: [] }));
  try {
    await assert.rejects(budget.fetch('test', endpoint, request), /usage is missing/);
    assert.equal(budget.report()[0].reservedUsd, 0.05);
    assert.equal(budget.report()[0].peakEstimateUsd, null);
    assert.equal(budget.report()[0].unaccountedRequests, 1);
  } finally { budget.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
