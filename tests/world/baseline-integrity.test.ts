import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { captureWorldRevision, openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { validateWorldCandidate } from '../../src/world/validation.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
const adapter = { id: 'integrity', version: '1', declareCoverage: async () => ({
  paths: ['input'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}) };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-integrity-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'input'), 'original');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
});
afterEach(async () => { world?.close(); await fs.rm(temp, { recursive: true, force: true }); });

it.each(['initial', 'revision'] as const)('rejects an altered %s baseline before invoking the agent', async kind => {
  if (kind === 'revision') world = await captureWorldRevision(world);
  const snapshotId = world.state.snapshotId;
  await fs.writeFile(path.join(world.state.root, 'input'), 'replacement');
  const other = await captureWorldRevision(world);
  const commit = world.domain.getStore().getSnapshot(other.state.snapshotId)!.commitHash!;
  await exec('git', ['update-ref', `refs/xioflow/snapshots/${snapshotId}`, commit], { cwd: world.state.root });
  let calls = 0;
  const result = await prepareWorldStep(world, { execute: async () => {
    calls++;
    throw new Error('must not execute');
  } }, { task: 'read' });
  expect(result).toMatchObject({ status: 'failed', reason: 'World baseline commit identity mismatch' });
  expect(calls).toBe(0);
  expect(world.domain.getStore().getJournalEvents('world').some(e => e.type === 'WORLD_STEP_PREPARED')).toBe(false);
  expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe('replacement');
});

it.each(['before', 'during'] as const)('rejects lost candidate baseline %s replay without reporting a change', async when => {
  const result = await prepareWorldStep(world, { execute: async ({ record, version }) => {
    const seq = await record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'original' }, []);
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [seq], artifacts: [] };
  } }, { task: 'read' });
  if (result.status !== 'prepared') throw new Error(JSON.stringify(result));
  const remove = () => exec('git', ['update-ref', '-d', `refs/xioflow/snapshots/${world.state.snapshotId}`],
    { cwd: world.state.root });
  if (when === 'before') await remove();
  let calls = 0;
  const validation = await validateWorldCandidate(world, result.candidate, { ...adapter, replay: async () => {
    calls++;
    await remove();
    return 'original';
  } });
  expect(validation.status).toBe('failed');
  expect(validation.plan).toBeNull();
  expect(calls).toBe(when === 'before' ? 0 : 1);
});

it('does not prepare a candidate when its baseline disappears during execution', async () => {
  const result = await prepareWorldStep(world, { execute: async ({ version }) => {
    await exec('git', ['update-ref', '-d', `refs/xioflow/snapshots/${version.snapshotId}`], { cwd: world.state.root });
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [], artifacts: [] };
  } }, { task: 'read' });
  expect(result.status).toBe('failed');
  expect(world.domain.getStore().getJournalEvents('world').some(e => e.type === 'WORLD_STEP_PREPARED')).toBe(false);
});
