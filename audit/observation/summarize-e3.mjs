#!/usr/bin/env node
// Summary of an E3 results directory: the two commit rules side by side.
// Usage: node audit/observation/summarize-e3.mjs [audit/results/observation/<date>/e3]
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../results/observation', new Date().toISOString().slice(0, 10), 'e3'));
const load = (arm) => {
  const armDir = path.join(dir, arm);
  return fs.existsSync(armDir) ? fs.readdirSync(armDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(armDir, f), 'utf8'))) : [];
};
const pct = (n, d) => (d === 0 ? 'n/a' : `${n}/${d} = ${((100 * n) / d).toFixed(0)}%`);
const tokensOf = (tasks) => tasks.reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0), 0);

function stats(runs) {
  const ok = runs.filter((r) => r.tasks);
  const tasks = ok.flatMap((r) => r.tasks);
  const finished = tasks.filter((t) => t.status === 'committed' || t.status === 'conflict');
  const committed = tasks.filter((t) => t.status === 'committed');
  const conflicts = tasks.filter((t) => t.status === 'conflict');
  return {
    runs: runs.length, runnerErrors: runs.length - ok.length, workers: tasks.length,
    failed: tasks.length - finished.length,
    committed: committed.length, finished: finished.length,
    byObservations: committed.filter((t) => t.validation === 'observations').length,
    conflicts: conflicts.length,
    conflictWhy: conflicts.reduce((acc, t) => {
      const why = t.observation ? t.observation.reason : [...new Set(t.conflicts.map((c) => c.kind))].sort().join('+');
      acc[why] = (acc[why] ?? 0) + 1;
      return acc;
    }, {}),
    tokens: tokensOf(tasks), discardedTokens: tokensOf(conflicts),
    allCommittedRuns: ok.filter((r) => r.tasks.every((t) => t.status === 'committed')).length,
    typecheckOk: ok.filter((r) => r.typecheck?.passed).length, okRuns: ok.length,
    // A merge that the rule let through and that does not compile: every task committed, type check failed.
    allCommittedTypecheckFailed: ok.filter((r) => r.tasks.every((t) => t.status === 'committed') && !r.typecheck?.passed).length,
    wallS: Math.round(ok.reduce((sum, r) => sum + r.wallMs, 0) / 1000),
  };
}

const arms = { files: load('files'), observations: load('observations') };
const row = (label, s) => `| ${label} | ${s.runs} | ${s.workers} | ${pct(s.committed, s.finished)} | ${s.byObservations} | ${s.conflicts} (${Object.entries(s.conflictWhy).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}) | ${pct(s.discardedTokens, s.tokens)} | ${pct(s.allCommittedRuns, s.okRuns)} | ${pct(s.typecheckOk, s.okRuns)} | ${s.allCommittedTypecheckFailed} | ${s.failed} | ${s.runnerErrors} |`;
const header = '| arm | group runs | workers | committed / finished workers | of which by observations | conflicts (why) | tokens of discarded workers / all tokens | runs with every task applied | merged tree type-checks | every task applied but type check fails | workers that failed or were cancelled | runner errors |\n|---|---|---|---|---|---|---|---|---|---|---|---|';

console.log(`model(s): ${[...new Set(Object.values(arms).flat().map((r) => `${r.provider}/${r.model}`))].join(', ')}\n`);
console.log('## All groups\n');
console.log(header);
for (const [arm, runs] of Object.entries(arms)) console.log(row(arm, stats(runs)));
for (const category of ['unrelated', 'semantic', 'same-file']) {
  console.log(`\n## ${category}\n`);
  console.log(header);
  for (const [arm, runs] of Object.entries(arms)) console.log(row(arm, stats(runs.filter((r) => r.category === category))));
}
console.log('\n## By group (committed / finished workers; merged tree type-checks)\n');
console.log('| group | category | files | observations |\n|---|---|---|---|');
for (const group of [...new Set(Object.values(arms).flat().map((r) => r.group))].sort()) {
  const cell = (arm) => { const s = stats(arms[arm].filter((r) => r.group === group)); return `${pct(s.committed, s.finished)}; tsc ${s.typecheckOk}/${s.okRuns}`; };
  console.log(`| ${group} | ${Object.values(arms).flat().find((r) => r.group === group).category} | ${cell('files')} | ${cell('observations')} |`);
}
const failures = Object.values(arms).flat().filter((r) => r.typecheck && !r.typecheck.passed);
console.log(`\n## Type-check failures (${failures.length})\n`);
for (const r of failures) console.log(`- ${r.arm} ${r.group} #${r.rep}: ${r.tasks.map((t) => `${t.name}=${t.status}${t.validation === 'observations' ? '(obs)' : ''}`).join(', ')} | ${r.typecheck.firstErrors[0] ?? `exit ${r.typecheck.exit}`}`);
