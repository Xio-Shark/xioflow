import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeWorldResources, readWorldClose } from '../../src/world/close.js';
import { openWorldState } from '../../src/world/state.js';
import { explainWorldResources } from '../../src/world/resources.js';
import { executeWorldStep } from '../../src/world/step.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { cleanupAgentCausalFork, listAgentCausalForkCleanups, planAgentCausalResourceCleanup } from '../../src/agents/workspace-resources.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
const adapter = { id: 'test', version: '1', declareCoverage: async () => ({
  paths: ['input'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}) };
const plan = (options = {}) => planAgentCausalResourceCleanup(world.domain, options);
const record = (type: string, id: string) => world.domain.getStore().recordJournalEvent({
  domainId: 'world', runId: 'owner', type, timestamp: new Date().toISOString(),
  payload: { worldId: world.state.worldId, id, txId: id },
});
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-resources-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'input'), 'original');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  const store = world.domain.getStore();
  store.saveTask({ id: 'task', domainId: 'world', name: 'test', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'owner', taskId: 'task', domainId: 'world', owner: 'test', status: 'running', startedAt: new Date().toISOString() });
});
afterEach(async () => { vi.restoreAllMocks(); world?.close(); await fs.rm(temp, { recursive: true, force: true }); });

it('protects actual world execution and completed candidates through the existing planner', async () => {
  const result = await executeWorldStep(world, null, async () => {
    expect(plan().resources[0]).toMatchObject({ state: 'open', fork: { disposition: 'retain' } });
    return { checkpoint: null, causalHeads: [] };
  });
  expect(result.status).toBe('executed');
  const before = world.domain.getStore().getJournalEvents('world');
  const frozen = plan();
  expect(frozen.resources).toHaveLength(1);
  expect(frozen.resources[0]).toMatchObject({ txId: result.txId, state: 'open',
    reasons: expect.arrayContaining(['current_checkpoint', 'pending_publication']) });
  await expect(cleanupAgentCausalFork(new ProcessSupervisor(world.domain), {
    txId: result.txId, atSeq: frozen.atSeq,
  })).rejects.toThrow('retained');
  expect(plan({ runId: 'other' }).resources).toEqual([]);
  expect(plan({ planSeq: frozen.atSeq }).resources).toEqual([]);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(before);
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  record('LATER', 'other');
  expect(plan({ atSeq: frozen.atSeq })).toEqual(frozen);
  expect(await fs.readFile(path.join(root, 'input'), 'utf8')).toBe('original');
});

it.each(['STEP', 'REPAIR'])('tracks interrupted %s allocation and reclaims a failed unreferenced fork', async kind => {
  const id = 'interrupted';
  const started = record(`WORLD_${kind}_STARTED`, id);
  expect(plan().resources[0]).toMatchObject({ txId: id, state: 'reserved', preparationSeqs: [started],
    reasons: ['pending_publication'] });
  const supervisor = new ProcessSupervisor(world.domain);
  const tx = await supervisor.beginWorkspaceTransaction({ txId: id, runId: 'owner', root: world.state.root,
    baseSnapshotId: world.state.snapshotId, forkPath: path.join(temp, 'fork') });
  const live = plan();
  record(`WORLD_${kind}_FAILED`, id);
  expect(plan({ atSeq: live.atSeq })).toEqual(live);
  expect(plan({ runId: 'owner' }).resources[0].fork?.disposition).toBe('review');
  const fail = vi.spyOn(supervisor, 'abortWorkspaceTransaction').mockRejectedValueOnce(new Error('cleanup unavailable'));
  await expect(cleanupAgentCausalFork(supervisor, { txId: id, atSeq: plan().atSeq })).rejects.toThrow('cleanup unavailable');
  expect(listAgentCausalForkCleanups(world.domain)[0]).toMatchObject({ status: 'failed', error: 'cleanup unavailable' });
  const ref = { worldId: world.state.worldId, id, atSeq: plan().atSeq };
  const failed = explainWorldResources(world, ref);
  expect(failed[0]).toMatchObject({ id, kind: 'fork', status: 'cleanup_failed', reason: 'cleanup unavailable' });
  expect(failed.slice(1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: world.state.snapshotId, kind: 'snapshot', status: 'retained' }),
    expect.objectContaining({ kind: 'journal', status: 'retained' }),
  ]));
  fail.mockRestore();
  await cleanupAgentCausalFork(supervisor, { txId: id, atSeq: plan().atSeq });
  expect(plan().resources[0].state).toBe('aborted');
  expect(explainWorldResources(world, { ...ref, atSeq: plan().atSeq })[0]).toMatchObject({ status: 'reclaimed' });
  expect(explainWorldResources(world, ref)).toEqual(failed);
  const events = world.domain.getStore().getJournalEvents('world');
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(explainWorldResources(world, ref)).toEqual(failed);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  await expect(fs.stat(tx.forkRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(world.domain.getStore().getSnapshot(world.state.snapshotId)).toBeDefined();
  expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe('original');
});

