import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionDomain } from '../domain.js';
import { detectAvailableConfinementDrivers } from '../confinement/detector.js';
import { LandlockConfinementDriver } from '../confinement/landlock.js';
import { CgroupPlatformDriver } from '../driver/cgroup-driver.js';
import { NodePlatformDriver } from '../driver/node-driver.js';
import { locateNativeShimLibrary, locateReaperHelper, ReaperPlatformDriver } from '../driver/reaper-driver.js';
import { PlatformDriver, StructuredCommand } from '../driver/types.js';
import { resolveExecutable } from '../driver/spawn-support.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { collectReadSet, normalizeAccessTimes, probeReadTracking } from '../workspace/read-tracking.js';
import { Http304CausalCache } from './http304-cache.js';
import {
  Http304CacheAdapter,
  ParsedToolCall,
  RecordedGatewayTurn,
  ShellExecRequest,
  ShellExecResponse,
  startWireProxy,
  WireProtocolName,
  WireProxyHandle,
  WireProxyOptions,
  writeGatewayInFlightTool,
} from './wire-proxy.js';

export type DriverMode = 'auto' | 'reaper' | 'node' | 'cgroup';

export interface WrapAgentOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  driver?: DriverMode | PlatformDriver;
  domain?: ExecutionDomain;
  domainPath?: string;
  domainId?: string;
  runId?: string;
  upstreamUrl?: string | Partial<Record<WireProtocolName | 'default', string>>;
  tape?: WireProxyOptions['tape'];
  http304Cache?: Http304CacheAdapter | false;
  onTurnCompleted?: (turn: RecordedGatewayTurn) => Promise<void> | void;
  onShellExecOverride?: (params: {
    req: ShellExecRequest;
    turnIndex: number;
    activeToolCall?: ParsedToolCall;
    defaultExec: () => Promise<ShellExecResponse>;
  }) => Promise<ShellExecResponse>;
  /** Forward agent stdout/stderr to caller's process.stdout/stderr (default: false in programmatic API, true in CLI). */
  inheritStdio?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Optional OS filesystem confinement for tool executions (e.g.true or 'landlock' / 'sandbox-exec'). */
  confinement?: boolean | string;
  /** Writable roots when `confinement` is enabled (defaults to `[cwd, os.tmpdir()]`). */
  writableRoots?: string[];
}

export interface WrapAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  runId: string;
  domainPath: string;
  proxyStats: {
    requests: number;
    mainRequests: number;
    upstreamRequests: number;
    cacheHits304: number;
    turns: RecordedGatewayTurn[];
  };
  residualProcessesReaped: boolean;
}

function findReaperBinary(): string | null {
  const fromLocator = locateReaperHelper();
  if (fromLocator) return fromLocator;
  if (process.env.XIOFLOW_REAPER_PATH) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../native', `${process.platform}-${process.arch}`, 'xioflow-reaper'),
    path.resolve(here, '../../dist/native', `${process.platform}-${process.arch}`, 'xioflow-reaper'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

export function resolveDriver(spec: DriverMode | PlatformDriver = 'auto'): PlatformDriver {
  if (typeof spec !== 'string') return spec;
  const helperPath = findReaperBinary();
  if (spec === 'reaper') return new ReaperPlatformDriver(helperPath ? { helperPath } : {});
  if (spec === 'node') return new NodePlatformDriver();
  if (spec === 'cgroup') return new CgroupPlatformDriver();
  if ((process.platform === 'linux' || process.platform === 'darwin') && helperPath) {
    return new ReaperPlatformDriver({ helperPath });
  }
  return new NodePlatformDriver();
}

const SHIM_CLIENT_CODE = `#!/usr/bin/env node
import http from 'node:http';

const [, , realShell, commandStr] = process.argv;
const proxyUrl = process.env.XIO_GATEWAY_URL;
if (!proxyUrl || !commandStr) {
  process.exit(1);
}

const payload = JSON.stringify({
  command: commandStr,
  shell: realShell || '/bin/sh',
  cwd: process.cwd(),
  env: process.env,
});

const url = new URL('/__xio_exec', proxyUrl);
const req = http.request(
  {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(typeof result.exitCode === 'number' ? result.exitCode : 1);
      } catch {
        process.exit(1);
      }
    });
  }
);

req.on('error', () => {
  process.exit(137);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    req.destroy();
    process.exit(130);
  });
}

req.write(payload);
req.end();
`;

/**
 * Watchdog worker script: runs reparented to PID 1 (via double-fork), holds no sandbox path in argv,
 * tracks all descendant PIDs of the wrapped harness and tool processes, and immediately SIGKILLs the
 * entire tree if the host xio wrap process dies unexpectedly (e.g., SIGKILL).
 */
const WATCHDOG_WORKER_CODE = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number(process.env.XIO_WATCHDOG_PORT || process.argv[1] || process.argv[2]);
const hostPid = Number(process.env.XIO_HOST_PID || 0);
if (!port) process.exit(0);

const rootPids = new Set();
const trackedPids = new Map(); // pid -> startToken
const trackedPgids = new Set();
let hostPgid = 0;
let domainPath = process.env.XIO_DOMAIN_PATH || '';
let shuttingDown = false;
let handled = false;
let scanning = false;

async function scanProcessTable() {
  const rows = [];
  const byPid = new Map();
  if (process.platform === 'linux') {
    let names = [];
    try {
      names = fs.readdirSync('/proc');
    } catch {
      return byPid;
    }
    for (const name of names) {
      const c0 = name.charCodeAt(0);
      if (c0 < 48 || c0 > 57) continue;
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const rparen = stat.lastIndexOf(')');
        if (rparen < 0) continue;
        const fields = stat.slice(rparen + 2).trim().split(/\\s+/);
        const state = fields[0];
        if (state === 'Z' || state === 'X') continue;
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const start = fields[19];
        if (!start) continue;
        const entry = { pid, ppid, pgid, start };
        rows.push(entry);
        byPid.set(pid, entry);
      } catch {}
    }
  } else {
    let out = '';
    try {
      const res = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      out = res.stdout || '';
    } catch {
      return byPid;
    }
    for (const line of out.split('\\n')) {
      const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+)\\s*$/.exec(line);
      if (!m) continue;
      const entry = { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4] };
      rows.push(entry);
      byPid.set(entry.pid, entry);
    }
  }
  const hostRow = byPid.get(hostPid);
  if (hostRow && hostRow.pgid > 1) {
    hostPgid = hostRow.pgid;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (r.pid === process.pid || r.pid === hostPid) continue;
      if (trackedPids.has(r.pid)) continue;
      if (
        // 只跟踪显式 watch 过的 root 及其后代：同一宿主进程里可能并发跑着多个被包裹的
        // 运行（xio race 的候选就是这样），若把宿主的每个 detached 子进程都算进来，
        // 先结束的那个运行的 watchdog 收场时会把它兄弟一并 SIGKILL。
        rootPids.has(r.pid) ||
        (r.ppid > 1 && trackedPids.has(r.ppid)) ||
        (r.pgid > 1 && r.pgid !== hostPgid && trackedPgids.has(r.pgid))
      ) {
        trackedPids.set(r.pid, r.start);
        if (r.pgid > 1 && r.pgid !== hostPid && r.pgid !== hostPgid) {
          trackedPgids.add(r.pgid);
        }
        changed = true;
      }
    }
  }
  return byPid;
}

