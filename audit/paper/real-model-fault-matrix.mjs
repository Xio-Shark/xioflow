import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOllamaConfig, scrubCredential } from './_ollama.mjs';
import { initGitRepo, summarizeMs, systemEnvironmentMetadata, writeBenchmarkJson } from '../../benchmarks/paper/_stats.mjs';

function parseArgs(argv) {
  const out = { trials: 3, output: null, scenarios: ['orphan-at-exit', 'kill-mid-tool', 'mcp-orphan-kill', 'cancel-tree'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trials' && argv[i + 1]) out.trials = Number(argv[++i]);
    else if (a === '--scenarios' && argv[i + 1]) out.scenarios = argv[++i].split(',');
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
  }
  return out;
}

function findTaggedPids(tag) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    const hits = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      if (m[3].includes(tag) && Number(m[1]) !== process.pid) {
        hits.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3].slice(0, 120) });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function forceCleanupTag(tag) {
  for (const p of findTaggedPids(tag)) {
    try { process.kill(p.pid, 'SIGKILL'); } catch {}
  }
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (fs.existsSync(filePath)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 40);
    };
    tick();
  });
}

function seedScenarioWorkspace(wsDir, scenario, tag, mcpMarkerPath, tempRoot) {
  fs.mkdirSync(path.join(wsDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'src', 'config.json'), '{"env":"prod","retries":3}\n', 'utf8');

  if (scenario === 'orphan-at-exit') {
    const bgWorker = path.join(wsDir, 'scripts', 'bg-daemon.mjs');
    const tickLog = path.join(wsDir, 'orphan.log');
    fs.writeFileSync(
      bgWorker,
      [
        "import fs from 'node:fs';",
        `setInterval(() => { try { fs.appendFileSync(${JSON.stringify(tickLog)}, 'tick\\n'); } catch {} }, 100);`,
        'setTimeout(() => process.exit(0), 25000);',
      ].join('\n'),
      'utf8',
    );
    const entry = path.join(wsDir, 'scripts', 'check-env.mjs');
    fs.writeFileSync(
      entry,
      [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        `const child = spawn(process.execPath, [${JSON.stringify(bgWorker)}, ${JSON.stringify(`--paper-tag=${tag}`)}], { detached: true, stdio: 'ignore' });`,
        'child.unref();',
        `fs.writeFileSync(${JSON.stringify(path.join(wsDir, 'orphan.started'))}, String(child.pid));`,
        'console.log("Environment check passed. Helper started pid=" + child.pid);',
      ].join('\n'),
      'utf8',
    );
    return {
      prompt: 'Run `node scripts/check-env.mjs` using the shell tool and report whether it succeeded.',
      markerFile: path.join(wsDir, 'orphan.started'),
      tickLog,
    };
  }

  if (scenario === 'kill-mid-tool') {
    const midMarker = path.join(tempRoot, 'mid-tool.started');
    fs.writeFileSync(
      path.join(wsDir, 'scripts', 'subworker.mjs'),
      `setTimeout(() => process.exit(0), 30000); // --paper-tag=${tag}`,
      'utf8',
    );
    const verifyScript = path.join(wsDir, 'scripts', 'slow-verify.mjs');
    fs.writeFileSync(
      verifyScript,
      [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        `spawn(process.execPath, ['scripts/subworker.mjs', ${JSON.stringify(`--paper-tag=${tag}`)}], { detached: true, stdio: 'ignore' }).unref();`,
        `fs.writeFileSync('src/config.json', '{BROKEN_MID_TOOL');`,
        `fs.writeFileSync('partial-artifact.tmp', 'dirty\\n');`,
        `fs.writeFileSync(${JSON.stringify(midMarker)}, 'started');`,
        'setTimeout(() => process.exit(0), 30000);',
      ].join('\n'),
      'utf8',
    );
    return {
      prompt: 'Execute `node scripts/slow-verify.mjs` now via the shell tool to verify the repository.',
      markerFile: midMarker,
    };
  }

  if (scenario === 'mcp-orphan-kill') {
    return {
      prompt: 'Run `echo ready && sleep 15` via the shell tool and summarize.',
      markerFile: mcpMarkerPath,
    };
  }

  // cancel-tree
  const child = path.join(wsDir, 'scripts', 'sleep-leaf.mjs');
  fs.writeFileSync(child, 'setTimeout(() => process.exit(0), 30000);', 'utf8');
  const treeScript = path.join(wsDir, 'scripts', 'spawn-chain.mjs');
  fs.writeFileSync(
    treeScript,
    [
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      `const c1 = spawn(process.execPath, [${JSON.stringify(child)}, ${JSON.stringify(`--paper-tag=${tag}`)}], { detached: true, stdio: 'ignore' }); c1.unref();`,
      `const c2 = spawn(process.execPath, [${JSON.stringify(child)}, ${JSON.stringify(`--paper-tag=${tag}`)}], { detached: true, stdio: 'ignore' }); c2.unref();`,
      `fs.writeFileSync(${JSON.stringify(path.join(wsDir, 'chain.started'))}, '1');`,
      'setTimeout(() => process.exit(0), 30000);',
    ].join('\n'),
    'utf8',
  );
  return {
    prompt: 'Execute `node scripts/spawn-chain.mjs` using the shell tool and wait for it.',
    markerFile: path.join(wsDir, 'chain.started'),
  };
}

