import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceArbiterClient, WorkspaceArbiterServer } from '../../dist/index.js';
import { initGitRepo, summarizeMs, systemEnvironmentMetadata, writeBenchmarkJson } from './_stats.mjs';

function parseArgs(argv) {
  const out = { trials: 4, concurrencies: [2, 4, 8], output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trials' && argv[i + 1]) out.trials = Number(argv[++i]);
    else if (a === '--concurrencies' && argv[i + 1]) out.concurrencies = argv[++i].split(',').map(Number);
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
  }
  return out;
}

function seedMultiModuleRepo(repoDir, numModules) {
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    '{\n  "name": "occ-bench",\n  "type": "module",\n  "scripts": { "test": "node test/verify.mjs" }\n}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoDir, 'src', 'shared.js'),
    [
      '// Shared domain helpers',
      'export function computeTax(amount) {',
      '  return Math.round(amount * 1.1);',
      '}',
      '',
      'export function computeDiscount(amount) {',
      '  return Math.round(amount * 0.9);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const routeEntries = [];
  for (let i = 0; i < numModules; i++) {
    fs.writeFileSync(
      path.join(repoDir, 'src', `mod_${i}.js`),
      `import { computeTax } from './shared.js';\nexport function calc_${i}(x) {\n  return computeTax(x) + ${i};\n}\n`,
      'utf8',
    );
    routeEntries.push(`  mod_${i}: 'v0',`);
  }
  fs.writeFileSync(
    path.join(repoDir, 'src', 'routes.js'),
    `export const ROUTES = {\n${routeEntries.join('\n')}\n};\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoDir, 'test', 'verify.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { computeTax, computeDiscount } from '../src/shared.js';",
      "import { ROUTES } from '../src/routes.js';",
      'const targetArg = process.argv[2];',
      'if (targetArg === undefined) {',
      `  for (let i = 0; i < ${numModules}; i++) {`,
      '    const mod = await import(`../src/mod_${i}.js`);',
      '    const val = mod[`calc_${i}`](100);',
      '    assert.equal(typeof val, "number");',
      '  }',
      '} else if (Number.isInteger(Number(targetArg)) && Number(targetArg) > 0) {',
      '  const idx = Number(targetArg);',
      '  const mod = await import(`../src/mod_${idx}.js`);',
      '  assert.equal(typeof mod[`calc_${idx}`](100), "number");',
      '}',
      'assert.equal(computeTax(100), 110);',
      'assert.equal(computeDiscount(100), 90);',
      'assert.ok(ROUTES);',
    ].join('\n'),
    'utf8',
  );
  initGitRepo(repoDir);
}

function createBarrier(count) {
  let rem = count;
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return async () => {
    rem -= 1;
    if (rem <= 0) release();
    await promise;
  };
}

function runGateAsync(cwd, moduleIndex = null) {
  return new Promise((resolve) => {
    const args = moduleIndex === null ? ['test/verify.mjs'] : ['test/verify.mjs', String(moduleIndex)];
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    child.once('close', (code) => resolve(code === 0));
  });
}

function verifyRepoCleanAndValid(repoDir, numModules) {
  let valid = true;
  try {
    execFileSync(process.execPath, ['test/verify.mjs'], { cwd: repoDir, stdio: 'ignore' });
  } catch {
    valid = false;
  }
  let routesObjValid = true;
  try {
    const txt = fs.readFileSync(path.join(repoDir, 'src', 'routes.js'), 'utf8');
    // Extract key: value pairs inside ROUTES = { ... }
    routesObjValid = txt.includes('export const ROUTES = {') && txt.includes('};');
  } catch {
    routesObjValid = false;
  }
  return { valid, routesObjValid };
}

/**
 * Baseline 1: No Coordination (agents read routes.js concurrently, sleep briefly for test check, write back).
 * Models classic multi-agent shared-workspace lost updates when touching a shared index/registry.
 */
async function runNoCoordination(k, workload, repoDir) {
  const t0 = process.hrtime.bigint();
  let committed = 0;
  let brokenStates = 0;
  let lostUpdates = 0;
  let spuriousAborts = 0;
  const readBarrier = createBarrier(k);
  let markAgent0Done;
  const agent0Done = new Promise((r) => { markAgent0Done = r; });

  await Promise.all(
    Array.from({ length: k }, async (_, i) => {
      if (workload === 'disjoint') {
        const sharedBefore = fs.readFileSync(path.join(repoDir, 'src', 'shared.js'), 'utf8');
        await readBarrier();
        if (i === 0) {
          fs.writeFileSync(
            path.join(repoDir, 'src', 'shared.js'),
            sharedBefore.replace('return Math.round(amount * 0.9);', 'const rate = 0.9; return Math.round(amount * rate); // peer discount'),
            'utf8',
          );
          markAgent0Done();
          const ok = await runGateAsync(repoDir, 0);
          if (!ok) brokenStates += 1;
          committed += 1;
        } else {
          await agent0Done;
          const modPath = path.join(repoDir, 'src', `mod_${i}.js`);
          const modTxt = fs.readFileSync(modPath, 'utf8');
          fs.writeFileSync(modPath, modTxt.replace(`+ ${i};`, `+ ${i + 100};`), 'utf8');
          const ok = await runGateAsync(repoDir, i);
          if (!ok) brokenStates += 1;
          committed += 1;
        }
      } else {
        const routesBefore = fs.readFileSync(path.join(repoDir, 'src', 'routes.js'), 'utf8');
        await readBarrier();
        await runGateAsync(repoDir);
        const updatedRoutes = routesBefore.replace(`mod_${i}: 'v0'`, `mod_${i}: 'v1-agent-${i}'`);
        fs.writeFileSync(path.join(repoDir, 'src', 'routes.js'), updatedRoutes, 'utf8');
        committed += 1;
      }
    }),
  );

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const routesFinal = fs.readFileSync(path.join(repoDir, 'src', 'routes.js'), 'utf8');
  let retainedUpdates = 0;
  if (workload === 'disjoint') {
    for (let i = 0; i < k; i++) {
      if (i === 0) {
        if (fs.readFileSync(path.join(repoDir, 'src', 'shared.js'), 'utf8').includes('const rate = 0.9')) retainedUpdates += 1;
      } else if (fs.readFileSync(path.join(repoDir, 'src', `mod_${i}.js`), 'utf8').includes(`+ ${i + 100};`)) {
        retainedUpdates += 1;
      }
    }
    lostUpdates = committed - retainedUpdates;
  } else {
    for (let i = 0; i < k; i++) {
      if (routesFinal.includes(`mod_${i}: 'v1-agent-${i}'`)) retainedUpdates += 1;
    }
    lostUpdates = committed - retainedUpdates;
  }
  const { valid } = verifyRepoCleanAndValid(repoDir, k);
  return {
    wallMs,
    attempted: k,
    committed,
    conflicts: 0,
    lostUpdates,
    spuriousAborts,
    mainBroken: valid ? brokenStates : brokenStates + 1,
  };
}

/**
 * Baseline 2: Coarse File-Hash OCC / Re-read (No Early Cutoff, No Worktree Isolation).
 * Checks file sha before commit and aborts if ANY byte of read file changed (false positive on unrelated symbol/comment).
 */
async function runCoarseNoCutoff(k, workload, repoDir) {
  const t0 = process.hrtime.bigint();
  let committed = 0;
  let conflicts = 0;
  let spuriousAborts = 0;
  let brokenStates = 0;
  const readBarrier = createBarrier(k);
  let markAgent0Done;
  const agent0Done = new Promise((r) => { markAgent0Done = r; });

  await Promise.all(
    Array.from({ length: k }, async (_, i) => {
      if (workload === 'disjoint') {
        const sharedSnap = fs.readFileSync(path.join(repoDir, 'src', 'shared.js'), 'utf8');
        await readBarrier();
        if (i === 0) {
          fs.writeFileSync(
            path.join(repoDir, 'src', 'shared.js'),
            sharedSnap.replace('return Math.round(amount * 0.9);', 'const rate = 0.9; return Math.round(amount * rate); // peer discount'),
            'utf8',
          );
          const ok = await runGateAsync(repoDir, 0);
          if (!ok) brokenStates += 1;
          committed += 1;
          markAgent0Done();
        } else {
          await agent0Done;
          await runGateAsync(repoDir, i);
          const sharedNow = fs.readFileSync(path.join(repoDir, 'src', 'shared.js'), 'utf8');
          if (sharedNow !== sharedSnap) {
            spuriousAborts += 1;
            conflicts += 1;
            return;
          }
          const modPath = path.join(repoDir, 'src', `mod_${i}.js`);
          fs.writeFileSync(modPath, fs.readFileSync(modPath, 'utf8').replace(`+ ${i};`, `+ ${i + 100};`), 'utf8');
          committed += 1;
        }
      } else {
        // Contended workload with compare-and-swap on routes.js
        const routesSnap = fs.readFileSync(path.join(repoDir, 'src', 'routes.js'), 'utf8');
        await readBarrier();
        await runGateAsync(repoDir);
        const routesNow = fs.readFileSync(path.join(repoDir, 'src', 'routes.js'), 'utf8');
        if (routesNow !== routesSnap) {
          conflicts += 1;
          return;
        }
        fs.writeFileSync(
          path.join(repoDir, 'src', 'routes.js'),
          routesNow.replace(`mod_${i}: 'v0'`, `mod_${i}: 'v1-agent-${i}'`),
          'utf8',
        );
        committed += 1;
      }
    }),
  );

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const { valid } = verifyRepoCleanAndValid(repoDir, k);
  return {
    wallMs,
    attempted: k,
    committed,
    conflicts,
    lostUpdates: 0,
    spuriousAborts,
    mainBroken: valid ? brokenStates : brokenStates + 1,
  };
}

/**
 * Baseline 3: Manual Git Worktree + Naive Git Merge (heavyweight per-agent worktree lifecycle).
 */
async function runManualGitWorktree(k, workload, repoDir) {
  const t0 = process.hrtime.bigint();
  let committed = 0;
  let conflicts = 0;
  let brokenStates = 0;
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-manual-wt-'));
  let mergeLock = Promise.resolve();
  const serializeMerge = (fn) => {
    const next = mergeLock.then(fn, fn);
    mergeLock = next.catch(() => {});
    return next;
  };

  try {
    await Promise.all(
      Array.from({ length: k }, async (_, i) => {
        const wt = path.join(worktreesDir, `agent-${i}`);
        const branch = `manual-wt-${i}-${Date.now()}`;
        await serializeMerge(async () => {
          execFileSync('git', ['worktree', 'add', '-b', branch, wt, 'HEAD'], { cwd: repoDir, stdio: 'ignore' });
        });
        if (workload === 'disjoint') {
          if (i === 0) {
            const p = path.join(wt, 'src', 'shared.js');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('return Math.round(amount * 0.9);', 'const rate = 0.9; return Math.round(amount * rate); // peer discount'), 'utf8');
          } else {
            const p = path.join(wt, 'src', `mod_${i}.js`);
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`+ ${i};`, `+ ${i + 100};`), 'utf8');
          }
        } else {
          // Contend on routes.js line 2/3 or shared file
          const p = path.join(wt, 'src', 'routes.js');
          fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`mod_${i}: 'v0'`, `mod_${i}: 'v1-agent-${i}'`), 'utf8');
        }
        const gateOk = await runGateAsync(wt, workload === 'disjoint' ? i : null);
        if (!gateOk) {
          brokenStates += 1;
          return;
        }
        await serializeMerge(async () => {
          execFileSync('git', ['add', '-A'], { cwd: wt, stdio: 'ignore' });
          execFileSync('git', ['commit', '-q', '-m', `agent-${i}`], { cwd: wt, stdio: 'ignore' });
          try {
            execFileSync('git', ['merge', '--no-edit', branch], { cwd: repoDir, stdio: 'ignore' });
            committed += 1;
          } catch {
            try { execFileSync('git', ['merge', '--abort'], { cwd: repoDir, stdio: 'ignore' }); } catch {}
            conflicts += 1;
          }
        });
      }),
    );
  } finally {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, stdio: 'ignore' }); } catch {}
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const { valid } = verifyRepoCleanAndValid(repoDir, k);
  return {
    wallMs,
    attempted: k,
    committed,
    conflicts,
    lostUpdates: 0,
    spuriousAborts: 0,
    mainBroken: valid ? brokenStates : brokenStates + 1,
  };
}

/**
 * Regime 4: xioflow WorkspaceArbiter + isolated vfs_tx + SessionView Early Cutoff (no manual git merge).
 */
async function runXioflowArbiter(k, workload, repoDir, domainDir) {
  const t0 = process.hrtime.bigint();
  const server = new WorkspaceArbiterServer({ workspaceRoot: repoDir, domainPath: domainDir });
  const manifest = await server.start();

  let committed = 0;
  let conflicts = 0;
  let earlyCutoffHitsTotal = 0;
  let spuriousAborts = 0;
  let staleAlertsOnDeps = 0;
  const readBarrier = createBarrier(k);
  let markAgent0Done;
  const agent0Done = new Promise((r) => { markAgent0Done = r; });

  try {
    await Promise.all(
      Array.from({ length: k }, async (_, i) => {
        const client = new WorkspaceArbiterClient(manifest, `agent-${i}`);
        await client.registerHello();
        try {
          if (workload === 'disjoint') {
            // Read shared.js scoped to symbol computeTax ONLY (agent-0 mutates computeDiscount)!
            await client.blob({ op: 'slice', target: 'src/shared.js', symbols: ['computeTax'] });
            await readBarrier();
            if (i === 0) {
              try {
                const res = await client.vfs_tx({
                  txId: `tx-disjoint-${i}`,
                  isolated: true,
                  mutations: [
                    {
                      kind: 'patch',
                      path: 'src/shared.js',
                      oldText: 'return Math.round(amount * 0.9);',
                      newText: 'const rate = 0.9; return Math.round(amount * rate); // peer discount',
                    },
                  ],
                  gateCmd: 'node test/verify.mjs 0',
                });
                if (res.status === 'committed') committed += 1;
                else conflicts += 1;
              } finally {
                markAgent0Done();
              }
            } else {
              await agent0Done;
              const obs = await client.observe();
              earlyCutoffHitsTotal += obs.sessionStats.earlyCutoffHits;
              if (obs.staleReads.some((sr) => sr.path === 'src/shared.js')) {
                spuriousAborts += 1;
              }
              const modPath = `src/mod_${i}.js`;
              const sl = await client.blob({ op: 'slice', target: modPath });
              const res = await client.vfs_tx({
                txId: `tx-disjoint-${i}`,
                isolated: true,
                mutations: [
                  {
                    kind: 'patch',
                    path: modPath,
                    oldText: `+ ${i};`,
                    newText: `+ ${i + 100};`,
                    expectedRev: sl.rev,
                  },
                ],
                gateCmd: `node test/verify.mjs ${i}`,
              });
              if (res.status === 'committed') committed += 1;
              else conflicts += 1;
            }
          } else {
            // Contended workload: all k agents read & mutate src/routes.js concurrently with expectedRev OCC!
            const sl = await client.blob({ op: 'slice', target: 'src/routes.js' });
            await readBarrier();
            const res = await client.vfs_tx({
              txId: `tx-contend-${i}`,
              isolated: true,
              mutations: [
                {
                  kind: 'patch',
                  path: 'src/routes.js',
                  oldText: `mod_${i}: 'v0'`,
                  newText: `mod_${i}: 'v1-agent-${i}'`,
                  expectedRev: sl.rev,
                },
              ],
              gateCmd: 'node test/verify.mjs',
            });
            if (res.status === 'committed') committed += 1;
            else if (res.status === 'conflict') conflicts += 1;
            const obs = await client.observe();
            if (obs.staleReads.length > 0) staleAlertsOnDeps += 1;
          }
        } finally {
          await client.close();
        }
      }),
    );
  } finally {
    await server.close();
  }

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const routesFinal = fs.readFileSync(path.join(repoDir, 'src', 'routes.js'), 'utf8');
  let lostUpdates = 0;
  if (workload === 'contended') {
    let retained = 0;
    for (let i = 0; i < k; i++) {
      if (routesFinal.includes(`mod_${i}: 'v1-agent-${i}'`)) retained += 1;
    }
    lostUpdates = committed - retained;
  }
  const { valid } = verifyRepoCleanAndValid(repoDir, k);
  return {
    wallMs,
    attempted: k,
    committed,
    conflicts,
    lostUpdates,
    spuriousAborts,
    earlyCutoffHits: earlyCutoffHitsTotal,
    staleAlertsOnDeps,
    mainBroken: valid ? 0 : 1,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workloads = ['disjoint', 'contended'];
  const regimes = [
    { id: 'no_coordination', fn: (k, w, repo) => runNoCoordination(k, w, repo) },
    { id: 'coarse_no_cutoff', fn: (k, w, repo) => runCoarseNoCutoff(k, w, repo) },
    { id: 'manual_git_worktree', fn: (k, w, repo) => runManualGitWorktree(k, w, repo) },
    { id: 'xioflow_arbiter_occ', fn: (k, w, repo, dom) => runXioflowArbiter(k, w, repo, dom) },
  ];

  const rows = [];
  for (const workload of workloads) {
    for (const k of opts.concurrencies) {
      for (const regime of regimes) {
        const trialMetrics = [];
        for (let t = 0; t < opts.trials; t++) {
          const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-occ-')));
          const repoDir = path.join(tempRoot, 'repo');
          const domDir = path.join(tempRoot, 'domain');
          fs.mkdirSync(repoDir, { recursive: true });
          try {
            seedMultiModuleRepo(repoDir, k);
            const m = await regime.fn(k, workload, repoDir, domDir);
            trialMetrics.push(m);
          } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
          }
        }
        const sum = (key) => trialMetrics.reduce((a, m) => a + (m[key] ?? 0), 0);
        const totalAttempted = sum('attempted');
        const wallSummary = summarizeMs(trialMetrics.map((m) => m.wallMs));
        rows.push({
          workload,
          concurrency: k,
          regime: regime.id,
          trials: opts.trials,
          committedTotal: sum('committed'),
          attemptedTotal: totalAttempted,
          commitRatePct: Math.round((sum('committed') / totalAttempted) * 1000) / 10,
          conflictsTotal: sum('conflicts'),
          lostUpdatesTotal: sum('lostUpdates'),
          lostUpdateRatePct: Math.round((sum('lostUpdates') / totalAttempted) * 1000) / 10,
          spuriousAbortsTotal: sum('spuriousAborts'),
          earlyCutoffHitsTotal: sum('earlyCutoffHits'),
          mainBrokenTotal: sum('mainBroken'),
          wallP50Ms: wallSummary.p50Ms,
          wallP95Ms: wallSummary.p95Ms,
          wallMeanMs: wallSummary.meanMs,
        });
      }
    }
  }

  const report = {
    benchmark: 'occ-scalability',
    env: systemEnvironmentMetadata(),
    config: opts,
    results: rows,
  };
  writeBenchmarkJson(opts.output, report);

  console.log('\nMulti-Client OCC Scalability Summary:');
  console.table(
    rows.map((r) => ({
      workload: r.workload,
      k: r.concurrency,
      regime: r.regime,
      commit_pct: r.commitRatePct,
      lost_updates: r.lostUpdatesTotal,
      spurious_aborts: r.spuriousAbortsTotal,
      early_cutoffs: r.earlyCutoffHitsTotal,
      main_broken: r.mainBrokenTotal,
      wall_p50_ms: r.wallP50Ms,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
