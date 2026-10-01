#!/usr/bin/env node
// Writes one reproduction script per violated cell of a results directory.
// Usage: node audit/repro/generate.mjs [audit/results/<date>]
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../results', new Date().toISOString().slice(0, 10)));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8')).harnesses;
let written = 0;
for (const scenario of fs.readdirSync(root)) {
  const scenarioDir = path.join(root, scenario);
  if (!fs.statSync(scenarioDir).isDirectory()) continue;
  for (const harnessDir of fs.readdirSync(scenarioDir)) {
    const results = fs.readdirSync(path.join(scenarioDir, harnessDir))
      .map((trial) => path.join(scenarioDir, harnessDir, trial, 'verdict.json')).filter((f) => fs.existsSync(f))
      .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    const violated = results.filter((r) => r.verdict === 'violated');
    if (violated.length < 4) continue; // only stable violations get a script
    const label = results[0].harness;
    const kinds = [...new Set(violated.flatMap((r) => r.evidence.violations ?? []))];
    const script = `#!/bin/sh
# Reproduces: ${label} (${versions[label]?.version ?? 'unknown version'}), scenario ${scenario}
# Observed ${violated.length}/${results.length} on ${path.basename(root)}: ${kinds.join(', ')}
# No real model and no API key are involved: a local endpoint replays a fixed tape.
# Exit status: 0 if the violation reproduces in all 3 trials, 1 otherwise.
set -eu
${label === 'qwen' ? ': "${XF_QWEN_BIN:?set XF_QWEN_BIN to the qwen binary of an isolated install (npm install --prefix <dir> @qwen-code/qwen-code)}"\n' : ''}cd "$(dirname "$0")/../.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
node audit/run.mjs --scenario ${scenario} --harness ${label} --trials 3 --out "$out" | tee "$out/log.txt"
grep -q '^== ${scenario} ${label} .*: violated 3/3$' "$out/log.txt"
`;
    fs.writeFileSync(path.join(import.meta.dirname, `${harnessDir}-${scenario}.sh`), script, { mode: 0o755 });
    written++;
  }
}
console.log(`wrote ${written} reproduction scripts`);
