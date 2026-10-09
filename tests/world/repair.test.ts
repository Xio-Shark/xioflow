import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { validateWorldCandidate } from '../../src/world/validation.js';
import { prepareWorldRepair } from '../../src/world/repair.js';
import type { ObservationEntry } from '../../src/workspace/transactions.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
const adapter = { id: 'test', version: '1', declareCoverage: async () => ({
  paths: ['a', 'b', 'out-a', 'out-b'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}), replay: async (entry: ObservationEntry, root: string) => {
  const key = entry.call.args.key as string;
  const value = await fs.readFile(path.join(root, key), 'utf8');
  if (entry.kind === 'mutate') await fs.writeFile(path.join(root, `out-${key}`), value);
  return value;
} };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-repair-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'a'), 'old-a');
  await fs.writeFile(path.join(root, 'b'), 'stable-b');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
});
afterEach(async () => { world?.close(); await fs.rm(temp, { recursive: true, force: true }); });
async function fixture() {
  const prepared = await prepareWorldStep(world, { execute: async ({ record, forkRoot, version }) => {
    const heads: number[] = [];
    for (const key of ['a', 'b']) {
      const observation = { kind: 'observe' as const, call: { tool: 'read', args: { key } } };
      const value = await adapter.replay(observation, forkRoot);
      const read = await record({ ...observation, resultHash: value }, []);
      const mutation = { kind: 'mutate' as const, call: { tool: 'copy', args: { key } } };
      await adapter.replay(mutation, forkRoot);
      heads.push(await record({ ...mutation, resultHash: value }, [read]));
    }
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads, artifacts: [] };
  } }, { task: 'copy both' });
  if (prepared.status !== 'prepared') throw new Error(JSON.stringify(prepared));
  await fs.writeFile(path.join(world.state.root, 'a'), 'new-a');
  const probe = await validateWorldCandidate(world, prepared.candidate, adapter, 'selected_nodes');
  expect(probe.status).toBe('changed');
  return { candidate: prepared.candidate, probe };
}

it('materializes reusable writes and recomputes only invalidated nodes on the durable version after reopening', async () => {
  const { probe } = await fixture();
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  await fs.writeFile(path.join(root, 'a'), 'later-a');
  const executed: number[] = [];
  const result = await prepareWorldRepair(world, probe.ref, adapter, async (source, tx, dependencies) => {
    executed.push(source.seq);
    expect(await fs.readFile(path.join(tx.forkRoot, 'out-b'), 'utf8')).toBe('stable-b');
    if (source.observation.kind === 'mutate') expect(dependencies[0].observation.resultHash).toBe('new-a');
    return { actorId: 'repair', observation: { ...source.observation,
      resultHash: await adapter.replay(source.observation, tx.forkRoot) } };
  });
  expect(executed).toEqual(probe.plan!.invalidated.map(n => n.seq));
  expect(result.repair.reused.map(n => n.seq)).toEqual(probe.plan!.unaffected.map(n => n.seq));
  expect(result.version).toEqual(probe.version);
  expect(await fs.readFile(path.join(result.repair.transaction.forkRoot, 'out-a'), 'utf8')).toBe('new-a');
  expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('later-a');
  await expect(fs.stat(path.join(root, 'out-a'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(world.domain.getStore().getJournalEvent('world', result.ref.atSeq)?.type).toBe('WORLD_REPAIR_PREPARED');
});

it.each(['mismatch', 'exception', 'source_tampered', 'final_coverage'] as const)('aborts %s without publishing and retains the validation baseline', async failure => {
  const { candidate, probe } = await fixture();
  if (failure === 'source_tampered') {
    const completed = world.domain.getStore().getJournalEvents('world').find(e => e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id)!;
    await fs.writeFile(path.join(completed.payload.forkRoot as string, 'out-b'), 'tampered');
  }
  let calls = 0;
  await expect(prepareWorldRepair(world, probe.ref, { ...adapter, replay: async (entry, root) => {
    if (failure === 'exception') throw new Error('tool offline');
    if (failure === 'mismatch') return 'different';
    return adapter.replay(entry, root);
  } }, async (source, tx) => {
    calls++;
    await fs.mkdir(path.join(tx.forkRoot, 'out-a'), { recursive: true });
    return { actorId: 'repair', observation: source.observation };
  })).rejects.toThrow(failure === 'exception' ? 'tool offline' : failure === 'mismatch' ? 'Reuse validation failed' : /output|regular files/i);
  expect(calls).toBe(failure === 'final_coverage' ? 2 : 0);
  const events = world.domain.getStore().getJournalEvents('world');
  expect(events.some(e => e.type === 'WORLD_REPAIR_PREPARED')).toBe(false);
  expect(events.at(-1)?.type).toBe('WORLD_REPAIR_FAILED');
  const txId = events.at(-1)!.payload.txId;
  if (failure !== 'source_tampered') expect(events.some(e => e.type === 'TX_ABORTED' && e.payload.txId === txId)).toBe(true);
  expect(world.domain.getStore().getSnapshot(probe.version!.snapshotId)).toBeDefined();
  await expect(fs.stat(path.join(world.state.root, 'out-b'))).rejects.toMatchObject({ code: 'ENOENT' });
});
