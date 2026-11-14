import { parentPort, workerData } from 'node:worker_threads';
import { SqliteStore } from './sqlite.js';

export interface SerializedStoreError {
  name: string;
  message: string;
  stack?: string;
  domainId?: string;
  ownerPid?: number;
  acquiredAt?: string;
  attemptedEpoch?: number;
  currentEpoch?: number;
  opId?: string;
  reason?: string;
  resourceId?: string;
  holderOpId?: string;
}

export interface GroupCommitStats {
  totalWriteItems: number;
  totalReads: number;
  totalCommits: number;
  savedFsyncs: number;
  maxBatchSizeSeen: number;
}

export type WorkerRpcRequest =
  | {
      id: number;
      kind: 'write';
      calls: ReadonlyArray<{ method: string; args: unknown[] }>;
    }
  | {
      id: number;
      kind: 'read';
      method: string;
      args: unknown[];
    }
  | {
      id: number;
      kind: 'stats';
    }
  | {
      id: number;
      kind: 'close';
    };

export type WorkerRpcResponse =
  | {
      id: number;
      ok: true;
      result: unknown;
      batchSize?: number;
    }
  | {
      id: number;
      ok: false;
      error: SerializedStoreError;
    };

interface WorkerInitData {
  dbPath: string;
  groupWindowMs: number;
  maxBatchSize: number;
}

function serializeError(err: unknown): SerializedStoreError {
  if (err instanceof Error) {
    const anyErr = err as unknown as Record<string, unknown>;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(typeof anyErr.domainId === 'string' ? { domainId: anyErr.domainId } : {}),
      ...(typeof anyErr.ownerPid === 'number' ? { ownerPid: anyErr.ownerPid } : {}),
      ...(typeof anyErr.acquiredAt === 'string' ? { acquiredAt: anyErr.acquiredAt } : {}),
      ...(typeof anyErr.attemptedEpoch === 'number' ? { attemptedEpoch: anyErr.attemptedEpoch } : {}),
      ...(typeof anyErr.currentEpoch === 'number' ? { currentEpoch: anyErr.currentEpoch } : {}),
      ...(typeof anyErr.opId === 'string' ? { opId: anyErr.opId } : {}),
      ...(typeof anyErr.reason === 'string' ? { reason: anyErr.reason } : {}),
      ...(typeof anyErr.resourceId === 'string' ? { resourceId: anyErr.resourceId } : {}),
      ...(typeof anyErr.holderOpId === 'string' ? { holderOpId: anyErr.holderOpId } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

function invokeStoreMethod(store: SqliteStore, method: string, args: unknown[]): unknown {
  const fn = (store as unknown as Record<string, unknown>)[method];
  if (typeof fn !== 'function' || method === 'constructor' || method === 'transaction' || method === 'runGroupCommitBatch') {
    throw new Error(`Unsupported worker store method: ${method}`);
  }
  return (fn as (...callArgs: unknown[]) => unknown).apply(store, args);
}

if (parentPort) {
  const port = parentPort;
  const init = workerData as WorkerInitData;
  const store = new SqliteStore(init.dbPath);
  const groupWindowMs = Math.max(0, init.groupWindowMs ?? 1.5);
  const maxBatchSize = Math.max(1, init.maxBatchSize ?? 64);

  const stats: GroupCommitStats = {
    totalWriteItems: 0,
    totalReads: 0,
    totalCommits: 0,
    savedFsyncs: 0,
    maxBatchSizeSeen: 0,
  };

  let pendingWrites: Array<Extract<WorkerRpcRequest, { kind: 'write' }>> = [];
  let pendingReadsAfterFlush: Array<Extract<WorkerRpcRequest, { kind: 'read' | 'stats' | 'close' }>> = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const send = (res: WorkerRpcResponse): void => {
    port.postMessage(res);
  };

  const handleNonWrite = (req: Extract<WorkerRpcRequest, { kind: 'read' | 'stats' | 'close' }>): void => {
    if (req.kind === 'stats') {
      send({ id: req.id, ok: true, result: { ...stats } });
      return;
    }
    if (req.kind === 'close') {
      closed = true;
      try {
        store.close();
        send({ id: req.id, ok: true, result: true });
      } catch (err) {
        send({ id: req.id, ok: false, error: serializeError(err) });
      }
      port.close();
      return;
    }
    try {
      stats.totalReads += 1;
      const result = invokeStoreMethod(store, req.method, req.args);
      send({ id: req.id, ok: true, result });
    } catch (err) {
      send({ id: req.id, ok: false, error: serializeError(err) });
    }
  };

  const flushBatch = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingWrites.length > 0) {
      const batch = pendingWrites;
      pendingWrites = [];
      const batchSize = batch.length;
      stats.totalWriteItems += batchSize;
      if (batchSize > stats.maxBatchSizeSeen) stats.maxBatchSizeSeen = batchSize;

      try {
        const outcomes = store.runGroupCommitBatch(
          batch.map((req) => () => {
            const results = req.calls.map((c) => invokeStoreMethod(store, c.method, c.args));
            return req.calls.length === 1 ? results[0] : results;
          })
        );
        const succeededCount = outcomes.filter((o) => o.ok).length;
        if (succeededCount > 0) {
          stats.totalCommits += 1;
          stats.savedFsyncs += Math.max(0, succeededCount - 1);
        }
        for (let i = 0; i < batch.length; i++) {
          const req = batch[i]!;
          const out = outcomes[i]!;
          if (out.ok) {
            send({ id: req.id, ok: true, result: out.value, batchSize });
          } else {
            send({ id: req.id, ok: false, error: serializeError(out.error) });
          }
        }
      } catch (commitErr) {
        const serialized = serializeError(commitErr);
        for (const req of batch) {
          send({ id: req.id, ok: false, error: serialized });
        }
      }
    }

    if (pendingReadsAfterFlush.length > 0) {
      const deferred = pendingReadsAfterFlush;
      pendingReadsAfterFlush = [];
      for (const req of deferred) {
        handleNonWrite(req);
        if (closed) break;
      }
    }
  };

  const scheduleFlush = (): void => {
    if (pendingWrites.length >= maxBatchSize || groupWindowMs === 0) {
      flushBatch();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushBatch, groupWindowMs);
    }
  };

  port.on('message', (req: WorkerRpcRequest) => {
    if (closed) {
      send({ id: req.id, ok: false, error: { name: 'Error', message: 'AsyncWorkerStore is closed' } });
      return;
    }
    if (req.kind === 'write') {
      pendingWrites.push(req);
      scheduleFlush();
      return;
    }
    // Preserve linearizable read-your-writes ordering when writes are waiting in the window
    if (pendingWrites.length > 0) {
      pendingReadsAfterFlush.push(req);
      if (req.kind === 'close') {
        flushBatch();
      }
      return;
    }
    handleNonWrite(req);
  });

  port.postMessage({ id: 0, ready: true });
}
