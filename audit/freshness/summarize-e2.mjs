#!/usr/bin/env node
// Recall / precision / share selected, per selector and mutation kind, over an E2 results directory.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../results/freshness', new Date().toISOString().slice(0, 10), 'e2'));
const records = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const SELECTORS = [['testmon', 'pytest-testmon'], ['nocache', 'observed reads, bytecode cache out of the way'], ['warm', 'observed reads, default bytecode cache']];
const ratio = (n, d) => (d === 0 ? 'n/a' : `${(n / d).toFixed(3)} (${n}/${d})`);

function score(mutations, libSizes, key) {
  let hit = 0; let flipped = 0; let selected = 0; let possible = 0;
  for (const m of mutations) {
    const marked = new Set(m[key]);
    hit += m.flipped.filter((f) => marked.has(f)).length;
    flipped += m.flipped.length;
    selected += marked.size;
    possible += libSizes[m.lib];
  }
  return { recall: ratio(hit, flipped), precision: ratio(hit, selected), selected: ratio(selected, possible) };
}

const libSizes = Object.fromEntries(records.map((r) => [r.lib, r.testFiles]));
const dropped = records.flatMap((r) => r.mutations.filter((m) => m.timedOut)).length;
for (const r of records) r.mutations = r.mutations.filter((m) => !m.timedOut);
const all = records.flatMap((r) => r.mutations.map((m) => ({ ...m, lib: r.lib })));
if (dropped > 0) console.log(`(${dropped} mutations made the suite hang and were dropped)\n`);
console.log(`E2: ${records.length} libraries (${records.map((r) => `${r.lib}@${r.commit}, ${r.testFiles} test files`).join('; ')})\n`);
for (const kind of ['source', 'data']) {
  const subset = all.filter((m) => m.kind === kind);
  const flipping = subset.filter((m) => m.flipped.length > 0).length;
  console.log(`### ${kind} mutations: ${subset.length}, of which ${flipping} flip at least one test file (${subset.reduce((n, m) => n + m.flipped.length, 0)} flipped test files in total)\n`);
  console.log('| selector | recall | precision | share of test files selected |');
  console.log('|---|---|---|---|');
  for (const [key, label] of SELECTORS) {
    const s = score(subset, libSizes, key);
    console.log(`| ${label} | ${s.recall} | ${s.precision} | ${s.selected} |`);
  }
  console.log('');
}
console.log('### source mutations, per library (recall)\n');
console.log('| library | flipping mutations | testmon | observed reads (no cache) | observed reads (default cache) |');
console.log('|---|---|---|---|---|');
for (const r of records) {
  const subset = r.mutations.filter((m) => m.kind === 'source').map((m) => ({ ...m, lib: r.lib }));
  console.log(`| ${r.lib} | ${subset.filter((m) => m.flipped.length > 0).length}/${subset.length} | ${score(subset, libSizes, 'testmon').recall} | ${score(subset, libSizes, 'nocache').recall} | ${score(subset, libSizes, 'warm').recall} |`);
}
const overhead = records.flatMap((r) => r.overhead);
const share = overhead.map((o) => o.overheadMs / o.commandMs).sort((a, b) => a - b);
console.log(`\noverhead of recording evidence per test-file run (${overhead.length} runs): median ${(100 * share[Math.floor(share.length / 2)]).toFixed(1)}% of the command's time, max ${(100 * share[share.length - 1]).toFixed(1)}%`);
