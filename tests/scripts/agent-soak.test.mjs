import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('soak failure evidence', () => {
  it('fails visibly at the RSS stop gate and retains its journal for diagnosis', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-soak-evidence-test-'));
    roots.push(root);
    const output = path.join(root, 'result.json');
    const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../scripts/agent-soak.mjs')], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, XIOFLOW_SOAK_PROFILE: '24h', XIOFLOW_SOAK_SECONDS: '1',
        XIOFLOW_SOAK_ROOT: root, XIOFLOW_SOAK_OUTPUT: output, XIOFLOW_SOAK_MAX_RSS_BYTES: '1',
        XIOFLOW_SOAK_DRIVER: 'node', XIOFLOW_EXPECT_CGROUP: '0' },
    });
    expect(run.error).toBeUndefined();
    expect(run.status).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(report).toMatchObject({ status: 'FAIL', completedTargetDuration: false, targetDurationSeconds: 86_400 });
    expect(report.error.message).toContain('RSS stop gate exceeded');
    expect(report.peakRss).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(report.domainPath, 'domain.db'))).toBe(true);
    expect(run.stderr).toContain('Soak evidence retained at');
  });
});
