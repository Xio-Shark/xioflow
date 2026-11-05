import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileArtifactGet,
  compileArtifactPut,
  compileArtifactStream,
  compileExecuteProcess,
  compileWorkspaceDiff,
  compileWorkspaceRollback,
  compileWorkspaceSnapshot,
  validateProgram,
  type Capability,
} from '../../src/isa/index.js';

const capability: Capability = {
  id: 'cap:compiler-test', issuer: 'test', policyVersion: '1', reason: 'compiler test',
  scope: {
    opcodes: ['proc.spawn', 'proc.wait', 'workspace.snapshot', 'workspace.diff', 'workspace.rollback', 'artifact.put', 'artifact.get', 'artifact.stream'],
    workspaces: ['workspace:root'], paths: ['**'], secrets: [],
  },
  limits: { cpuMs: 10_000, memoryBytes: 1_000_000, outputBytes: 1_000_000, concurrentOps: 16, processes: 4 },
  expiresAt: '2099-01-01T00:00:00.000Z',
  epoch: 1,
};

const identity = { requestId: 'request-1', programId: 'program-1', workspace: 'workspace:root' as const, capability: capability.id };

describe('ISA capability compilers', () => {
  it('matches the process golden Program and does not include undefined JSON fields', () => {
    const program = compileExecuteProcess({ ...identity, id: 'build', argv: ['node', '-e', '0'], cwd: 'workspace:root', timeoutMs: 100 });
    const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/compile-process.json'), 'utf8'));
    expect(program).toEqual(fixture);
    expect(JSON.stringify(program)).not.toContain('undefined');
  });

  it('compiles workspace and artifact helpers into one-op Programs only', () => {
    const programs = [
      compileWorkspaceSnapshot({ ...identity, label: 'base', roots: ['src'] }),
      compileWorkspaceDiff({ ...identity, from: 'snapshot:base', to: 'snapshot:current' }),
      compileWorkspaceRollback({ ...identity, snapshot: 'snapshot:base' }),
      compileArtifactPut({ ...identity, content: 'hello', mediaType: 'text/plain' }),
      compileArtifactGet({ ...identity, artifact: 'artifact:one', range: { start: 0, end: 5 } }),
      compileArtifactStream({ ...identity, artifact: 'artifact:one', maxBytes: 5 }),
    ];
    expect(programs.map((program) => program.instructions[0]?.op)).toEqual([
      'workspace.snapshot', 'workspace.diff', 'workspace.rollback', 'artifact.put', 'artifact.get', 'artifact.stream',
    ]);
    for (const program of programs) {
      const result = validateProgram(program, { capability, availableCapabilities: ['workspace.snapshot', 'workspace.read', 'filesystem.read', 'workspace.rollback', 'filesystem.write', 'artifact.put', 'artifact.get'] });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
  });
});
