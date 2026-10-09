import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { validateWorldCandidate, readWorldCandidateValidation } from '../../src/world/validation.js';

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

it.each(['matched', 'changed', 'failed'] as const)('persists %s replay with read-only history after reopening', async status => {
  const candidate = await prepare();
  if (status === 'changed') await fs.writeFile(path.join(world.state.root, 'input'), 'new price');
  let calls = 0;
  const result = await validateWorldCandidate(world, candidate, { ...adapter, replay: async (entry, root) => {
    calls++;
    if (status === 'failed') throw new Error('tool unavailable');
    return adapter.replay(entry, root);
  } });
  expect(result.status).toBe(status);
  expect(result.previous).toEqual({ worldId: candidate.worldId, id: candidate.id, atSeq: candidate.atSeq });
  expect(calls).toBe(status === 'matched' ? 2 : 1);
  expect(result.validationSeq).not.toBeNull();
  if (status === 'changed') {
    expect(result.plan?.invalidated).toHaveLength(2);
    expect(result.plan?.explanations[1].causes[0].path).toHaveLength(2);
  } else if (status === 'failed') {
    expect(result.plan).toBeNull();
    expect(result.reasons.join()).toContain('tool unavailable');
  } else expect(result.plan?.invalidated).toEqual([]);
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  const events = world.domain.getStore().getJournalEvents('world');
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldCandidateValidation(world, result.ref)).toEqual(result);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(await fs.readFile(path.join(root, 'input'), 'utf8')).toBe(status === 'changed' ? 'new price' : 'original');
});

it('retains unknown reasons without replay, even when caller forges coverage and heads', async () => {
  const candidate = await prepare(true);
  const result = await validateWorldCandidate(world, { ...candidate, coverage: { status: 'complete',
    manifestHash: world.state.manifestHash }, heads: [] } as typeof candidate,
  { ...adapter, replay: async () => { throw new Error('must not replay'); } });
  expect(result).toMatchObject({ status: 'unknown', validationSeq: null, plan: null,
    reasons: expect.arrayContaining(['network_read']) });
  expect(readWorldCandidateValidation(world, result.ref)).toEqual(result);
});

it.each(['before', 'during'] as const)('rejects candidate output tampering %s replay', async timing => {
  const candidate = await prepare();
  const completed = world.domain.getStore().getJournalEvents('world').find(e =>
    e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id)!;
  const output = path.join(completed.payload.forkRoot as string, 'output');
  if (timing === 'before') await fs.writeFile(output, 'tampered');
  let calls = 0;
  const result = await validateWorldCandidate(world, candidate, { ...adapter, replay: async (entry, root) => {
    calls++;
    if (timing === 'during') await fs.writeFile(output, 'tampered');
    return adapter.replay(entry, root);
  } });
  expect(result).toMatchObject({ status: 'failed', reasons: ['Candidate output changed'], plan: null });
  expect(calls).toBe(timing === 'before' ? 0 : 2);
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects foreign references and adapter identity before changing history', async () => {
  const candidate = await prepare();
  const events = world.domain.getStore().getJournalEvents('world');
  await expect(validateWorldCandidate(world, { ...candidate, worldId: 'other' }, adapter)).rejects.toThrow('reference mismatch');
  await expect(validateWorldCandidate(world, candidate, { ...adapter, version: '2' })).rejects.toThrow('adapter mismatch');
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
});

it.each([null, []] as (number[] | null)[])('distinguishes untracked and empty heads: %j', async heads => {
  const prepared = await prepareWorldStep(world, { execute: async ({ version }) => ({
    coverage: { status: 'complete', manifestHash: version.manifestHash }, heads, artifacts: [],
  }) }, { task: 'empty' });
  if (prepared.status === 'failed') throw new Error(prepared.reason);
  const result = await validateWorldCandidate(world, prepared.candidate,
    { ...adapter, replay: async () => { throw new Error('must not replay'); } });
  expect(result.status).toBe(heads === null ? 'unknown' : 'matched');
  if (heads === null) expect(result.reasons).toContain('untracked_dependencies');
  else expect(result.plan).toMatchObject({ invalidated: [], unaffected: [] });
});
