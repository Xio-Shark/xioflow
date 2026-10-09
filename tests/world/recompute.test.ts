import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { validateWorldCandidate } from '../../src/world/validation.js';

import { recomputeWorldCandidate } from '../../src/world/recompute.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
const adapter = { id: 'test', version: '1', declareCoverage: async () => ({
  paths: ['input', 'output'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}), replay: async (entry: { kind: string }, root: string) => {
  const value = await fs.readFile(path.join(root, 'input'), 'utf8');
  if (entry.kind === 'mutate') await fs.writeFile(path.join(root, 'output'), value);
  return value;
} };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-validation-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'input'), 'original');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
});
afterEach(async () => { world?.close(); await fs.rm(temp, { recursive: true, force: true }); });

async function prepare(unknown = false) {
  const result = await prepareWorldStep(world, { execute: async ({ record, forkRoot, version }) => {
    const read = await record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'original' }, []);
    await fs.writeFile(path.join(forkRoot, 'output'), 'original');
    const write = await record({ kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'original' }, [read]);
    return { coverage: unknown ? { status: 'unknown', reasons: ['network_read'] }
      : { status: 'complete', manifestHash: version.manifestHash }, heads: [write], artifacts: [] };
  } }, { task: 'copy' });
  if (result.status === 'failed') throw new Error(result.reason);
  return result.candidate;
}

it('fully recomputes against a fresh version and preserves lineage after reopening', async () => {
  const previous = await prepare();
  const baseline = world.state.snapshotId;
  await fs.writeFile(path.join(world.state.root, 'input'), 'new price');
  const result = await recomputeWorldCandidate(world, previous, { execute: async (context, input) => {
    expect(input).toEqual({ task: 'copy' });
    expect(context.refresh).toBeNull();
    expect(context.version.snapshotId).not.toBe(baseline);
    const value = await fs.readFile(path.join(context.forkRoot, 'input'), 'utf8');
    const read = await context.record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: value }, []);
    await fs.writeFile(path.join(context.forkRoot, 'output'), value);
    const write = await context.record({ kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: value }, [read]);
    return { coverage: { status: 'complete', manifestHash: context.version.manifestHash }, heads: [write], artifacts: [] };
  } });
  if (result.status !== 'prepared') throw new Error(JSON.stringify(result));
  expect(world.state.snapshotId).toBe(baseline);
  expect(result.candidate.id).not.toBe(previous.id);
  expect((await validateWorldCandidate(world, result.candidate, adapter)).status).toBe('matched');
  const events = world.domain.getStore().getJournalEvents('world');
  expect(events.find(e => e.type === 'WORLD_RECOMPUTE_COMPLETED')?.payload).toMatchObject({
    previous: { worldId: previous.worldId, id: previous.id, atSeq: previous.atSeq }, mode: 'full', result,
  });
  const root = world.state.root;
  await expect(fs.stat(path.join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(world.state.snapshotId).toBe(baseline);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect((await validateWorldCandidate(world, result.candidate, adapter)).status).toBe('matched');
  await fs.writeFile(path.join(root, 'input'), 'changed again');
  expect((await validateWorldCandidate(world, result.candidate, adapter)).status).toBe('changed');
});

it.each([true, false])('requires fresh dependency coverage when recomputing unknown: %s', async complete => {
  const previous = await prepare(true);
  const result = await recomputeWorldCandidate(world, previous, { execute: async ({ version }) => ({
    coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: complete ? [] : null, artifacts: [],
  }) });
  expect(result.status).toBe(complete ? 'prepared' : 'unknown');
});

it.each(['symlink', 'ignored', 'exception'])('records %s failure without publishing', async failure => {
  const previous = await prepare();
  if (failure === 'symlink') {
    await fs.unlink(path.join(world.state.root, 'input'));
    await fs.symlink('output', path.join(world.state.root, 'input'));
  }
  if (failure === 'ignored') await fs.writeFile(path.join(world.state.root, '.gitignore'), 'input\n');
  let calls = 0;
  const result = await recomputeWorldCandidate(world, previous, { execute: async () => {
    calls++;
    throw new Error('model unavailable');
  } });
  expect(result.status).toBe('failed');
  expect(calls).toBe(failure === 'exception' ? 1 : 0);
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(world.domain.getStore().getJournalEvents('world').some(e =>
    e.type === (failure === 'exception' ? 'WORLD_RECOMPUTE_COMPLETED' : 'WORLD_RECOMPUTE_FAILED'))).toBe(true);
});

it('rejects foreign candidate references without calling the agent or changing history', async () => {
  const previous = await prepare();
  const events = world.domain.getStore().getJournalEvents('world');
  await expect(recomputeWorldCandidate(world, { ...previous, worldId: 'foreign' }, {
    execute: async () => { throw new Error('must not call'); },
  })).rejects.toThrow('reference mismatch');
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
});
