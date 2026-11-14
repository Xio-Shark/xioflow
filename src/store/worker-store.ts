import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SqliteStore } from './sqlite.js';
import type { GroupCommitStats, SerializedStoreError, WorkerRpcRequest, WorkerRpcResponse } from './sqlite-worker.js';
import {
  DomainLockedError,
  DuplicateOperationError,
  EpochFencedError,
  ResourceConflictError,
} from '../types.js';

export type { GroupCommitStats } from './sqlite-worker.js';

export interface AsyncWorkerStoreOptions {
  /** Micro-batch aggregation window in milliseconds (default: 1.5ms). */
  groupWindowMs?: number;
  /** Maximum number of write items per Group Commit transaction (default: 64). */
  maxBatchSize?: number;
}

type MethodNames<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];

export type StoreMethodName = Exclude<MethodNames<SqliteStore>, 'transaction' | 'runGroupCommitBatch' | 'close'>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type WorkerRpcPayload = DistributiveOmit<WorkerRpcRequest, 'id'>;

function spawnStoreWorker(workerData: { dbPath: string; groupWindowMs: number; maxBatchSize: number }): Worker {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsCandidate = path.join(here, 'sqlite-worker.js');
  if (fs.existsSync(jsCandidate)) {
    return new Worker(jsCandidate, { execArgv: [], workerData });
  }
  const tsCandidate = path.join(here, 'sqlite-worker.ts');
  if (fs.existsSync(tsCandidate)) {
    const targetUrl = pathToFileURL(tsCandidate).href;
    const loaderCode = [
      "import fs from 'node:fs';",
      "import mod from 'node:module';",
      "import { fileURLToPath, pathToFileURL } from 'node:url';",
      'export async function resolve(specifier, context, nextResolve) {',
      '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {',
      '    try {',
      '      const candidateUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);',
      '      if (fs.existsSync(fileURLToPath(candidateUrl))) {',
      '        return nextResolve(pathToFileURL(fileURLToPath(candidateUrl)).href, context);',
      '      }',
      '    } catch {}',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      'export async function load(url, context, nextLoad) {',
      '  if (url.startsWith("file:") && url.endsWith(".ts") && typeof mod.stripTypeScriptTypes === "function") {',
      '    const source = fs.readFileSync(fileURLToPath(url), "utf8");',
      '    return { format: "module", shortCircuit: true, source: mod.stripTypeScriptTypes(source) };',
      '  }',
      '  return nextLoad(url, context);',
      '}',
    ].join('\n');
    const loaderDataUrl = `data:text/javascript;base64,${Buffer.from(loaderCode, 'utf8').toString('base64')}`;
    const bootstrap = `
      const mod = require('node:module');
      mod.register(${JSON.stringify(loaderDataUrl)});
      import(${JSON.stringify(targetUrl)}).catch((err) => {
        setImmediate(() => { throw err; });
      });
    `;
    return new Worker(bootstrap, {
      eval: true,
      execArgv: ['--no-warnings'],
      workerData,
    });
  }
  throw new Error(`Cannot locate sqlite-worker entry in ${here}`);
}

function hydrateError(serialized: SerializedStoreError): Error {
  if (serialized.name === 'DomainLockedError' && serialized.domainId && serialized.ownerPid !== undefined && serialized.acquiredAt) {
    return new DomainLockedError(serialized.domainId, serialized.ownerPid, serialized.acquiredAt);
  }
  if (serialized.name === 'EpochFencedError' && serialized.domainId && serialized.attemptedEpoch !== undefined && serialized.currentEpoch !== undefined) {
    return new EpochFencedError(serialized.domainId, serialized.attemptedEpoch, serialized.currentEpoch);
  }
  if (serialized.name === 'DuplicateOperationError' && serialized.opId) {
    return new DuplicateOperationError(serialized.opId, serialized.reason ?? 'existing', '');
  }
  if (serialized.name === 'ResourceConflictError' && serialized.resourceId && serialized.holderOpId) {
    return new ResourceConflictError(serialized.resourceId, serialized.holderOpId, serialized.opId ?? '');
  }
  const err = new Error(serialized.message);
  err.name = serialized.name;
  if (serialized.stack) err.stack = serialized.stack;
  return err;
}

/**
 * Offloads SQLite WAL + FULL-sync writes onto a dedicated worker thread with
 * SAVEPOINT-isolated Group Commit batching, eliminating main-thread event-loop stalls.
 */
export class AsyncWorkerStore {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private nextId = 1;
  private closed = false;
  private readonly inflight = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(
    public readonly dbPath: string,
    options: AsyncWorkerStoreOptions = {}
  ) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.worker = spawnStoreWorker({
      dbPath: path.resolve(dbPath),
      groupWindowMs: options.groupWindowMs ?? 1.5,
      maxBatchSize: options.maxBatchSize ?? 64,
    });

    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    let isReady = false;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => {
        isReady = true;
        resolve();
      };
      rejectReady = reject;
    });

    this.worker.on('message', (msg: WorkerRpcResponse | { id: 0; ready: true }) => {
      if ('ready' in msg && msg.ready) {
        resolveReady();
        return;
      }
      const rpc = msg as WorkerRpcResponse;
      const pending = this.inflight.get(rpc.id);
      if (!pending) return;
      this.inflight.delete(rpc.id);
      if (rpc.ok) {
        pending.resolve(rpc.result);
      } else {
        pending.reject(hydrateError(rpc.error));
      }
    });
    this.worker.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!isReady) rejectReady(error);
      this.failAll(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        const error = new Error(`SQLite worker exited unexpectedly with code ${code}`);
        if (!isReady) rejectReady(error);
        this.failAll(error);
      }
    });
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.inflight) {
      pending.reject(error);
    }
    this.inflight.clear();
  }

  private async sendRequest<R>(payload: WorkerRpcPayload): Promise<R> {
    if (this.closed && payload.kind !== 'close') {
      throw new Error('AsyncWorkerStore is closed');
    }
    await this.ready;
    if (this.closed && payload.kind !== 'close') {
      throw new Error('AsyncWorkerStore is closed');
    }
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.worker.postMessage({ ...payload, id } as WorkerRpcRequest);
    });
  }

  /** Enqueue a durable write into the Group Commit batch window. */
  public write<K extends StoreMethodName>(
    method: K,
    ...args: Parameters<SqliteStore[K]>
  ): Promise<ReturnType<SqliteStore[K]>> {
    return this.sendRequest<ReturnType<SqliteStore[K]>>({
      kind: 'write',
      calls: [{ method, args }],
    });
  }

  /** Execute multiple write calls atomically within one SAVEPOINT inside the Group Commit batch. */
  public writeAtomic(
    calls: ReadonlyArray<{ method: StoreMethodName; args: unknown[] }>
  ): Promise<unknown[]> {
    if (calls.length === 0) return Promise.resolve([]);
    return this.sendRequest<unknown>({
      kind: 'write',
      calls,
    }).then((res) => (calls.length === 1 ? [res] : (res as unknown[])));
  }

  /** Linearizable read against the worker-owned database (flushes pending batch first if queued). */
  public read<K extends StoreMethodName>(
    method: K,
    ...args: Parameters<SqliteStore[K]>
  ): Promise<ReturnType<SqliteStore[K]>> {
    return this.sendRequest<ReturnType<SqliteStore[K]>>({
      kind: 'read',
      method,
      args,
    });
  }

  public getStats(): Promise<GroupCommitStats> {
    return this.sendRequest<GroupCommitStats>({ kind: 'stats' });
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.sendRequest<boolean>({ kind: 'close' });
    } finally {
      await this.worker.terminate();
    }
  }
}
