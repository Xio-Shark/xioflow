import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CgroupPlatformDriver,
  ExecutionDomain,
  KernelMedium,
  ProcessSupervisor,
  ReaperPlatformDriver,
} from '../../dist/index.js';
import { initGitRepo, summarizeMs, systemEnvironmentMetadata, writeBenchmarkJson } from './_stats.mjs';

function parseArgs(argv) {
  const out = { trials: 6, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trials' && argv[i + 1]) out.trials = Number(argv[++i]);
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
  }
  return out;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidForce(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

/**
 * Scenario S1 (Crashed node / activity spawning detached grandchild):
 * Simulates LangGraph node or Temporal activity invoking an external tool that
 * detaches a background helper (`setsid`) writing heartbeats to effects.log,
 * followed by a sudden SIGKILL crash on the orchestrator/worker.
 */
async function runOrphanEscapeComparison(trials) {
  const reaperAvailable = ReaperPlatformDriver.isAvailable();
  const cgroupAvailable = CgroupPlatformDriver.unavailableReason() === null;
  const regimes = [
    'langgraph_checkpoint_only_spawn',
    'temporal_activity_retry_only_spawn',
    ...(reaperAvailable ? ['xioflow_reaper_subreaper'] : []),
    ...(cgroupAvailable ? ['xioflow_cgroup_v2'] : []),
  ];

  const rows = [];
  for (const regime of regimes) {
    let orphanSurvived = 0;
    let postKillDuplicates = 0;
    let verifiedEmptyCount = 0;
    const stopLatencies = [];

    for (let t = 0; t < trials; t++) {
      const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-crash-s1-')));
      const logFile = path.join(tempRoot, 'effects.log');
      const pidFile = path.join(tempRoot, 'daemon.pid');
      const helperScript = path.join(tempRoot, 'detached-daemon.mjs');
      fs.writeFileSync(
        helperScript,
        [
          "import fs from 'node:fs';",
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
          `fs.appendFileSync(${JSON.stringify(logFile)}, 'tick-0\\n', 'utf8');`,
          `const timer = setInterval(() => { try { fs.appendFileSync(${JSON.stringify(logFile)}, 'orphan-tick\\n', 'utf8'); } catch {} }, 60);`,
          'setTimeout(() => { clearInterval(timer); process.exit(0); }, 2500);',
        ].join('\n'),
        'utf8',
      );
      const launchCode = [
        "import { spawn } from 'node:child_process';",
        `const child = spawn(process.execPath, [${JSON.stringify(helperScript)}], { detached: true, stdio: 'ignore' });`,
        'child.unref();',
        'setTimeout(() => process.exit(0), 2200);',
      ].join(' ');

      let trackedPid = null;
      try {
        if (regime === 'langgraph_checkpoint_only_spawn' || regime === 'temporal_activity_retry_only_spawn') {
          const worker = spawn('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} --input-type=module -e ${JSON.stringify(launchCode)}`], {
            cwd: tempRoot,
            stdio: 'ignore',
          });
          // Wait for daemon.pid to appear
          const deadline = Date.now() + 2000;
          while (!fs.existsSync(pidFile) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 15));
          }
          if (fs.existsSync(pidFile)) trackedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
          const t0 = process.hrtime.bigint();
          worker.kill('SIGKILL');
          await new Promise((r) => worker.once('close', r));
          stopLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
          await new Promise((r) => setTimeout(r, 200));
          if (trackedPid && isPidAlive(trackedPid)) orphanSurvived += 1;
          const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
          if (lines.some((l) => l === 'orphan-tick')) postKillDuplicates += 1;
        } else {
          const driver = regime === 'xioflow_cgroup_v2' ? new CgroupPlatformDriver() : new ReaperPlatformDriver();
          const domain = ExecutionDomain.acquire(path.join(tempRoot, 'dom'), `crash-s1-${t}`);
          try {
            const store = domain.getStore();
            store.saveTask({ id: 't1', domainId: domain.domainId, name: 't1', createdAt: new Date().toISOString() });
            store.saveRun({ id: 'r1', taskId: 't1', domainId: domain.domainId, owner: 'bench', status: 'running', startedAt: new Date().toISOString() });
            const sup = new ProcessSupervisor(domain, driver);
            const execPromise = sup.executeProcess({
              runId: 'r1',
              opId: `op-s1-${t}`,
              name: 'daemon-spawn',
              timeoutMs: 180,
              graceMs: 120,
              command: {
                execPath: process.execPath,
                args: ['--input-type=module', '-e', launchCode],
                cwd: tempRoot,
                inheritEnv: true,
              },
            });
            const t0 = process.hrtime.bigint();
            const res = await execPromise;
            stopLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
            if (fs.existsSync(pidFile)) trackedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            if (res.kind === 'process' && res.stopResult?.stopped === 'confirmed_stopped') verifiedEmptyCount += 1;
            await new Promise((r) => setTimeout(r, 150));
            const linesBeforeCheck = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
            await new Promise((r) => setTimeout(r, 120));
            const linesAfterCheck = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
            if (trackedPid && isPidAlive(trackedPid)) orphanSurvived += 1;
            if (linesAfterCheck > linesBeforeCheck) postKillDuplicates += 1;
          } finally {
            domain.close();
          }
        }
      } finally {
        if (trackedPid) killPidForce(trackedPid);
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }

    const lat = summarizeMs(stopLatencies);
    rows.push({
      scenario: 'S1_detached_setsid_orphan_on_crash',
      regime,
      trials,
      orphanSurvived,
      orphanSurvivalRatePct: Math.round((orphanSurvived / trials) * 1000) / 10,
      postCrashSideEffects: postKillDuplicates,
      confirmedTreeEmptyCount: verifiedEmptyCount,
      stopLatencyP50Ms: lat.p50Ms,
    });
  }
  return rows;
}

