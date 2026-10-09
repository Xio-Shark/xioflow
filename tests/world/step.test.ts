import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorldState } from '../../src/world/state.js';
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
