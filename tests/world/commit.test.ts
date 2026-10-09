import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { commitWorldCandidate } from '../../src/world/commit.js';
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
