#!/usr/bin/env node
// Spot check that a trial stays inside its sandbox: for each harness, run the baseline once and report
//   1. files under the user's real config dirs that changed during the trial and mention the run (must be none);
//   2. non-loopback TCP peers of the harness's process group (sampled with lsof while it runs; must be none).
// Usage: node audit/check-isolation.mjs [--harness xio,codex,...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESSES, resolveHarness } from './harnesses/index.mjs';
import { SCENARIOS } from './scenarios/index.mjs';
import { runTrial } from './trial.mjs';

const home = os.homedir();
const REAL_DIRS = {
  xio: ['.xiocode'],
  codex: ['.codex'],
  opencode: ['.local/share/opencode', '.config/opencode', '.cache/opencode', '.local/state/opencode'],
  gemini: ['.gemini'],
  claude: ['.claude', '.claude.json'],
};

function filesChangedSince(target, since, found = []) {
  let st;
  try { st = fs.lstatSync(target); } catch { return found; }
  if (st.isSymbolicLink()) return found;
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) filesChangedSince(path.join(target, name), since, found);
  } else if (st.mtimeMs >= since || st.ctimeMs >= since) {
    found.push({ file: target, bytes: st.size });
  }
  return found;
}

function mentions(file, bytes, needles) {
  if (bytes > 32 * 1024 * 1024) return 'too large to scan';
  const text = fs.readFileSync(file, 'latin1');
  return needles.some((needle) => text.includes(needle));
}

const index = process.argv.indexOf('--harness');
const names = index > 0 ? process.argv[index + 1].split(',') : Object.keys(HARNESSES);
let failed = false;
for (const name of names) {
  const { harness, label, variantEnv } = resolveHarness(name);
  const peers = new Set();
  const scenario = {
    ...SCENARIOS.baseline,
    async drive(ctx) {
      const launch = ctx.start();
      const local = `127.0.0.1:${ctx.endpoint.port}`;
      while (!launch.exit) {
        // -a ANDs the two filters; without it lsof lists every TCP socket on the machine.
        const out = spawnSync('lsof', ['-nP', '-a', '-iTCP', '-g', String(launch.pid)], { encoding: 'utf8' }).stdout;
        for (const line of out.split('\n')) {
          const match = /->(\S+)/.exec(line);
          // Loopback peers are the harness talking to itself (opencode's private server), not the network.
          if (match && match[1] !== local && !match[1].startsWith('127.0.0.1:') && !match[1].startsWith('[::1]:')) peers.add(match[1]);
        }
        await ctx.sleep(100);
      }
    },
  };
  const since = Date.now();
  const result = await runTrial({ harness, label, variantEnv, scenario, trial: 1, version: 'isolation-check' });
  const needles = [result.bench.runId];
  const changed = (REAL_DIRS[name] ?? []).flatMap((rel) => filesChangedSince(path.join(home, rel), since));
  const leaking = changed.filter(({ file, bytes }) => mentions(file, bytes, needles) !== false);
  if (leaking.length > 0 || peers.size > 0) failed = true;
  if (result.verdict !== 'holds') console.log(`[${name}] evidence: ${JSON.stringify(result.evidence)}`);
  console.log(`[${name}] baseline=${result.verdict} | real config files changed during the trial: ${changed.length}`
    + ` (mentioning this run: ${leaking.length}) | non-loopback TCP peers seen: ${peers.size ? [...peers].join(', ') : 'none'}`);
  for (const { file } of leaking) console.log(`   mentions the run: ${file.replace(home, '~')}`);
}
process.exit(failed ? 1 : 0);
