import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Builds the reaper helper from the checked-in source once per source revision.
 * A missing compiler fails the test run instead of skipping the driver's tests.
 */
export function buildReaperHelper(): string {
  const source = fs.readFileSync(path.join(repoRoot, 'native/reaper/xioflow-reaper.c'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const outDir = path.join(os.tmpdir(), `xioflow-reaper-${process.platform}-${process.arch}-${digest}`);
  const helper = path.join(outDir, 'xioflow-reaper');
  if (!fs.existsSync(helper)) {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts/build-native.mjs'), '--out', outDir], {
      stdio: 'inherit',
    });
  }
  return helper;
}
