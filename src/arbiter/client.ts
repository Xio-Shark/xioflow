import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLocalIpc, capabilityBoundNonce, type LocalIpcAuth } from '../ipc/local-socket.js';
import { defaultDomainPathForWorkspace, KernelMedium } from '../kernel/medium.js';
import type {
  AdjudicateSyscallRequest,
  AdjudicateSyscallResult,
  AwaitSyscallRequest,
  AwaitSyscallResult,
  BlobSyscallRequest,
  BlobSyscallResult,
  ExecSyscallRequest,
  ExecSyscallResult,
  ObserveSyscallRequest,
  ObserveSyscallResult,
  OsMedium,
  VfsTxSyscallRequest,
  VfsTxSyscallResult,
} from '../kernel/syscalls.js';
import {
  type ArbiterManifest,
  arbiterBootLockPath,
  isProcessAlive,
  readArbiterManifest,
} from './protocol.js';

export interface ConnectWorkspaceOptions {
  domainPath?: string;
  domainId?: string;
  sessionId?: string;
  /**
   * Connection mode:
   * - `'auto'` (default): connect to or spawn the workspace-scoped UDS Micro-Arbiter so multiple clients share one ledger.
   * - `'arbiter'`: strictly require UDS Micro-Arbiter.
   * - `'in-process'`: open `KernelMedium` directly in the caller process (single-owner mode).
   */
  mode?: 'auto' | 'arbiter' | 'in-process';
  /** Idle auto-exit timeout passed when spawning a new Micro-Arbiter (default 300_000ms). */
  idleTimeoutMs?: number;
  /** Maximum wait time for Micro-Arbiter bootstrap (default 10_000ms). */
  connectTimeoutMs?: number;
}

export class WorkspaceArbiterClient implements OsMedium {
  public readonly workspaceRoot: string;
  public readonly sessionId: string;
  public readonly manifest: ArbiterManifest;
  private readonly auth: LocalIpcAuth;
  private reqSeq = 0;
  private closed = false;

  constructor(manifest: ArbiterManifest, sessionId: string) {
    this.workspaceRoot = manifest.workspaceRoot;
    this.manifest = manifest;
    this.sessionId = sessionId;
    this.auth = {
      sessionKey: manifest.sessionKey,
      capabilityId: manifest.capabilityId,
      nonce: capabilityBoundNonce(manifest.sessionKey, manifest.capabilityId, manifest.epoch),
    };
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, timeoutMs: number = 120_000): Promise<T> {
    if (this.closed && method !== 'bye') {
      throw new Error('WorkspaceArbiterClient is closed');
    }
    this.reqSeq += 1;
    const res = await callLocalIpc(
      {
        socketPath: this.manifest.socketPath,
        auth: this.auth,
        timeoutMs,
      },
      {
        id: `${this.sessionId}-${this.reqSeq}`,
        method,
        params,
      },
    );
    return res as T;
  }

  public async ping(): Promise<{ ok: boolean; pid: number; activeClients: number; epoch: number }> {
    return this.rpc('ping', {}, 2500);
  }

  public async registerHello(): Promise<void> {
    await this.rpc('hello', { sessionId: this.sessionId }, 5000);
  }

  public async exec(req: ExecSyscallRequest): Promise<ExecSyscallResult> {
    const rpcTimeout = (req.timeoutMs ?? 60_000) + 15_000;
    return this.rpc('exec', { ...req, sessionId: req.sessionId ?? this.sessionId }, rpcTimeout);
  }

  public async await(req: AwaitSyscallRequest): Promise<AwaitSyscallResult> {
    const rpcTimeout = (req.timeoutMs ?? 15_000) + 10_000;
    return this.rpc('await', { ...req, sessionId: req.sessionId ?? this.sessionId }, rpcTimeout);
  }

  public async vfs_tx(req: VfsTxSyscallRequest): Promise<VfsTxSyscallResult> {
    const rpcTimeout = (req.gateTimeoutMs ?? 60_000) * 2 + 15_000;
    return this.rpc('vfs_tx', { ...req, sessionId: req.sessionId ?? this.sessionId }, rpcTimeout);
  }

