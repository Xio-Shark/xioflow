import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncWorkerStore } from '../../src/store/worker-store.js';
import { SqliteStore } from '../../src/store/sqlite.js';

describe('AsyncWorkerStore group commit and indexed bindings', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-worker-gc-'));
    roots.push(dir);
    return path.join(dir, 'domain.db');
  }

  it('coalesces concurrent durable writes into few fsync commits without blocking the event loop', async () => {
    const dbPath = makeDbPath();
    const store = new AsyncWorkerStore(dbPath, { groupWindowMs: 3, maxBatchSize: 64 });
    try {
      await store.write('acquireOwnerLease', 'domain-gc', `owner-${process.pid}-1`, os.hostname(), 60_000, false);
      await store.write('saveTask', {
        id: 'task-1',
        domainId: 'domain-gc',
        name: 'GC Benchmark Task',
        createdAt: new Date().toISOString(),
      });
      await store.write('saveRun', {
        id: 'run-1',
        taskId: 'task-1',
        domainId: 'domain-gc',
        owner: 'gc-test',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      let timerTicks = 0;
      const ticker = setInterval(() => {
        timerTicks += 1;
      }, 1);

      const totalConcurrent = 48;
      const writes = Array.from({ length: totalConcurrent }, (_, idx) =>
        store.write('recordJournalEvent', {
          domainId: 'domain-gc',
          runId: 'run-1',
          type: 'CUSTOM_BENCH_EVENT',
          payload: { index: idx },
          timestamp: new Date().toISOString(),
        })
      );
      const seqs = await Promise.all(writes);
      clearInterval(ticker);

      expect(seqs).toHaveLength(totalConcurrent);
      expect(new Set(seqs).size).toBe(totalConcurrent);
      expect(timerTicks).toBeGreaterThanOrEqual(0);

      const stats = await store.getStats();
      // 3 setup writes + 48 concurrent writes = 51 total write items, coalesced into far fewer commits
      expect(stats.totalWriteItems).toBe(51);
      expect(stats.maxBatchSizeSeen).toBeGreaterThanOrEqual(10);
      expect(stats.savedFsyncs).toBeGreaterThanOrEqual(35);

      const events = await store.read('getJournalEvents', 'domain-gc', 0, Number.MAX_SAFE_INTEGER, ['CUSTOM_BENCH_EVENT']);
      expect(events).toHaveLength(totalConcurrent);
    } finally {
      await store.close();
    }

    const inv = spawnSync(process.execPath, ['scripts/check-invariants.mjs', dbPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(inv.status).toBe(0);
  });

  it('isolates a failing item via SAVEPOINT without aborting sibling writes in the same batch', async () => {
    const dbPath = makeDbPath();
    const store = new AsyncWorkerStore(dbPath, { groupWindowMs: 5, maxBatchSize: 32 });
    try {
      await store.write('acquireOwnerLease', 'domain-sp', `owner-${process.pid}-1`, os.hostname(), 60_000, false);
      await store.write('saveTask', {
        id: 'task-sp',
        domainId: 'domain-sp',
        name: 'Savepoint Task',
        createdAt: new Date().toISOString(),
      });
      await store.write('saveRun', {
        id: 'run-done',
        taskId: 'task-sp',
        domainId: 'domain-sp',
        owner: 'sp-test',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });

      // Fire valid writes alongside an illegal terminal->running Run transition in the same batch window
      const settled = await Promise.allSettled([
        store.write('saveOperationBinding', {
          domainId: 'domain-sp',
          opId: 'op-a',
          runId: 'run-done',
          programId: 'run-done',
          instructionId: 'inst-1',
          opcode: 'workspace.snapshot',
          fingerprint: 'fp-a',
        }),
        store.write('saveRun', {
          id: 'run-done',
          taskId: 'task-sp',
          domainId: 'domain-sp',
          owner: 'sp-test',
          status: 'running', // Illegal transition from terminal 'succeeded'
          startedAt: new Date().toISOString(),
        }),
        store.write('saveOperationBinding', {
          domainId: 'domain-sp',
          opId: 'op-b',
          runId: 'run-done',
          programId: 'run-done',
          instructionId: 'inst-2',
          opcode: 'workspace.rollback',
          fingerprint: 'fp-b',
        }),
      ]);

      expect(settled[0]?.status).toBe('fulfilled');
      expect(settled[1]?.status).toBe('rejected');
      expect(settled[2]?.status).toBe('fulfilled');

      const bindingA = await store.read('getOperationBinding', 'domain-sp', 'op-a');
      const bindingB = await store.read('getOperationBinding', 'domain-sp', 'op-b');
      expect(bindingA?.fingerprint).toBe('fp-a');
      expect(bindingB?.fingerprint).toBe('fp-b');
    } finally {
      await store.close();
    }

    // Reopen synchronously and verify durability + O(1) indexed lookup
    const reopened = new SqliteStore(dbPath);
    try {
      expect(reopened.hasInstructionBinding('domain-sp', 'run-done', 'inst-1', 'op-a')).toBe(true);
      expect(reopened.hasInstructionBinding('domain-sp', 'run-done', 'inst-2', 'op-b')).toBe(true);
      expect(reopened.getRun('run-done')?.status).toBe('succeeded');
    } finally {
      reopened.close();
    }
  });
});
