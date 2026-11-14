#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootBuild = path.resolve(here, '../../scripts/build-native.mjs');

execFileSync(process.execPath, [rootBuild, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