  public async blob(req: BlobSyscallRequest): Promise<BlobSyscallResult> {
    return this.rpc('blob', { ...req, sessionId: req.sessionId ?? this.sessionId }, 30_000);
  }

  public async observe(req?: ObserveSyscallRequest): Promise<ObserveSyscallResult> {
    return this.rpc('observe', { ...(req ?? {}), sessionId: req?.sessionId ?? this.sessionId }, 15_000);
  }

  public async adjudicate(req: AdjudicateSyscallRequest): Promise<AdjudicateSyscallResult> {
    return this.rpc('adjudicate', { ...req }, 15_000);
  }

  public async shutdownArbiter(): Promise<void> {
    await this.rpc('shutdown', {}, 5000).catch(() => {});
    this.closed = true;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rpc('bye', { sessionId: this.sessionId }, 3000).catch(() => {});
  }
}

async function tryConnectExisting(domainPath: string, sessionId: string): Promise<WorkspaceArbiterClient | null> {
  const manifest = readArbiterManifest(domainPath);
  if (!manifest) return null;
  if (!isProcessAlive(manifest.pid)) return null;
  const client = new WorkspaceArbiterClient(manifest, sessionId);
  try {
    const pong = await client.ping();
    if (!pong?.ok) return null;
    await client.registerHello();
    return client;
  } catch {
    return null;
  }
}

function spawnDetachedArbiter(options: {
  workspaceRoot: string;
  domainPath: string;
  domainId?: string;
  idleTimeoutMs?: number;
}): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const siblingJs = path.join(here, 'daemon-entry.js');
  const distJs = path.resolve(here, '../../dist/arbiter/daemon-entry.js');
  const tsEntry = path.join(here, 'daemon-entry.ts');
  const serverTs = path.join(here, 'server.ts');
  const mediumTs = path.resolve(here, '../kernel/medium.ts');

  let entryPath: string;
  let useJs = false;
  if (fs.existsSync(siblingJs)) {
    entryPath = siblingJs;
    useJs = true;
  } else if (fs.existsSync(distJs)) {
    const distMtime = fs.statSync(distJs).mtimeMs;
    const latestSrcMtime = Math.max(
      fs.existsSync(tsEntry) ? fs.statSync(tsEntry).mtimeMs : 0,
      fs.existsSync(serverTs) ? fs.statSync(serverTs).mtimeMs : 0,
      fs.existsSync(mediumTs) ? fs.statSync(mediumTs).mtimeMs : 0,
    );
    if (distMtime >= latestSrcMtime) {
      entryPath = distJs;
      useJs = true;
    } else {
      entryPath = tsEntry;
    }
  } else {
    entryPath = tsEntry;
  }

  const execArgs: string[] = [];
  if (!useJs) {
    // Support running directly from TypeScript source in Node >=22.13.0 via module.register + stripTypeScriptTypes
    const loaderCode = [
      "import fs from 'node:fs';",
      "import module from 'node:module';",
      "import { fileURLToPath, pathToFileURL } from 'node:url';",
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {',
      '    const candidateUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);',
      '    if (fs.existsSync(fileURLToPath(candidateUrl))) {',
      '      return nextResolve(pathToFileURL(fileURLToPath(candidateUrl)).href, context);',
      '    }',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      'export async function load(url, context, nextLoad) {',
      '  if (url.startsWith("file:") && url.endsWith(".ts") && typeof module.stripTypeScriptTypes === "function") {',
      '    const source = fs.readFileSync(fileURLToPath(url), "utf8");',
      '    return { format: "module", shortCircuit: true, source: module.stripTypeScriptTypes(source) };',
      '  }',
      '  return nextLoad(url, context);',
      '}',
    ].join('\n');
    const loaderDataUrl = `data:text/javascript;base64,${Buffer.from(loaderCode, 'utf8').toString('base64')}`;
    const regCode = `import module from 'node:module'; module.register(${JSON.stringify(loaderDataUrl)});`;
    execArgs.push('--no-warnings', '--import', `data:text/javascript;base64,${Buffer.from(regCode, 'utf8').toString('base64')}`);
  }

  const cliArgs = [
    entryPath,
    '--workspace',
    options.workspaceRoot,
    '--domain',
    options.domainPath,
    ...(options.domainId ? ['--domain-id', options.domainId] : []),
    ...(options.idleTimeoutMs !== undefined ? ['--idle-timeout-ms', String(options.idleTimeoutMs)] : []),
  ];

  const errLogPath = path.join(options.domainPath, 'arbiter.err.log');
  const errFd = fs.openSync(errLogPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...execArgs, ...cliArgs], {
      cwd: options.workspaceRoot,
      detached: true,
      stdio: ['ignore', 'ignore', errFd],
      env: process.env,
    });
    child.unref();
  } finally {
    fs.closeSync(errFd);
  }
}

