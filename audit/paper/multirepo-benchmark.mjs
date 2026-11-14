import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KernelMedium, ReaperPlatformDriver } from '../../dist/index.js';
import { createSurfaceDispatcher, toOpenAiTools } from '../../dist/surface/index.js';
import { summarizeMs, systemEnvironmentMetadata, writeBenchmarkJson } from '../../benchmarks/paper/_stats.mjs';
import { callChatCompletions, getOllamaConfig, scrubCredential } from './_ollama.mjs';
import { buildAll30Tasks } from './multirepo-tasks.mjs';

function parseArgs(argv) {
  const out = {
    concurrency: 3,
    maxTurns: 14,
    output: null,
    filter: null,
    dryCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' && argv[i + 1]) out.concurrency = Math.max(1, Number(argv[++i]));
    else if (a === '--max-turns' && argv[i + 1]) out.maxTurns = Math.max(2, Number(argv[++i]));
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
    else if (a === '--filter' && argv[i + 1]) out.filter = argv[++i];
    else if (a === '--dry-check') out.dryCheck = true;
  }
  return out;
}

function findTaggedPids(tag, port = null) {
  const pids = new Map();
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      const cmd = m[3];
      if (cmd.includes(tag) || (port && (cmd.includes(`--port ${port}`) || cmd.includes(`LISTENING:${port}`)))) {
        pids.set(pid, { pid, ppid: Number(m[2]), cmd: cmd.slice(0, 140) });
      }
    }
  } catch {}
  try {
    if (port) {
      const lsofOut = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
      for (const raw of lsofOut.split('\n')) {
        const pid = Number(raw.trim());
        if (pid > 0 && pid !== process.pid && !pids.has(pid)) {
          pids.set(pid, { pid, ppid: 0, cmd: `LISTEN:${port}` });
        }
      }
    }
  } catch {}
  return [...pids.values()];
}

function forceCleanupTag(tag, port = null) {
  for (const p of findTaggedPids(tag, port)) {
    try { process.kill(p.pid, 'SIGKILL'); } catch {}
  }
}

const RAW_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command via /bin/sh -c in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          timeoutMs: { type: 'integer', description: 'Timeout in ms (default 10000).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read UTF-8 text from a workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative workspace file path.' },
          startLine: { type: 'integer', description: 'Optional 1-based start line.' },
          endLine: { type: 'integer', description: 'Optional 1-based inclusive end line.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Overwrite or create a workspace file with exact UTF-8 content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative workspace file path.' },
          content: { type: 'string', description: 'Complete file content to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search text across workspace files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to search for.' },
          path: { type: 'string', description: 'Optional relative path.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
];

function resolveSafePath(wsDir, relPath) {
  const abs = path.resolve(wsDir, relPath);
  const root = fs.realpathSync(wsDir);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return abs;
}

function runRawShell(command, cwd, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 120_000;
    child.stdout.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        exitCode: 124,
        timedOut: true,
        stdout: stdout.slice(0, cap),
        stderr: `${stderr.slice(0, cap)}\n[shell timed out after ${timeoutMs}ms]`,
      });
    }, Math.min(20_000, Math.max(1000, Number(timeoutMs) || 10_000)));
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, timedOut: false, stdout, stderr: err.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve({ exitCode: code ?? 1, timedOut: false, stdout: stdout.slice(0, cap), stderr: stderr.slice(0, cap) });
      }
    });
  });
}

function createRawDispatcher(wsDir) {
  return {
    async call(name, args) {
      if (name === 'shell') {
        if (typeof args?.command !== 'string') return { error: 'command string required' };
        return await runRawShell(args.command, wsDir, args.timeoutMs);
      }
      if (name === 'read_file') {
        const abs = resolveSafePath(wsDir, String(args?.path ?? ''));
        if (!fs.existsSync(abs)) return { error: `missing file: ${args?.path}` };
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const start = Math.max(1, Number(args?.startLine ?? 1));
        const end = Math.min(lines.length, Number(args?.endLine ?? lines.length));
        const numbered = lines.slice(start - 1, end).map((l, idx) => `${start + idx}|${l}`).join('\n');
        return { path: args.path, totalLines: lines.length, content: numbered };
      }
      if (name === 'write_file') {
        const abs = resolveSafePath(wsDir, String(args?.path ?? ''));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args?.content ?? ''), 'utf8');
        return { ok: true, path: args.path };
      }
      if (name === 'grep') {
        const pat = String(args?.pattern ?? '');
        const target = args?.path ? resolveSafePath(wsDir, String(args.path)) : wsDir;
        try {
          const out = execFileSync('grep', ['-rn', pat, target], { cwd: wsDir, encoding: 'utf8', maxBuffer: 1024 * 1024 });
          return { matches: out.slice(0, 16_384) };
        } catch (err) {
          if (err.status === 1) return { matches: '' };
          return { error: String(err.message) };
        }
      }
      return { error: `Unknown tool: ${name}` };
    },
  };
}

function isServerTestCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  return (
    cmd.includes('integration.mjs') ||
    cmd.includes('integration.py') ||
    cmd.includes('make test') ||
    cmd.includes('build/check')
  );
}

function getSystemPrompt(arm) {
  if (arm === 'raw_baseline') {
    return [
      'You are an autonomous systems & software engineering agent.',
      'You have `shell`, `read_file`, `write_file`, and `grep` operating directly on the repository workspace.',
      'Inspect the relevant source/test files, make clean minimal edits, and run verification tests before concluding.',
      'If asked to start a background server, stop every background server/child process before replying.',
      'If a speculative patch fails a test invariant, restore the workspace cleanly against Git HEAD before replying.',
    ].join('\n');
  }
  return [
    'You are an autonomous systems & software engineering agent operating inside the `xioflow` OS-kernel medium.',
    'You have 4 tools:',
    '- `inspect`: read file slices (pass `symbols` when observing shared dependencies so unrelated edits hit Early Cutoff), grep files or spilled `blob:...` outputs (`mode="grep"`), await ports/HTTP/processes, or check status.',
    '- `run`: execute supervised commands, or launch `background: true` services with `waitHttpUrl` readiness and clean tree teardown via `stopOpId`. Oversized logs spill cleanly to `blob:...` refs that you can search with `inspect`.',
    '- `edit`: atomic causal edits (`patch` or `write`) backed by `SessionView` (if `conflict` reports a concurrent peer commit diff, re-`inspect` and merge without losing peer changes) and optional `gateCmd` auto-rollback.',
    '- `branch`: isolated git-shadow worktree execution (`cmd`, `mutations`, `gateCmd`, `commit`) that leaves the main workspace completely untouched if `gateCmd` exits non-zero.',
    'Always verify tests pass cleanly and clean up any background process you started before giving your final response.',
  ].join('\n');
}

