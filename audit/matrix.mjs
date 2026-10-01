#!/usr/bin/env node
// Builds the harness x scenario matrix from a results directory.
// Usage: node audit/matrix.mjs [audit/results/<date>] > matrix.md
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'results', new Date().toISOString().slice(0, 10)));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
const SCENARIO_ORDER = ['baseline', 'pipe-hold', 'orphan-at-exit', 'unconfirmed-stop', 'kill-mid-tool', 'kill-before-report', 'output-flood', 'cancel-tree', 'mcp-orphan-exit', 'mcp-orphan-kill', 'spawn-failure'];
const SHORT = { holds: 'holds', violated: 'VIOLATED', not_applicable: 'n/a', inconclusive: 'inconclusive', bench_error: 'bench error' };

const cells = {}; // scenario -> harness -> [verdict.json]
for (const scenario of fs.readdirSync(root)) {
  const scenarioDir = path.join(root, scenario);
  if (!fs.statSync(scenarioDir).isDirectory()) continue;
  for (const harness of fs.readdirSync(scenarioDir)) {
    for (const trial of fs.readdirSync(path.join(scenarioDir, harness))) {
      const file = path.join(scenarioDir, harness, trial, 'verdict.json');
      if (fs.existsSync(file)) ((cells[scenario] ??= {})[harness] ??= []).push(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }
}
const scenarios = SCENARIO_ORDER.filter((s) => cells[s]).concat(Object.keys(cells).filter((s) => !SCENARIO_ORDER.includes(s)));
const harnesses = Object.keys(versions.harnesses).map((label) => label.replace(':', '-')).filter((h) => scenarios.some((s) => cells[s][h]));

function cell(results) {
  if (!results) return '—';
  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([verdict, n]) => `${SHORT[verdict] ?? verdict} ${n}/${results.length}`).join(', ');
}

const lines = [];
lines.push(`# Execution-layer audit matrix`, '');
lines.push(`Recorded ${versions.recordedAt.slice(0, 10)} on ${versions.platform}, Node ${versions.node}. Each cell is the verdict over the trials of that cell; a verdict counts as stable at 4 of 5 or more.`, '');
lines.push('| harness | version |', '|---|---|');
for (const [label, info] of Object.entries(versions.harnesses)) lines.push(`| \`${label}\` | ${info.version ?? 'not installed'} |`);
lines.push('', `| scenario | ${harnesses.map((h) => `\`${h}\``).join(' | ')} |`, `|---|${harnesses.map(() => '---').join('|')}|`);
for (const scenario of scenarios) lines.push(`| ${scenario} | ${harnesses.map((h) => cell(cells[scenario][h])).join(' | ')} |`);

lines.push('', '## Violations by kind', '', '| scenario | violation | harnesses (trials) |', '|---|---|---|');
for (const scenario of scenarios) {
  const byKind = {};
  for (const harness of harnesses) {
    for (const result of cells[scenario][harness] ?? []) {
      if (result.verdict !== 'violated') continue;
      for (const kind of result.evidence.violations ?? ['(unspecified)']) ((byKind[kind] ??= {})[harness] ??= []).push(result.trial);
    }
  }
  for (const [kind, perHarness] of Object.entries(byKind)) {
    lines.push(`| ${scenario} | \`${kind}\` | ${Object.entries(perHarness).map(([h, trials]) => `\`${h}\` (${trials.length}/${cells[scenario][h].length})`).join(', ')} |`);
  }
}
const other = [];
for (const scenario of scenarios) {
  for (const harness of harnesses) {
    const byReason = {};
    for (const result of cells[scenario][harness] ?? []) {
      if (!['not_applicable', 'inconclusive', 'bench_error'].includes(result.verdict)) continue;
      const key = `${result.verdict} | ${String(result.evidence.reason ?? '').slice(0, 140)}`;
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
    for (const [key, n] of Object.entries(byReason)) other.push(`| ${scenario} | \`${harness}\` | ${n}/${cells[scenario][harness].length} | ${key} |`);
  }
}
if (other.length > 0) lines.push('', '## Cells without a verdict on the property', '', '| scenario | harness | trials | verdict | reason |', '|---|---|---|---|---|', ...other);
console.log(lines.join('\n'));
