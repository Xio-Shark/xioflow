import { describe, expect, it } from 'vitest';
import {
  executePipeline,
  PipelineDomainCoordinator,
  type Capability,
  type Program,
} from '../../src/isa/index.js';

const capability: Capability = {
  id: 'cap:pipeline-test', issuer: 'test', policyVersion: '1', reason: 'pipeline test',
  scope: { opcodes: ['fs.read', 'fs.write'], workspaces: ['workspace:root'], paths: ['**'], secrets: [] },
  limits: { cpuMs: 10_000, memoryBytes: 1_000_000, outputBytes: 1_000_000, concurrentOps: 8, processes: 0 },
  expiresAt: '2099-01-01T00:00:00.000Z',
  epoch: 1,
};

function program(instructions: Program['instructions']): Program {
  return { isa: 'xio/1', requestId: 'pipeline-request', programId: 'pipeline-program', mode: 'pipeline', capability: capability.id, workspace: 'workspace:root', instructions };
}

const read = (id: string, path: string, dependsOn: string[] = []) => ({
  id, op: 'fs.read' as const, args: { workspace: 'workspace:root' as const, path }, dependsOn, precondition: [], output: `${id}-result`,
});

const write = (id: string, opId: string, dependsOn: string[] = []) => ({
  id, op: 'fs.write' as const, args: { workspace: 'workspace:root' as const, path: `${id}.txt`, content: `artifact:${id}` as const }, dependsOn, precondition: [], output: `${id}-result`, opId: `op:${opId}` as const,
});

const options = { capability, availableCapabilities: ['filesystem.read', 'filesystem.write', 'artifact.put', 'artifact.get'] };

describe('ISA pipeline scheduler', () => {
  it('executes only ready DAG nodes and skips dependents after a failure', async () => {
    const calls: string[] = [];
    const result = await executePipeline(program([read('first', 'a'), read('second', 'b', ['first']), read('third', 'c', ['second'])]), async ({ instruction }) => {
      calls.push(instruction.id);
      return instruction.id === 'second' ? { status: 'failed', error: { code: 'test', message: 'stop' } } : { status: 'succeeded' };
    }, options);
    expect(result.status).toBe('failed');
    expect(calls).toEqual(['first', 'second']);
    expect(result.results.find((item) => item.id === 'third')?.status).toBe('partial');
  });

  it('serializes write resources and keeps independent reads eligible for concurrency', async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const result = await executePipeline(program([write('one', 'one'), write('two', 'two'), read('read', 'README.md')]), async ({ instruction }) => {
      if (instruction.op === 'fs.write') {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWrites -= 1;
      }
      return { status: 'succeeded' };
    }, { ...options, maxConcurrency: 3 });
    expect(result.status).toBe('succeeded');
    expect(maxActiveWrites).toBe(1);
  });

  it('joins an in-flight opId in the same domain instead of invoking the executor twice', async () => {
    const domain = new PipelineDomainCoordinator();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = () => executePipeline(program([write('one', 'shared')]), async () => {
      calls += 1;
      await gate;
      return { status: 'succeeded' };
    }, { ...options, domain });
    const first = execute();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = execute();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('succeeded');
    expect(secondResult.status).toBe('succeeded');
    expect(calls).toBe(1);
    expect(secondResult.results[0]?.joined).toBe(true);
  });

  it('rejects an in-flight opId with different input without joining or dispatching it', async () => {
    const domain = new PipelineDomainCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = executePipeline(program([write('one', 'shared')]), async () => {
      await gate;
      return { status: 'succeeded' };
    }, { ...options, domain });
    const changed = write('one', 'shared');
    changed.args.path = 'different.txt';
    let calls = 0;
    const second = await executePipeline(program([changed]), async () => {
      calls += 1;
      return { status: 'succeeded' };
    }, { ...options, domain });
    release();
    expect((await first).status).toBe('succeeded');
    expect(second.status).toBe('failed');
    expect(second.results[0]?.error?.code).toBe('op_id_conflict');
    expect(second.results[0]?.joined).toBeUndefined();
    expect(calls).toBe(0);
  });

  it.each([
    { kind: 'file_hash' as const, path: 'README.md', sha256: 'a'.repeat(64) },
    { kind: 'artifact_hash' as const, artifact: 'artifact:readme' as const, sha256: 'b'.repeat(64) },
    { kind: 'workspace_revision' as const, workspace: 'workspace:root' as const, revision: 'v1' },
  ])('fails closed for $kind without an external facts verifier', async (condition) => {
    const instruction = { ...read('one', 'README.md'), precondition: [condition] };
    let calls = 0;
    const result = await executePipeline(program([instruction]), async () => {
      calls += 1;
      return { status: 'succeeded' };
    }, options);
    expect(result.status).toBe('failed');
    expect(result.results[0]?.error?.code).toBe('precondition_failed');
    expect(calls).toBe(0);
  });

  it.each(['stale', 'unknown'] as const)('does not dispatch when external evidence is %s', async (verdict) => {
    let calls = 0;
    const result = await executePipeline(program([{
      ...read('one', 'README.md'), precondition: [{ kind: 'file_hash', path: 'README.md', sha256: 'a'.repeat(64) }],
    }]), async () => {
      calls += 1;
      return { status: 'succeeded' };
    }, { ...options, checkPrecondition: async () => verdict });
    expect(result.status).toBe('failed');
    expect(calls).toBe(0);
  });

  it('checks instruction status and external facts before dispatch', async () => {
    const events: string[] = [];
    const result = await executePipeline(program([
      read('first', 'a'),
      { ...read('second', 'b', ['first']), precondition: [
        { kind: 'instruction_status', instruction: 'first', status: 'succeeded' },
        { kind: 'file_hash', path: 'b', sha256: 'a'.repeat(64) },
      ] },
      { ...read('third', 'c', ['first']), precondition: [{ kind: 'instruction_status', instruction: 'first', status: 'failed' }] },
    ]), async ({ instruction }) => {
      events.push(`execute:${instruction.id}`);
      return { status: 'succeeded' };
    }, { ...options, checkPrecondition: async (_condition, context) => {
      events.push(`check:${context.instruction.id}`);
      return 'valid';
    } });
    expect(result.status).toBe('failed');
    expect(events).toEqual(['execute:first', 'check:second', 'execute:second']);
    expect(result.results[2]?.error?.code).toBe('precondition_failed');
  });

  it('does not execute a cancelled instruction after it obtains a queued resource', async () => {
    const domain = new PipelineDomainCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = executePipeline(program([read('first', 'a')]), async () => {
      await gate;
      return { status: 'succeeded' };
    }, { ...options, domain });
    const controller = new AbortController();
    let calls = 0;
    const second = executePipeline(program([read('second', 'b')]), async () => {
      calls += 1;
      return { status: 'succeeded' };
    }, { ...options, domain, signal: controller.signal });
    controller.abort();
    release();
    await first;
    const result = await second;
    expect(result.results[0]?.status).toBe('cancelled');
    expect(calls).toBe(0);
  });
});
