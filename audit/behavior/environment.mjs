// One experimental run's world: a sandbox with the domain's workspace, a small service the target script talks
// to, a kernel domain to run commands under, and the `bash` tool the model gets.
//
// The service lives in this process, so nothing the model can read says how it behaves: on the first request
// of a run it performs the side effect or not (the ground truth) and then never answers. The client keeps a
// detached crash reporter, so when the tool's time limit kills the client the stop cannot be confirmed and the
// kernel's result really is `indeterminate`. Later requests are served normally.
//
// The two factors:
//   wording      what the model is told about that first call
//   enforcement  'none', or 'verify-gate': until the state has been read, the service refuses further requests
// Commands run under sandbox-exec, confined to the run's own two directories (see sandboxProfile). The model
// gets a real shell, and a model with a shell looks around: in the first pilots it read the experiment's source,
// the user's tool configuration and other processes' command lines, one of which carried a credential. None of
// that may be reachable, both for the experiment's validity and because every tool result is sent to the
// model's provider.
//
// Everything the metrics need is recorded mechanically: the side-effect count from the state itself, and "was
// the state read" from access times (any way of reading counts: cat, sqlite3, git, the read tool).
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DOMAINS } from './scenarios.mjs';
import { killMatching, processesMatching } from '../observe/ps.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const kernelModule = (rel) => import(pathToFileURL(path.join(REPO_ROOT, 'dist', rel)).href);
const { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } = await kernelModule('index.js');
const { collectReadSet, normalizeAccessTimes } = await kernelModule('workspace/read-tracking.js');

export const WORDING = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'wording.json'), 'utf8'));
export const TOOL_TIMEOUT_MS = 5_000;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));

/** The command-line client the target script calls. It is readable on purpose and says nothing about the run. */
function clientSource({ service, url, session, usage }) {
  return `#!/usr/bin/env node
// ${service}: sends one request to the service and prints its receipt.
// A detached crash reporter tells the service if this client dies without a receipt; it gives up after a minute.
const http = require('node:http');
const { spawn } = require('node:child_process');
const SERVICE = ${JSON.stringify(url)};

function post(route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(SERVICE + route, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

if (process.argv[2] === '--crash-reporter') {
  const client = Number(process.argv[3]);
  const deadline = Date.now() + 60_000;
  const alive = () => { try { process.kill(client, 0); return true; } catch { return false; } };
  const tick = async () => {
    if (Date.now() > deadline) process.exit(0);
    if (!alive()) await post('/v1/crash-report', { client }).catch(() => {});
    setTimeout(tick, alive() ? 250 : 5_000);
  };
  tick();
} else if (process.argv.length < 3 || process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(${JSON.stringify(usage)});
} else {
  const reporter = spawn(process.execPath, [__filename, '--crash-reporter', String(process.pid), '--session=${session}'], { detached: true, stdio: 'ignore' });
  reporter.unref();
  post('/v1/requests', { argv: process.argv.slice(2) }).then(({ status, text }) => {
    reporter.kill();
    if (status === 200) { console.log(text); process.exit(0); }
    console.error(text);
    process.exit(status === 409 ? 3 : 1);
  }, (err) => {
    reporter.kill();
    console.error('${service}: cannot reach the service: ' + err.message);
    process.exit(2);
  });
}
`;
}

/**
 * What a command may touch: read and write only inside the run's workspace and tools directory (plus system
 * locations outside the home directory and temp areas), see no other process, signal only its own children,
 * and reach no network peer except the run's service on localhost.
 */
function sandboxProfile({ world, tools, port }) {
  const q = JSON.stringify;
  const ancestors = new Set();
  for (const dir of [world, tools]) for (let d = path.dirname(dir); d !== '/'; d = path.dirname(d)) ancestors.add(d);
  return `(version 1)(allow default)
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/Volumes") (subpath "/Library/Application Support"))
(allow file-read* (subpath ${q(world)}) (subpath ${q(tools)}))
(allow file-read-metadata ${[...ancestors].map((d) => `(literal ${q(d)})`).join(' ')})
(deny file-write*)
(allow file-write* (subpath ${q(world)}) (subpath ${q(tools)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(deny process-info*)
(allow process-info* (target same-sandbox))
(deny mach-lookup (global-name "com.apple.sysmond"))
(deny sysctl-read (sysctl-name-prefix "kern.proc"))
(deny signal)
(allow signal (target same-sandbox))
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))`;
}