scanProcessTable().catch(() => {});

async function reapAll() {
  const byPid = await scanProcessTable();
  for (const pgid of trackedPgids) {
    if (pgid > 1 && pgid !== process.pid && pgid !== hostPid && pgid !== hostPgid) {
      try { process.kill(-pgid, 'SIGKILL'); } catch {}
    }
  }
  for (const [pid, start] of trackedPids.entries()) {
    if (pid === process.pid || pid === hostPid || pid <= 1) continue;
    const current = byPid.get(pid);
    if (current && current.start === start) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}

function markInterruptedIfNeeded() {
  if (!domainPath) return;
  try {
    const stateFile = path.join(domainPath, 'gateway-state.json');
    if (!fs.existsSync(stateFile)) return;
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (data.inFlightToolCall && !data.interruptedToolCall) {
      data.interruptedToolCall = { ...data.inFlightToolCall, reapedByWatchdog: true };
      data.inFlightToolCall = null;
      fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
    }
  } catch {}
}

const timer = setInterval(() => {
  if (hostPid > 1) {
    try {
      process.kill(hostPid, 0);
    } catch (e) {
      if (e && e.code === 'ESRCH') {
        onHostGone();
        return;
      }
    }
  }
  if ((rootPids.size > 0 || hostPid > 1) && !scanning) {
    scanning = true;
    scanProcessTable().finally(() => { scanning = false; });
  }
}, 20);
timer.unref();

async function onHostGone() {
  if (handled) return;
  handled = true;
  clearInterval(timer);
  if (!shuttingDown) {
    markInterruptedIfNeeded();
  }
  await reapAll();
  setTimeout(async () => {
    await reapAll();
    process.exit(0);
  }, 25);
}

const req = http.get({ hostname: '127.0.0.1', port, path: '/__xio_watchdog' }, (res) => {
  let buf = '';
  res.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'init') {
          domainPath = msg.domainPath || domainPath;
        } else if (msg.type === 'watch' && typeof msg.pid === 'number') {
          rootPids.add(msg.pid);
          if (msg.pid > 1) trackedPgids.add(msg.pid);
          scanProcessTable().catch(() => {});
        } else if (msg.type === 'scan') {
          scanProcessTable().catch(() => {});
        } else if (msg.type === 'shutdown') {
          shuttingDown = true;
          onHostGone();
        }
      } catch {}
    }
  });
  res.on('end', onHostGone);
  res.on('close', onHostGone);
  res.on('error', onHostGone);
});
req.on('error', onHostGone);
req.on('close', onHostGone);
`;

export function createShellShimDir(options: {
  shimDir: string;
  proxyUrl: string;
}): { shimDir: string; bashPath: string; shPath: string; zshPath: string } {
  const { shimDir } = options;
  fs.mkdirSync(shimDir, { recursive: true });
  const clientPath = path.join(shimDir, 'shim-client.mjs');
  fs.writeFileSync(clientPath, SHIM_CLIENT_CODE, { mode: 0o755 });

  const writeShellWrapper = (name: string, realShell: string) => {
    const file = path.join(shimDir, name);
    const script = `#!/bin/sh
if [ "\${XIO_SHIM_BYPASS:-}" = "1" ]; then
  exec ${realShell} "$@"
