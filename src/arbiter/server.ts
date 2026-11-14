import fs from 'node:fs';
import { createLocalIpcSessionKey, LocalIpcServer } from '../ipc/local-socket.js';
import { defaultDomainPathForWorkspace, KernelMedium } from '../kernel/medium.js';
import type {
  AdjudicateSyscallRequest,
  AwaitSyscallRequest,
  BlobSyscallRequest,
  ExecSyscallRequest,
  ObserveSyscallRequest,
  VfsTxSyscallRequest,
} from '../kernel/syscalls.js';
import type { PlatformDriver } from '../driver/types.js';
import {
  type ArbiterManifest,
  arbiterManifestPath,
  resolveArbiterSocketPath,
} from './protocol.js';

const ARBITER_CAPABILITY_ID = 'arbiter-local';
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const ARBITER_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface WorkspaceArbiterServerOptions {
  workspaceRoot: string;
  domainPath?: string;
  domainId?: string;
  socketPath?: string;
  idleTimeoutMs?: number;
  driver?: PlatformDriver;
  onIdleShutdown?: () => void;
}

export class WorkspaceArbiterServer {
  public readonly workspaceRoot: string;
  public readonly domainPath: string;
  public readonly socketPath: string;
  private readonly idleTimeoutMs: number;
  private readonly onIdleShutdown?: () => void;
  private readonly driverOverride?: PlatformDriver;
  private readonly domainIdOverride?: string;
  private medium?: KernelMedium;
  private ipcServer?: LocalIpcServer;
  private manifest?: ArbiterManifest;
  private readonly activeSessions = new Set<string>();
  private inFlightRpcs = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(options: WorkspaceArbiterServerOptions) {
    this.workspaceRoot = fs.realpathSync(options.workspaceRoot);
    this.domainPath = options.domainPath
      ? (fs.mkdirSync(options.domainPath, { recursive: true, mode: 0o700 }), fs.realpathSync(options.domainPath))
      : defaultDomainPathForWorkspace(this.workspaceRoot);
    this.socketPath = options.socketPath ?? resolveArbiterSocketPath(this.domainPath);
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onIdleShutdown = options.onIdleShutdown;
    this.driverOverride = options.driver;
    this.domainIdOverride = options.domainId;
  }

  public getManifest(): ArbiterManifest {
    if (!this.manifest) {
      throw new Error('WorkspaceArbiterServer is not started');
    }
    return this.manifest;
  }

  public getMedium(): KernelMedium {
    if (!this.medium) {
      throw new Error('WorkspaceArbiterServer is not started');
    }
    return this.medium;
  }

