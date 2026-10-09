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
const adapter = { id: 'output-coverage', version: '1', declareCoverage: async () => ({
  paths: ['input', 'output', 'nested/output'], excluded: [], symlinks: 'reject' as const,
  externalReads: 'unsupported' as const, externalWrites: 'unsupported' as const,
}) };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-output-coverage-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'input'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), 'output\n');
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
});
afterEach(async () => { world?.close(); await fs.rm(temp, { recursive: true, force: true }); });

async function corrupt(root: string, kind: string) {
  if (kind === 'ignored') await fs.writeFile(path.join(root, 'output'), 'invisible');
  else if (kind === 'directory') await fs.mkdir(path.join(root, 'output'));
  else if (kind === 'symlink') await fs.symlink('input', path.join(root, 'output'));
  else await fs.symlink(temp, path.join(root, 'nested'));
}

it.each(['ignored', 'directory', 'symlink', 'ancestor'])('rejects %s output before preparing a candidate', async kind => {
  const result = await prepareWorldStep(world, { execute: async ({ forkRoot, version }) => {
    await corrupt(forkRoot, kind);
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [], artifacts: [] };
  } }, { task: 'invalid output' });
  expect(result.status).toBe('failed');
  if (result.status !== 'failed') throw new Error('Expected failure');
  expect(result.reason).toMatch(kind === 'ignored' ? /absent from snapshot coverage/ : /regular files/);
  expect(world.domain.getStore().getJournalEvents('world').some(e => e.type === 'WORLD_STEP_PREPARED')).toBe(false);
  await expect(fs.lstat(path.join(world.state.root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['before', 'during'] as const)('rejects fingerprint-invisible output %s replay and preserves the failure after reopen', async timing => {
  const prepared = await prepareWorldStep(world, { execute: async ({ record, version }) => {
    const read = await record({ kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'original' }, []);
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [read], artifacts: [] };
  } }, { task: 'observe' });
  if (prepared.status !== 'prepared') throw new Error(JSON.stringify(prepared));
  const completed = world.domain.getStore().getJournalEvents('world').find(e => e.type === 'WORLD_STEP_COMPLETED')!;
  const fork = completed.payload.forkRoot as string;
  if (timing === 'before') await corrupt(fork, 'ignored');
  let calls = 0;
  const result = await validateWorldCandidate(world, prepared.candidate, { ...adapter, replay: async () => {
    calls++;
    await corrupt(fork, 'ignored');
    return 'original';
  } });
  expect(result).toMatchObject({ status: 'failed', plan: null });
  expect(result.reasons.join()).toContain('absent from snapshot coverage');
  expect(calls).toBe(timing === 'before' ? 0 : 1);
  const root = world.state.root;
  const events = world.domain.getStore().getJournalEvents('world');
  world.close();
  world = await openWorldState({ root, statePath: path.join(temp, 'state'), adapter });
  expect(readWorldCandidateValidation(world, result.ref)).toEqual(result);
  expect(world.domain.getStore().getJournalEvents('world')).toEqual(events);
  await expect(fs.lstat(path.join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['write', 'delete'] as const)('allows covered regular-file %s and declared absent paths', async action => {
  const prepared = await prepareWorldStep(world, { execute: async ({ forkRoot, version }) => {
    if (action === 'write') await fs.writeFile(path.join(forkRoot, 'input'), 'new');
    else await fs.unlink(path.join(forkRoot, 'input'));
    return { coverage: { status: 'complete', manifestHash: version.manifestHash }, heads: [], artifacts: [] };
  } }, { task: action });
  expect(prepared.status).toBe('prepared');
  expect(await fs.readFile(path.join(world.state.root, 'input'), 'utf8')).toBe('original');
});
