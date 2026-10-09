import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readWorldArtifacts } from '../../src/world/artifacts.js';
import { explainWorldPreparation } from '../../src/world/explain.js';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { refreshWorldCandidate, readWorldRefresh } from '../../src/world/refresh.js';
import { validateWorldCandidate, readWorldCandidateValidation } from '../../src/world/validation.js';
import type { WorldAgent } from '../../src/world/contract.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
let calls: number;
let unknown: boolean;
const adapter = { id: 'test', version: '1', declareCoverage: async () => ({
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
  expect(refresh).toBeNull();
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

it('recomputes the probed version when the main directory changes during validation', async () => {
  const previous = await prepare();
  await fs.writeFile(path.join(world.state.root, 'input'), 'probed price');
  const report = await refreshWorldCandidate(world, previous, { ...adapter, replay: async (entry, root) => {
    await fs.writeFile(path.join(world.state.root, 'input'), 'later price');
    return adapter.replay(entry, root);
  } }, agent, { onUnknown: 'reject' });
  if (report.result.status !== 'prepared') throw new Error(JSON.stringify(report));
  const candidate = report.result.candidate;
  expect(candidate.version).toEqual(readWorldCandidateValidation(world, report.validation!).version);
  const events = world.domain.getStore().getJournalEvents('world');
  expect(events.filter(e => e.type === 'WORLD_VERSION_CREATED')).toHaveLength(1);
  const completed = events.find(e => e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id)!;
  expect(await fs.readFile(path.join(completed.payload.forkRoot as string, 'output'), 'utf8')).toBe('probed price');
  expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe('later price');
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await validateWorldCandidate(world, candidate, adapter)).status).toBe('changed');
});

it.each([false, true])('refreshes changed=%s and preserves exact read-only history after reopening', async changed => {
  const previous = await prepare();
  if (changed) await fs.writeFile(path.join(world.state.root, 'input'), 'new price');
  const report = await refreshWorldCandidate(world, { ...previous, heads: [] } as typeof previous,
    adapter, agent, { onUnknown: 'reject' });
  expect(report.strategy).toBe(changed ? 'full' : 'reuse');
  expect(calls).toBe(changed ? 2 : 1);
  if (report.result.status !== 'prepared') throw new Error(JSON.stringify(report));
  const candidate = report.result.candidate;
  expect(candidate.id).not.toBe(previous.id);
  expect(candidate.heads).not.toEqual([]);
  const completed = world.domain.getStore().getJournalEvents('world').find(e =>
    e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id)!;
  expect(await fs.readFile(path.join(completed.payload.forkRoot as string, 'output'), 'utf8'))
    .toBe(changed ? 'new price' : 'original');
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  const events = world.domain.getStore().getJournalEvents('world');
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldRefresh(world, report.ref)).toEqual(report);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(calls).toBe(changed ? 2 : 1);
  await fs.writeFile(path.join(root, 'input'), 'changed again');
  expect((await validateWorldCandidate(world, candidate, adapter)).status).toBe('changed');
});

it.each(['reject', 'recompute'] as const)('handles unknown with %s without replaying unknown evidence', async onUnknown => {
  unknown = true;
  const previous = await prepare();
  unknown = false;
  const report = await refreshWorldCandidate(world, previous,
    { ...adapter, replay: async () => { throw new Error('must not replay'); } }, agent, { onUnknown });
  expect(report.strategy).toBe(onUnknown === 'reject' ? 'reject' : 'full');
  expect(report.result.status).toBe(onUnknown === 'reject' ? 'unknown' : 'prepared');
  expect(calls).toBe(onUnknown === 'reject' ? 1 : 2);
});

it('keeps missing evidence unknown after full recomputation', async () => {
  unknown = true;
  const report = await refreshWorldCandidate(world, await prepare(), adapter, agent, { onUnknown: 'recompute' });
  expect(report).toMatchObject({ strategy: 'full', result: { status: 'unknown', reasons: expect.arrayContaining(['network_read']) } });
  expect(calls).toBe(2);
});

