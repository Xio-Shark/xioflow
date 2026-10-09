import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { commitWorldCandidate, readWorldPublication } from '../../src/world/commit.js';
import { explainWorldPublication } from '../../src/world/explain.js';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { refreshWorldCandidate } from '../../src/world/refresh.js';
import type { WorldAgent } from '../../src/world/contract.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
let calls: number;
let unknown: boolean;
const adapter = { accept: async (root: string) => await fs.readFile(path.join(root, 'output'), 'utf8') === await fs.readFile(path.join(root, 'input'), 'utf8'), id: 'test', version: '1', declareCoverage: async () => ({
  paths: ['input', 'output', 'unrelated'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}), replay: async (entry: { kind: string }, root: string) => {
  const value = await fs.readFile(path.join(root, 'input'), 'utf8');
  if (entry.kind === 'mutate') await fs.writeFile(path.join(root, 'output'), value);
  return value;
} };
const agent: WorldAgent = { execute: async ({ record, forkRoot, version, refresh }, input) => {
  calls++;
  expect(input.task).toBe('copy');
  if (refresh) expect(refresh.plan.unaffected).toEqual([]);
  const value = await fs.readFile(path.join(forkRoot, 'input'), 'utf8');
  const read = await record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: value }, []);
  await fs.writeFile(path.join(forkRoot, 'output'), value);
  const write = await record({ kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: value }, [read]);
  return { coverage: unknown ? { status: 'unknown', reasons: ['network_read'] }
    : { status: 'complete', manifestHash: version.manifestHash }, heads: [write], artifacts: [] };
} };
beforeEach(async () => {
  calls = 0;
  unknown = false;
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-refresh-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'input'), 'original');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
});
afterEach(async () => { world?.close(); await fs.rm(temp, { recursive: true, force: true }); });
async function prepare() {
  const result = await prepareWorldStep(world, agent, { task: 'copy' });
  if (result.status === 'failed') throw new Error(result.reason);
  return result.candidate;
}

it.each([false, true])('publishes a refreshed candidate changed=%s and preserves receipt after reopen', async changed => {
  const previous = await prepare();
  if (changed) await fs.writeFile(path.join(world.state.root, 'input'), '120');
  const refreshed = await refreshWorldCandidate(world, previous, adapter, agent, { onUnknown: 'reject' });
  if (refreshed.result.status !== 'prepared') throw new Error(JSON.stringify(refreshed));
  const candidate = refreshed.result.candidate;
  const result = await commitWorldCandidate(world, candidate, adapter);
  expect(result).toMatchObject({ status: 'committed', receipt: { validation: 'observations' } });
  expect(await fs.readFile(path.join(world.state.root, 'output'), 'utf8')).toBe(changed ? '120' : 'original');
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  const before = world.domain.getStore().getJournalEvents('world');
  expect(await commitWorldCandidate(world, candidate, adapter)).toEqual(result);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(before);
});

it('rejects all ten stale refreshed candidates without publishing', async () => {
  for (let i = 0; i < 10; i++) {
    const previous = await prepare();
    await fs.writeFile(path.join(world.state.root, 'input'), `price-${i}`);
    const refreshed = await refreshWorldCandidate(world, previous, adapter, agent, { onUnknown: 'reject' });
    if (refreshed.result.status !== 'prepared') throw new Error(JSON.stringify(refreshed));
    await fs.writeFile(path.join(world.state.root, 'input'), `later-${i}`);
    // Forged empty heads must not bypass durable dependencies.
    expect(await commitWorldCandidate(world, { ...refreshed.result.candidate, heads: [] } as typeof previous, adapter))
      .toMatchObject({ status: 'conflict' });
    await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe(`later-${i}`);
  }
}, 60_000);