async function runSingleTrial({ scenario, mode, trialIndex, cfg }) {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const cliPath = path.join(repoRoot, 'dist/cli.js');
  const workerPath = path.join(repoRoot, 'audit/paper/_react-cli-worker.mjs');
  const mcpDummyPath = path.join(repoRoot, 'audit/paper/_mcp-dummy.mjs');

  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-rm-fault-')));
  const wsDir = path.join(tempRoot, 'workspace');
  const domDir = path.join(tempRoot, 'domain');
  fs.mkdirSync(wsDir, { recursive: true });
  const tag = `xfpaper-${scenario}-${mode}-${trialIndex}-${Date.now()}`;
  const mcpMarker = path.join(tempRoot, 'mcp.started');

  const meta = seedScenarioWorkspace(wsDir, scenario, tag, mcpMarker, tempRoot);
  initGitRepo(wsDir);

  const workerArgs = [workerPath, '--prompt', meta.prompt, '--max-turns', '4'];
  if (scenario === 'mcp-orphan-kill') {
    const mcpCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(mcpDummyPath)} ${JSON.stringify(`--marker=${mcpMarker}`)} ${JSON.stringify(`--paper-tag=${tag}`)}`;
    workerArgs.push('--mcp-cmd', mcpCmd);
  }

  let cmdBin = process.execPath;
  let cmdArgs = workerArgs;
  if (mode === 'xio_wrap') {
    cmdBin = process.execPath;
    cmdArgs = [
      cliPath,
      'wrap',
      '--domain',
      domDir,
      '--run-id',
      tag,
      '--upstream-url',
      cfg.apiBase,
      ...(scenario === 'kill-mid-tool' ? ['--shadow'] : []),
      '--',
      process.execPath,
      ...workerArgs,
    ];
  }

  const t0 = process.hrtime.bigint();
  const child = spawn(cmdBin, cmdArgs, {
    cwd: wsDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OLLAMA_API_BASE: cfg.apiBase,
      OLLAMA_MODEL: cfg.model,
      OLLAMA_API_KEY: cfg.apiKey,
      OPENAI_BASE_URL: cfg.apiBase,
      OPENAI_API_KEY: cfg.apiKey,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let modelInvokedTool = false;
  let exitInfo;
  try {
    if (scenario === 'orphan-at-exit') {
      const deadline = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 60_000);
      exitInfo = await exited;
      clearTimeout(deadline);
      modelInvokedTool = fs.existsSync(meta.markerFile);
    } else if (scenario === 'kill-mid-tool' || scenario === 'mcp-orphan-kill') {
      const started = await Promise.race([
        waitForFile(meta.markerFile, 45_000),
        exited.then(() => false),
      ]);
      modelInvokedTool = started;
      if (started) {
        // Give the agent ~200ms to be genuinely in-flight before SIGKILL
        if (scenario === 'mcp-orphan-kill') await new Promise((r) => setTimeout(r, 400));
        else await new Promise((r) => setTimeout(r, 150));
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }
      exitInfo = await exited;
    } else {
      // cancel-tree: wait for child tree marker then send SIGINT x2
      const started = await Promise.race([
        waitForFile(meta.markerFile, 45_000),
        exited.then(() => false),
      ]);
      modelInvokedTool = started;
      if (started) {
        await new Promise((r) => setTimeout(r, 150));
        try { process.kill(-child.pid, 'SIGINT'); } catch {}
        const done1 = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))]);
        if (!done1) {
          try { process.kill(-child.pid, 'SIGINT'); } catch {}
        }
      }
      const done2 = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
      if (!done2) {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }
      exitInfo = await exited;
    }

    // Settle 1200ms so watchdog / reaper cleanup runs completely (matching S2/S8 audit settle)
    await new Promise((r) => setTimeout(r, 1200));

    const survivors = findTaggedPids(tag);
    let postTicks = 0;
    if (meta.tickLog && fs.existsSync(meta.tickLog)) {
      const before = fs.readFileSync(meta.tickLog, 'utf8').length;
      await new Promise((r) => setTimeout(r, 300));
      const after = fs.readFileSync(meta.tickLog, 'utf8').length;
      if (after > before) postTicks = after - before;
    }

    let dirtyWorkspace = false;
    if (scenario === 'kill-mid-tool') {
      try {
        const cfgObj = JSON.parse(fs.readFileSync(path.join(wsDir, 'src', 'config.json'), 'utf8'));
        if (cfgObj.retries !== 3 || fs.existsSync(path.join(wsDir, 'partial-artifact.tmp'))) {
          dirtyWorkspace = true;
        }
      } catch {
        dirtyWorkspace = true;
      }
    }

    let faultHolds = false;
    if (!modelInvokedTool) {
      faultHolds = false;
    } else if (scenario === 'kill-mid-tool') {
      faultHolds = survivors.length === 0 && !dirtyWorkspace;
    } else {
      faultHolds = survivors.length === 0 && postTicks === 0;
    }

    return {
      scenario,
      mode,
      trial: trialIndex,
      modelInvokedTool,
      survivorCount: survivors.length,
      postExitLogBytes: postTicks,
      dirtyWorkspace,
      faultHolds,
      wallMs: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100,
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      stderrTail: modelInvokedTool ? '' : scrubCredential(stderr.slice(-400), cfg.apiKey),
    };
  } finally {
    forceCleanupTag(tag);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = getOllamaConfig();
  const rawTrials = [];

  for (const scenario of opts.scenarios) {
    for (const mode of ['raw', 'xio_wrap']) {
      for (let t = 1; t <= opts.trials; t++) {
        const res = await runSingleTrial({ scenario, mode, trialIndex: t, cfg });
        rawTrials.push(res);
        console.log(
          `[real-fault] ${scenario} | ${mode} | t=${t}/${opts.trials} | toolStarted=${res.modelInvokedTool} survivors=${res.survivorCount} dirty=${res.dirtyWorkspace} holds=${res.faultHolds} (${res.wallMs}ms)`,
        );
      }
    }
  }

  const summary = [];
  for (const scenario of opts.scenarios) {
    for (const mode of ['raw', 'xio_wrap']) {
      const sub = rawTrials.filter((r) => r.scenario === scenario && r.mode === mode);
      const applicable = sub.filter((r) => r.modelInvokedTool);
      summary.push({
        scenario,
        mode,
        trials: sub.length,
        toolTriggered: applicable.length,
        holdsCount: applicable.filter((r) => r.faultHolds).length,
        holdsRatePct: applicable.length > 0 ? Math.round((applicable.filter((r) => r.faultHolds).length / applicable.length) * 1000) / 10 : null,
        avgSurvivors: applicable.length > 0 ? Math.round((applicable.reduce((a, r) => a + r.survivorCount, 0) / applicable.length) * 100) / 100 : null,
        dirtyCount: applicable.filter((r) => r.dirtyWorkspace).length,
        wallP50Ms: summarizeMs(sub.map((r) => r.wallMs)).p50Ms,
      });
    }
  }

  const report = {
    experiment: 'real-model-fault-matrix',
    model: cfg.model,
    env: systemEnvironmentMetadata(),
    config: opts,
    summary,
    trials: rawTrials,
  };
  writeBenchmarkJson(opts.output, report);

  console.log('\nReal-Model Fault Matrix Summary:');
  console.table(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
