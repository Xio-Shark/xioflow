import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Catalog declarations and runnable tests are separate inventories, not a partition. */
export function catalogInventory(markdown) {
  const entries = [];
  const seen = new Set();
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|\s*(L[1-4]|H)\s*\|(.+)\|\s*([^|]+)\|\s*$/u.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (seen.has(id)) throw new Error(`duplicate catalog contract: ${id}`);
    seen.add(id);
    const declaration = match[4].trim();
    const classification = /^S\d/u.test(declaration) ? 'shared'
      : declaration === 'R' ? 'internal'
        : /^(计划|Planned)/u.test(declaration) ? 'planned'
          : /^(已归档|Archived)/u.test(declaration) ? 'archived' : undefined;
    if (!classification) throw new Error(`unknown catalog declaration for ${id}: ${declaration}`);
    entries.push({ id, level: match[2], description: match[3].trim(), declaration, classification });
  }
  if (!entries.length) throw new Error('no numbered conformance catalog entries found');
  return entries;
}

export function runnableInventory(source) {
  const entries = [...source.matchAll(/\bit\(\s*'([^'\n]*契约\s+(\d+):[^'\n]*)'/gu)]
    .map((match) => ({ id: Number(match[2]), name: match[1] }));
  if (!entries.length) throw new Error('no runnable conformance definitions found');
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error('duplicate runnable conformance contract IDs');
  }
  return entries;
}

export function classifyResults(tests, raw, capabilities, executed) {
  const failed = new Set(raw?.failures.map((failure) => failure.test) ?? []);
  return tests.map((test) => {
    const requiredCapability = test.id === 37 ? 'memoryHardLimit' : test.id === 38 ? 'pidsLimit' : undefined;
    const unsupported = requiredCapability !== undefined && capabilities[requiredCapability] !== true;
    const status = !executed ? 'not_run' : failed.has(test.name) ? 'failed'
      : unsupported ? 'unsupported' : 'passed';
    return {
      ...test, status,
      ...(requiredCapability ? { requiredCapability } : {}),
      ...(unsupported ? { reason: `driver does not declare ${requiredCapability}` } : {}),
      ...(executed && unsupported && status !== 'failed' ? { admissionRejectionCheck: 'passed' } : {}),
    };
  });
}

export function reportStatus({ executed, exitCode, results, errors, skipped }) {
  if (!executed) return 'NOT_RUN';
  if (exitCode !== 0 || errors.length || results.some((entry) => entry.status === 'failed')) return 'FAIL';
  if (skipped || results.some((entry) => entry.status === 'not_run')) return 'PASS_WITH_CONCERNS';
  return 'PASS';
}

function readInputs() {
  const catalogSource = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
  const suiteSource = fs.readFileSync(path.join(root, 'src/testing/contract-suite.ts'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return {
    catalog: catalogInventory(catalogSource), tests: runnableInventory(suiteSource),
    suite: {
      package: packageJson.name, version: packageJson.version,
      sourceSha256: hash(suiteSource), catalogSha256: hash(catalogSource),
      sourceCommit: git.status === 0 ? git.stdout.trim() : null,
      sourceCommitError: git.status === 0 ? null : git.stderr.trim() || 'git revision unavailable',
    },
  };
}

function builtDigest(directory) {
  const digest = createHash('sha256');
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && name.endsWith('.js')) digest.update(name).update('\0').update(fs.readFileSync(path.join(directory, name))).update('\0');
    }
  };
  visit('');
  return digest.digest('hex');
}

