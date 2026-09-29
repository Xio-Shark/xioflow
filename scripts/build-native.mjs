#!/usr/bin/env node
/**
 * Builds the xioflow-reaper helper for the current platform.
 *
 *   node scripts/build-native.mjs [--out <dir>] [--arch <x86_64|arm64>]
 *
 * Default output: dist/native/<platform>-<arch>/xioflow-reaper, the path
 * `locateReaperHelper()` resolves from the published package. `--arch` cross
 * compiles on macOS (clang -arch); CC overrides the compiler. Fails loudly: a
 * missing compiler or a warning is an error, never a silently absent helper.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'native/reaper/xioflow-reaper.c');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error(`xioflow-reaper: unsupported platform ${process.platform}`);
  process.exit(1);
}

const crossArch = arg('--arch');
const nodeArch = crossArch ? { x86_64: 'x64', arm64: 'arm64' }[crossArch] : process.arch;
if (!nodeArch) {
  console.error(`xioflow-reaper: unknown --arch ${crossArch}`);
  process.exit(1);
}
if (crossArch && process.platform !== 'darwin') {
  console.error('xioflow-reaper: --arch cross compilation is only supported on macOS');
  process.exit(1);
}

const outDir = path.resolve(arg('--out') ?? path.join(repoRoot, 'dist/native', `${process.platform}-${nodeArch}`));
fs.mkdirSync(outDir, { recursive: true });
const output = path.join(outDir, 'xioflow-reaper');
const cc = process.env.CC || 'cc';
const flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
// Linux: static so one binary runs on any libc (glibc versions, musl/Alpine); the helper needs no NSS.
if (process.platform === 'linux') flags.push('-static');
if (crossArch) flags.push('-arch', crossArch);

// stdout stays clean: `npm pack --json` runs this from prepack and parses stdout.
execFileSync(cc, [...flags, '-o', output, source], { stdio: ['ignore', 2, 2] });
fs.chmodSync(output, 0o755);
console.error(`built ${path.relative(repoRoot, output)}`);
