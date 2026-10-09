import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readWorldArtifacts } from '../../src/world/artifacts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorldState } from '../../src/world/state.js';
import { prepareWorldStep } from '../../src/world/prepare.js';
import { executeWorldStep } from '../../src/world/step.js';
import { WorkspaceCausalGraph } from '../../src/workspace/causal-graph.js';

const exec = promisify(execFile);
let temp: string;
let world: Awaited<ReturnType<typeof openWorldState>>;
const adapter = { id: 'test', version: '1', declareCoverage: async () => ({
  paths: ['input', 'output'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}) };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-step-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'input'), 'original');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
});
afterEach(async () => {
  world?.close();
  await fs.rm(temp, { recursive: true, force: true });
});

it('executes on the frozen fork and persists output, causal checkpoint and identity across reopen', async () => {
  await fs.writeFile(path.join(world.state.root, 'input'), 'external');
  const result = await executeWorldStep(world, { task: 'copy' }, async ({ forkRoot, record }) => {
    const value = await fs.readFile(path.join(forkRoot, 'input'), 'utf8');
    const read = record({ kind: 'observe', call: { tool: 'read', args: { path: 'input' } }, resultHash: value }, []);
    await fs.writeFile(path.join(forkRoot, 'output'), value);
    const write = record({ kind: 'mutate', call: { tool: 'write', args: { path: 'output', value } }, resultHash: value }, [read]);
    return { checkpoint: { response: value }, causalHeads: [write] };
  });
  expect(result.status).toBe('executed');
  if (result.status !== 'executed') throw new Error(result.reason);
  expect(result.checkpoint).toEqual({ response: 'original' });
  expect(result.outputFingerprint).not.toBe(world.state.fingerprint);
  expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe('external');
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  const nodes = new WorkspaceCausalGraph(world.domain).nodes();
  expect(nodes).toHaveLength(2);
  expect(nodes[1].dependsOn).toEqual([nodes[0].seq]);
  const events = world.domain.getStore().getJournalEvents('world');
  const state = world.state;
  world.close();
  world = await openWorldState({ root: state.root, statePath: path.join(temp, 'state'), adapter });
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(new WorkspaceCausalGraph(world.domain).nodes()).toEqual(nodes);
  expect(events.find(e => e.seq === result.atSeq)?.payload).toMatchObject({
    checkpoint: result.checkpoint, outputFingerprint: result.outputFingerprint, causalHeads: result.causalHeads,
  });
});

it.each([null, []] as (number[] | null)[])('preserves unknown versus empty dependencies: %j', async dependencies => {
  const result = await executeWorldStep(world, null, async ({ record }) => {
    record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'value' }, dependencies);
    return { checkpoint: 'response', causalHeads: [] };
  });
  expect(result.status).toBe('executed');
  if (result.status !== 'executed') throw new Error(result.reason);
  expect(result.causalHeads).toEqual(dependencies);
  expect(world.domain.getStore().getJournalEvents('world').some(e => e.type === 'WORLD_OBSERVATION_UNTRACKED'))
    .toBe(dependencies === null);
});

it('records tool failure without publication and permits a subsequent isolated step', async () => {
  const failed = await executeWorldStep(world, null, async ({ forkRoot }) => {
    await fs.writeFile(path.join(forkRoot, 'output'), 'partial');
    throw new Error('tool unavailable');
  });
  expect(failed).toMatchObject({ status: 'failed', reason: 'Error: tool unavailable' });
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(world.domain.getStore().getJournalEvents('world').find(e => e.seq === failed.atSeq)?.type).toBe('WORLD_STEP_FAILED');
  const next = await executeWorldStep(world, null, async () => ({ checkpoint: 'ok', causalHeads: [] }));
  expect(next.status).toBe('executed');
});

it('rejects invented heads and closes retained record callbacks after execution', async () => {
  let lateRecord: (() => number) | undefined;
  const result = await executeWorldStep(world, null, async ({ record }) => {
    lateRecord = () => record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'v' }, []);
    return { checkpoint: 'bad', causalHeads: [123456] };
  });
  expect(result).toMatchObject({ status: 'failed', reason: 'Error: Head is outside this world step' });
  const before = world.domain.getStore().getJournalEvents('world');
  expect(lateRecord).toThrow('recording is closed');
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(before);
});

