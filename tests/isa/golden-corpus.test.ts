import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ISA_V1_REGISTRY,
  createExecutionResult,
  planProgram,
  replayExecutionResult,
  validateProgram,
  type Capability,
} from '../../src/isa/index.js';

const fixtureDir = path.join(import.meta.dirname, 'fixtures');
const readFixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
const allCapabilities = [...new Set(Object.values(ISA_V1_REGISTRY).flatMap((entry) => entry.requiredCapabilities))];
const capability: Capability = {
  id: 'cap:golden', issuer: 'golden', policyVersion: '1', reason: 'golden corpus',
  scope: { opcodes: Object.keys(ISA_V1_REGISTRY) as Capability['scope']['opcodes'], workspaces: ['workspace:root'], paths: ['**'], secrets: [] },
  limits: { cpuMs: 1_000_000, memoryBytes: 1_000_000_000, outputBytes: 1_000_000_000, concurrentOps: 256, processes: 32 },
  expiresAt: '2099-01-01T00:00:00.000Z',
  epoch: 1,
};

describe('ISA golden corpus', () => {
  it('admits each golden Program fixture without touching a domain or host resource', () => {
    const programs = fs.readdirSync(fixtureDir).filter((name) => name.startsWith('program-'));
    expect(programs.length).toBe(6);
    for (const name of programs) {
      const result = validateProgram(readFixture(name), { capability, availableCapabilities: allCapabilities });
      expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('classifies the unsupported-driver fixture before execution', () => {
    const report = planProgram(readFixture('program-unsupported-driver.json'), { capability, availableCapabilities: allCapabilities, drivers: [] });
    expect(report.status).toBe('unsupported');
    expect(report.drivers[0]?.status).toBe('unsupported');
  });

  it('validates indeterminate/rollback result fixtures and replays the partial fixture to terminal', () => {
    const indeterminate = createExecutionResult(readFixture('result-indeterminate.json') as Parameters<typeof createExecutionResult>[0]);
    const rollback = createExecutionResult(readFixture('result-rollback.json') as Parameters<typeof createExecutionResult>[0]);
    expect(indeterminate.status).toBe('indeterminate');
    expect(indeterminate.results[0]?.lease).toBe('lease:golden-indeterminate');
    expect(rollback.results[0]?.status).toBe('rolled_back');

    const partial = createExecutionResult(readFixture('result-partial-replay.json') as Parameters<typeof createExecutionResult>[0]);
    const replayed = replayExecutionResult(partial, [
      { sequence: 1, cursor: 'event:golden-2', type: 'instruction.result', result: { ...partial.results[0]!, status: 'succeeded', observation: { status: 'proven' } } },
      { sequence: 2, cursor: 'event:golden-3', type: 'program.status', status: 'succeeded' },
    ]);
    expect(replayed.status).toBe('succeeded');
    expect(replayed.events.nextCursor).toBe('event:golden-3');
  });
});
