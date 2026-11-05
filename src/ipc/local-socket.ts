import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ExecutionDomain } from '../domain.js';

export interface LocalIpcAuth {
  sessionKey: string;
  capabilityId: string;
  nonce: string;
}

export interface LocalIpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
  auth: LocalIpcAuth;
}

export interface LocalIpcHandlerContext {
  capabilityId: string;
  epoch: number;
  nonce: string;
}

export type LocalIpcHandler = (
  method: string,
  params: unknown,
  context: LocalIpcHandlerContext,
) => unknown | Promise<unknown>;

export interface LocalIpcServerOptions {
  socketPath: string;
  handler: LocalIpcHandler;
  /** Resolve the current epoch/revocation state for the bound capability. */
  resolveCapability: (capabilityId: string) => { epoch: number } | null | Promise<{ epoch: number } | null>;
  sessionKey?: string;
  maxMessageBytes?: number;
  log?: (message: string) => void;
}

export interface LocalIpcClientOptions {
  socketPath: string;
  auth: LocalIpcAuth;
  timeoutMs?: number;
}

export interface LocalIpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code: string; message: string };
}

export class LocalIpcAuthError extends Error {
  constructor(public readonly code: 'invalid_request' | 'missing_session_key' | 'invalid_session_key' | 'missing_capability' | 'capability_rejected' | 'invalid_nonce') {
    super(code);
    this.name = 'LocalIpcAuthError';
  }
}

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

