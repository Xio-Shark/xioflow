#!/usr/bin/env node
// Executable wrapper that runs any black-box agent harness under `xio wrap` (dual-boundary gateway + reaper).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { wrapAgent } from '../../dist/index.js';

const argv = process.argv.slice(2);

if (argv[0] === '--xf-wrap-version') {
  const [, bin, ...versionArgs] = argv;
  const probe = spawnSync(bin, versionArgs, { encoding: 'utf8' });
  if (probe.error) process.exit(1);
  const line = (probe.stdout || probe.stderr || '').trim().split('\n')[0];
  if (!line) process.exit(1);
  process.stdout.write(`${line} (xio-wrap)\n`);
  process.exit(0);
}

let domainPath = path.join(process.env.HOME || process.cwd(), '.xioflow-wrap-domain');
let sepIdx = argv.indexOf('--');
for (let i = 0; i < (sepIdx >= 0 ? sepIdx : argv.length); i++) {
  if (argv[i] === '--xf-domain' && argv[i + 1]) {
    domainPath = argv[++i];
  }
}

const cmdSlice = sepIdx >= 0 ? argv.slice(sepIdx + 1) : argv;
const [command, ...cmdArgs] = cmdSlice;
if (!command) {
  process.stderr.write('wrap-bin: missing command\n');
  process.exit(64);
}

const result = await wrapAgent({
  command,
  args: cmdArgs,
  cwd: process.cwd(),
  env: process.env,
  domainPath,
  driver: 'reaper',
  inheritStdio: true,
  http304Cache: process.env.XIO_WRAP_HTTP304 === '1' ? undefined : false,
});

process.exit(result.exitCode ?? (result.signal ? 130 : 0));