fi
if [ "$1" = "-c" ] && [ $# -eq 2 ]; then
  XIO_SHIM_BYPASS=1 XIO_TRACE_BYPASS=1 exec "${process.execPath}" "${clientPath}" "${realShell}" "$2"
fi
if [ "$1" = "-lc" ] && [ $# -eq 2 ]; then
  XIO_SHIM_BYPASS=1 XIO_TRACE_BYPASS=1 exec "${process.execPath}" "${clientPath}" "${realShell}" "$2"
fi
if [ "$1" = "-c" ] && [ "$2" = "-l" ] && [ $# -eq 3 ]; then
  XIO_SHIM_BYPASS=1 XIO_TRACE_BYPASS=1 exec "${process.execPath}" "${clientPath}" "${realShell}" "$3"
fi
if [ "$1" = "-l" ] && [ "$2" = "-c" ] && [ $# -eq 3 ]; then
  XIO_SHIM_BYPASS=1 XIO_TRACE_BYPASS=1 exec "${process.execPath}" "${clientPath}" "${realShell}" "$3"
fi
XIO_SHIM_BYPASS=1 exec ${realShell} "$@"
`;
    fs.writeFileSync(file, script, { mode: 0o755 });
    return file;
  };

  const bashPath = writeShellWrapper('bash', '/bin/bash');
  const shPath = writeShellWrapper('sh', '/bin/sh');
  writeShellWrapper('dash', fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh');
  const zshPath = writeShellWrapper('zsh', '/bin/zsh');
  return { shimDir, bashPath, shPath, zshPath };
}

/**
 * Spawn a double-forked watchdog process whose ppid becomes 1 and whose argv contains no sandbox path.
 */
async function startDoubleForkedWatchdog(port: number, domainPath: string): Promise<void> {
  const launcherCode = `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(WATCHDOG_WORKER_CODE)}], {
  cwd: '/',
  detached: true,
  stdio: 'ignore',
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin',
    XIO_WATCHDOG_PORT: process.env.XIO_WATCHDOG_PORT || '',
    XIO_DOMAIN_PATH: process.env.XIO_DOMAIN_PATH || '',
    XIO_HOST_PID: process.env.XIO_HOST_PID || '',
  },
});
child.unref();
process.exit(0);
`;
  await new Promise<void>((resolve) => {
    const middle = spawn(process.execPath, ['--input-type=module', '-e', launcherCode], {
      cwd: '/',
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        XIO_WATCHDOG_PORT: String(port),
        XIO_DOMAIN_PATH: domainPath,
        XIO_HOST_PID: String(process.pid),
      },
    });
    middle.on('exit', () => resolve());
    middle.on('error', () => resolve());
  });
}

/**
 * Inspect and rewrite CLI args & config files for black-box agents (claude, codex, gemini, opencode, qwen, xio)
 * so their LLM traffic transparently routes through wireProxy.baseUrl.
 */
export function interceptAgentUpstream(params: {
  args: string[];
  env: Record<string, string | undefined>;
  proxyBaseUrl: string;
  explicitUpstream?: WrapAgentOptions['upstreamUrl'];
}): {
  rewrittenArgs: string[];
  rewrittenEnv: Record<string, string | undefined>;
  upstreamMap: Partial<Record<WireProtocolName | 'default', string>>;
  restoreConfigs: () => void;
} {
  const { args, env, proxyBaseUrl, explicitUpstream } = params;
  const rewrittenArgs = [...args];
  const rewrittenEnv: Record<string, string | undefined> = { ...env };
  const upstreamMap: Partial<Record<WireProtocolName | 'default', string>> =
    typeof explicitUpstream === 'string'
      ? { default: explicitUpstream }
      : explicitUpstream
        ? { ...explicitUpstream }
        : {};
  const backups: Array<{ file: string; content: string }> = [];

  const normalizeUpstream = (rawUrl: string): string => {
    return rawUrl.replace(/\/+$/, '');
  };

  if (rewrittenEnv.ANTHROPIC_BASE_URL) {
    upstreamMap.anthropic ??= normalizeUpstream(rewrittenEnv.ANTHROPIC_BASE_URL);
    upstreamMap.default ??= upstreamMap.anthropic;
  }
  if (rewrittenEnv.OPENAI_BASE_URL) {
    const base = normalizeUpstream(rewrittenEnv.OPENAI_BASE_URL).replace(/\/v1$/, '');
    upstreamMap['chat-completions'] ??= base;
    upstreamMap.responses ??= base;
    upstreamMap.default ??= base;
  }
  if (rewrittenEnv.GOOGLE_GEMINI_BASE_URL) {
    upstreamMap.gemini ??= normalizeUpstream(rewrittenEnv.GOOGLE_GEMINI_BASE_URL);
    upstreamMap.default ??= upstreamMap.gemini;
  }

  // Inspect CLI args for inline base_url (e.g. codex -c 'model_providers.mock={ ... base_url = "http://..." }')
  for (let i = 0; i < rewrittenArgs.length; i++) {
    const arg = rewrittenArgs[i];
    const match = /base_url\s*=\s*"(https?:\/\/[^"]+)"/.exec(arg);
    if (match) {
      const extracted = normalizeUpstream(match[1]).replace(/\/v1$/, '');
      upstreamMap.responses ??= extracted;
      upstreamMap['chat-completions'] ??= extracted;
      upstreamMap.default ??= extracted;
      rewrittenArgs[i] = arg.replace(match[1], `${proxyBaseUrl}/v1`);
    }
  }

  // Inspect OPENCODE_CONFIG JSON file if present
  if (rewrittenEnv.OPENCODE_CONFIG && fs.existsSync(rewrittenEnv.OPENCODE_CONFIG)) {
    try {
      const file = rewrittenEnv.OPENCODE_CONFIG;
      const content = fs.readFileSync(file, 'utf8');
      const match = /"baseURL"\s*:\s*"(https?:\/\/[^"]+)"/.exec(content);
      if (match) {
        const extracted = normalizeUpstream(match[1]).replace(/\/v1$/, '');
        upstreamMap['chat-completions'] ??= extracted;
        upstreamMap.default ??= extracted;
        backups.push({ file, content });
        fs.writeFileSync(file, content.replace(match[1], `${proxyBaseUrl}/v1`));
      }
    } catch {}
  }

  // Inspect XIO_CONFIG TOML/JSON file if present
  if (rewrittenEnv.XIO_CONFIG && fs.existsSync(rewrittenEnv.XIO_CONFIG)) {
    try {
      const file = rewrittenEnv.XIO_CONFIG;
      const content = fs.readFileSync(file, 'utf8');
      const match = /(?:base_url\s*=\s*|"base(?:Url|_url|URL)"\s*:\s*)"(https?:\/\/[^"]+)"/.exec(content);
      if (match) {
        const extracted = normalizeUpstream(match[1]).replace(/\/v1$/, '');
        upstreamMap['chat-completions'] ??= extracted;
        upstreamMap.default ??= extracted;
        backups.push({ file, content });
        fs.writeFileSync(file, content.replace(match[1], `${proxyBaseUrl}/v1`));
      }
    } catch {}
  }

  // Default real provider endpoints if none were overridden
  upstreamMap.anthropic ??= upstreamMap.default ?? 'https://api.anthropic.com';
  upstreamMap['chat-completions'] ??= upstreamMap.default ?? 'https://api.openai.com';
  upstreamMap.responses ??= upstreamMap.default ?? 'https://api.openai.com';
  upstreamMap.gemini ??= upstreamMap.default ?? 'https://generativelanguage.googleapis.com';

  rewrittenEnv.ANTHROPIC_BASE_URL = proxyBaseUrl;
  rewrittenEnv.OPENAI_BASE_URL = `${proxyBaseUrl}/v1`;
  rewrittenEnv.GOOGLE_GEMINI_BASE_URL = proxyBaseUrl;
  rewrittenEnv.XIO_GATEWAY_URL = proxyBaseUrl;

  return {
    rewrittenArgs,
    rewrittenEnv,
    upstreamMap,
    restoreConfigs() {
      for (const b of backups) {
        try {
          fs.writeFileSync(b.file, b.content);
        } catch {}
      }
    },
  };
}

const SHELL_READ_TRACK_SKIP = ['node_modules', '.venv', 'venv', 'vendor', '.next', 'dist'];

function parseSyscallTraceFile(
  traceFile: string,
  workspaceRoot: string
): { readSet: string[]; writeSet: string[]; deleteSet: string[]; deniedSet: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const deletes = new Set<string>();
  const denied = new Set<string>();
  if (!fs.existsSync(traceFile)) {
    return { readSet: [], writeSet: [], deleteSet: [], deniedSet: [] };
  }
  let raw = '';
  try {
    raw = fs.readFileSync(traceFile, 'utf8');
    fs.writeFileSync(traceFile, '');
  } catch {
    return { readSet: [], writeSet: [], deleteSet: [], deniedSet: [] };
  }
  if (!raw) {
    return { readSet: [], writeSet: [], deleteSet: [], deniedSet: [] };
  }
  const absRoot = path.resolve(workspaceRoot);
  let realRoot = absRoot;
  try {
    realRoot = fs.realpathSync(absRoot);
  } catch {}

  const isIgnoredSegment = (rel: string): boolean => {
    const first = rel.split('/')[0] ?? '';
    return (
      !rel ||
      rel === '.' ||
      first === '.git' ||
      first === '.xioflow-kernel' ||
      first === '.xioflow' ||
      first === 'node_modules' ||
      first === '.venv' ||
      first === 'venv'
    );
  };

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const op = line.slice(0, tab);
    const rawPath = line.slice(tab + 1).trim();
    if (!rawPath) continue;
    const resolved = path.resolve(rawPath);
    let rel = path.relative(absRoot, resolved);
    if (rel.startsWith('..') && realRoot !== absRoot) {
      const relReal = path.relative(realRoot, resolved);
      if (!relReal.startsWith('..')) rel = relReal;
    }
    const inWorkspace = !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inWorkspace) {
      if (isIgnoredSegment(rel)) continue;
      if (op === 'R') {
        try {
          if (fs.statSync(path.join(absRoot, rel)).isDirectory()) continue;
        } catch {}
        reads.add(rel);
      } else if (op === 'W') {
        writes.add(rel);
        deletes.delete(rel);
      } else if (op === 'D') {
        deletes.add(rel);
        writes.delete(rel);
      } else if (op === 'E') {
        denied.add(rel);
      }
    } else if (op === 'E') {
      denied.add(resolved);
    }
  }
  return {
    readSet: [...reads].sort(),
    writeSet: [...writes].sort(),
    deleteSet: [...deletes].sort(),
    deniedSet: [...denied].sort(),
  };
}

/**
 * Dual-boundary transparent agent wrapper (`xio wrap <agent>`):
 * - Upper Boundary: Four-protocol LLM Wire Proxy (`startWireProxy`)
 * - Lower Boundary: OS Process & Shell Shim (`ProcessSupervisor` + `ReaperPlatformDriver` + crash watchdog)
 */
export async function wrapAgent(options: WrapAgentOptions): Promise<WrapAgentResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const ownsDomain = !options.domain;
  const domainPath = path.resolve(options.domain?.domainPath ?? options.domainPath ?? path.join(cwd, '.xioflow-kernel'));
  const domainId = options.domain?.domainId ?? options.domainId ?? 'default';
  const domain = options.domain ?? ExecutionDomain.acquire(domainPath, domainId);
  const baseDriver = resolveDriver(options.driver ?? 'auto');
  const watchedPids = new Set<number>();
  let watchdogStream: http.ServerResponse | undefined;
  const sendToWatchdog = (msg: Record<string, unknown>) => {
    if (msg.type === 'watch' && typeof msg.pid === 'number') {
      watchedPids.add(msg.pid);
    }
    if (watchdogStream && !watchdogStream.writableEnded && !watchdogStream.destroyed) {
      try {
        watchdogStream.write(`${JSON.stringify(msg)}\n`);
      } catch {}
    }
  };

  const origSpawn = baseDriver.spawn.bind(baseDriver);
  baseDriver.spawn = async (cmd) => {
    const h = await origSpawn(cmd);
    sendToWatchdog({ type: 'watch', pid: h.identity.pid });
    const helperPid = (h.rawProcess as any)?.helperPid;
    if (typeof helperPid === 'number' && helperPid > 1) {
      sendToWatchdog({ type: 'watch', pid: helperPid });
    }
    return h;
  };
  const driver = baseDriver;

  const snapshotDriver = new GitShadowSnapshotDriver();
  const supervisor = new ProcessSupervisor(domain, driver, snapshotDriver);
  const runId = options.runId ?? `wrap-run-${crypto.randomUUID().slice(0, 8)}`;

  const store = domain.getStore();
  const taskId = 'wrap-task';
  if (!store.getTask(taskId)) {
    store.saveTask({
      id: taskId,
      domainId: domain.domainId,
      name: 'Wrapped Agent Task',
      createdAt: new Date().toISOString(),
    });
  }
  if (!store.getRun(runId)) {
    store.saveRun({
      id: runId,
      taskId,
      domainId: domain.domainId,
      owner: 'xio-wrap',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }

  let subOpCounter = 0;
  const activeToolOpIds = new Set<string>();
  let isGitRepo: boolean | undefined;
  const dynamicUpstream: Partial<Record<WireProtocolName | 'default', string>> = {};
  const http304Cache =
    options.http304Cache === false
      ? undefined
      : (options.http304Cache ?? new Http304CausalCache({ domain, domainPath, workspaceRoot: cwd }));

  const traceDir = path.join(domainPath, 'gateway-traces');
  const syscallTraceDir = path.join(domainPath, 'syscall-traces');
  try {
    fs.mkdirSync(syscallTraceDir, { recursive: true });
  } catch {}
  const agentSyscallTracePath = path.join(syscallTraceDir, `${runId}-agent.trace`);
  const shimSoPath = locateNativeShimLibrary();
  let totalReadFiles = 0;
  let totalWriteFiles = 0;
  let totalDeletedFiles = 0;
  let totalDeniedFiles = 0;

  const saveTraceBundle = (turns: RecordedGatewayTurn[]) => {
    try {
      fs.mkdirSync(traceDir, { recursive: true });
      fs.writeFileSync(
        path.join(traceDir, `${runId}.json`),
        JSON.stringify(
          {
            runId,
            domainId,
            domainPath,
            workspaceRoot: cwd,
            updatedAt: new Date().toISOString(),
            turns,
          },
          null,
          2
        )
      );
    } catch {}
  };

  const drainAgentDirectSyscalls = (targetTurn?: RecordedGatewayTurn) => {
    const lastTurn = targetTurn ?? proxy?.state.turns.at(-1);
    if (!lastTurn) return;
    const traced = parseSyscallTraceFile(agentSyscallTracePath, cwd);
    if (
      traced.readSet.length === 0 &&
      traced.writeSet.length === 0 &&
      traced.deleteSet.length === 0 &&
      traced.deniedSet.length === 0
    ) {
      return;
    }
    const turnIdx = lastTurn.turnIndex ?? 0;
    for (const r of traced.readSet) {
      if (!lastTurn.readFiles.includes(r)) {
        lastTurn.readFiles.push(r);
        totalReadFiles++;
      }
    }
    lastTurn.writeFiles ??= [];
    for (const w of traced.writeSet) {
      if (!lastTurn.writeFiles.includes(w)) {
        lastTurn.writeFiles.push(w);
        totalWriteFiles++;
      }
    }
    lastTurn.deletedFiles ??= [];
    for (const d of traced.deleteSet) {
      if (!lastTurn.deletedFiles.includes(d)) {
        lastTurn.deletedFiles.push(d);
        totalDeletedFiles++;
      }
    }
    lastTurn.deniedFiles ??= [];
    for (const e of traced.deniedSet) {
      if (!lastTurn.deniedFiles.includes(e)) {
        lastTurn.deniedFiles.push(e);
        totalDeniedFiles++;
      }
    }
    saveTraceBundle(proxy.state.turns);
    if (traced.readSet.length > 0 || traced.writeSet.length > 0 || traced.deleteSet.length > 0) {
      http304Cache?.recordToolExecution?.({
        turnIndex: turnIdx,
        command: '[native-vfs-io]',
        readFiles: traced.readSet,
        writeFiles: [...traced.writeSet, ...traced.deleteSet],
        output: '',
      });
    }
  };

  const cancelActiveTools = async () => {
    drainAgentDirectSyscalls();
    await Promise.all(
      [...activeToolOpIds].map((id) => supervisor.cancelOperation(id, 200).catch(() => {}))
    );
  };

  const shimDir = path.join(domainPath, 'shims');
  const proxy: WireProxyHandle = await startWireProxy({
    domain,
    domainPath,
    domainId,
    runId,
    workspaceRoot: cwd,
    upstreamUrl: dynamicUpstream,
    tape: options.tape,
    http304Cache,
    onBeforeMainRequest: cancelActiveTools,
    getKernelStatus: () => ({
      driver: driver.name,
      capabilities: driver.capabilities,
      confinementDrivers: detectAvailableConfinementDrivers(),
      landlockAbiVersion: LandlockConfinementDriver.getAbiVersion(),
      ldPreloadShimActive: Boolean(shimSoPath),
      activeToolOpIds: [...activeToolOpIds],
      vfsStats: {
        readFiles: totalReadFiles,
        writeFiles: totalWriteFiles,
        deletedFiles: totalDeletedFiles,
        deniedFiles: totalDeniedFiles,
      },
    }),
    async captureTurnSnapshot(turnIndex: number) {
      if (isGitRepo === undefined) {
        try {
          await snapshotDriver.assertGitRepo(cwd);
          isGitRepo = true;
        } catch {
          isGitRepo = false;
        }
      }
      if (!isGitRepo) return undefined;
      try {
        const snapRes = await supervisor.captureSnapshot({
          runId,
          opId: `${runId}-step-${turnIndex + 1}-snap`,
          roots: [cwd],
        });
        if (snapRes.status === 'succeeded' && snapRes.snapshot) {
          return {
            snapshotId: snapRes.snapshot.id,
            treeFingerprint: snapRes.snapshot.treeFingerprint,
            journalSeq: snapRes.snapshot.journalSeq,
          };
        }
      } catch {}
      return undefined;
    },
    async onTurnCompleted(turn) {
      drainAgentDirectSyscalls(turn);
      saveTraceBundle(proxy.state.turns);
      await options.onTurnCompleted?.(turn);
    },
    async onShellExec(req: ShellExecRequest, activeToolCall) {
      const lastTurn = proxy.state.turns.at(-1);
      const currentTurnIndex = lastTurn?.turnIndex ?? 0;

      const defaultExec = async (): Promise<ShellExecResponse> => {
        const opId = `${runId}-tool-${++subOpCounter}`;
        const opTraceFile = path.join(syscallTraceDir, `${opId}.trace`);
        const cleanEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.env)) {
          if (v !== undefined) cleanEnv[k] = v;
        }
        cleanEnv.XIO_SHIM_BYPASS = '1';
        delete cleanEnv.XIO_TRACE_BYPASS;
        cleanEnv.XIO_SYSCALL_TRACE_PATH = opTraceFile;
        if (shimSoPath) {
          const existingPreload = cleanEnv.LD_PRELOAD ?? '';
          if (!existingPreload.split(/[:\s]+/).includes(shimSoPath)) {
            cleanEnv.LD_PRELOAD = existingPreload ? `${shimSoPath}:${existingPreload}` : shimSoPath;
          }
        }
        if (options.confinement && process.platform === 'linux' && LandlockConfinementDriver.isAvailable()) {
          const roots = (options.writableRoots ?? [cwd, os.tmpdir()]).map((r) => {
            try {
              return fs.realpathSync(r);
            } catch {
              return path.resolve(r);
            }
          });
          cleanEnv.XIOFLOW_LANDLOCK_WRITE_ROOTS = roots.join(':');
        }
        if (cleanEnv.PATH) {
          cleanEnv.PATH = cleanEnv.PATH.split(path.delimiter)
            .filter((p) => path.resolve(p) !== path.resolve(shimDir))
            .join(path.delimiter);
        }

        // If the LLM tool_call specified a timeoutMs, enforce an earlier bound so ReaperPlatformDriver's
        // stop ladder (1500ms SIGINT + 1000ms SIGTERM + SIGKILL = 2500ms) confirms the process tree is dead
        // before the harness's own unconfirmed timer fires.
        let timeoutMs: number | undefined = options.timeoutMs;
        if (activeToolCall?.timeoutMs && activeToolCall.timeoutMs > 0) {
          timeoutMs = Math.max(250, activeToolCall.timeoutMs - 2650);
        }
        const inlineTimeout = /\[xio-timeout=(\d+)ms\]/.exec(req.command);
        if (inlineTimeout) {
          timeoutMs = Number(inlineTimeout[1]);
        }

        const execCwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : cwd;
        const canTrackReads = probeReadTracking(execCwd) === 'atime';
        if (canTrackReads) {
          try {
            normalizeAccessTimes(execCwd, { skip: SHELL_READ_TRACK_SKIP });
          } catch {}
        }

        activeToolOpIds.add(opId);
        let res: Awaited<ReturnType<ProcessSupervisor['executeProcess']>>;
        try {
          res = await supervisor.executeProcess({
            runId,
            opId,
            name: `shell:${path.basename(req.shell)}`,
            command: {
              execPath: req.shell || '/bin/sh',
              args: ['-c', req.command],
              cwd: execCwd,
              envWhiteList: cleanEnv,
            },
            timeoutMs,
            drainTimeoutMs: 1500,
            maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
          });
        } finally {
          activeToolOpIds.delete(opId);
        }

        let atimeReads: string[] = [];
        if (canTrackReads) {
          try {
            atimeReads = collectReadSet(execCwd, { skip: SHELL_READ_TRACK_SKIP }).filter((p) => !p.endsWith('/'));
          } catch {}
        }
        const syscallTrace = parseSyscallTraceFile(opTraceFile, execCwd);
        try {
          fs.rmSync(opTraceFile, { force: true });
        } catch {}
        const readSet = [...new Set([...atimeReads, ...syscallTrace.readSet])].sort();
        const writeSet = syscallTrace.writeSet;
        const deleteSet = syscallTrace.deleteSet;
        const deniedSet = syscallTrace.deniedSet;

        let stdout = res.status === 'indeterminate' ? '' : res.stdout;
        let stderr = res.status === 'indeterminate' ? res.reason : res.stderr;
        let exitCode = res.status === 'indeterminate' ? 137 : res.exitCode;

        if (deniedSet.length > 0) {
          stderr = `${stderr ? `${stderr.replace(/\n$/, '')}\n` : ''}[xioflow kernel trap: blocked unauthorized write to ${deniedSet.join(', ')}]\n`;
        }

        if (res.status !== 'indeterminate' && res.terminationReason === 'timed_out') {
          stderr = `${stderr ? `${stderr}\n` : ''}[xioflow: command timed out and process tree was confirmed stopped]\n`;
          exitCode = exitCode ?? 124;
        }

        if (res.status !== 'indeterminate' && res.stdoutTruncated && res.stdoutRef) {
          // Retain the tail line from the spilled file if present, plus explicit truncation notice & location
          let tailSnippet = '';
          try {
            const stat = fs.statSync(res.stdoutRef);
            const readLen = Math.min(stat.size, 512);
            const fd = fs.openSync(res.stdoutRef, 'r');
            const buf = Buffer.alloc(readLen);
            fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
            fs.closeSync(fd);
            tailSnippet = `\n${buf.toString('utf8')}`;
          } catch {}
          stdout = `${stdout}\n[xioflow: output truncated (${res.stdoutBytes} bytes total); full output saved to ${res.stdoutRef}]${tailSnippet}\n`;
        }

        return {
          exitCode,
          signal: res.status === 'indeterminate' ? 'SIGKILL' : res.signal,
          stdout,
          stderr,
          residualProcessesReaped: res.status !== 'indeterminate' ? res.residualProcessesReaped : true,
          readSet,
          writeSet,
          deleteSet,
          deniedSet,
          opId,
        };
      };

      const execOut = options.onShellExecOverride
        ? await options.onShellExecOverride({
            req,
            turnIndex: currentTurnIndex,
            activeToolCall,
            defaultExec,
          })
        : await defaultExec();

      const opId = execOut.opId ?? `${runId}-tool-${++subOpCounter}`;
      const readSet = execOut.readSet ?? [];
      const writeSet = execOut.writeSet ?? [];
      const deleteSet = execOut.deleteSet ?? [];
      const deniedSet = execOut.deniedSet ?? [];

      totalReadFiles += readSet.length;
      totalWriteFiles += writeSet.length;
      totalDeletedFiles += deleteSet.length;
      totalDeniedFiles += deniedSet.length;

      if (lastTurn) {
        if (!lastTurn.opIds.includes(opId)) lastTurn.opIds.push(opId);
        for (const r of readSet) {
          if (!lastTurn.readFiles.includes(r)) lastTurn.readFiles.push(r);
        }
        lastTurn.writeFiles ??= [];
        for (const w of writeSet) {
          if (!lastTurn.writeFiles.includes(w)) lastTurn.writeFiles.push(w);
        }
        lastTurn.deletedFiles ??= [];
        for (const d of deleteSet) {
          if (!lastTurn.deletedFiles.includes(d)) lastTurn.deletedFiles.push(d);
        }
        lastTurn.deniedFiles ??= [];
        for (const e of deniedSet) {
          if (!lastTurn.deniedFiles.includes(e)) lastTurn.deniedFiles.push(e);
        }
        lastTurn.toolExecutions ??= [];
        lastTurn.toolExecutions.push({
          opId,
          callId: activeToolCall?.id,
          command: req.command,
          exitCode: execOut.exitCode,
          signal: execOut.signal,
          stdout: execOut.stdout,
          stderr: execOut.stderr,
          readSet,
          writeSet,
          deleteSet,
          deniedSet,
        });
        saveTraceBundle(proxy.state.turns);
      }

      http304Cache?.recordToolExecution?.({
        turnIndex: currentTurnIndex,
        callId: activeToolCall?.id,
        command: req.command,
        readFiles: readSet,
        writeFiles: [...writeSet, ...deleteSet],
        output: `${execOut.stdout}${execOut.stderr}`,
      });

      return { ...execOut, opId, readSet, writeSet, deleteSet, deniedSet };
    },
  });
  proxy.events.on('request', () => {
    sendToWatchdog({ type: 'scan' });
  });

  let resolveWatchdogConnected!: () => void;
  const watchdogConnected = new Promise<void>((resolve) => {
    resolveWatchdogConnected = resolve;
  });

  const watchdogServer = http.createServer((req, res) => {
    if (req.url === '/__xio_watchdog') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
      watchdogStream = res;
      sendToWatchdog({ type: 'init', domainPath });
      for (const pid of watchedPids) {
        sendToWatchdog({ type: 'watch', pid });
      }
      resolveWatchdogConnected();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => watchdogServer.listen(0, '127.0.0.1', () => resolve()));
  const watchdogPort = (watchdogServer.address() as { port: number }).port;
  await startDoubleForkedWatchdog(watchdogPort, domainPath);
  await Promise.race([watchdogConnected, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);

  const callerEnv = options.env ?? process.env;
  const originalPath = callerEnv.PATH ?? process.env.PATH ?? '/usr/bin:/bin';
  const resolvedExec = resolveExecutable(options.command, originalPath) ?? options.command;

  const { bashPath } = createShellShimDir({
    shimDir,
    proxyUrl: proxy.baseUrl,
  });

  const { rewrittenArgs, rewrittenEnv, upstreamMap, restoreConfigs } = interceptAgentUpstream({
    args: options.args ?? [],
    env: callerEnv,
    proxyBaseUrl: proxy.baseUrl,
    explicitUpstream: options.upstreamUrl,
  });
  Object.assign(dynamicUpstream, upstreamMap);

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(rewrittenEnv)) {
    if (v !== undefined) childEnv[k] = v;
  }
  childEnv.PATH = `${shimDir}${path.delimiter}${originalPath}`;
  childEnv.SHELL = bashPath;
  childEnv.XIO_SHIM_DIR = shimDir;
  childEnv.XIO_SYSCALL_TRACE_PATH = agentSyscallTracePath;
  if (shimSoPath) {
    const existingPreload = childEnv.LD_PRELOAD ?? '';
    if (!existingPreload.split(/[:\s]+/).includes(shimSoPath)) {
      childEnv.LD_PRELOAD = existingPreload ? `${shimSoPath}:${existingPreload}` : shimSoPath;
    }
  }
  if (options.confinement && process.platform === 'linux' && LandlockConfinementDriver.isAvailable()) {
    const roots = (options.writableRoots ?? [cwd, os.tmpdir()]).map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    });
    childEnv.XIOFLOW_LANDLOCK_WRITE_ROOTS = roots.join(':');
  }

  const agentCommand: StructuredCommand = {
    execPath: resolvedExec,
    args: rewrittenArgs,
    cwd,
    envWhiteList: childEnv,
    stdinMode: 'stream',
  };

  let handle: Awaited<ReturnType<PlatformDriver['spawn']>> | undefined;
  let stdout = '';
  let stderr = '';
  let residualProcessesReaped = false;

  const onSigInt = () => {
    cancelActiveTools().catch(() => {});
    if (handle) driver.terminate(handle.identity, 300).catch(() => {});
  };
  const onSigTerm = () => {
    cancelActiveTools().catch(() => {});
    if (handle) driver.terminate(handle.identity, 300).catch(() => {});
  };
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    handle = await driver.spawn(agentCommand);
    sendToWatchdog({ type: 'watch', pid: handle.identity.pid });
    if ((handle.rawProcess as any)?.helperPid) {
      sendToWatchdog({ type: 'watch', pid: (handle.rawProcess as any).helperPid });
    }
    handle.releaseGate?.();

    if (options.inheritStdio && !process.stdin.isTTY) {
      process.stdin.on('data', (chunk) => {
        try {
          handle!.stdin?.write(chunk);
        } catch {}
      });
      process.stdin.on('end', () => {
        try {
          handle!.stdin?.end();
        } catch {}
      });
    }

    handle.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      stdout += str;
      if (options.inheritStdio) process.stdout.write(chunk);
    });
    handle.stderr.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      stderr += str;
      if (options.inheritStdio) process.stderr.write(chunk);
    });

    const rootExit = await (handle.onRootExit ?? handle.onExit);
    await cancelActiveTools();
    try {
      fs.rmSync(agentSyscallTracePath, { force: true });
    } catch {}

    // Ensure all descendants (escaped setsid processes, MCP servers, pipe holders) are reaped on exit
    const settlement = driver.settleTree ? await driver.settleTree(handle.identity, 200) : 'non_empty';
    if (settlement !== 'empty') {
      const stopRes = await driver.terminate(handle.identity, 500);
      if (stopRes.stopped === 'confirmed_stopped') {
        residualProcessesReaped = true;
      }
    }

    // Clear in-flight tool state on clean agent exit
    writeGatewayInFlightTool(domainPath, null, null);

    if (rootExit.exitCode === 0) {
      domain.reportRunSucceeded(runId);
    } else {
      domain.reportRunFailed(runId);
    }

    return {
      exitCode: rootExit.exitCode,
      signal: rootExit.signal,
      stdout,
      stderr,
      runId,
      domainPath,
      proxyStats: {
        requests: proxy.state.requests,
        mainRequests: proxy.state.mainRequests,
        upstreamRequests: proxy.state.upstreamRequests,
        cacheHits304: proxy.state.cacheHits304,
        turns: proxy.state.turns,
      },
      residualProcessesReaped,
    };
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    restoreConfigs();
    sendToWatchdog({ type: 'shutdown' });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    watchdogServer.closeAllConnections();
    await new Promise<void>((resolve) => watchdogServer.close(() => resolve()));
    await proxy.close();
    if (ownsDomain) {
      domain.close();
    }
  }
}
