import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { catalogInventory, classifyResults, reportStatus, runnableInventory } from '../../scripts/conformance-report.mjs';

describe('conformance evidence boundaries', () => {
  it('keeps planned and archived declarations separate from registered tests', () => {
    const catalog = catalogInventory('| 1 | L1 | shared | S1 |\n| 2 | L3 | future | 计划 |\n| 3 | L4 | old | 已归档（daemon） |');
    expect(catalog.map((entry) => entry.classification)).toEqual(['shared', 'planned', 'archived']);
    expect(runnableInventory("it('契约 1: actual', async () => {});")).toEqual([{ id: 1, name: '契约 1: actual' }]);
    expect(() => catalogInventory('| 1 | L1 | unknown | maybe |')).toThrow('unknown catalog');
    expect(() => catalogInventory('| 1 | L1 | first | S1 |\n| 1 | L1 | duplicate | S1 |')).toThrow('duplicate');
  });

  it('never promotes unsupported hard limits to passed', () => {
    const tests = [{ id: 37, name: 'memory' }, { id: 38, name: 'pids' }, { id: 1, name: 'spawn' }];
    const raw = { failures: [], errors: [] };
    expect(classifyResults(tests, raw, { memoryHardLimit: false, pidsLimit: false }, true)).toMatchObject([
      { status: 'unsupported', admissionRejectionCheck: 'passed' },
      { status: 'unsupported', admissionRejectionCheck: 'passed' },
      { status: 'passed' },
    ]);
    expect(classifyResults(tests, raw, {}, false).every((entry) => entry.status === 'not_run')).toBe(true);
  });

  it('preserves failure when an unsupported-capability rejection check fails', () => {
    expect(classifyResults([{ id: 37, name: 'memory' }], { failures: [{ test: 'memory' }] }, {}, true))
      .toEqual([{ id: 37, name: 'memory', status: 'failed', requiredCapability: 'memoryHardLimit', reason: 'driver does not declare memoryHardLimit' }]);
  });

  it('fails closed on command or background errors even if tests otherwise passed', () => {
    const passed = { executed: true, exitCode: 0, results: [{ status: 'passed' }], errors: [], skipped: 0 };
    expect(reportStatus(passed)).toBe('PASS');
    expect(reportStatus({ ...passed, exitCode: 1 })).toBe('FAIL');
    expect(reportStatus({ ...passed, errors: [{ phase: 'unhandledRejection', error: 'failure' }] })).toBe('FAIL');
    expect(reportStatus({ ...passed, results: [{ status: 'not_run' }] })).toBe('PASS_WITH_CONCERNS');
    expect(reportStatus({ ...passed, executed: false, exitCode: null })).toBe('NOT_RUN');
  });

  it('rejects an unknown CLI option before executing the suite', () => {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../scripts/conformance-report.mjs'), '--unknown'], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage: node scripts/conformance-report.mjs');
    expect(result.stdout).toBe('');
  });
});