function tryAcquireBootLock(domainPath: string): (() => void) | null {
  fs.mkdirSync(domainPath, { recursive: true, mode: 0o700 });
  const lockPath = arbiterBootLockPath(domainPath);
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return () => {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    };
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      try {
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; ts?: number };
        const stale =
          !meta.pid ||
          !isProcessAlive(meta.pid) ||
          (typeof meta.ts === 'number' && Date.now() - meta.ts > 15_000);
        if (stale) {
          fs.rmSync(lockPath, { force: true });
          const fd = fs.openSync(lockPath, 'wx', 0o600);
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
          fs.closeSync(fd);
          return () => {
            try {
              fs.rmSync(lockPath, { force: true });
            } catch {}
          };
        }
      } catch {}
    }
    return null;
  }
}

/**
 * Connect to a workspace's OS medium.
 *
 * By default (`mode: 'auto'`), attaches to the running workspace-scoped UDS Micro-Arbiter
 * or transparently spawns one on demand so IDE MCP servers, CLI wrappers, and parallel sub-agents
 * never collide with `DomainLockedError` and share a single process-tree & OCC ledger.
 */
export async function connectWorkspace(
  workspaceRoot: string,
  options?: ConnectWorkspaceOptions,
): Promise<OsMedium> {
  const realWorkspace = fs.realpathSync(workspaceRoot);
  const sessionId =
    options?.sessionId ?? `sess-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const mode = options?.mode ?? 'auto';
  const domainPath = options?.domainPath
    ? (fs.mkdirSync(options.domainPath, { recursive: true, mode: 0o700 }), fs.realpathSync(options.domainPath))
    : defaultDomainPathForWorkspace(realWorkspace);

  if (mode === 'in-process') {
    const medium = await KernelMedium.open(realWorkspace, {
      domainPath,
      domainId: options?.domainId,
    });
    medium.getSession(sessionId);
    return medium;
  }

  const existing = await tryConnectExisting(domainPath, sessionId);
  if (existing) return existing;

  const releaseBootLock = tryAcquireBootLock(domainPath);
  try {
    if (releaseBootLock) {
      // Double-check after acquiring lock
      const secondCheck = await tryConnectExisting(domainPath, sessionId);
      if (secondCheck) return secondCheck;

      spawnDetachedArbiter({
        workspaceRoot: realWorkspace,
        domainPath,
        domainId: options?.domainId,
        idleTimeoutMs: options?.idleTimeoutMs,
      });
    }

    const deadline = Date.now() + (options?.connectTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 35));
      const connected = await tryConnectExisting(domainPath, sessionId);
      if (connected) return connected;
    }
  } finally {
    releaseBootLock?.();
  }

  let errTail = '';
  const errLogPath = path.join(domainPath, 'arbiter.err.log');
  if (fs.existsSync(errLogPath)) {
    try {
      errTail = fs.readFileSync(errLogPath, 'utf8').trim().slice(-1000);
    } catch {}
  }

  throw new Error(
    `Timed out waiting for WorkspaceArbiter at "${domainPath}" for workspace "${realWorkspace}"${errTail ? `: ${errTail}` : ''}`,
  );
}