it.each(['unknown', 'output', 'accept', 'tool', 'accept-mutation'] as const)('blocks %s before publication', async failure => {
  unknown = failure === 'unknown';
  const candidate = await prepare();
  if (failure === 'output') {
    const completed = world.domain.getStore().getJournalEvents('world').find(e => e.type === 'WORLD_STEP_COMPLETED')!;
    await fs.writeFile(path.join(completed.payload.forkRoot as string, 'output'), 'tampered');
  }
  const result = await commitWorldCandidate(world, candidate, { ...adapter,
    replay: failure === 'tool' ? async () => { throw new Error('tool offline'); } : adapter.replay,
    accept: failure === 'accept' ? async () => false : failure === 'accept-mutation' ? async root => {
      await fs.writeFile(path.join(root, 'output'), 'tampered'); return true;
    } : adapter.accept,
  });
  expect(result.status).toBe(failure === 'unknown' ? 'unknown' : failure === 'tool' ? 'validation_failed' : 'rejected');
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('serializes competing candidates so only one publishes', async () => {
  const a = await prepare();
  const b = await prepare();
  const results = await Promise.all([commitWorldCandidate(world, a, adapter), commitWorldCandidate(world, b, adapter)]);
  expect(results.map(r => r.status).sort()).toEqual(['committed', 'conflict']);
});

it('binds independent keys once under concurrent requests and preserves historical queries', async () => {
  const candidate = await prepare();
  const before = world.domain.getStore().getJournalEvents('world').at(-1)!.seq;
  const [first, retry] = await Promise.all([
    commitWorldCandidate(world, candidate, adapter, { key: 'request-1' }),
    commitWorldCandidate(world, candidate, adapter, { key: 'request-1' }),
  ]);
  expect(first.status).toBe('committed');
  expect(retry).toEqual(first);
  expect(first.identity.key).toBe('request-1');
  expect(readWorldPublication(world, 'request-1', before).result).toBeNull();
  const saved = readWorldPublication(world, 'request-1');
  const events = world.domain.getStore().getJournalEvents('world');
  expect(await commitWorldCandidate(world, candidate, adapter, { key: 'unused' })).toEqual(first);
  expect(readWorldPublication(world, 'unused').result).toBeNull();
  expect(await commitWorldCandidate(world, { ...candidate, id: 'other', atSeq: -1 }, adapter,
    { key: 'request-1' })).toMatchObject({ status: 'key_conflict', identity: first.identity });
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldPublication(world, 'request-1', saved.atSeq)).toEqual(saved);
  expect(await commitWorldCandidate(world, candidate, adapter, { key: 'request-1' })).toEqual(first);
});

it('does not retry a terminal rejection or allocate a key for an invalid reference', async () => {
  unknown = true;
  const candidate = await prepare();
  const result = await commitWorldCandidate(world, candidate, adapter, { key: 'unknown-key' });
  expect(result.status).toBe('unknown');
  const events = world.domain.getStore().getJournalEvents('world');
  expect(await commitWorldCandidate(world, candidate, { ...adapter,
    replay: async () => { throw new Error('must not replay'); } }, { key: 'unknown-key' })).toEqual(result);
  await expect(commitWorldCandidate(world, { ...candidate, atSeq: -1 }, adapter,
    { key: 'invalid' })).rejects.toThrow('reference mismatch');
  expect(readWorldPublication(world, 'invalid').result).toBeNull();
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
});

it('retries validation exceptions with the original key and transaction', async () => {
  const candidate = await prepare();
  const failed = await commitWorldCandidate(world, candidate, { ...adapter,
    accept: async () => { throw new Error('temporary acceptance failure'); } }, { key: 'retry' });
  expect(failed.status).toBe('validation_failed');
  expect(await commitWorldCandidate(world, candidate, adapter, { key: 'replacement' })).toEqual(failed);
  expect(readWorldPublication(world, 'replacement').result).toBeNull();
  const retried = await commitWorldCandidate(world, candidate, adapter, { key: 'retry' });
  expect(retried).toMatchObject({ status: 'committed', identity: failed.identity });
});

it('reads a missing world result from the durable transaction receipt at its cutoff', async () => {
  const candidate = await prepare();
  const result = await commitWorldCandidate(world, candidate, adapter, { key: 'lost-response' });
  if (result.status !== 'committed') throw new Error(result.status);
  const binding = world.domain.getStore().getJournalEvents('world')
    .find(e => e.type === 'WORLD_PUBLICATION_KEY_BOUND')!;
  expect(readWorldPublication(world, 'lost-response', binding.seq).result)
    .toMatchObject({ status: 'undetermined', identity: result.identity });
  expect(readWorldPublication(world, 'lost-response', result.receipt.commitSeq).result).toEqual(result);
});

it.each(['observe', 'mutate'])('retries %s failures ten times across reopen with the original identity', async kind => {
  const candidate = await prepare();
  for (let attempt = 0; attempt < 10; attempt++) {
    const visited: string[] = [];
    const failed = await commitWorldCandidate(world, candidate, { ...adapter, replay: async (entry, root) => {
      visited.push(entry.kind);
      if (entry.kind === kind) {
        if (kind === 'mutate') await fs.writeFile(path.join(root, 'output'), 'partial');
        throw new Error('tool offline');
      }
      return adapter.replay(entry, root);
    } }, { key: 'tool-retry' });
    expect(failed).toMatchObject({ status: 'validation_failed', reason: 'tool offline' });
    expect(visited).toEqual(kind === 'observe' ? ['observe'] : ['observe', 'mutate']);
    await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
    const events = world.domain.getStore().getJournalEvents('world');
    expect(events.filter(e => e.type === 'TX_CONFLICTED' && e.payload.txId === candidate.txId)).toEqual([]);
    expect(events.filter(e => e.type === 'TX_REPLAY_FAILED').at(-1)?.payload)
      .toMatchObject({ txId: candidate.txId, divergedAt: kind === 'observe' ? 0 : 1, error: 'tool offline' });
    const replayPath = events.filter(e => e.type === 'TX_REPLAY_STARTED').at(-1)!.payload.replayPath as string;
    await expect(fs.stat(replayPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = readWorldPublication(world, 'tool-retry');
    const root = world.state.root;
    world.close();
    world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
    expect(readWorldPublication(world, 'tool-retry', saved.atSeq)).toEqual(saved);
  }
  const failed = readWorldPublication(world, 'tool-retry').result!;
  const visited: string[] = [];
  const result = await commitWorldCandidate(world, candidate, { ...adapter, replay: async (entry, root) => {
    visited.push(entry.kind);
    return adapter.replay(entry, root);
  } }, { key: 'tool-retry' });
  expect(result).toMatchObject({ status: 'committed', identity: failed.identity });
  expect(visited).toEqual(['observe', 'mutate']);
  expect(await fs.readFile(path.join(world.state.root, 'output'), 'utf8')).toBe('original');
  expect(calls).toBe(1);
}, 60_000);

it('revalidates world changes after a retryable tool failure', async () => {
  const candidate = await prepare();
  const failed = await commitWorldCandidate(world, candidate, { ...adapter,
    replay: async () => { throw new Error('tool offline'); } });
  expect(failed.status).toBe('validation_failed');
  await fs.writeFile(path.join(world.state.root, 'input'), 'changed');
  const result = await commitWorldCandidate(world, candidate, adapter);
  expect(result).toMatchObject({ status: 'conflict', identity: failed.identity });
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  const events = world.domain.getStore().getJournalEvents('world');
  expect(await commitWorldCandidate(world, candidate, adapter)).toEqual(result);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
});


it.each([false, true])('explains publication and refresh evidence read-only across reopen changed=%s', async changed => {
  const previous = await prepare();
  if (changed) await fs.writeFile(path.join(world.state.root, 'input'), '120');
  const refresh = await refreshWorldCandidate(world, previous, adapter, agent, { onUnknown: 'reject' });
  if (refresh.result.status !== 'prepared') throw new Error(refresh.result.status);
  const candidate = refresh.result.candidate;
  const before = explainWorldPublication(world, refresh.ref);
  expect(before.publication).toBeNull();
  const result = await commitWorldCandidate(world, candidate, adapter, { key: 'explain' });
  if (result.status !== 'committed') throw new Error(result.status);
  const store = world.domain.getStore();
  const events = store.getJournalEvents('world');
  const binding = events.find(e => e.type === 'WORLD_PUBLICATION_KEY_BOUND')!;
  const pending = explainWorldPublication(world, { identity: result.identity, atSeq: binding.seq });
  expect(pending.publication).toMatchObject({ status: 'undetermined' });
  const saved = explainWorldPublication(world, { identity: result.identity, atSeq: result.receipt.commitSeq });
  expect(saved.publication).toEqual(result);
  expect(saved.preparation.refresh).toEqual(refresh);
  expect(saved.preparation.reuse?.mode).toBe(changed ? 'incremental' : 'matched');
  expect(saved.preparation.plan).toEqual(before.preparation.plan);
  const run = store.getRun(candidate.id);
  const root = world.state.root;
  await fs.writeFile(path.join(root, 'input'), 'later');
  const latest = explainWorldPublication(world, { identity: result.identity });
  expect(latest.ref.atSeq).toBe(events.at(-1)!.seq);
  for (const field of ['worldId', 'candidateId', 'txId', 'key'] as const) {
    expect(() => explainWorldPublication(world, { identity: { ...result.identity, [field]: 'forged' } }))
      .toThrow('identity mismatch');
  }
  expect(() => explainWorldPublication(world, { identity: result.identity, atSeq: -1 })).toThrow('cutoff');
  expect(() => explainWorldPublication(world, { identity: result.identity, atSeq: candidate.atSeq })).toThrow('identity mismatch');
  expect(store.getJournalEvents('world')).toEqual(events);
  expect(store.getRun(candidate.id)).toEqual(run);
  expect(await fs.readFile(path.join(root, 'input'), 'utf8')).toBe('later');
  expect(await fs.readFile(path.join(root, 'output'), 'utf8')).toBe(changed ? '120' : 'original');
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(explainWorldPublication(world, refresh.ref)).toEqual(before);
  expect(explainWorldPublication(world, { identity: result.identity, atSeq: pending.ref.atSeq })).toEqual(pending);
  expect(explainWorldPublication(world, { identity: result.identity, atSeq: saved.ref.atSeq })).toEqual(saved);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(world.domain.getStore().getRun(candidate.id)).toEqual(run);
});