it.each(['tool', 'output', 'agent'] as const)('persists %s failure without publication or implicit retry', async failure => {
  const previous = await prepare();
  if (failure === 'output') {
    const completed = world.domain.getStore().getJournalEvents('world').find(e => e.type === 'WORLD_STEP_COMPLETED')!;
    await fs.writeFile(path.join(completed.payload.forkRoot as string, 'output'), 'tampered');
  }
  if (failure === 'agent') await fs.writeFile(path.join(world.state.root, 'input'), 'changed');
  const report = await refreshWorldCandidate(world, previous,
    failure === 'tool' ? { ...adapter, replay: async () => { throw new Error('tool offline'); } } : adapter,
    { execute: async () => { calls++; throw new Error('agent offline'); } }, { onUnknown: 'recompute' });
  expect(report.result.status).toBe('failed');
  expect(calls).toBe(failure === 'agent' ? 2 : 1);
  expect(readWorldRefresh(world, report.ref)).toEqual(report);
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects foreign references and adapter identity before recording a refresh', async () => {
  const previous = await prepare();
  const events = world.domain.getStore().getJournalEvents('world');
  await expect(refreshWorldCandidate(world, { ...previous, worldId: 'foreign' }, adapter, agent,
    { onUnknown: 'reject' })).rejects.toThrow('reference mismatch');
  await expect(refreshWorldCandidate(world, previous, { ...adapter, version: '2' }, agent,
    { onUnknown: 'reject' })).rejects.toThrow('adapter mismatch');
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(calls).toBe(1);
});

