// One trial: sandbox -> endpoint -> harness -> (scenario drives faults) -> observe from outside -> verdict -> cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { startEndpoint } from './endpoint/server.mjs';
import { startBlackhole } from './endpoint/blackhole.mjs';
import { renderTape } from './endpoint/tape.mjs';
import { harnessProcesses, isAlive, killMatching, processesMatching, taggedProcesses } from './observe/ps.mjs';
import { readEffects, readMarkers } from './observe/effects.mjs';
import { readTranscript, requestSummaries, toolCallsIssued, toolResultsReported } from './observe/transcript.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixture/xf-fixture.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Sandboxes of trials in flight, so an interrupted runner can still clean up. */
export const activeCleanups = new Set();

/** Whitelist only: no token or base URL from the caller's environment reaches a harness. */
function baseEnv(home) {
  const user = os.userInfo().username;
  return {
    PATH: process.env.PATH ?? '', HOME: home, USER: user, LOGNAME: user, SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1',
  };
}

function makeWorkspace(work) {
  fs.mkdirSync(work, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed while preparing the workspace: ${result.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'audit@xf.local');
  git('config', 'user.name', 'xf-audit');
  fs.writeFileSync(path.join(work, 'tracked.txt'), 'tracked, committed\n');
  fs.writeFileSync(path.join(work, '.gitignore'), '*.tmp\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(work, 'untracked.txt'), 'untracked, not ignored\n');
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(25);
  }
}

export async function runTrial({ harness, label, variantEnv, scenario, trial, outDir, keep = false, version }) {
  const runId = `xf${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xf-audit-${runId}-`)));
  const dirs = { work: path.join(sandbox, 'work'), home: path.join(sandbox, 'home'), run: path.join(sandbox, 'run') };
  fs.mkdirSync(dirs.home);
  fs.mkdirSync(dirs.run);
  makeWorkspace(dirs.work);
  const transcriptPath = path.join(sandbox, 'transcript.jsonl');
  const started = Date.now();
  const launches = [];
  const notes = {};
  let endpoint;
  let blackhole;

  const cleanup = () => {
    for (const { child } of launches) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    }
    const killed = [...killMatching(`--xf-tag=${runId}`), ...killMatching(sandbox)];
    return killed;
  };
  // What an interrupted runner calls: same kill pass, and the sandbox goes too.
  const abort = () => {
    cleanup();
    if (!keep) fs.rmSync(sandbox, { recursive: true, force: true });
  };
  activeCleanups.add(abort);

  const result = { harness: label, version, scenario: scenario.name, trial, verdict: 'bench_error', evidence: {}, bench: { runId } };
  try {
    const vars = {
      xf: `${quote(process.execPath)} ${quote(FIXTURE)} --xf-run=${quote(dirs.run)} --xf-tag=${runId}`,
      work: dirs.work, run: dirs.run, tag: runId,
    };
    endpoint = await startEndpoint({ tape: renderTape(scenario.tape, vars), transcriptPath });
    blackhole = await startBlackhole();
    const endpointErrors = [];
    endpoint.events.on('endpoint-error', (err) => endpointErrors.push(String(err?.message ?? err)));

    /** Starts the harness ("launch" or "resume"); each start is its own process group. */
    const start = (kind = 'launch', prompt = scenario.prompt) => {
      if (!harness[kind]) throw new Error(`harness ${harness.name} has no "${kind}" command`);
      // A scenario may register a stdio MCP server (the fixture) in the harness's sandboxed config.
      const mcp = scenario.mcpServer
        ? { name: 'xf', command: process.execPath, args: [FIXTURE, 'mcp-server', `--xf-run=${dirs.run}`, `--xf-tag=${runId}`] }
        : undefined;
      const spec = harness[kind]({ home: dirs.home, work: dirs.work, baseUrl: endpoint.baseUrl, prompt, mcp });
      const child = spawn(harness.bin, spec.args, {
        cwd: dirs.work, env: { ...baseEnv(dirs.home), ...blackhole.env, ...spec.env, ...variantEnv },
        stdio: [spec.interact ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true,
      });
      const launch = { kind, child, pid: child.pid, startedAt: Date.now(), stdout: '', stderr: '', exit: undefined };
      // A harness without a usable one-shot mode is driven through its line interface: the driver reacts to output.
      let onOutput = () => {};
      child.stdout.on('data', (d) => { launch.stdout += d; onOutput(launch.stdout); });
      child.stderr.on('data', (d) => { launch.stderr += d; });
      if (spec.interact) {
        child.stdin.on('error', () => { /* the harness went away mid-write; its exit is recorded below */ });
        spec.interact({ prompt, write: (text) => child.stdin.write(text), onOutput: (listener) => { onOutput = listener; } });
      }
      launch.exited = new Promise((resolve) => {
        child.on('exit', (code, signal) => { launch.exit = { code, signal, at: Date.now() }; resolve(launch.exit); });
        child.on('error', (err) => { launch.exit = { code: null, signal: null, spawnError: err.message, at: Date.now() }; resolve(launch.exit); });
      });
      launches.push(launch);
      return launch;
    };

    const ctx = {
      runId, dirs, endpoint, start, sleep, notes, canResume: typeof harness.resume === 'function',
      tagged: () => taggedProcesses(runId),
      waitForFile: (name, timeoutMs = 30_000) => waitFor(() => fs.existsSync(path.join(dirs.run, name)), timeoutMs, `marker ${name}`),
      waitForRequest: (predicate, timeoutMs = 30_000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { endpoint.events.off('request', onRequest); reject(new Error(`timed out after ${timeoutMs}ms waiting for a request`)); }, timeoutMs);
        const onRequest = (info) => {
          if (!predicate(info)) return;
          clearTimeout(timer);
          endpoint.events.off('request', onRequest);
          resolve(info);
        };
        endpoint.events.on('request', onRequest);
      }),
      isAlive,
      /** What a terminal's Ctrl-C does: SIGINT to the harness's whole foreground process group. */
      interruptGroup(launch) {
        try { process.kill(-launch.pid, 'SIGINT'); } catch { /* group already gone */ }
      },
      /** Signals the harness (launcher and its own descendants), never the commands it started. */
      signalHarness(launch, signal = 'SIGKILL') {
        const targets = harnessProcesses(launch.pid, runId);
        for (const { pid } of targets) {
          try { process.kill(pid, signal); } catch { /* exited in between */ }
        }
        return targets.map(({ pid, command }) => ({ pid, command: command.slice(0, 80) }));
      },
    };

    const drive = scenario.drive ?? (async (c) => { await c.start().exited; });
    let timedOut = false;
    let driveError;
    await Promise.race([
      drive(ctx).catch((err) => { driveError = String(err?.message ?? err); }),
      sleep(scenario.timeoutMs ?? 90_000).then(() => { timedOut = true; }),
    ]);

    const transcript = readTranscript(transcriptPath);
    const observed = {
      launches: launches.map(({ kind, pid, startedAt, exit, stdout, stderr }) => ({
        kind, pid, startedAt, exit: exit ?? null,
        cleanExit: harness.cleanExit ? harness.cleanExit(exit) : exit?.code === 0,
        stdoutTail: stdout.slice(-1500), stderrTail: stderr.slice(-1500),
      })),
      effects: readEffects(dirs.run),
      markers: readMarkers(dirs.run),
      survivors: taggedProcesses(runId),
      requests: requestSummaries(transcript),
      toolCalls: toolCallsIssued(transcript),
      toolResults: toolResultsReported(transcript),
      endpoint: { ...endpoint.state, errors: endpointErrors },
      outboundAttempts: [...new Set(blackhole.attempts)],
      notes, timedOut, driveError,
    };

    if (endpointErrors.length > 0) {
      Object.assign(result, { verdict: 'bench_error', evidence: { reason: 'endpoint_error', errors: endpointErrors } });
    } else if (endpoint.state.adapterNeeded || (endpoint.state.mainRequests > 0 && !endpoint.state.shellTool)) {
      Object.assign(result, { verdict: 'not_applicable', evidence: { reason: 'adapter_needed', tools: observed.requests.find((r) => r.kind === 'main')?.tools } });
    } else if (driveError) {
      Object.assign(result, { verdict: 'inconclusive', evidence: { reason: 'drive_failed', error: driveError } });
    } else {
      Object.assign(result, scenario.judge(observed));
    }
    result.observed = observed;
  } catch (err) {
    Object.assign(result, { verdict: 'bench_error', evidence: { reason: 'runner_threw', error: String(err?.stack ?? err) } });
  } finally {
    await endpoint?.close();
    await blackhole?.close();
    cleanup();
    // The bench itself must leave nothing behind; if it does, the trial says so instead of blaming the harness.
    await sleep(150);
    const leftovers = [...processesMatching(`--xf-tag=${runId}`), ...processesMatching(sandbox)];
    activeCleanups.delete(abort);
    result.bench.durationMs = Date.now() - started;
    result.bench.leftoverAfterCleanup = leftovers;
    if (leftovers.length > 0) Object.assign(result, { verdict: 'bench_error', evidence: { reason: 'leftover_processes_after_cleanup', leftovers, previous: { verdict: result.verdict, evidence: result.evidence } } });

    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      if (fs.existsSync(transcriptPath)) fs.copyFileSync(transcriptPath, path.join(outDir, 'transcript.jsonl'));
      fs.writeFileSync(path.join(outDir, 'verdict.json'), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (keep) result.bench.sandboxKept = sandbox;
    else fs.rmSync(sandbox, { recursive: true, force: true });
  }
  return result;
}