  public async start(): Promise<ArbiterManifest> {
    if (this.manifest) return this.manifest;

    // Clean up stale socket file if left behind by a SIGKILLed arbiter
    if (fs.existsSync(this.socketPath)) {
      try {
        const st = fs.lstatSync(this.socketPath);
        if (st.isSocket()) fs.unlinkSync(this.socketPath);
      } catch {}
    }

    const medium = await KernelMedium.open(this.workspaceRoot, {
      domainPath: this.domainPath,
      domainId: this.domainIdOverride,
      driver: this.driverOverride,
    });
    this.medium = medium;

    const epoch = medium.domain.getStore().getCurrentEpoch() ?? 1;
    const sessionKey = createLocalIpcSessionKey();

    const ipc = new LocalIpcServer({
      socketPath: this.socketPath,
      sessionKey,
      maxMessageBytes: ARBITER_MAX_MESSAGE_BYTES,
      resolveCapability: (capabilityId) => {
        if (capabilityId !== ARBITER_CAPABILITY_ID) return null;
        return { epoch };
      },
      handler: async (method, params) => this.dispatchRpc(method, params),
    });

    try {
      await ipc.start();
    } catch (err) {
      await medium.close();
      this.medium = undefined;
      throw err;
    }
    this.ipcServer = ipc;

    const manifest: ArbiterManifest = {
      protocol: 'xio-arbiter/1',
      pid: process.pid,
      workspaceRoot: this.workspaceRoot,
      domainPath: this.domainPath,
      socketPath: this.socketPath,
      sessionKey,
      capabilityId: ARBITER_CAPABILITY_ID,
      epoch,
      startedAt: new Date().toISOString(),
    };
    const manifestFile = arbiterManifestPath(this.domainPath);
    const tmpFile = `${manifestFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, manifestFile);
    this.manifest = manifest;

    // Re-evaluate idle state periodically in case a background process finishes after clients disconnected
    if (this.idleTimeoutMs > 0) {
      this.idleCheckInterval = setInterval(() => this.refreshIdleTimer(), Math.min(2000, Math.max(100, Math.floor(this.idleTimeoutMs / 2))));
      this.idleCheckInterval.unref?.();
      this.refreshIdleTimer();
    }

    return manifest;
  }

  private async dispatchRpc(method: string, params: unknown): Promise<unknown> {
    if (!this.medium) throw new Error('Arbiter shutting down');
    this.inFlightRpcs += 1;
    this.cancelIdleTimer();
    try {
      const payload = (params && typeof params === 'object' ? params : {}) as Record<string, any>;
      switch (method) {
        case 'ping':
          return {
            ok: true,
            pid: process.pid,
            workspaceRoot: this.workspaceRoot,
            activeClients: this.activeSessions.size,
            epoch: this.manifest?.epoch ?? 0,
          };
        case 'hello': {
          const sessionId = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : `client-${Date.now()}`;
          this.activeSessions.add(sessionId);
          this.medium.getSession(sessionId);
          return { sessionId, workspaceRoot: this.workspaceRoot, pid: process.pid };
        }
        case 'bye': {
          if (typeof payload.sessionId === 'string') {
            this.activeSessions.delete(payload.sessionId);
            if (payload.dropView === true) {
              this.medium.dropSession(payload.sessionId);
            }
          }
          return { ok: true };
        }
        case 'exec':
          return await this.medium.exec(payload as ExecSyscallRequest);
        case 'await':
          return await this.medium.await(payload as AwaitSyscallRequest);
        case 'vfs_tx':
          return await this.medium.vfs_tx(payload as VfsTxSyscallRequest);
        case 'blob':
          return await this.medium.blob(payload as BlobSyscallRequest);
        case 'observe':
          return await this.medium.observe(payload as ObserveSyscallRequest);
        case 'adjudicate':
          return await this.medium.adjudicate(payload as AdjudicateSyscallRequest);
        case 'shutdown':
          setImmediate(() => {
            void this.close().then(() => this.onIdleShutdown?.());
          });
          return { shuttingDown: true };
        default:
          throw new Error(`Unknown arbiter method "${method}"`);
      }
    } finally {
      this.inFlightRpcs -= 1;
      this.refreshIdleTimer();
    }
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private isIdle(): boolean {
    if (!this.medium) return true;
    return (
      this.activeSessions.size === 0 &&
      this.inFlightRpcs === 0 &&
      !this.medium.hasActiveWork()
    );
  }

  private refreshIdleTimer(): void {
    if (this.closing || this.idleTimeoutMs <= 0) return;
    if (!this.isIdle()) {
      this.cancelIdleTimer();
      return;
    }
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isIdle() && !this.closing) {
        void this.close().then(() => this.onIdleShutdown?.());
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  public async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelIdleTimer();
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    const manifestFile = arbiterManifestPath(this.domainPath);
    try {
      const current = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
      if (!current || current.pid === process.pid) {
        fs.rmSync(manifestFile, { force: true });
      }
    } catch {}

    if (this.ipcServer) {
      await this.ipcServer.close().catch(() => {});
      this.ipcServer = undefined;
    }
    if (this.medium) {
      await this.medium.close().catch(() => {});
      this.medium = undefined;
    }
    this.manifest = undefined;
  }
}