it('blocks recomputation when an independent tool fails after a changed observation', async () => {
  const prepared = await prepareWorldStep(world, { execute: async ({ record, version }) => {
    const a = await record({ kind: 'observe', call: { tool: 'a', args: {} }, resultHash: 'old' }, []);
    const b = await record({ kind: 'observe', call: { tool: 'b', args: {} }, resultHash: 'old' }, []);
    const join = await record({ kind: 'observe', call: { tool: 'join', args: {} }, resultHash: 'old' }, [a, b]);
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [join], artifacts: [] };
  } }, { task: 'copy' });
  if (prepared.status !== 'prepared') throw new Error('Preparation failed');
  const report = await refreshWorldCandidate(world, prepared.candidate, { ...adapter, replay: async entry => {
    if (entry.call.tool === 'b') throw new Error('later tool failed');
    return 'changed';
  } }, agent, { onUnknown: 'recompute' });
  expect(report).toMatchObject({ strategy: 'failed', result: { status: 'failed', reason: 'later tool failed' } });
  expect(calls).toBe(0);
  expect(readWorldRefresh(world, report.ref)).toEqual(report);
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([false, true])('explains changed=%s from a frozen cutoff without replay or budget changes', async changed => {
  const previous = await prepare();
  if (changed) await fs.writeFile(path.join(world.state.root, 'input'), 'new price');
  const report = await refreshWorldCandidate(world, previous, adapter, agent, { onUnknown: 'reject' });
  const explanation = explainWorldPreparation(world, report.ref);
  expect(explanation.refresh).toEqual(report);
  expect(explanation.validation?.previous).toEqual({ worldId: previous.worldId, id: previous.id, atSeq: previous.atSeq });
  expect(explanation.plan?.invalidated.length).toBe(changed ? 2 : 0);
  if (changed) {
    const nodes = explanation.plan!.invalidated;
    expect(explanation.plan!.explanations).toContainEqual({ nodeSeq: nodes[1].seq,
      causes: [{ changedSeq: nodes[0].seq, path: [nodes[0].seq, nodes[1].seq] }] });
    expect(explanation.candidate.id).not.toBe(previous.id);
  }
  expect(explainWorldPreparation(world, previous).plan).toBeNull();
  expect(explainWorldPreparation(world, report.validation!).plan).toEqual(explanation.plan);
  await fs.writeFile(path.join(world.state.root, 'input'), 'later change');
  await prepare(); // Later independent history must not enter this explanation.
  const events = world.domain.getStore().getJournalEvents('world');
  const run = world.domain.getStore().getRun(previous.id);
  const callCount = calls;
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(explainWorldPreparation(world, report.ref)).toEqual(explanation);
  const copy = explainWorldPreparation(world, report.ref);
  copy.plan!.invalidated.length = 0;
  expect(explainWorldPreparation(world, report.ref)).toEqual(explanation);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(world.domain.getStore().getRun(previous.id)).toEqual(run);
  expect(calls).toBe(callCount);
  expect(await fs.readFile(path.join(root, 'input'), 'utf8')).toBe('later change');
  await expect(fs.stat(path.join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('explains unknown and validation failure without inventing a plan or a successful result', async () => {
  unknown = true;
  const previous = await prepare();
  const rejected = await refreshWorldCandidate(world, previous, adapter, agent, { onUnknown: 'reject' });
  expect(explainWorldPreparation(world, rejected.ref)).toMatchObject({ plan: null,
    coverage: { status: 'unknown' }, refresh: { strategy: 'reject' }, validation: { status: 'unknown' } });
  unknown = false;
  const tracked = await prepare();
  const failed = await refreshWorldCandidate(world, tracked,
    { ...adapter, replay: async () => { throw new Error('offline'); } }, agent, { onUnknown: 'recompute' });
  expect(explainWorldPreparation(world, failed.ref)).toMatchObject({ candidate: tracked, plan: null,
    validation: { status: 'failed', reasons: ['offline'] }, refresh: { result: { status: 'failed' } } });
});

it('rejects foreign, mismatched and unfinished explanation references without advancing history', async () => {
  const candidate = await prepare();
  const events = world.domain.getStore().getJournalEvents('world');
  const started = events.find(event => event.type === 'WORLD_STEP_STARTED')!;
  for (const ref of [{ ...candidate, worldId: 'foreign' }, { ...candidate, id: 'other' },
    { ...candidate, atSeq: started.seq }, { ...candidate, atSeq: 999999 }]) {
    expect(() => explainWorldPreparation(world, ref)).toThrow();
  }
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  world.close();
  expect(() => explainWorldPreparation(world, candidate)).toThrow('World is closed');
});

it('rebases matched artifacts and dependencies onto the fixed version without model calls', async () => {
  const body = 'saved model response';
  const initial = await prepareWorldStep(world, { execute: async (context, input) => {
    const execution = await agent.execute(context, input);
    return { ...execution, artifacts: [{ id: 'response', kind: 'model_response', body,
      hash: createHash('sha256').update(body).digest('hex'), dependsOn: execution.heads }] };
  } }, { task: 'copy' });
  if (initial.status !== 'prepared') throw new Error('Preparation failed');
  const previous = initial.candidate;
  await fs.writeFile(path.join(world.state.root, 'unrelated'), 'new covered file');
  const report = await refreshWorldCandidate(world, previous, { ...adapter, replay: async (entry, root) => {
    // A later world change cannot replace the version captured by this probe.
    await fs.writeFile(path.join(world.state.root, 'unrelated'), 'later change');
    return adapter.replay(entry, root);
  } }, agent, { onUnknown: 'reject' });
  expect(report.strategy).toBe('reuse');
  if (report.result.status !== 'prepared') throw new Error(JSON.stringify(report));
  const candidate = report.result.candidate;
  expect(candidate.version).toEqual(readWorldCandidateValidation(world, report.validation!).version);
  expect(candidate.version.fingerprint).not.toBe(previous.version.fingerprint);
  expect(candidate.id).not.toBe(previous.id);
  expect(candidate.heads).not.toEqual(previous.heads);
  expect(readWorldArtifacts(world, candidate)).toEqual([{ id: 'response', kind: 'model_response', body,
    hash: createHash('sha256').update(body).digest('hex'), dependsOn: candidate.heads }]);
  const events = world.domain.getStore().getJournalEvents('world');
  const completed = events.find(e => e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id)!;
  expect(await fs.readFile(path.join(completed.payload.forkRoot as string, 'unrelated'), 'utf8')).toBe('new covered file');
  expect(await fs.readFile(path.join(completed.payload.forkRoot as string, 'output'), 'utf8')).toBe('original');
  expect(events.find(e => e.type === 'WORLD_REUSE_PREPARED')?.payload).toMatchObject({ previous: {
    worldId: previous.worldId, id: previous.id, atSeq: previous.atSeq }, replacements: expect.any(Array) });
  expect(calls).toBe(1);
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldArtifacts(world, candidate)[0].body).toBe(body);
  expect(readWorldRefresh(world, report.ref)).toEqual(report);
  expect((await validateWorldCandidate(world, candidate, adapter)).status).toBe('matched');
  const repeated = await refreshWorldCandidate(world, candidate, adapter, agent, { onUnknown: 'reject' });
  if (repeated.result.status !== 'prepared') throw new Error(JSON.stringify(repeated));
  expect(repeated.strategy).toBe('reuse');
  expect(repeated.result.candidate.id).not.toBe(candidate.id);
  expect(readWorldArtifacts(world, repeated.result.candidate)).toEqual([{
    id: 'response', kind: 'model_response', body,
    hash: createHash('sha256').update(body).digest('hex'), dependsOn: repeated.result.candidate.heads,
  }]);
  expect(readWorldRefresh(world, report.ref)).toEqual(report);
  expect(calls).toBe(1);
});

it('reuses explicitly empty dependencies without replay or model execution', async () => {
  const body = 'constant response';
  const initial = await prepareWorldStep(world, { execute: async ({ version }) => ({
    coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [],
    artifacts: [{ id: 'constant', kind: 'model_response', body,
      hash: createHash('sha256').update(body).digest('hex'), dependsOn: [] }],
  }) }, { task: 'constant' });
  if (initial.status !== 'prepared') throw new Error(JSON.stringify(initial));
  await fs.writeFile(path.join(world.state.root, 'input'), 'changed unrelated input');
  const report = await refreshWorldCandidate(world, initial.candidate,
    { ...adapter, replay: async () => { throw new Error('Empty history must not replay'); } },
    { execute: async () => { throw new Error('Constant response must not recompute'); } },
    { onUnknown: 'reject' });
  expect(report.strategy).toBe('reuse');
  if (report.result.status !== 'prepared') throw new Error(JSON.stringify(report));
  expect(report.result.candidate.heads).toEqual([]);
  expect(report.result.candidate.version.fingerprint).not.toBe(initial.candidate.version.fingerprint);
  expect(readWorldArtifacts(world, report.result.candidate)).toEqual(readWorldArtifacts(world, initial.candidate));
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['mismatch', 'exception', 'source_tampered'] as const)('rejects %s during matched materialization without model fallback', async failure => {
  const previous = await prepare();
  const original = world.domain.getStore().getJournalEvents('world').find(e => e.type === 'WORLD_STEP_COMPLETED')!;
  const materialized: string[] = [];
  const report = await refreshWorldCandidate(world, previous, { ...adapter, replay: async (entry, root) => {
    const materializing = world.domain.getStore().getJournalEvents('world')
      .filter(e => e.type === 'WORLD_STEP_STARTED').length === 2;
    if (materializing) {
      materialized.push(entry.kind);
      if (failure === 'exception') throw new Error('reuse tool offline');
      if (failure === 'mismatch') return 'wrong hash';
      await fs.writeFile(path.join(original.payload.forkRoot as string, 'output'), 'tampered');
    }
    return adapter.replay(entry, root);
  } }, agent, { onUnknown: 'recompute' });
  expect(report.result.status).toBe('failed');
  expect(materialized).toEqual(failure === 'source_tampered' ? ['observe', 'mutate'] : ['observe']);
  expect(readWorldCandidateValidation(world, report.validation!).status).toBe('matched');
  expect(calls).toBe(1);
  expect(world.domain.getStore().getJournalEvents('world').some(e => e.type === 'WORLD_REUSE_FAILED')).toBe(true);
  expect(readWorldRefresh(world, report.ref)).toEqual(report);
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
