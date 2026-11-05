import { describe, expect, it } from 'vitest';
import {
  assertValidProgram,
  lookupOpcode,
  ProgramValidationError,
  validateProgram,
  type Capability,
  type Program,
} from '../../src/isa/index.js';

const capability: Capability = {
  id: 'cap:validator-test',
  issuer: 'test',
  policyVersion: '1',
  reason: 'validator test',
  scope: {
    opcodes: ['fs.read', 'fs.write'],
    workspaces: ['workspace:root'],
    paths: ['**'],
    secrets: [],
  },
  limits: { cpuMs: 10_000, memoryBytes: 1_000_000, outputBytes: 1_000_000, concurrentOps: 8, processes: 2 },
  expiresAt: '2099-01-01T00:00:00.000Z',
  epoch: 1,
};

function baseProgram(): Program {
  return {
    isa: 'xio/1',
    requestId: 'request-1',
    programId: 'program-1',
    mode: 'plan',
    capability: capability.id,
    workspace: 'workspace:root',
    instructions: [{
      id: 'read', op: 'fs.read',
      args: { workspace: 'workspace:root', path: 'README.md' },
      dependsOn: [], precondition: [], output: 'read-result',
    }],
  };
}

describe('ISA admission validator', () => {
  it('negotiates xio/1, resolves the opcode registry and predicts resources without side effects', () => {
    expect(lookupOpcode('fs.read')).toBe('fs.read');
    expect(lookupOpcode('unknown.op')).toBeUndefined();
    const result = validateProgram(baseProgram(), {
      capability,
      availableCapabilities: ['filesystem.read', 'artifact.put'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.negotiatedIsa).toBe('xio/1.0');
    expect(result.plan.resources.resourceCost).toEqual(['artifact.write', 'io.read']);
    expect(result.plan.resources.requiredCapabilities).toEqual(['artifact.put', 'filesystem.read']);
    expect(result.plan.capabilityPrecheck).toBe('complete');
  });

  it('rejects unknown fields, duplicate ids/outputs, unknown references and dependency cycles', () => {
    const program = baseProgram() as unknown as Record<string, unknown>;
    const instruction = (program.instructions as Array<Record<string, unknown>>)[0];
    program.unexpected = true;
    instruction.unexpected = true;
    instruction.id = 'second';
    instruction.output = 'same';
    instruction.dependsOn = ['second', 'missing'];
    instruction.precondition = [{ kind: 'instruction_status', instruction: 'missing', status: 'succeeded' }];
    (program.instructions as Array<Record<string, unknown>>).push({ ...instruction, id: 'second', output: 'same', dependsOn: ['second'] });
    const result = validateProgram(program, { capability });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'unknown_field', 'duplicate_id', 'duplicate_output', 'unknown_reference', 'dependency_cycle',
    ]));
  });

  it('fails closed for unsupported ISA minors, missing opIds and capability/resource violations', () => {
    const program = baseProgram() as unknown as Record<string, unknown>;
    program.isa = 'xio/1.1';
    const write = (program.instructions as Array<Record<string, unknown>>)[0];
    write.op = 'fs.write';
    write.args = { workspace: 'workspace:other', path: 'secret.txt', content: 'artifact:input' };
    const result = validateProgram(program, { capability, availableCapabilities: ['filesystem.read'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'unsupported_isa_minor', 'invalid_value', 'capability_denied',
    ]));
  });

  it('throws a structured error only when the caller requests assertion semantics', () => {
    expect(() => assertValidProgram({})).toThrow(ProgramValidationError);
  });
});