it('never releases an unresolved publication even after a preparation failure', async () => {
  record('WORLD_STEP_STARTED', 'pending');
  const supervisor = new ProcessSupervisor(world.domain);
  await supervisor.beginWorkspaceTransaction({ txId: 'pending', runId: 'owner', root: world.state.root,
    baseSnapshotId: world.state.snapshotId, forkPath: path.join(temp, 'pending') });
  record('TX_COMMITTING', 'pending');
  record('WORLD_STEP_FAILED', 'pending');
  expect(plan().resources[0]).toMatchObject({ state: 'committing', reasons: ['commit_in_progress'],
    fork: { disposition: 'retain' } });
  await expect(cleanupAgentCausalFork(supervisor, { txId: 'pending', atSeq: plan().atSeq })).rejects.toThrow('retained');
});

it('reports allocation uncertainty and rejects references outside the frozen world history', () => {
  const atSeq = record('WORLD_REPAIR_STARTED', 'reserved');
  const ref = { worldId: world.state.worldId, id: 'reserved', atSeq };
  expect(explainWorldResources(world, ref)[0]).toMatchObject({ status: 'retained', reason: 'pending_publication' });
  expect(() => explainWorldResources(world, { ...ref, worldId: 'other' })).toThrow('reference mismatch');
  expect(() => explainWorldResources(world, { ...ref, id: 'other' })).toThrow('reference mismatch');
  expect(() => explainWorldResources(world, { ...ref, atSeq: atSeq + 100 })).toThrow('cutoff');
  world.close();
  expect(() => explainWorldResources(world, ref)).toThrow('closed');
});

it('closes with durable reclamation facts, deduplicates calls and reopens read-only history', async () => {
  record('WORLD_STEP_STARTED', 'failed');
  const tx = await new ProcessSupervisor(world.domain).beginWorkspaceTransaction({ txId: 'failed',
    runId: 'owner', root: world.state.root, baseSnapshotId: world.state.snapshotId,
    forkPath: path.join(temp, 'failed') });
  record('WORLD_STEP_FAILED', 'failed');
  record('WORLD_REPAIR_STARTED', 'reserved');
  const root = world.state.root;
  const [report, duplicate] = await Promise.all([closeWorldResources(world), closeWorldResources(world)]);
  expect(duplicate).toEqual(report);
  expect(world.domain.isClosed()).toBe(true);
  expect(report.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'failed', status: 'reclaimed' }),
    expect.objectContaining({ id: 'reserved', status: 'retained' }),
  ]));
  await expect(fs.stat(tx.forkRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await closeWorldResources(world)).toEqual(report);
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  record('LATER', 'other');
  const events = world.domain.getStore().getJournalEvents('world');
  expect(readWorldClose(world, report.ref)).toEqual(report);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(events.filter(e => e.type === 'WORLD_RESOURCES_CLOSED')).toHaveLength(1);
  expect(() => readWorldClose(world, { ...report.ref, id: 'other' })).toThrow('reference mismatch');
  expect(await fs.readFile(path.join(root, 'input'), 'utf8')).toBe('original');
});

it('persists cleanup failure, retains unresolved commits and retries only after reopening', async () => {
  const supervisor = new ProcessSupervisor(world.domain);
  for (const id of ['failed', 'pending']) {
    record('WORLD_STEP_STARTED', id);
    await supervisor.beginWorkspaceTransaction({ txId: id, runId: 'owner', root: world.state.root,
      baseSnapshotId: world.state.snapshotId, forkPath: path.join(temp, id) });
    record('WORLD_STEP_FAILED', id);
  }
  record('TX_COMMITTING', 'pending');
  const fail = vi.spyOn(ProcessSupervisor.prototype, 'abortWorkspaceTransaction')
    .mockRejectedValueOnce(new Error('cleanup unavailable'));
  const root = world.state.root;
  const report = await closeWorldResources(world);
  expect(report.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'failed', status: 'cleanup_failed', reason: 'cleanup unavailable' }),
    expect.objectContaining({ id: 'pending', status: 'retained', reason: 'commit_in_progress' }),
  ]));
  await closeWorldResources(world);
  expect(fail).toHaveBeenCalledTimes(1);
  fail.mockRestore();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldClose(world, report.ref)).toEqual(report);
  const retry = await closeWorldResources(world);
  expect(retry.resources.find(r => r.id === 'failed')).toMatchObject({ status: 'reclaimed' });
  await expect(fs.stat(path.join(temp, 'pending'))).resolves.toBeDefined();
});

it('does not confirm closure when report persistence fails, and preserves an empty world baseline', async () => {
  const store = world.domain.getStore();
  const original = store.recordJournalEvent.bind(store);
  const fail = vi.spyOn(store, 'recordJournalEvent').mockImplementation(event => {
    if (event.type === 'WORLD_RESOURCES_CLOSED') throw new Error('journal unavailable');
    return original(event);
  });
  await expect(closeWorldResources(world)).rejects.toThrow('journal unavailable');
  expect(world.domain.isClosed()).toBe(false);
  fail.mockRestore();
  const report = await closeWorldResources(world);
  expect(report.resources.map(r => [r.kind, r.status])).toEqual([
    ['snapshot', 'retained'], ['journal', 'retained'],
  ]);
});