function assertSafeSocketParent(socketPath: string): void {
  const parent = path.dirname(socketPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(parent);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`IPC socket parent is not owned by the current user: ${parent}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`IPC socket parent is group/other-writable: ${parent}`);
  }
}

function assertOwnerOnlySocket(socketPath: string): void {
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error(`IPC path is not a Unix socket: ${socketPath}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`IPC socket is not owned by the current user: ${socketPath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`IPC socket must be owner-only (0600): ${socketPath}`);
  }
}

function hexKey(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new LocalIpcAuthError('invalid_session_key');
  return Buffer.from(value, 'hex');
}

function constantTimeHexEquals(actual: string, expected: string): boolean {
  try {
    const left = hexKey(actual);
    const right = hexKey(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** Derive a nonce that is valid only for this session, capability and epoch. */
export function capabilityBoundNonce(sessionKey: string, capabilityId: string, epoch: number): string {
  if (!capabilityId || !Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError('capability-bound nonce requires a capability id and non-negative epoch');
  const key = hexKey(sessionKey);
  return crypto.createHmac('sha256', key)
    .update(`xio/local-ipc/v1\0${capabilityId}\0${epoch}`)
    .digest('hex');
}

export function createLocalIpcSessionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Bind local IPC authentication to the domain's current, non-expired capability record. */
export function resolveDomainCapability(domain: Pick<ExecutionDomain, 'getCapability'>): (capabilityId: string) => { epoch: number } | null {
  return (capabilityId) => {
    const capability = domain.getCapability(capabilityId);
    if (!capability || capability.revokedAt || Date.parse(capability.expiresAt) <= Date.now()) return null;
    return { epoch: capability.epoch };
  };
}

export class LocalIpcServer {
  private readonly log: (message: string) => void;
  private readonly maxMessageBytes: number;
  private readonly sessionKey: string;
  private server?: net.Server;
  private readonly connections = new Set<net.Socket>();
  private started = false;

  constructor(private readonly options: LocalIpcServerOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new TypeError('IPC socketPath must be absolute');
    if (Buffer.byteLength(options.socketPath, 'utf8') > 100) throw new RangeError('IPC socketPath is too long for a Unix domain socket');
    if (options.maxMessageBytes !== undefined && (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1024)) {
      throw new RangeError('IPC maxMessageBytes must be a safe integer >= 1024');
    }
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.sessionKey = options.sessionKey ?? createLocalIpcSessionKey();
    hexKey(this.sessionKey);
    this.log = options.log ?? (() => {});
  }

  public getSessionKey(): string {
    return this.sessionKey;
  }

  public async start(): Promise<void> {
    if (this.started) return;
    assertSafeSocketParent(this.options.socketPath);
    if (fs.existsSync(this.options.socketPath)) throw new Error(`IPC socket path already exists: ${this.options.socketPath}`);
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.socketPath);
    });
    try {
      fs.chmodSync(this.options.socketPath, 0o600);
      assertOwnerOnlySocket(this.options.socketPath);
    } catch (error) {
      await this.close();
      throw error;
    }
    this.started = true;
    this.log(`local IPC listening on ${this.options.socketPath}`);
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.started = false;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(this.options.socketPath)) {
      const stat = fs.lstatSync(this.options.socketPath);
      if (stat.isSocket()) fs.unlinkSync(this.options.socketPath);
    }
  }

  public credentials(capabilityId: string, epoch: number): LocalIpcAuth {
    return {
      sessionKey: this.sessionKey,
      capabilityId,
      nonce: capabilityBoundNonce(this.sessionKey, capabilityId, epoch),
    };
  }

  private async authenticate(auth: unknown): Promise<LocalIpcHandlerContext> {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new LocalIpcAuthError('missing_session_key');
    const candidate = auth as Partial<LocalIpcAuth>;
    if (typeof candidate.sessionKey !== 'string') throw new LocalIpcAuthError('missing_session_key');
    if (!constantTimeHexEquals(candidate.sessionKey, this.sessionKey)) throw new LocalIpcAuthError('invalid_session_key');
    if (typeof candidate.capabilityId !== 'string' || candidate.capabilityId.length === 0) throw new LocalIpcAuthError('missing_capability');
    if (typeof candidate.nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.nonce)) throw new LocalIpcAuthError('invalid_nonce');
    const binding = await this.options.resolveCapability(candidate.capabilityId);
    if (!binding || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0) throw new LocalIpcAuthError('capability_rejected');
    const expectedNonce = capabilityBoundNonce(this.sessionKey, candidate.capabilityId, binding.epoch);
    if (!constantTimeHexEquals(candidate.nonce, expectedNonce)) throw new LocalIpcAuthError('invalid_nonce');
    return { capabilityId: candidate.capabilityId, epoch: binding.epoch, nonce: candidate.nonce };
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > this.maxMessageBytes) {
        socket.destroy(new Error('IPC message exceeds maxMessageBytes'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        void this.handleLine(socket, line);
      }
    });
    socket.on('error', (error) => this.log(`local IPC connection error: ${error.message}`));
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: Partial<LocalIpcRequest>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request must be an object');
      request = parsed as Partial<LocalIpcRequest>;
    } catch {
      this.writeResponse(socket, { id: null, error: { code: 'invalid_request', message: 'request must be one JSON object per line' } });
      return;
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    if (typeof request.method !== 'string' || request.method.length === 0) {
      this.writeResponse(socket, { id, error: { code: 'invalid_request', message: 'method is required' } });
      return;
    }
    try {
      const context = await this.authenticate(request.auth);
      const result = await this.options.handler(request.method, request.params, context);
      this.writeResponse(socket, { id, result });
    } catch (error) {
      const code = error instanceof LocalIpcAuthError ? error.code : 'handler_error';
      const message = error instanceof Error ? error.message : String(error);
      this.writeResponse(socket, { id, error: { code, message } });
    }
  }

  private writeResponse(socket: net.Socket, response: LocalIpcResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }
}

export async function callLocalIpc(
  options: LocalIpcClientOptions,
  request: { id: string | number; method: string; params?: unknown },
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const socket = net.createConnection(options.socketPath);
  return await new Promise<unknown>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('IPC request timed out')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line) as LocalIpcResponse;
        if (response.error) finish(new Error(`${response.error.code}: ${response.error.message}`));
        else finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ ...request, auth: options.auth })}\n`);
    });
  });
}