/**
 * Scenario S2 & S3:
 * Extending `examples/langgraph-node` & `examples/temporal-activity` with REAL SIGKILL worker crashes:
 * Spawns a real Node worker process that runs an external side-effect + workspace edit,
 * prints READY before persisting its app-level checkpoint, and is immediately SIGKILLed.
 * Attempt 2 spawns a fresh worker process to recover/retry.
 */
async function spawnUntilReadyThenKill(scriptPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (!killed && stdout.includes('__READY_BEFORE_CHECKPOINT__')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, killed, stdout, stderr }));
  });
}

async function runSpawnSyncWorker(scriptPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runReplayDuplicationAndDirtyTreeComparison(trials) {
  const kernelPath = path.resolve(import.meta.dirname, '../../dist/index.js');
  const regimes = [
    'langgraph_checkpoint_only',
    'temporal_retry_only',
    'xioflow_langgraph_opid_vfs_tx',
    'xioflow_temporal_opid_vfs_tx',
  ];

  const rows = [];
  for (const regime of regimes) {
    let duplicateSideEffects = 0;
    let dirtyCorruptRepos = 0;
    let killsDelivered = 0;

    for (let t = 0; t < trials; t++) {
      const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-crash-s23-')));
      const repoDir = path.join(tempRoot, 'workspace');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'config.json'), '{"version":1,"stable":true}\n', 'utf8');
      const externalLog = path.join(tempRoot, 'external-effects.log');
      const checkpointFile = path.join(tempRoot, 'app-checkpoint.json');
      const domPath = path.join(tempRoot, 'dom');
      initGitRepo(repoDir);

      try {
        const isXio = regime.startsWith('xioflow_');
        const workerScript = path.join(tempRoot, 'worker.mjs');
        if (!isXio) {
          fs.writeFileSync(
            workerScript,
            [
              "import fs from 'node:fs';",
              "const mode = process.argv[2];",
              `const logPath = ${JSON.stringify(externalLog)};`,
              `const ckptPath = ${JSON.stringify(checkpointFile)};`,
              `const cfgPath = ${JSON.stringify(path.join(repoDir, 'config.json'))};`,
              'if (fs.existsSync(ckptPath)) { console.log("CKPT_HIT"); process.exit(0); }',
              // Execute external side effect + leave corrupt partial config write before checkpoint:
              `fs.appendFileSync(logPath, 'side-effect-${t}\\n', 'utf8');`,
              'fs.writeFileSync(cfgPath, "{CORRUPT_PARTIAL_WRITE", "utf8");',
              'if (mode === "attempt1") {',
              '  console.log("__READY_BEFORE_CHECKPOINT__");',
              '  setTimeout(() => { fs.writeFileSync(ckptPath, JSON.stringify({ done: true })); }, 400);',
              '} else {',
              '  fs.writeFileSync(ckptPath, JSON.stringify({ done: true }));',
              '  console.log("ATTEMPT2_DONE");',
              '}',
            ].join('\n'),
            'utf8',
          );
        } else {
          const appendSnippet = `require("fs").appendFileSync(${JSON.stringify(externalLog)}, "side-effect-${t}\\n", "utf8")`;
          const gateCheckCmd = `${JSON.stringify(process.execPath)} -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"`;
          fs.writeFileSync(
            workerScript,
            [
              "import fs from 'node:fs';",
              `import { KernelMedium } from ${JSON.stringify(kernelPath)};`,
              "const mode = process.argv[2];",
              `const repoDir = ${JSON.stringify(repoDir)};`,
              `const domPath = ${JSON.stringify(domPath)};`,
              `const ckptPath = ${JSON.stringify(checkpointFile)};`,
              `const opId = ${JSON.stringify(`${regime}:wf-${t}:step-1`)};`,
              'if (fs.existsSync(ckptPath)) { console.log("CKPT_HIT"); process.exit(0); }',
              'const medium = await KernelMedium.open(repoDir, { domainPath: domPath });',
              'try {',
              '  const res = await medium.exec({',
              '    opId,',
              '    execPath: process.execPath,',
              `    args: ["-e", ${JSON.stringify(appendSnippet)}],`,
              '  });',
              // Isolated tx with broken JSON rolls back cleanly before touching main repo:
              '  await medium.vfs_tx({',
              `    txId: "tx-corrupt-${t}-" + mode,`,
              '    isolated: true,',
              '    mutations: [{ kind: "write", path: "config.json", content: "{CORRUPT_PARTIAL_WRITE" }],',
              `    gateCmd: ${JSON.stringify(gateCheckCmd)},`,
              '  });',
              '  if (mode === "attempt1") {',
              '    console.log("__READY_BEFORE_CHECKPOINT__");',
              '    await new Promise((r) => setTimeout(r, 400));',
              '    fs.writeFileSync(ckptPath, JSON.stringify({ done: true }));',
              '  } else {',
              '    fs.writeFileSync(ckptPath, JSON.stringify({ done: true, replayed: res.replayed === true }));',
              '    console.log(JSON.stringify({ replayed: res.replayed === true }));',
              '  }',
              '} finally { await medium.close(); }',
            ].join('\n'),
            'utf8',
          );
        }

        const attempt1 = await spawnUntilReadyThenKill(workerScript, ['attempt1'], tempRoot);
        if (attempt1.killed) killsDelivered += 1;
        await runSpawnSyncWorker(workerScript, ['attempt2'], tempRoot);

        const count = fs.existsSync(externalLog)
          ? fs.readFileSync(externalLog, 'utf8').trim().split('\n').filter(Boolean).length
          : 0;
        if (count !== 1) duplicateSideEffects += 1;
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(repoDir, 'config.json'), 'utf8'));
          if (cfg.version !== 1) dirtyCorruptRepos += 1;
        } catch {
          dirtyCorruptRepos += 1;
        }
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }

    rows.push({
      scenario: 'S2_S3_real_sigkill_before_checkpoint',
      regime,
      trials,
      killsDelivered,
      duplicateSideEffects,
      duplicateRatePct: Math.round((duplicateSideEffects / trials) * 1000) / 10,
      dirtyCorruptRepos,
      dirtyRatePct: Math.round((dirtyCorruptRepos / trials) * 1000) / 10,
    });
  }
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const s1 = await runOrphanEscapeComparison(opts.trials);
  const s23 = await runReplayDuplicationAndDirtyTreeComparison(opts.trials);

  const report = {
    benchmark: 'crash-idempotency-baselines',
    env: systemEnvironmentMetadata(),
    config: opts,
    orphanEscape: s1,
    replayAndDirtyTree: s23,
  };
  writeBenchmarkJson(opts.output, report);

  console.log('\nCrash S1: Detached Subprocess Escape vs Subreaper / Cgroup Tree Containment:');
  console.table(s1);
  console.log('\nCrash S2/S3: LangGraph/Temporal Checkpoint-Only vs xioflow WAL opId + vfs_tx:');
  console.table(s23);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
