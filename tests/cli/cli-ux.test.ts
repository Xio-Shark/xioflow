import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelMedium } from '../../src/kernel/index.js';
import { buildDist, repoRoot } from '../support/build-dist.js';

buildDist();

describe('CLI ergonomics (help, version, doctor, prune)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-cli-ux-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runCli = (args: string[], cwd: string = root) =>
    spawnSync(process.execPath, [path.join(repoRoot, 'dist/cli.js'), ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
    });

  it('preserves empty stdout / stderr usage on bare invocation and prints stdout on --help / --version', () => {
    const bare = runCli([]);
    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toContain('OS Medium & Arbiter:');

    for (const flag of ['--help', '-h', 'help']) {
      const help = runCli([flag]);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stderr).toBe('');
      expect(help.stdout).toContain('xio doctor');
      expect(help.stdout).toContain('xio prune');
    }

    for (const flag of ['--version', '-v']) {
      const ver = runCli([flag]);
      expect(ver.status, ver.stderr).toBe(0);
      expect(ver.stderr).toBe('');
      expect(ver.stdout).toMatch(/^@xioflow\/kernel v\d+\.\d+\.\d+/);
    }

    const unknown = runCli(['--does-not-exist']);
    expect(unknown.status).toBe(64);
  });

  it('reports host readiness in doctor --json without creating domain files', () => {
    const res = runCli(['doctor', '--workspace', root, '--domain', path.join(root, '.xioflow-kernel'), '--json']);
    expect(res.status, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.node.supported).toBe(true);
    expect(typeof report.git.available).toBe('boolean');
    expect(Array.isArray(report.confinement.availableDrivers)).toBe(true);
    expect(typeof report.arbiterSocket.directPathBytes).toBe('number');
    expect(fs.existsSync(path.join(root, '.xioflow-kernel'))).toBe(false);
  });

  it('skips missing domains cleanly and prunes stale blobs/forks when domain exists', async () => {
    const domainPath = path.join(root, '.xioflow-kernel');
    const emptyPrune = runCli(['prune', '--workspace', root, '--domain', domainPath, '--json']);
    expect(emptyPrune.status, emptyPrune.stderr).toBe(0);
    expect(JSON.parse(emptyPrune.stdout).skipped).toBe(true);
    expect(fs.existsSync(domainPath)).toBe(false);

    const medium = await KernelMedium.open(root, { domainPath });
    try {
      const spilled = await medium.exec({
        cmd: `${JSON.stringify(process.execPath)} -e "process.stdout.write('Z'.repeat(20000))"`,
      });
      expect(spilled.stdoutTruncated).toBe(true);
    } finally {
      await medium.close();
    }

    const orphanFork = path.join(domainPath, 'forks', 'tx-cli-orphan');
    fs.mkdirSync(orphanFork, { recursive: true });
    fs.writeFileSync(path.join(orphanFork, 'tmp.txt'), 'orphan', 'utf8');

    const pruned = runCli(['prune', '--workspace', root, '--domain', domainPath, '--max-age-hours', '0', '--json']);
    expect(pruned.status, pruned.stderr).toBe(0);
    const summary = JSON.parse(pruned.stdout);
    expect(summary.deletedBlobs).toBeGreaterThanOrEqual(1);
    expect(summary.deletedForks).toBe(1);
    expect(fs.existsSync(orphanFork)).toBe(false);
  });
});
