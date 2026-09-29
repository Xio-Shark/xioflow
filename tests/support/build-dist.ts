import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '../..');

/** Builds dist/ from the current sources; tests that run the package in a child process need it. */
export function buildDist(): void {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
