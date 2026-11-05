import { describe, expect, it } from 'vitest';
import { executePlan, planProgram, type Capability, type Program } from '../../src/isa/index.js';

const capability: Capability = {
  id: 'cap:plan-test', issuer: 'test', policyVersion: '1', reason: 'plan test',
  scope: { opcodes: ['fs.read'], workspaces: ['workspace:root'], paths: ['**'], secrets: [] },
  limits: { cpuMs: 10_000, memoryBytes: 1_000_000, outputBytes: 1_000_000, concurrentOps: 4, processes: 0 },
  expiresAt: '2099-01-01T00:00:00.000Z',
  epoch: 1,
};

const program: Program = {
  isa: 'xio/1', requestId: 'plan-request', programId: 'plan-program', mode: 'plan', capability: capability.id,
  workspace: 'workspace:root', instructions: [{
    id: 'read', op: 'fs.read', args: { workspace: 'workspace:root', path: 'README.md' },
    dependsOn: [], precondition: [], output: 'read-result',
  }],
};

describe('ISA plan mode', () => {
  it('returns schema, dependency, resource and driver evidence without executing', () => {
    const report = executePlan(program, {
      capability,
      availableCapabilities: ['filesystem.read', 'artifact.put'],
      drivers: [{ name: 'node.filesystem' }, { name: 'artifact.store' }],
    });
    expect(report.status).toBe('admitted');
    expect(report.schema).toEqual({ id: 'xio://schema/isa-v1/program', version: '1.0' });
    expect(report.dependencies).toEqual({ read: [] });
    expect(report.resources?.instructionCount).toBe(1);
    expect(report.drivers[0]).toMatchObject({ status: 'available', selected: 'node.filesystem,artifact.store' });
    expect(report.issues).toEqual([]);
  });

  it('distinguishes rejected input from unsupported ISA or driver capabilities', () => {
    expect(planProgram({ ...program, isa: 'xio/1.1' }, { capability }).status).toBe('unsupported');
    expect(planProgram({ ...program, unexpected: true }, { capability }).status).toBe('rejected');
    expect(planProgram(program, { capability, drivers: [{ name: 'node.filesystem' }] }).status).toBe('unsupported');
  });

  it('does not silently plan transaction mode', () => {
    const report = planProgram({ ...program, mode: 'transaction' }, { capability });
    expect(report.status).toBe('rejected');
    expect(report.issues).toEqual(expect.arrayContaining([{ code: 'invalid_value', path: 'mode', message: 'planProgram only accepts mode=plan' }]));
  });
});