it('prepares WorldAgent declarations and retains identical evidence after reopen', async () => {
  const result = await prepareWorldStep(world, { execute: async ({ record, forkRoot, version, refresh }) => {
    expect(refresh).toBeNull();
    const read = await record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'original' }, []);
    await fs.writeFile(path.join(forkRoot, 'output'), 'original');
    const write = await record({ kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'original' }, [read]);
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [write],
      artifacts: [{ id: 'response', kind: 'model_response', hash: createHash('sha256').update('响应\n').digest('hex'), body: '响应\n', dependsOn: [read] }] };
  } }, { task: 'copy' });
  expect(result.status).toBe('prepared');
  if (result.status !== 'prepared') throw new Error('not prepared');
  const events = world.domain.getStore().getJournalEvents('world');
  expect(events.find(e => e.seq === result.candidate.atSeq)).toMatchObject({ type: 'WORLD_STEP_PREPARED',
    payload: { id: result.candidate.id, artifacts: [{ id: 'response', hash: createHash('sha256').update('响应\n').digest('hex'), body: '响应\n' }] } });
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
});

it.each(['manifest', 'host', 'heads', 'artifact', 'observation', 'untracked_head', 'omitted', 'mutation'])
  ('preserves unknown evidence for %s without publishing', async mode => {
    const result = await prepareWorldStep(world, { execute: async ({ record, version }) => {
      const node = await record({ kind: mode === 'mutation' ? 'mutate' : 'observe',
        call: { tool: 'test', args: {} }, resultHash: 'value' }, ['observation', 'untracked_head'].includes(mode) ? null : []);
      return { coverage: mode === 'host' ? { status: 'unknown', reasons: ['network_read'] }
        : { status: 'complete', manifestHash: mode === 'manifest' ? 'wrong' : version.manifestHash },
      heads: mode === 'heads' ? null : mode === 'untracked_head' ? [node] : [], artifacts: [{ id: 'response', kind: 'model_response', hash: 'hash',
        dependsOn: mode === 'artifact' ? null : mode === 'omitted' ? [node] : [] }] };
    } }, { task: 'unknown' });
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') throw new Error('not unknown');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(world.domain.getStore().getJournalEvents('world').find(e => e.seq === result.candidate.atSeq)?.type)
      .toBe('WORLD_STEP_UNKNOWN');
    expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe('original');
  });

it.each(['foreign', 'duplicate', 'empty_hash'])('fails malformed artifact declarations: %s', async mode => {
  const result = await prepareWorldStep(world, { execute: async ({ version }) => {
    const artifact = { id: 'response', kind: 'model_response' as const,
      hash: mode === 'empty_hash' ? '' : 'hash', dependsOn: mode === 'foreign' ? [999999] : [] };
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [],
      artifacts: mode === 'duplicate' ? [artifact, artifact] : [artifact] };
  } }, { task: 'invalid' });
  expect(result.status).toBe('failed');
  expect(world.domain.getStore().getJournalEvents('world').some(e => e.type === 'WORLD_STEP_PREPARED')).toBe(false);
});

it('accepts explicitly empty dependencies', async () => {
  const result = await prepareWorldStep(world, { execute: async ({ version }) => ({
    coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [], artifacts: [],
  }) }, { task: 'no-op' });
  expect(result).toMatchObject({ status: 'prepared', candidate: { heads: [], coverage: { status: 'complete' } } });
});

it('propagates untracked ancestry through tools and saves unknown evidence across reopen', async () => {
  const seqs: number[] = [];
  const result = await prepareWorldStep(world, { execute: async ({ record, forkRoot, version }) => {
    const entry = { kind: 'observe' as const, call: { tool: 'read', args: {} }, resultHash: 'value' };
    const tracked = await record(entry, []);
    const unknown = await record(entry, null);
    const derived = await record(entry, [tracked, unknown]);
    await fs.writeFile(path.join(forkRoot, 'output'), 'derived');
    const write = await record({ ...entry, kind: 'mutate' }, [derived]);
    seqs.push(tracked, unknown, derived, write);
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [write],
      artifacts: [{ id: 'response', kind: 'model_response', body: 'derived',
        hash: createHash('sha256').update('derived').digest('hex'), dependsOn: [write] }] };
  } }, { task: 'derive from incomplete evidence' });
  expect(result).toMatchObject({ status: 'unknown', reasons: ['untracked_dependencies'],
    candidate: { heads: null } });
  if (result.status !== 'unknown') throw new Error('not unknown');
  const events = world.domain.getStore().getJournalEvents('world');
  expect(events.filter(e => e.type === 'WORLD_OBSERVATION_UNTRACKED').map(e => e.payload.dependsOn))
    .toEqual([null, [seqs[0], seqs[1]], [seqs[2]]]);
  expect(new WorkspaceCausalGraph(world.domain).nodes().map(n => n.seq)).toEqual([seqs[0]]);
  expect(events.find(e => e.type === 'WORLD_STEP_COMPLETED')?.payload.causalHeads).toBeNull();
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
  world.close();
  world = await openWorldState({ root: path.join(temp, 'repo'), statePath: path.join(temp, 'state'), adapter });
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  expect(readWorldArtifacts(world, result.candidate)[0]).toMatchObject({ body: 'derived', dependsOn: [seqs[3]] });
});

