import fs from 'node:fs';
import path from 'node:path';
import { GoExperimentBudget } from '../lib/go-budget.mjs';

const root = path.resolve(import.meta.dirname, '../results/real-model');
const trials = fs.readdirSync(root).filter((name) => /^e8-.*\.json$/.test(name))
  .map((name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
  .filter((record) => record.experiment === 'e8-real-model-pilot');
const rows = trials.map((record) => {
  const cost = (phase) => record.cost.find((entry) => entry.label.endsWith(`:${phase}`));
  return {
    trial: record.trial, status: record.status, scenario: record.scenario ?? 'comment', order: record.order ?? 'baseline-first',
    baselinePassed: record.baseline?.passed ?? null, resumedPassed: record.resumed?.passed ?? null,
    reusedObservations: record.recovery?.reusedObservations ?? null,
    baselineRequests: cost('baseline')?.requests ?? null, resumedRequests: cost('resumed')?.requests ?? null,
    baselinePeakUsd: cost('baseline')?.peakEstimateUsd ?? null, resumedPeakUsd: cost('resumed')?.peakEstimateUsd ?? null,
    baselineMs: record.timingsMs.baseline ?? null,
    baselinePreparationMs: record.timingsMs.baselinePreparation ?? null,
    recoveryMs: record.timingsMs.resumed === undefined ? null : record.timingsMs.resumed + record.timingsMs.reconstruction,
  };
});
const pairs = rows.filter((row) => row.status === 'passed');
const byScenario = [...new Set(rows.map((row) => row.scenario))].map((scenario) => {
  const all = rows.filter((row) => row.scenario === scenario);
  const passed = all.filter((row) => row.status === 'passed');
  const total = (key) => passed.reduce((sum, row) => sum + row[key], 0);
  return { scenario, trials: all.length, passingPairs: passed.length,
    zeroReusePairs: passed.filter((row) => row.reusedObservations === 0).length,
    baselineRequests: total('baselineRequests'), resumedRequests: total('resumedRequests'),
    baselinePeakUsd: total('baselinePeakUsd'), resumedPeakUsd: total('resumedPeakUsd'),
    baselineMs: total('baselineMs'), recoveryMs: total('recoveryMs'),
  };
});
const file = path.join(root, 'go-deepseek-approved-2026-10-01.sqlite');
if (!fs.existsSync(file)) throw new Error('Budget ledger missing');
const budget = new GoExperimentBudget(file);
try {
  const usage = budget.report();
  console.log(JSON.stringify({
    trials: rows,
    byScenario,
    pairedSummary: { totalTrials: rows.length, passingPairs: pairs.length },
    cumulative: {
      requests: usage.reduce((n, row) => n + row.requests, 0),
      reservedUsd: usage.reduce((n, row) => n + row.reservedUsd, 0),
      accountedPeakUsd: usage.reduce((n, row) => n + (row.peakEstimateUsd ?? 0), 0),
      unaccountedRequests: usage.reduce((n, row) => n + row.unaccountedRequests, 0),
    },
    caveat: 'Results are stratified by scenario, not pooled as an optimization effect. Zero-reuse restarts also vary in requests and tokens: observed differences are not causal savings. Costs use peak rates, not invoices. First three baseline timings exclude fork creation.',
  }, null, 2));
} finally { budget.close(); }
