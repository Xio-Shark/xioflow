#!/usr/bin/env node
/**
 * Pack-and-install verification.
 *
 * Proves @xioflow/kernel is consumable as a published package (built entry points,
 * files whitelist, zero runtime dependencies) instead of only working from sources
 * inside this repository. Fails loudly on any missing artifact or failed check.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = repoRoot;
const consumerSrc = path.join(repoRoot, 'scripts/pack-smoke/consumer.mjs');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

console.log('1/4 build');
run('npm', ['run', 'build'], pkgDir);

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-pack-'));
const packDir = path.join(staging, 'pack');
const appDir = path.join(staging, 'app');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });

console.log('2/4 npm pack');
const packRaw = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
  cwd: pkgDir,
  encoding: 'utf8',
});
const [packInfo] = JSON.parse(packRaw);
const tarball = path.join(packDir, packInfo.filename);
console.log(`    ${packInfo.filename}: ${(packInfo.size / 1024).toFixed(1)} KiB, ${packInfo.entryCount} files`);

const packed = packInfo.files.map((file) => file.path).sort();
for (const required of [
  'LICENSE',
  'README.md',
  'package.json',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/testing/contract-suite.js',
  'dist/testing/contract-suite.d.ts',
]) {
  if (!packed.includes(required)) {
    throw new Error(`tarball is missing ${required}`);
  }
}
const leaked = packed.filter((file) => file.startsWith('src/') || file.startsWith('tests/') || file.startsWith('examples/'));
if (leaked.length > 0) {
  throw new Error(`tarball leaks repository-only files: ${leaked.join(', ')}`);
}

console.log('3/4 install into a clean project');
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: 'xioflow-embed-smoke', private: true, type: 'module' }, null, 2)
);
run('npm', ['install', tarball, '--no-audit', '--no-fund', '--silent'], appDir);
fs.copyFileSync(consumerSrc, path.join(appDir, 'consumer.mjs'));

console.log('4/4 run embedder contract checks');
run(process.execPath, ['consumer.mjs'], appDir);

// The ./testing subpath needs vitest, so it is validated in-repo rather than in the
// dependency-free staging app.
run(process.execPath, ['--input-type=module', '-e', "await import('./dist/testing/contract-suite.js')"], pkgDir);

fs.rmSync(staging, { recursive: true, force: true });
console.log(`\nPASS: ${packInfo.filename} installs clean and satisfies every embedder check`);