it('keeps low-level untracked heads unknown rather than rejecting their recorded identity', async () => {
  const result = await executeWorldStep(world, null, async ({ record }) => {
    const seq = record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'value' }, null);
    return { checkpoint: 'response', causalHeads: [seq] };
  });
  expect(result).toMatchObject({ status: 'executed', causalHeads: null });
});

it('rejects a foreign dependency even when another parent is untracked', async () => {
  const result = await executeWorldStep(world, null, async ({ record }) => {
    const entry = { kind: 'observe' as const, call: { tool: 'read', args: {} }, resultHash: 'value' };
    const unknown = record(entry, null);
    record(entry, [unknown, 999999]);
    return { checkpoint: 'invalid', causalHeads: null };
  });
  expect(result).toMatchObject({ status: 'failed', reason: 'Error: Dependency is outside this world step' });
  expect(world.domain.getStore().getJournalEvents('world').filter(e => e.type === 'WORLD_OBSERVATION_UNTRACKED'))
    .toHaveLength(1);
});

it.each(['', '响应\n', 'tool output'])('restores verified artifact body %j without changing history', async body => {
  const artifact = { id: 'response', kind: body === 'tool output' ? 'tool_result' as const : 'model_response' as const,
    hash: createHash('sha256').update(body).digest('hex'), body, dependsOn: [] };
  const result = await prepareWorldStep(world, { execute: async ({ version }) => ({
    coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [], artifacts: [artifact],
  }) }, { task: 'save' });
  if (result.status !== 'prepared') throw new Error('not prepared');
  const events = world.domain.getStore().getJournalEvents('world');
  artifact.body = 'host changed its response';
  const root = world.state.root;
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldArtifacts(world, result.candidate)[0].body).toBe(body);
  expect(() => readWorldArtifacts(world, { ...result.candidate, worldId: 'other' })).toThrow('world mismatch');
  expect(() => readWorldArtifacts(world, { ...result.candidate, id: 'other' })).toThrow('reference mismatch');
  expect(() => readWorldArtifacts(world, { ...result.candidate, atSeq: result.candidate.atSeq - 1 })).toThrow('reference mismatch');
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  const db = new DatabaseSync(path.join(world.domain.domainPath, 'domain.db'));
  try {
    const event = events.find(e => e.seq === result.candidate.atSeq)!;
    const payload = structuredClone(event.payload);
    (payload.artifacts as { body: string }[])[0].body = 'corrupt';
    db.prepare('UPDATE journal_events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), event.seq);
  } finally { db.close(); }
  expect(() => readWorldArtifacts(world, result.candidate)).toThrow('hash mismatch');
});

it.each(['missing', 'mismatch', 'invalid'])('refuses unverified response bodies: %s', async mode => {
  const result = await prepareWorldStep(world, { execute: async ({ version }) => ({
    coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [],
    artifacts: [{ id: 'response', kind: 'tool_result', hash: 'wrong', dependsOn: [],
      ...(mode === 'missing' ? {} : { body: mode === 'invalid' ? 123 as unknown as string : 'response' }) }],
  }) }, { task: 'invalid body' });
  expect(result.status).toBe(mode === 'missing' ? 'unknown' : 'failed');
  if (result.status === 'unknown') {
    expect(result.reasons).toContain('artifact_body_missing');
    expect(() => readWorldArtifacts(world, result.candidate)).toThrow('body missing');
  }
  await expect(fs.stat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
