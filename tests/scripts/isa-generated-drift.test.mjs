import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps generated opcode source byte-identical to the existing generator output', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-isa-generated-drift-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'spec/isa-v1'), { recursive: true });
    fs.copyFileSync(path.join(root, 'spec/isa-v1/registry.json'), path.join(temporaryRoot, 'spec/isa-v1/registry.json'));
    const generated = spawnSync(process.execPath, [path.join(root, 'scripts/generate-isa-opcodes.mjs')], {
      cwd: temporaryRoot, encoding: 'utf8', timeout: 10_000,
    });
    expect({ exit: generated.status, error: generated.error?.message, stderr: generated.stderr }).toEqual({ exit: 0, error: undefined, stderr: '' });
    const relativePath = 'src/isa/opcodes.generated.ts';
    expect(fs.readFileSync(path.join(root, relativePath), 'utf8'))
      .toBe(fs.readFileSync(path.join(temporaryRoot, relativePath), 'utf8'));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