async function runTaskArm({ task, arm, cfg, maxTurns }) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xio-mr-${arm}-`)));
  const wsDir = path.join(tempRoot, 'repo');
  const domDir = path.join(tempRoot, 'domain');
  fs.mkdirSync(wsDir, { recursive: true });
  const runTag = `xmr-${task.id}-${arm}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  let medium = null;
  let portForCleanup = null;
  const t0 = process.hrtime.bigint();

  try {
    const state = await task.seed(wsDir, { runTag });
    portForCleanup = state.port ?? null;
    const promptText = state.prompt ?? task.prompt;
    const sessionId = `sess-${runTag}`;

    let tools;
    let dispatcher;
    if (arm === 'raw_baseline') {
      tools = RAW_TOOLS;
      dispatcher = createRawDispatcher(wsDir);
    } else {
      medium = await KernelMedium.open(wsDir, {
        domainPath: domDir,
        driver: new ReaperPlatformDriver(),
      });
      tools = toOpenAiTools();
      dispatcher = createSurfaceDispatcher(medium);
    }

    const messages = [
      { role: 'system', content: getSystemPrompt(arm) },
      { role: 'user', content: promptText },
    ];

    let turns = 0;
    let toolCallsCount = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let toolOutputBytes = 0;
    let blobRefsObserved = 0;
    let conflictNotices = 0;
    let rollbacksTriggered = 0;
    let integrationOk = false;
    let agentError = null;
    let earlyCutoffHits = 0;
    let gateRollbacksObserved = 0;

    // Peer mutation tracking for Category D
    let hasReadTriggerPath = false;
    let cmdExecCount = 0;
    const maybeTriggerPeer = () => {
      if (state.peerMutated || typeof state.applyPeerMutation !== 'function') return;
      if (state.peerTriggerAfterFirstCmd) {
        if (hasReadTriggerPath && cmdExecCount >= 1) {
          state.applyPeerMutation();
          state.peerMutated = true;
        }
      } else if (hasReadTriggerPath) {
        state.applyPeerMutation();
        state.peerMutated = true;
      }
    };

    try {
      for (let t = 0; t < maxTurns; t++) {
        turns += 1;
        const resp = await callChatCompletions({
          baseUrl: cfg.apiBase,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages,
          tools,
          temperature: 0,
          maxTokens: 1536,
          timeoutMs: 60_000,
        });
        promptTokens += resp.usage.promptTokens;
        completionTokens += resp.usage.completionTokens;
        totalTokens += resp.usage.totalTokens;

        messages.push({
          role: 'assistant',
          content: resp.content || null,
          ...(resp.toolCalls.length > 0
            ? {
                tool_calls: resp.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        });

        if (resp.toolCalls.length === 0) break;

        for (const tc of resp.toolCalls) {
          toolCallsCount += 1;
          let resultObj;
          try {
            resultObj =
              arm === 'raw_baseline'
                ? await dispatcher.call(tc.name, tc.args)
                : await dispatcher.call(tc.name, tc.args, { sessionId });
          } catch (toolErr) {
            resultObj = { error: String(toolErr?.message ?? toolErr) };
          }

          if (state.peerTriggerPath) {
            if (tc.name === 'read_file' && typeof tc.args?.path === 'string' && tc.args.path.includes(path.basename(state.peerTriggerPath))) {
              hasReadTriggerPath = true;
            }
            if (tc.name === 'inspect' && typeof tc.args?.target === 'string' && tc.args.target.includes(path.basename(state.peerTriggerPath))) {
              hasReadTriggerPath = true;
            }
          }
          if (tc.name === 'shell' || tc.name === 'run') {
            cmdExecCount += 1;
            const cmdText = tc.args?.command || tc.args?.cmd || '';
            if (
              task.category === 'B_bg_service' &&
              isServerTestCommand(cmdText) &&
              resultObj?.exitCode === 0 &&
              String(resultObj?.stdout ?? '').includes('INTEGRATION_OK')
            ) {
              integrationOk = true;
            }
          }

          if (resultObj?.stdoutBlob || resultObj?.stderrBlob) blobRefsObserved += 1;
          if (resultObj?.status === 'conflict') conflictNotices += 1;
          if (resultObj?.status === 'rolled_back') {
            rollbacksTriggered += 1;
            gateRollbacksObserved += 1;
          }

          maybeTriggerPeer();

          const serialized = JSON.stringify(resultObj);
          toolOutputBytes += Buffer.byteLength(serialized, 'utf8');
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: serialized,
          });
        }
      }
    } catch (err) {
      agentError = scrubCredential(String(err?.message ?? err), cfg.apiKey);
    }

    if (medium) {
      try {
        const obs = await medium.observe({ sessionId });
        earlyCutoffHits = obs.sessionStats?.earlyCutoffHits ?? 0;
      } catch {}
    }

    const orphansBeforeClose =
      task.category === 'B_bg_service' ? findTaggedPids(runTag, state.port).length : 0;

    if (medium) {
      await medium.close();
      medium = null;
      if (task.category === 'B_bg_service') {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    const orphansAfterRuntimeClose =
      task.category === 'B_bg_service' ? findTaggedPids(runTag, state.port).length : 0;

    const ver = await task.verify(wsDir, state, {
      integrationOk,
      orphansBeforeClose,
      orphansAfterRuntimeClose,
      forceCleanTag: () => forceCleanupTag(runTag, portForCleanup),
    });

    const wallMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100;
    return {
      taskId: task.id,
      language: task.language,
      category: task.category,
      arm,
      passed: !agentError && ver.passed === true,
      testsUntampered: ver.testsUntampered !== false,
      peerUpdatePreserved: ver.peerUpdatePreserved ?? null,
      orphansBeforeClose,
      orphansAfterRuntimeClose,
      dirtyCount: ver.dirtyCount ?? null,
      turns,
      toolCallsCount,
      promptTokens,
      completionTokens,
      totalTokens,
      toolOutputBytes,
      blobRefsObserved,
      conflictNotices,
      rollbacksTriggered: gateRollbacksObserved,
      earlyCutoffHits,
      wallMs,
      error: agentError || (!ver.passed ? ver.detail : null),
    };
  } finally {
    if (medium) {
      try { await medium.close(); } catch {}
    }
    forceCleanupTag(runTag, portForCleanup);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function dryVerifyAllSeeds(tasks) {
  for (const task of tasks) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-dry-')));
    const ws = path.join(tmp, 'repo');
    fs.mkdirSync(ws, { recursive: true });
    try {
      const state = await task.seed(ws, { runTag: `dry-${task.id}` });
      const ver = await task.verify(ws, state, {
        integrationOk: false,
        orphansBeforeClose: 0,
        orphansAfterRuntimeClose: 0,
      });
      const expectedInitPass = task.id.includes('-c2-');
      if (ver.passed !== expectedInitPass) {
        throw new Error(`Dry seed check mismatch on ${task.id}: initial passed=${ver.passed}, expected=${expectedInitPass}, detail=${ver.detail}`);
      }
      if (!ver.testsUntampered) {
        throw new Error(`Dry seed tamper check failed on ${task.id}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`Dry check passed for all ${tasks.length} seeded tasks!`);
}

function summarizeGroup(rows) {
  const n = rows.length;
  if (n === 0) return null;
  const passed = rows.filter((r) => r.passed).length;
  const avg = (sel) => Math.round((rows.reduce((a, r) => a + sel(r), 0) / n) * 100) / 100;
  const peerRows = rows.filter((r) => r.peerUpdatePreserved !== null);
  const bgRows = rows.filter((r) => r.category === 'B_bg_service');
  return {
    tasks: n,
    passed,
    passRatePct: Math.round((passed / n) * 1000) / 10,
    avgPromptTokens: Math.round(avg((r) => r.promptTokens)),
    avgTotalTokens: Math.round(avg((r) => r.totalTokens)),
    avgToolOutputBytes: Math.round(avg((r) => r.toolOutputBytes)),
    avgTurns: avg((r) => r.turns),
    wallP50Ms: summarizeMs(rows.map((r) => r.wallMs)).p50Ms,
    bgOrphansAfterCloseTotal: bgRows.reduce((a, r) => a + r.orphansAfterRuntimeClose, 0),
    bgOrphansBeforeCloseTotal: bgRows.reduce((a, r) => a + r.orphansBeforeClose, 0),
    peerUpdatesLostTotal: peerRows.filter((r) => r.peerUpdatePreserved === false).length,
    earlyCutoffHitsTotal: rows.reduce((a, r) => a + r.earlyCutoffHits, 0),
    conflictNoticesTotal: rows.reduce((a, r) => a + r.conflictNotices, 0),
    rollbacksTriggeredTotal: rows.reduce((a, r) => a + r.rollbacksTriggered, 0),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let tasks = buildAll30Tasks();
  if (opts.filter) {
    tasks = tasks.filter((t) => t.id.includes(opts.filter) || t.category.includes(opts.filter) || t.language.includes(opts.filter));
  }
  console.log(`Loaded ${tasks.length} benchmark tasks.`);

  if (opts.dryCheck) {
    await dryVerifyAllSeeds(tasks);
    return;
  }

  const cfg = getOllamaConfig();
  const workItems = [];
  for (const task of tasks) {
    workItems.push({ task, arm: 'raw_baseline' });
    workItems.push({ task, arm: 'xioflow_surface' });
  }

  const results = await runPool(workItems, opts.concurrency, async ({ task, arm }, idx) => {
    const res = await runTaskArm({ task, arm, cfg, maxTurns: opts.maxTurns });
    console.log(
      `[${idx + 1}/${workItems.length}] ${task.id} (${arm}) => pass=${res.passed} turns=${res.turns} promptTok=${res.promptTokens} outBytes=${res.toolOutputBytes} orphans=${res.orphansAfterRuntimeClose} peerOk=${res.peerUpdatePreserved} (${res.wallMs}ms)${res.error ? ` err=${res.error.slice(0, 120)}` : ''}`,
    );
    return res;
  });

  const overall = {
    raw_baseline: summarizeGroup(results.filter((r) => r.arm === 'raw_baseline')),
    xioflow_surface: summarizeGroup(results.filter((r) => r.arm === 'xioflow_surface')),
  };

  const byCategory = [];
  for (const cat of ['A_spill_bugfix', 'B_bg_service', 'C_atomic_rollback', 'D_causal_peer']) {
    for (const arm of ['raw_baseline', 'xioflow_surface']) {
      const g = summarizeGroup(results.filter((r) => r.category === cat && r.arm === arm));
      if (g) byCategory.push({ category: cat, arm, ...g });
    }
  }

  const byLanguage = [];
  for (const lang of ['javascript', 'python', 'c']) {
    for (const arm of ['raw_baseline', 'xioflow_surface']) {
      const g = summarizeGroup(results.filter((r) => r.language === lang && r.arm === arm));
      if (g) byLanguage.push({ language: lang, arm, ...g });
    }
  }

  const report = {
    benchmark: 'multirepo-30tasks',
    model: cfg.model,
    env: systemEnvironmentMetadata(),
    config: { concurrency: opts.concurrency, maxTurns: opts.maxTurns, taskCount: tasks.length },
    overall,
    byCategory,
    byLanguage,
    runs: results,
  };
  writeBenchmarkJson(opts.output, report);

  console.log('\nOverall Comparison:');
  console.table([
    { arm: 'raw_baseline', ...overall.raw_baseline },
    { arm: 'xioflow_surface', ...overall.xioflow_surface },
  ]);
  console.log('\nBy Category:');
  console.table(byCategory);
  console.log('\nBy Language:');
  console.table(byLanguage);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
