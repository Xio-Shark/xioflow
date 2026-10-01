#!/usr/bin/env node
// Summary of an E2 results directory: file-level conflicts, how many were false, where true ones diverge.
// Usage: node audit/observation/summarize-e2.mjs [audit/results/observation/<date>/e2]
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../results/observation', new Date().toISOString().slice(0, 10), 'e2'));
const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`);

function stats(subset) {
  const ok = subset.filter((r) => r.tasks);
  const tasks = ok.flatMap((r) => r.tasks);
  const conflicts = tasks.filter((t) => t.status === 'conflict');
  const falseOnes = conflicts.filter((t) => t.falseConflict);
  const trueOnes = conflicts.filter((t) => !t.falseConflict);
  const position = trueOnes.filter((t) => t.replay && t.steps > 0).map((t) => t.replay.divergedAt / t.steps);
  const tokens = (list) => list.reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0), 0);
  return {
    runs: subset.length, runnerErrors: subset.length - ok.length, workers: tasks.length,
    committed: tasks.filter((t) => t.status === 'committed').length,
    failed: tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').length,
    conflicts: conflicts.length, falseConflicts: falseOnes.length,
    byKind: conflicts.reduce((acc, t) => { const k = [...new Set(t.conflicts.map((c) => c.kind))].sort().join('+'); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    falseByKind: falseOnes.reduce((acc, t) => { const k = [...new Set(t.conflicts.map((c) => c.kind))].sort().join('+'); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    divergencePositionMedian: median(position), divergencePositions: position.map((p) => Number(p.toFixed(2))).sort((a, b) => a - b),
    stepsDiscardedByFalseConflicts: falseOnes.reduce((sum, t) => sum + t.steps, 0),
    tokensAll: tokens(tasks), tokensDiscarded: tokens(conflicts), tokensDiscardedByFalseConflicts: tokens(falseOnes),
  };
}

const categories = [...new Set(runs.map((r) => r.category))];
console.log(`E2 summary: ${runs.length} runs in ${dir.replace(process.cwd(), '.')}, model(s): ${[...new Set(runs.map((r) => r.model))].join(', ')}\n`);
console.log('| category | runs | workers | committed | file-level conflicts | of which false | median divergence position (true conflicts) | conflict kinds (false / all) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const category of [...categories, 'ALL']) {
  const s = stats(category === 'ALL' ? runs : runs.filter((r) => r.category === category));
  const kinds = Object.entries(s.byKind).map(([k, n]) => `${k} ${s.falseByKind[k] ?? 0}/${n}`).join(', ') || '—';
  console.log(`| ${category} | ${s.runs} | ${s.workers} | ${s.committed} | ${s.conflicts} | ${s.falseConflicts} (${pct(s.falseConflicts, s.conflicts)}) | ${s.divergencePositionMedian === null ? 'n/a' : s.divergencePositionMedian.toFixed(2)} | ${kinds} |`);
}
const all = stats(runs);
console.log(`\nworkers that failed or were cancelled: ${all.failed}; runner errors: ${all.runnerErrors}`);
console.log(`tokens (input + output): all workers ${all.tokensAll}; discarded by file-level conflicts ${all.tokensDiscarded} (${pct(all.tokensDiscarded, all.tokensAll)}); of those, by false conflicts ${all.tokensDiscardedByFalseConflicts}`);
console.log(`steps discarded by false conflicts: ${all.stepsDiscardedByFalseConflicts}`);
console.log(`divergence positions of true conflicts (step index / steps): ${JSON.stringify(all.divergencePositions)}`);
console.log('\nper group:');
for (const group of [...new Set(runs.map((r) => r.group))].sort()) {
  const s = stats(runs.filter((r) => r.group === group));
  console.log(`  ${group}: runs ${s.runs}, conflicts ${s.conflicts}, false ${s.falseConflicts}, kinds ${JSON.stringify(s.byKind)}, failed ${s.failed}`);
}
