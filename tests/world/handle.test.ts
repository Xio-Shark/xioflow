import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWorld } from '../../src/world/handle.js';
import * as closure from '../../src/world/close.js';
import type { FileWorldAdapter, WorldAgent, WorldCandidate } from '../../src/world/contract.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorld>>;
const adapter: FileWorldAdapter = { id: 'handle', version: '1',
  declareCoverage: async () => ({ paths: ['input'], excluded: [], symlinks: 'reject',
    externalReads: 'unsupported', externalWrites: 'unsupported' }),
  replay: async () => undefined, accept: async () => true,
};
const agent: WorldAgent = { execute: async context => ({
  coverage: { status: 'complete', manifestHash: context.version.manifestHash }, heads: [], artifacts: [],
}) };
const options = () => ({ root: path.join(temp, 'repo'), statePath: path.join(temp, 'state'), adapter });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-handle-'));
  await fs.mkdir(options().root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: options().root });
  await fs.writeFile(path.join(options().root, 'input'), 'original');
  world = await openWorld(options());
});
afterEach(async () => { vi.restoreAllMocks(); await world?.close(); await fs.rm(temp, { recursive: true, force: true }); });

it('drains accepted work, rejects all new operations, and deduplicates close', async () => {
  const entered = deferred();
  const release = deferred();
  const running = world.runAgentStep({ execute: async context => {
    entered.resolve();
    await release.promise;
    return agent.execute(context, { task: 'held' });
  } }, { task: 'held' });
  await entered.promise;
  let closed = false;
  const closing = world.close().then(result => { closed = true; return result; });
  const duplicate = world.close();
  const ref = { worldId: world.worldId, id: 'unused', atSeq: 0 };
  try {
    await expect(world.runAgentStep(agent, { task: 'late' })).rejects.toThrow('closing');
    await expect(world.refresh(ref as WorldCandidate, { onUnknown: 'reject' })).rejects.toThrow('closing');
    await expect(world.explain(ref)).rejects.toThrow('closing');
    await expect(world.commit(ref as WorldCandidate, { validation: 'strict', key: 'late' })).rejects.toThrow('closing');
    expect(closed).toBe(false);
  } finally { release.resolve(); }
  expect((await running).status).toBe('prepared');
  const report = await closing;
  expect(report.status).toBe('closed');
  expect(await duplicate).toEqual(report);
  expect(await world.close()).toEqual(report);
  expect(report.resources.some(r => r.kind === 'fork' && r.status === 'reclaimed')).toBe(true);
  expect(await fs.readFile(path.join(options().root, 'input'), 'utf8')).toBe('original');
});

it('composes refresh and strict commit, drains immediately accepted publication, and reopens frozen evidence', async () => {
  const result = await world.runAgentStep(agent, { task: 'stable' });
  if (result.status !== 'prepared') throw new Error('preparation failed');
  const refreshed = await world.refresh(result.candidate, { onUnknown: 'recompute' });
  if (refreshed.status !== 'prepared') throw new Error('refresh failed');
  const committed = await world.commit(refreshed.candidate, { validation: 'strict', key: 'stable' });
  expect(committed.status).toBe('committed');
  const explanation = await world.explain({ identity: committed.identity });
  expect(explanation.publication).toEqual(committed);
  expect(explanation.coverage).toEqual(refreshed.candidate.coverage);
  expect(explanation.plan).toEqual(explanation.preparation.plan);
  if (committed.status === 'committed') expect(committed.receipt.validation).toBe('observations');
  const retry = world.commit(refreshed.candidate, { validation: 'strict', key: 'stable' });
  await world.close();
  expect(await retry).toEqual(committed);
  world = await openWorld(options());
  expect(await world.explain({ identity: committed.identity, atSeq: explanation.ref.atSeq })).toEqual(explanation);
  expect(await world.commit(refreshed.candidate, { validation: 'strict', key: 'stable' })).toEqual(committed);
});

it('waits for a failing agent and still closes after an accepted operation rejects', async () => {
  const failing = world.runAgentStep({ execute: async () => { throw new Error('agent failed'); } }, { task: 'fail' });
  const invalid = world.explain({ worldId: world.worldId, id: 'missing', atSeq: 0 });
  const rejection = expect(invalid).rejects.toThrow('reference mismatch');
  const closing = world.close();
  expect(await failing).toMatchObject({ status: 'failed', reason: expect.stringContaining('agent failed') });
  await rejection;
  expect((await closing).status).toBe('closed');
});


it('keeps admission closed when finalization fails and allows retrying close', async () => {
  const fail = vi.spyOn(closure, 'closeWorldResources').mockRejectedValueOnce(new Error('journal unavailable'));
  await expect(world.close()).rejects.toThrow('journal unavailable');
  await expect(world.runAgentStep(agent, { task: 'late' })).rejects.toThrow('closing');
  expect((await world.close()).status).toBe('closed');
  expect(fail).toHaveBeenCalledTimes(2);
});

