import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { validateWorldCandidate } from '../../src/world/validation.js';
import { prepareWorldRepair } from '../../src/world/repair.js';
import { readWorldArtifacts } from '../../src/world/artifacts.js';
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
    const artifacts = [
      { id: 'changed', dependsOn: [heads[0]] },
      { id: 'stable', dependsOn: [heads[1]] },
      { id: 'summary', dependsOn: heads },
      { id: 'constant', dependsOn: [] },
    ].map(artifact => ({ ...artifact, kind: 'model_response' as const, body: artifact.id,
      hash: createHash('sha256').update(artifact.id).digest('hex') }));
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads, artifacts };
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

it('exposes only verified independent artifacts to repair callbacks using frozen history', async () => {
  const { candidate, probe } = await fixture();
  const original = structuredClone(readWorldArtifacts(world, candidate));
  world.close();
  world = await openWorldState({ root: path.join(temp, 'repo'), statePath: path.join(temp, 'state'), adapter });
  await fs.writeFile(path.join(world.state.root, 'b'), 'later-b');
  const contexts: unknown[] = [];
  const result = await prepareWorldRepair(world, probe.ref, adapter, async (source, tx, _deps, refresh) => {
    expect(refresh.previous).toEqual(candidate);
    expect(refresh.previous).not.toHaveProperty('artifacts');
    expect(refresh.plan).toEqual(probe.plan);
    expect(refresh.reusableArtifacts).toEqual(original.filter(a => ['stable', 'constant'].includes(a.id)));
    expect(await fs.readFile(path.join(tx.forkRoot, 'out-b'), 'utf8')).toBe('stable-b');
    contexts.push(structuredClone(refresh));
    // Even a host bypassing readonly cannot poison subsequent callbacks or durable evidence.
    (refresh.reusableArtifacts[0] as { body?: string }).body = 'host mutation';
    (refresh.plan.unaffected as unknown[]).length = 0;
    return { actorId: 'repair', observation: { ...source.observation,
      resultHash: await adapter.replay(source.observation, tx.forkRoot) } };
  });
  expect(contexts).toHaveLength(2);
  expect(result.refresh).toEqual(contexts[0]);
  expect(readWorldArtifacts(world, candidate)).toEqual(original);
  const event = world.domain.getStore().getJournalEvent('world', result.ref.atSeq)!;
  expect(event.payload.reusableArtifacts).toEqual(['stable', 'constant']);
  expect(event.payload.invalidatedArtifacts).toEqual(['changed', 'summary']);
  await expect(fs.stat(path.join(world.state.root, 'out-b'))).rejects.toMatchObject({ code: 'ENOENT' });
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

it('prepares an incremental WorldAgent candidate with remapped reusable dependencies and checkpoint', async () => {
  const { prepareRepairedWorldCandidate } = await import('../../src/world/reuse.js');
  const { candidate, probe } = await fixture();
  let calls = 0;
  const result = await prepareRepairedWorldCandidate(world, probe.ref, adapter, { execute: async (context, input) => {
    calls++;
    expect(input.task).toBe('copy both');
    expect(context.version).toEqual(probe.version);
    expect(context.refresh!.previous).toEqual(candidate);
    expect(context.refresh!.plan).toEqual(probe.plan);
    expect(context.refresh!.reusableArtifacts.map(a => a.id)).toEqual(['stable', 'constant']);
    expect(await fs.readFile(path.join(context.forkRoot, 'out-b'), 'utf8')).toBe('stable-b');
    const stable = context.refresh!.reusableArtifacts[0];
    expect(stable.dependsOn).not.toEqual(readWorldArtifacts(world, candidate)[1].dependsOn);
    const read = { kind: 'observe' as const, call: { tool: 'read', args: { key: 'a' } } };
    const value = await adapter.replay(read, context.forkRoot);
    const seq = await context.record({ ...read, resultHash: value }, []);
    const write = { kind: 'mutate' as const, call: { tool: 'copy', args: { key: 'a' } } };
    await adapter.replay(write, context.forkRoot);
    const head = await context.record({ ...write, resultHash: value }, [seq]);
    return { coverage: { status: 'complete', manifestHash: context.version.manifestHash },
      heads: [head, ...stable.dependsOn!], artifacts: context.refresh!.reusableArtifacts };
  } });
  expect(calls).toBe(1);
  expect(result.status).toBe('prepared');
  if (result.status !== 'prepared') throw new Error(JSON.stringify(result));
  const events = world.domain.getStore().getJournalEvents('world');
  const completed = events.find(e => e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === result.candidate.id)!;
  expect((completed.payload.checkpoint as { artifacts: unknown }).artifacts).toEqual(readWorldArtifacts(world, result.candidate));
  expect(completed.payload.causalHeads).toEqual(result.candidate.heads);
  expect(await fs.readFile(path.join(completed.payload.forkRoot as string, 'out-a'), 'utf8')).toBe('new-a');
  await expect(fs.stat(path.join(world.state.root, 'out-a'))).rejects.toMatchObject({ code: 'ENOENT' });
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldArtifacts(world, result.candidate).map(a => a.id)).toEqual(['stable', 'constant']);
  expect((await validateWorldCandidate(world, result.candidate, adapter, 'selected_nodes')).status).toBe('matched');
});

it.each(['exception', 'old_dependency', 'untracked'] as const)('incremental preparation handles %s without publication', async failure => {
  const { prepareRepairedWorldCandidate } = await import('../../src/world/reuse.js');
  const { candidate, probe } = await fixture();
  let calls = 0;
  const result = await prepareRepairedWorldCandidate(world, probe.ref, { ...adapter,
    replay: async (entry, root) => {
      if (failure === 'exception') throw new Error('reuse offline');
      return adapter.replay(entry, root);
    } }, { execute: async context => {
    calls++;
    return { coverage: { status: 'complete', manifestHash: context.version.manifestHash },
      heads: failure === 'old_dependency' ? candidate.heads : null, artifacts: context.refresh!.reusableArtifacts };
  } });
  expect(calls).toBe(failure === 'exception' ? 0 : 1);
  expect(result.status).toBe(failure === 'untracked' ? 'unknown' : 'failed');
  if (result.status === 'failed') expect(result.reason).toContain(failure === 'exception' ? 'reuse offline' : 'outside this world step');
  await expect(fs.stat(path.join(world.state.root, 'out-b'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refreshes repeatedly using mapped nodes without artifacts and preserves incremental explanations', async () => {
  const { refreshWorldCandidate, readWorldRefresh } = await import('../../src/world/refresh.js');
  const { explainWorldPreparation } = await import('../../src/world/explain.js');
  const initial = await prepareWorldStep(world, { execute: async ({ record, forkRoot, version }) => {
    const heads: number[] = [];
    for (const key of ['a', 'b']) {
      const entry = { kind: 'observe' as const, call: { tool: 'read', args: { key } } };
      heads.push(await record({ ...entry, resultHash: await adapter.replay(entry, forkRoot) }, []));
    }
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads, artifacts: [] };
  } }, { task: 'observe both' });
  if (initial.status !== 'prepared') throw new Error(JSON.stringify(initial));
  let candidate = initial.candidate;
  let calls = 0;
  for (const key of ['a', 'b', 'a']) {
    await fs.writeFile(path.join(world.state.root, key), `updated-${calls}`);
    const previous = candidate;
    const report = await refreshWorldCandidate(world, previous, adapter, { execute: async context => {
      calls++;
      const refresh = context.refresh!;
      expect(refresh.reusableArtifacts).toEqual([]);
      expect(refresh.reusedNodes).toHaveLength(1);
      const mapping = refresh.reusedNodes[0];
      expect(previous.heads).toContain(mapping.sourceSeq);
      expect(previous.heads).not.toContain(mapping.replacementSeq);
      const entry = { kind: 'observe' as const, call: { tool: 'read', args: { key } } };
      const head = await context.record({ ...entry, resultHash: await adapter.replay(entry, context.forkRoot) }, []);
      return { coverage: { status: 'complete', manifestHash: context.version.manifestHash },
        heads: [head, mapping.replacementSeq], artifacts: [] };
    } }, { onUnknown: 'reject' });
    expect(report.strategy).toBe('incremental');
    if (report.result.status !== 'prepared') throw new Error(JSON.stringify(report));
    candidate = report.result.candidate;
    expect((await validateWorldCandidate(world, candidate, adapter, 'selected_nodes')).status).toBe('matched');
    const explanation = explainWorldPreparation(world, report.ref);
    expect(explanation.reuse).toMatchObject({ mode: 'incremental', replacements: [
      { sourceSeq: expect.any(Number), replacementSeq: expect.any(Number) },
    ] });
    const events = world.domain.getStore().getJournalEvents('world');
    const root = world.state.root;
    world.close();
    world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
    expect(readWorldRefresh(world, report.ref)).toEqual(report);
    expect(explainWorldPreparation(world, report.ref)).toEqual(explanation);
    expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
    await expect(fs.stat(path.join(root, 'out-a'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(calls).toBe(3);
});
