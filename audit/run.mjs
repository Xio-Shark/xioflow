#!/usr/bin/env node
// Audit bench runner.
//   node audit/run.mjs --scenario baseline --harness xio,codex --trials 5
//   node audit/run.mjs --self-test
// Flags: --keep (leave sandboxes), --out <dir> (default audit/results/<date>), --harness xio:node (variant).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveHarness } from './harnesses/index.mjs';
import { SCENARIOS } from './scenarios/index.mjs';
import { activeCleanups, runTrial } from './trial.mjs';
import { processesMatching } from './observe/ps.mjs';

function parseArgs(argv) {
  const options = { trials: 1, keep: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario') options.scenario = argv[++i];
    else if (arg === '--harness') options.harness = argv[++i];
    else if (arg === '--trials') options.trials = Number(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function versionOf(harness) {
  const probe = spawnSync(harness.bin, harness.versionArgs, { encoding: 'utf8' });
  if (probe.error) return undefined;
  return (probe.stdout || probe.stderr).trim().split('\n')[0];
}

// An interrupted runner still removes what its trials started.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const cleanup of activeCleanups) cleanup();
    process.exit(130);
  });
}

/** What was tested, next to the results: exact versions, resolved binaries, platform. */
function recordVersions(outRoot, harnessSpecs) {
  const harnesses = {};
  for (const spec of harnessSpecs) {
    const { harness, label, variantEnv } = resolveHarness(spec);
    const which = spawnSync('sh', ['-c', `command -v ${harness.bin}`], { encoding: 'utf8' }).stdout.trim();
    harnesses[label] = { version: versionOf(harness) ?? null, bin: which ? fs.realpathSync(which).replace(os.homedir(), '~') : null, variantEnv };
  }
  fs.mkdirSync(outRoot, { recursive: true });
  const file = path.join(outRoot, 'versions.json');
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).harnesses : {};
  fs.writeFileSync(file, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.arch()} ${os.release()}`, node: process.version,
    harnesses: { ...previous, ...harnesses },
  }, null, 2)}\n`);
}

async function runMatrix({ scenarios, harnessSpecs, trials, outRoot, keep }) {
  recordVersions(outRoot, harnessSpecs);
  const results = [];
  for (const scenarioName of scenarios) {
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) throw new Error(`unknown scenario "${scenarioName}" (known: ${Object.keys(SCENARIOS).join(', ')})`);
    for (const spec of harnessSpecs) {
      const { harness, label, variantEnv } = resolveHarness(spec);
      const version = versionOf(harness);
      if (!version) {
        console.log(`${scenario.name} ${label}: not installed, skipped`);
        continue;
      }
      const verdicts = [];
      for (let trial = 1; trial <= trials; trial++) {
        const outDir = path.join(outRoot, scenario.name, label.replace(':', '-'), `trial-${trial}`);
        const result = await runTrial({ harness, label, variantEnv, scenario, trial, outDir, keep, version });
        verdicts.push(result.verdict);
        results.push(result);
        const { observed, ...brief } = result;
        console.log(`${scenario.name} ${label} #${trial}: ${result.verdict} ${JSON.stringify(brief.evidence)}${result.bench.sandboxKept ? ` kept=${result.bench.sandboxKept}` : ''}`);
      }
      const tally = verdicts.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
      console.log(`== ${scenario.name} ${label} (${version}): ${Object.entries(tally).map(([v, n]) => `${v} ${n}/${trials}`).join(', ')}`);
    }
  }
  return results;
}

const options = parseArgs(process.argv.slice(2));
const outRoot = path.resolve(options.out ?? path.join(import.meta.dirname, 'results', new Date().toISOString().slice(0, 10)));

if (options.selfTest) {
  // The bench must drive a harness, inject a fault, and leave nothing behind: no tagged process, no sandbox.
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('xf-audit-')));
  const results = await runMatrix({ scenarios: ['baseline', 'pipe-hold'], harnessSpecs: [options.harness ?? 'xio'], trials: 1, outRoot, keep: false });
  const leftoverProcesses = processesMatching('--xf-tag=');
  const leftoverSandboxes = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('xf-audit-') && !before.has(name));
  const benchErrors = results.filter((r) => r.verdict === 'bench_error');
  const baselineOk = results.some((r) => r.scenario === 'baseline' && r.verdict === 'holds');
  console.log(`self-test: baseline drives the harness: ${baselineOk} | bench errors: ${benchErrors.length} | tagged processes left: ${leftoverProcesses.length} | sandboxes left: ${leftoverSandboxes.length}`);
  const ok = baselineOk && results.length === 2 && benchErrors.length === 0 && leftoverProcesses.length === 0 && leftoverSandboxes.length === 0;
  console.log(ok ? 'self-test: PASS' : 'self-test: FAIL');
  process.exit(ok ? 0 : 1);
}

if (!options.scenario || !options.harness) {
  console.error('usage: node audit/run.mjs --scenario <name[,name]> --harness <name[:variant][,...]> [--trials N] [--keep] [--out dir]\n       node audit/run.mjs --self-test');
  process.exit(64);
}
const results = await runMatrix({ scenarios: options.scenario.split(','), harnessSpecs: options.harness.split(','), trials: options.trials, outRoot, keep: options.keep });
process.exit(results.some((r) => r.verdict === 'bench_error') ? 1 : 0);
