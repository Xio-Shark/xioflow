import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { ExecutionDomain } from '../../src/domain.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { openWorld } from '../../src/world/handle.js';
import type { FileWorldAdapter, WorldAgent } from '../../src/world/contract.js';

const exec = promisify(execFile);
const scenarios = ['stable', 'local', 'all', 'untracked', 'tool_error', 'stale'] as const;
const cases = scenarios.flatMap(scenario => Array.from({ length: 10 }, (_, trial) => ({ scenario, trial })));

// The oracle reads the perturbed main directory and uses integer arithmetic;
// it never calls the agent, replay adapter, or refresh planner.
async function oracle(root: string) {
  return Promise.all(['a', 'b'].map(async name =>
    `${BigInt(await fs.readFile(path.join(root, name), 'utf8')) * 2n}\n`));
}
async function outputs(root: string) {
  return Promise.all(['a.out', 'b.out'].map(name => fs.readFile(path.join(root, name), 'utf8')));
}

it.each(cases)('M2 $scenario trial $trial: publication, isolation and frozen history', async ({ scenario, trial }) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'world-acceptance-'));
  const root = path.join(temp, 'repo');
  let world: Awaited<ReturnType<typeof openWorld>> | undefined;
  // Observe the real domain without exposing storage through the world API.
  const acquired = vi.spyOn(ExecutionDomain, 'acquire');
  const runIds = new Set<string>();
  const audit = async () => {
    const domain = acquired.mock.results.at(-1)!.value as ExecutionDomain;
    const runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1,
      step: async () => { throw new Error('History audit must not execute agents'); } });
    try {
      const usage = [...runIds].map(id => runtime.getRunUsage(id));
      for (const run of usage) expect(run).toMatchObject({ stepsUsed: 1, agentsCreated: 1, pendingCommands: 0 });
      return { usage, journal: domain.getStore().getJournalEvents('world'),
        files: await Promise.all(['a', 'b', 'a.out', 'b.out'].map(name => fs.readFile(path.join(root, name), 'utf8'))),
        generated, replays };
    } finally { runtime.close(); }
  };
  const explain = async (target: Parameters<NonNullable<typeof world>['explain']>[0]) => {
    const before = await audit();
    const evidence = await world!.explain(target);
    expect(await audit()).toEqual(before);
    return evidence;
  };
  let offline = false;
  let generated = 0;
  let replays = 0;
  const untracked = scenario === 'untracked';
  const adapter: FileWorldAdapter = {
    id: 'm2-acceptance', version: '1',
    declareCoverage: async () => ({ paths: ['a', 'b', 'a.out', 'b.out'], excluded: [],
      symlinks: 'reject', externalReads: 'unsupported', externalWrites: 'unsupported' }),
    replay: async (entry, forkRoot) => {
      replays++;
      if (offline) throw new Error('injected tool failure');
      const name = entry.call.args.name as string;
      const value = await fs.readFile(path.join(forkRoot, name), 'utf8');
      if (entry.kind === 'observe') return value;
      const body = `${Number(value) + Number(value)}\n`;
      await fs.writeFile(path.join(forkRoot, `${name}.out`), body);
      return body;
    },
    accept: async publicationRoot => (await outputs(publicationRoot)).every((body, i) =>
      body === expected[i]),
  };
  let expected: string[] = [];
  const agent: WorldAgent = { execute: async context => {
    const heads: number[] = [];
    for (const [i, name] of ['a', 'b'].entries()) {
      const oldHead = context.refresh?.previous.heads?.[i];
      const reused = context.refresh?.reusedNodes.find(node => node.sourceSeq === oldHead);
      if (reused) { heads.push(reused.replacementSeq); continue; }
      generated++;
      const value = await fs.readFile(path.join(context.forkRoot, name), 'utf8');
      const read = await context.record({ kind: 'observe', call: { tool: 'read', args: { name } },
        resultHash: value }, untracked ? null : []);
      const body = `${Number(value) + Number(value)}\n`;
      await fs.writeFile(path.join(context.forkRoot, `${name}.out`), body);
      heads.push(await context.record({ kind: 'mutate', call: { tool: 'write', args: { name } },
        resultHash: body }, [read]));
    }
    return { coverage: { status: 'complete', manifestHash: context.version.manifestHash },
      heads: untracked ? null : heads, artifacts: [] };
  } };
  const options = { root, statePath: path.join(temp, 'state'), adapter };
  try {
    await fs.mkdir(root);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await fs.writeFile(path.join(root, 'a'), String(100 + trial));
    await fs.writeFile(path.join(root, 'b'), String(200 + trial));
    await fs.writeFile(path.join(root, 'a.out'), 'unpublished a');
    await fs.writeFile(path.join(root, 'b.out'), 'unpublished b');
    world = await openWorld(options);
    const initial = await world.runAgentStep(agent, { task: 'double independent inputs' });
    if (initial.status === 'failed') throw new Error(initial.reason);
    expect(initial.status).toBe(untracked ? 'unknown' : 'prepared');
    runIds.add(initial.candidate.id);
    if (['local', 'all', 'stale'].includes(scenario)) await fs.writeFile(path.join(root, 'a'), String(120 + trial));
    if (scenario === 'all') await fs.writeFile(path.join(root, 'b'), String(240 + trial));
    offline = scenario === 'tool_error';
    const refreshed = await world.refresh(initial.candidate, { onUnknown: 'reject' });
    expect(await outputs(root)).toEqual(['unpublished a', 'unpublished b']);
    expect(generated).toBe(scenario === 'all' ? 4 : ['local', 'stale'].includes(scenario) ? 3 : 2);
    if (refreshed.status !== 'failed') runIds.add(refreshed.candidate.id);
    const ref = refreshed.ref;
    const evidence = await explain(ref);
    if (scenario === 'tool_error') {
      expect(refreshed.status).toBe('failed');
      expect(evidence.preparation.validation?.status).toBe('failed');
      expect(evidence.plan).toBeNull();
    } else if (untracked) {
      expect(refreshed.status).toBe('unknown');
      expect(evidence.coverage.status).toBe('unknown');
      expect(replays).toBe(0);
    } else {
      expect(refreshed.status).toBe('prepared');
      expect(evidence.plan?.invalidated).toHaveLength(scenario === 'stable' ? 0 : scenario === 'all' ? 4 : 2);
      expect(evidence.preparation.refresh?.strategy).toBe(scenario === 'stable' ? 'reuse' : 'incremental');
      for (const node of evidence.plan!.invalidated.filter(node => node.observation.kind === 'mutate')) {
        expect(evidence.plan!.explanations).toContainEqual({ nodeSeq: node.seq,
          causes: [{ changedSeq: node.dependsOn![0], path: [node.dependsOn![0], node.seq] }] });
      }
      if (refreshed.status !== 'prepared') throw new Error('expected preparation');
      expect(ref.atSeq).toBeGreaterThan(refreshed.candidate.atSeq);
      expect((await explain(refreshed.candidate)).plan).toBeNull();
    }
    if (scenario === 'stale') await fs.writeFile(path.join(root, 'a'), String(150 + trial));
    expected = await oracle(root);
    const candidate = refreshed.status === 'failed' ? initial.candidate : refreshed.candidate;
    const result = await world.commit(candidate, { validation: 'strict', key: 'acceptance' });
    expect(result.status).toBe(untracked ? 'unknown' : offline ? 'validation_failed' : scenario === 'stale' ? 'conflict' : 'committed');
    expect(await outputs(root)).toEqual(result.status === 'committed' ? expected : ['unpublished a', 'unpublished b']);
    expect(await oracle(root)).toEqual(expected);
    const publication = await explain({ identity: result.identity });
    if (!untracked && !offline) {
      expect(publication.plan?.invalidated).toHaveLength(scenario === 'stable' ? 0 : scenario === 'all' ? 4 : 2);
    }
    const calls = { generated, replays };
    expect(await explain(ref)).toEqual(evidence);
    const usage = (await audit()).usage;
    await world.close();
    world = await openWorld(options);
    expect((await audit()).usage).toEqual(usage);
    expect(await explain(ref)).toEqual(evidence);
    expect(await explain({ identity: result.identity, atSeq: publication.ref.atSeq })).toEqual(publication);
    expect({ generated, replays }).toEqual(calls);
    // Tool errors are retryable, so only terminal results must return without replay.
    if (!offline) {
      expect(await world.commit(candidate, { validation: 'strict', key: 'acceptance' })).toEqual(result);
      expect({ generated, replays }).toEqual(calls);
    }
    expect(await outputs(root)).toEqual(result.status === 'committed' ? expected : ['unpublished a', 'unpublished b']);
  } finally {
    acquired.mockRestore();
    await world?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
