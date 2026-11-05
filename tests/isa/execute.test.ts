import { describe, expect, it } from 'vitest';
import { execute } from '../../src/index.js';
import type { Capability, Program } from '../../src/isa/index.js';

const capability: Capability = {
  id: 'cap:execute-test', issuer: 'test', policyVersion: '1', reason: 'execute test',
  scope: { opcodes: ['fs.read'], workspaces: ['workspace:root'], paths: ['**'], secrets: [] },
  limits: { cpuMs: 10_000, memoryBytes: 1_000_000, outputBytes: 1_000_000, concurrentOps: 4, processes: 0 },
  expiresAt: '2099-01-01T00:00:00.000Z',
  epoch: 1,
};

const plan: Program = {
  isa: 'xio/1', requestId: 'execute-request', programId: 'execute-program', mode: 'plan', capability: capability.id,
  workspace: 'workspace:root', instructions: [{
    id: 'read', op: 'fs.read', args: { workspace: 'workspace:root', path: 'README.md' }, dependsOn: [], precondition: [], output: 'read-result',
  }],
};

describe('stable ISA execute façade', () => {
  it('routes plan mode to the zero-side-effect plan report', async () => {
    const result = await execute(plan, { capability, availableCapabilities: ['filesystem.read', 'artifact.put'] });
    expect(result.status).toBe('admitted');
  });

  it('requires an explicit pipeline executor and keeps transaction unsupported', async () => {
    const pipeline = await execute({ ...plan, mode: 'pipeline' }, { capability });
    expect(pipeline.status).toBe('unsupported');
    const transaction = await execute({ ...plan, mode: 'transaction' }, { capability });
    expect(transaction.status).toBe('unsupported');
  });
});
