import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDist, repoRoot } from '../support/build-dist.js';
import { execute } from '../../src/isa/execute.js';
import type { Program } from '../../src/isa/types.js';

buildDist();

describe('CLI ISA preview adapter', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-cli-isa-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const program: Program = {
    isa: 'xio/1', requestId: 'request', programId: 'program', mode: 'pipeline',
    instructions: [{ id: 'health', op: 'control.health', args: {}, dependsOn: [], precondition: [], output: 'health' }],
  };
  const run = (command: string, input: unknown) => spawnSync(process.execPath, [path.join(repoRoot, 'dist/cli.js'), command, '--input', '-'], {
    cwd: root, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
  });

  it('plans stdin through the same core with no execution files or locks', async () => {
    const result = run('plan', program);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(await execute(program, { mode: 'plan', requireCapability: false }));
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('returns the unbound pipeline result unchanged and exits nonzero', async () => {
    const result = run('execute', program);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(await execute(program));
    expect(JSON.parse(result.stdout).status).toBe('unsupported');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reports rejected and unsupported inputs without pretending success', () => {
    const invalid = run('plan', { ...program, unexpected: true });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).status).toBe('rejected');
    const transaction = run('execute', { ...program, mode: 'transaction' });
    expect(transaction.status).toBe(1);
    expect(JSON.parse(transaction.stdout).status).toBe('unsupported');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