it('carries the agent across refreshes and fails new inference honestly after reopening', async () => {
  const execute = vi.fn<WorldAgent['execute']>(async () => ({
    coverage: { status: 'unknown', reasons: ['missing evidence'] }, heads: null, artifacts: [],
  }));
  const first = await world.runAgentStep({ execute }, { task: 'unknown' });
  if (first.status !== 'unknown') throw new Error('expected unknown');
  const second = await world.refresh(first.candidate, { onUnknown: 'recompute' });
  if (second.status !== 'unknown') throw new Error('expected unknown refresh');
  const third = await world.refresh(second.candidate, { onUnknown: 'recompute' });
  if (third.status !== 'unknown') throw new Error('expected unknown second refresh');
  expect(execute).toHaveBeenCalledTimes(3);
  await world.close();
  world = await openWorld(options());
  expect(await world.refresh(third.candidate, { onUnknown: 'reject' })).toMatchObject({ status: 'unknown' });
  expect(await world.refresh(third.candidate, { onUnknown: 'recompute' })).toMatchObject({
    status: 'failed', reason: expect.stringContaining('not attached'),
  });
  expect(execute).toHaveBeenCalledTimes(3);
});


it('rejects publication of abandoned candidates after reopening', async () => {
  const result = await world.runAgentStep(agent, { task: 'abandon' });
  if (result.status !== 'prepared') throw new Error('preparation failed');
  const explanation = await world.explain(result.candidate);
  await world.close();
  world = await openWorld(options());
  expect(await world.explain(result.candidate)).toEqual(explanation);
  expect(await world.commit(result.candidate, { validation: 'strict', key: 'late' }))
    .toMatchObject({ status: 'rejected', reason: 'candidate_abandoned' });
  expect(await fs.readFile(path.join(options().root, 'input'), 'utf8')).toBe('original');
});

it('explains failed agent execution at a frozen cutoff after later work and reopening', async () => {
  const failed = await world.runAgentStep({ execute: async context => {
    await fs.writeFile(path.join(context.forkRoot, 'input'), 'isolated failure');
    throw new Error('inference unavailable');
  } }, { task: 'fail' });
  if (failed.status !== 'failed') throw new Error('expected failure');
  const explanation = await world.explain(failed.ref);
  expect(explanation).toMatchObject({ ref: failed.ref,
    failure: { ref: failed.ref, stage: 'step', reason: failed.reason },
    coverage: { status: 'unknown', reasons: ['preparation_failed'] }, plan: null,
    preparation: { candidate: null, coverage: { status: 'unknown' }, plan: null },
    publication: null, bindings: [],
  });
  expect(explanation.resources.some(r => r.kind === 'fork' && r.status === 'retained')).toBe(true);
  await world.runAgentStep(agent, { task: 'later' });
  expect(await world.explain(failed.ref)).toEqual(explanation);
  await expect(world.explain({ ...failed.ref, worldId: 'forged' })).rejects.toThrow('reference mismatch');
  await expect(world.explain({ ...failed.ref, atSeq: failed.ref.atSeq - 1 })).rejects.toThrow('reference mismatch');
  await world.close();
  world = await openWorld(options());
  expect(await world.explain(failed.ref)).toEqual(explanation);
  expect(await fs.readFile(path.join(options().root, 'input'), 'utf8')).toBe('original');
});

it('explains refresh tool failure without reporting a change or reading beyond the failure cutoff', async () => {
  const prepared = await world.runAgentStep({ execute: async context => {
    const seq = await context.record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'original' }, []);
    return { coverage: { status: 'complete', manifestHash: context.version.manifestHash }, heads: [seq], artifacts: [] };
  } }, { task: 'read' });
  if (prepared.status !== 'prepared') throw new Error('expected preparation');
  const replay = vi.spyOn(adapter, 'replay').mockRejectedValue(new Error('tool offline'));
  const failed = await world.refresh(prepared.candidate, { onUnknown: 'reject' });
  if (failed.status !== 'failed') throw new Error('expected failure');
  const calls = replay.mock.calls.length;
  const explanation = await world.explain(failed.ref);
  expect(explanation).toMatchObject({ failure: { stage: 'refresh', reason: failed.reason },
    preparation: { candidate: prepared.candidate, plan: null, validation: { status: 'failed' }, refresh: null },
    publication: null, bindings: [],
  });
  expect(replay).toHaveBeenCalledTimes(calls);
  await world.close();
  world = await openWorld(options());
  expect(await world.explain(failed.ref)).toEqual(explanation);
  expect(replay).toHaveBeenCalledTimes(calls);
});
