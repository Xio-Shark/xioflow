import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const nodeTests = [
  'audit/interaction/view-watch.test.mjs',
  'audit/interaction/process-suite.test.mjs',
  'audit/interaction/action-suite.test.mjs',
  'audit/interaction/observation.test.mjs',
  'audit/interaction/research-budget.test.mjs',
  'audit/interaction/task-suite.test.mjs',
  'audit/interaction/model-budget.test.mjs',
];

async function runPhase(label, args) {
  process.stdout.write(`\n[test] ${label}: ${JSON.stringify([process.execPath, ...args])}\n`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) {
          process.stderr.write(`[test] ${label} terminated by ${signal}\n`);
          resolve(128 + (os.constants.signals[signal] ?? 1));
        } else resolve(code ?? 1);
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

async function main() {
  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
  // A partial source bundle must fail before any suite starts, not silently lose coverage.
  for (const file of [vitest, ...nodeTests.map((file) => path.join(root, file)), path.join(root, 'spec/isa-v1/registry.json')]) {
    if (!fs.statSync(file).isFile()) throw new Error(`Required test input is not a file: ${file}`);
  }
  const actual = fs.readdirSync(path.join(root, 'audit/interaction'))
    .filter((file) => file.endsWith('.test.mjs')).map((file) => `audit/interaction/${file}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...nodeTests].sort())) {
    throw new Error('Native research test inventory changed; update scripts/test.mjs explicitly');
  }
  const args = process.argv.slice(2);
  // pnpm may preserve an explicit separator. All user arguments belong to Vitest only.
  if (args[0] === '--') args.shift();
  const vitestExit = await runPhase('Vitest', [vitest, 'run', ...args]);
  if (vitestExit !== 0) { process.exitCode = vitestExit; return; }
  process.exitCode = await runPhase('Node research tests (local fixtures only)', ['--test', '--test-concurrency=1', ...nodeTests]);
}

await main().catch((error) => {
  process.stderr.write(`[test] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