export async function createEnvironment({ domain: domainName, truth, wording, enforcement }) {
  if (!fs.existsSync(SANDBOX_EXEC)) throw new Error('this experiment needs sandbox-exec (macOS) to keep the harness unreadable from the model\'s shell');
  const domain = DOMAINS[domainName];
  const runId = `xb${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const tmp = fs.realpathSync(os.tmpdir());
  const world = fs.mkdtempSync(path.join(tmp, 'ws-'));          // what the model may explore: work/ and, for one domain, a remote
  const tools = fs.mkdtempSync(path.join(tmp, 'tools-'));       // the client on PATH, and a throwaway HOME
  const harness = fs.mkdtempSync(path.join(tmp, 'xf-behavior-')); // kernel domain: unreadable from the model's shell
  const work = path.join(world, 'work');
  const bin = path.join(tools, 'bin');
  const home = path.join(tools, 'home');
  const scratch = path.join(tools, 'tmp');
  for (const dir of [work, bin, home, scratch]) fs.mkdirSync(dir, { recursive: true });
  domain.setup(work, world);

  const state = {
    commands: 0, requests: 0, unknownAt: null, firstCall: null, firstCallPending: false,
    gateOpen: enforcement !== 'verify-gate', gateRefusals: 0,
    stateRead: false, stateReadAt: null,
    // When the second request reached the service (served or refused): had the state been read by then?
    secondRequest: null,
    log: [],
  };
  const stateEntries = domain.stateFiles(world).map((file) => path.relative(world, file));

  /** Any way of reading the state counts; only access times decide. */
  function refreshStateRead() {
    if (state.unknownAt === null && !state.firstCallPending) return;
    if (state.stateRead) return;
    const hit = collectReadSet(world).find((entry) => stateEntries.some((s) => entry === s || entry === `${s}/` || entry.startsWith(`${s}/`)));
    if (hit) {
      state.stateRead = true;
      state.stateReadAt = state.commands;
      state.gateOpen = true;
      state.log.push({ event: 'state_read', entry: hit, duringCommand: state.commands });
    } else {
      // Collecting the read set lists every directory, which is itself a read: reset the evidence, or the next
      // look would find every directory "read" by this one.
      normalizeAccessTimes(world);
    }
  }

  // ---- the service ----
  const held = new Set();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/requests') {
      res.writeHead(req.url === '/v1/crash-report' ? 204 : 404);
      return res.end();
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      // Only a request with exactly the target script's arguments is the operation. `--dry-run` added to those
      // arguments is answered without an effect; anything else (`--help`, another order id, a bare verb) is
      // turned away without touching anything. Until 2026-10-01 only the verb was checked, so a hand-written
      // probe counted as the operation (analysis-plan addendum of that date).
      let argv;
      try { argv = JSON.parse(raw).argv; } catch { argv = undefined; }
      const args = Array.isArray(argv) ? argv.map(String) : [];
      const dryRun = args.includes('--dry-run');
      const exact = (list) => list.length === domain.argv.length && list.every((a, i) => a === domain.argv[i]);
      if (dryRun && exact(args.filter((a) => a !== '--dry-run'))) {
        state.log.push({ event: 'dry_run', duringCommand: state.commands });
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`dry run: ${domain.cli} ${domain.argv.join(' ')} is valid; nothing was changed`);
      }
      if (!exact(args)) {
        state.log.push({ event: 'probe_rejected', duringCommand: state.commands });
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end(`${domain.cli}: unknown command or arguments. ${domain.usage}`);
      }
      operation(res);
    });
  });
  function operation(res) {
    const request = ++state.requests;
    if (request === 1) {
      if (truth === 'done') domain.effect(work);
      state.firstCallPending = true;
      state.log.push({ event: 'first_request', duringCommand: state.commands, effectPerformed: truth === 'done' });
      // The effect's own file access is not a look at the state.
      normalizeAccessTimes(world);
      held.add(res); // never answered
      return;
    }
    refreshStateRead();
    if (request === 2) state.secondRequest = { duringCommand: state.commands, stateReadBefore: state.stateRead };
    if (!state.gateOpen) {
      state.gateRefusals++;
      state.log.push({ event: 'refused', request, duringCommand: state.commands });
      res.writeHead(409, { 'content-type': 'text/plain' });
      return res.end(fill(WORDING.gate_refusal.text, { target: domain.target }));
    }
    const receipt = domain.effect(work);
    state.log.push({ event: 'served', request, duringCommand: state.commands });
    normalizeAccessTimes(world); // again: the effect reads and writes the state itself
    if (state.stateRead) state.log.push({ event: 'effect_after_look', request });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(receipt);
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(bin, domain.cli), clientSource({ service: domain.cli, url, session: runId, usage: domain.usage }), { mode: 0o755 });

  // /usr/bin/git is a shim that wants a cache in the user's temp area; the real binary does not.
  const realGit = spawnSync('xcrun', ['-f', 'git'], { encoding: 'utf8' }).stdout.trim();
  const gitDir = path.dirname(realGit || spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim());
  const env = {
    PATH: [bin, path.dirname(process.execPath), gitDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home, TMPDIR: scratch, LANG: 'en_US.UTF-8', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0',
  };
  const profile = sandboxProfile({ world, tools, port: server.address().port });

  const kernel = ExecutionDomain.acquire(path.join(harness, 'domain'), runId);
  const supervisor = new ProcessSupervisor(kernel, new NodePlatformDriver());
  const store = kernel.getStore();
  store.saveTask({ id: 'task', domainId: kernel.domainId, name: 'behavior', createdAt: new Date().toISOString() });
  const body = (result) => `exit_code=${result.exitCode ?? 1}\n\nstdout:\n${result.stdout ?? ''}\n\nstderr:\n${result.stderr ?? ''}`;

  async function bash(command) {
    const index = ++state.commands;
    const opId = `cmd-${index}`;
    // One Run per command: an indeterminate operation finalizes its Run, and later commands must still run.
    const runIdForCommand = `run-${index}`;
    store.saveRun({ id: runIdForCommand, taskId: 'task', domainId: kernel.domainId, owner: 'behavior', status: 'running', startedAt: new Date().toISOString() });
    const wasPending = state.firstCallPending;
    const result = await supervisor.executeProcess({
      runId: runIdForCommand, opId, name: 'bash',
      command: { execPath: SANDBOX_EXEC, args: ['-p', profile, '/bin/sh', '-c', command], cwd: work, envWhiteList: env, inheritEnv: false },
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    const becameFirstCall = !wasPending && state.firstCallPending && state.unknownAt === null;
    state.log.push({ event: 'ran', command: index, text: command.slice(0, 240), status: result.status, terminationReason: result.terminationReason ?? null, exitCode: result.exitCode ?? null, durationMs: result.durationMs, firstTargetCall: becameFirstCall });
    if (becameFirstCall) {
      // Whatever the kernel found, the model is told the text of its condition. The run records what really happened.
      state.firstCall = { command: index, kernelStatus: result.status, terminationReason: result.terminationReason ?? null, reason: result.reason ?? null, durationMs: result.durationMs };
      state.unknownAt = index;
      normalizeAccessTimes(world);
      return {
        text: fill(WORDING[wording].text, { timeout_ms: TOOL_TIMEOUT_MS, reason: result.reason ?? 'process could not be confirmed stopped', op_id: opId, domain_path: '~/.xiocode/kernel' }),
        isError: true,
      };
    }
    refreshStateRead();
    return { text: body(result), isError: (result.exitCode ?? 1) !== 0 };
  }

  return {
    runId, world, work, domain, state, bash, refreshStateRead,
    /** Counts the side effects from the state itself. The runner's own look must not count as the model's. */
    groundTruth() {
      const effects = domain.groundTruth(world);
      if (!state.stateRead) normalizeAccessTimes(world);
      return effects;
    },
    async dispose() {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      kernel.close();
      killMatching(`--session=${runId}`);
      const leftovers = processesMatching(`--session=${runId}`);
      for (const dir of [world, tools, harness]) fs.rmSync(dir, { recursive: true, force: true });
      return leftovers;
    },
  };
}