export async function generateReport({ inventoryOnly = false } = {}) {
  const startedAt = new Date().toISOString();
  const inputs = readInputs();
  let driver = { name: 'NodePlatformDriver', capabilities: {} };
  let raw = null;
  let executed = false;
  let exitCode = null;
  let executionError = null;
  let buildSha256 = null;
  if (!inventoryOnly) {
    try {
      const runner = await import('../dist/testing/plain-runner.js');
      const kernel = await import('../dist/index.js');
      buildSha256 = builtDigest(path.join(root, 'dist'));
      process.env.XIOFLOW_EXPECT_READ_TRACKING ??= 'atime';
      runner.installPlainEnvironment();
      const { defineContractTestSuite } = await import('../dist/testing/contract-suite.js');
      const platformDriver = new kernel.NodePlatformDriver();
      driver = { name: platformDriver.name, capabilities: platformDriver.capabilities };
      // Detect stale dist without pretending the current source was executed.
      const builtSource = fs.readFileSync(path.join(root, 'dist/testing/contract-suite.js'), 'utf8');
      const builtNames = [...builtSource.matchAll(/\bit\(\s*'([^'\n]*契约\s+(\d+):[^'\n]*)'/gu)]
        .map((match) => match[1]);
      if (JSON.stringify(builtNames) !== JSON.stringify(inputs.tests.map((entry) => entry.name))) {
        throw new Error('built conformance inventory differs from source; run pnpm build first');
      }
      defineContractTestSuite('evidence report (NodePlatformDriver)', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-conformance-report-'));
        const domain = kernel.ExecutionDomain.acquire(tempDir, 'conformance-report');
        const instanceDriver = new kernel.NodePlatformDriver();
        const supervisor = new kernel.ProcessSupervisor(domain, instanceDriver);
        return {
          domain, driver: instanceDriver, supervisor, tempDir, workflowType: 'headless',
          cleanup: async () => { domain.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
        };
      });
      executed = true;
      raw = await runner.runPlainSuite({ consumerName: 'conformance evidence report', quiet: true });
      const expected = inputs.tests.length;
      if (raw.passed + raw.failed + raw.skipped !== expected || raw.skipped !== 0) {
        throw new Error(`unexpected suite coverage: ${JSON.stringify({ expected, passed: raw.passed, failed: raw.failed, skipped: raw.skipped })}`);
      }
      exitCode = raw.failed || raw.errors.length ? 1 : 0;
    } catch (error) {
      exitCode = 1;
      executionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  const results = classifyResults(inputs.tests, raw, driver.capabilities, executed && raw !== null && executionError === null);
  const counts = Object.fromEntries(['passed', 'failed', 'unsupported', 'not_run']
    .map((status) => [status, results.filter((entry) => entry.status === status).length]));
  const errors = [...(raw?.errors ?? []), ...(executionError ? [{ phase: 'suite', error: executionError }] : [])];
  return {
    schemaVersion: 'xio/conformance-report/1',
    status: reportStatus({ executed: !inventoryOnly, exitCode, results, errors, skipped: raw?.skipped ?? 0 }),
    startedAt, finishedAt: new Date().toISOString(), suite: { ...inputs.suite, buildSha256 },
    environment: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), driver },
    command: { argv: [process.execPath, ...process.argv.slice(1)], cwd: process.cwd(), executed, exitCode },
    inventory: {
      catalog: { count: inputs.catalog.length, entries: inputs.catalog },
      runnable: { count: inputs.tests.length, entries: results },
      archived: inputs.catalog.filter((entry) => entry.classification === 'archived').map((entry) => entry.id),
      planned: inputs.catalog.filter((entry) => entry.classification === 'planned').map((entry) => entry.id),
      internalOnly: inputs.catalog.filter((entry) => entry.classification === 'internal').map((entry) => entry.id),
      unsupported: results.filter((entry) => entry.status === 'unsupported').map((entry) => entry.id),
    },
    counts, raw, errors,
    limitations: [
      'Catalog declarations and registered suite tests are independent views; their counts must not be added.',
      'Unsupported hard-limit features are not passed; a successful admission-rejection check is recorded separately.',
      'This report covers NodePlatformDriver only, not cgroup enforcement or other platforms.',
      'A source commit identifies ancestry; uncommitted source is identified by the suite and catalog hashes.',
      'The build hash identifies executed JavaScript; matching test names alone does not prove every source body was freshly compiled. Run pnpm build immediately before this command.',
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const inventoryOnly = args.includes('--inventory-only');
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const known = args.filter((arg, index) => arg !== '--inventory-only' && arg !== '--output' && !(outputIndex >= 0 && index === outputIndex + 1));
  if (known.length || (outputIndex >= 0 && (!output || output.startsWith('--')))) {
    throw new Error('usage: node scripts/conformance-report.mjs [--inventory-only] [--output PATH]');
  }
  const report = await generateReport({ inventoryOnly });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, text, { flag: 'wx' });
    process.stdout.write(`${report.status}: ${path.resolve(output)}\n`);
  } else process.stdout.write(text);
  process.exitCode = report.status === 'FAIL' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
