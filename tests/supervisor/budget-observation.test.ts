import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '../../src/index.js';
import { buildReaperHelper } from '../support/reaper-helper.js';
import type { PlatformDriver } from '../../src/driver/types.js';

const helperPath = buildReaperHelper();

describe('resource observation failures', () => {
  let root: string;
  let domain: ExecutionDomain;
  let driver: ReaperPlatformDriver;
  let supervisor: ProcessSupervisor;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-budget-observation-'));
    domain = ExecutionDomain.acquire(root, 'budget-observation');
    driver = new ReaperPlatformDriver({ helperPath });
    supervisor = new ProcessSupervisor(domain, driver);
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    vi.spyOn(driver, 'sampleMetrics').mockRejectedValue(new Error('injected resource observation failure'));
  });
  afterEach(() => { domain.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('stops a soft-budget operation when its limit cannot be observed, even if SIGINT exits zero', async () => {
    const result = await supervisor.executeProcess({
      runId: 'run', opId: 'soft', name: 'soft budget', requiredResources: ['workspace'], timeoutMs: 2000,
      command: { execPath: process.execPath, cwd: root, args: ['-e', 'process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000)'] },
      resourceBudget: { enforcement: 'soft', maxMemoryBytes: 2 ** 30 },
    });
    assert(result.kind === 'process');
    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('observation_failed');
    expect(result.resourceSamplingError).toContain('injected resource observation failure');
    expect(result.peakMemoryBytes).toBeUndefined();
    expect(result.cpuTimeMs).toBeUndefined();
    expect(domain.isResourceLocked('workspace')).toBe(false);
  });

  it('reports unavailable observe-only measurements without substituting zero or stopping the command', async () => {
    const result = await supervisor.executeProcess({
      runId: 'run', opId: 'observe', name: 'observe', timeoutMs: 2000,
      command: { execPath: process.execPath, cwd: root, args: ['-e', 'setTimeout(() => process.stdout.write("completed"), 250)'] },
      resourceBudget: { enforcement: 'observe' },
    });
    assert(result.kind === 'process');
    expect(result.status).toBe('succeeded');
    expect(result.stdout).toBe('completed');
    expect(result.resourceSamplingError).toContain('injected resource observation failure');
    expect(result.peakMemoryBytes).toBeUndefined();
    expect(result.cpuTimeMs).toBeUndefined();
  });

  it('rejects a soft measured limit before launch when the driver has no metric observer', async () => {
    const unsupported: PlatformDriver = {
      name: 'no-metric-observer', capabilities: driver.capabilities,
      spawn: driver.spawn.bind(driver), terminate: driver.terminate.bind(driver),
      verifyIdentity: driver.verifyIdentity.bind(driver), settleTree: driver.settleTree.bind(driver),
    };
    const caller = new ProcessSupervisor(domain, unsupported);
    const marker = path.join(root, 'unexpected');
    await expect(caller.executeProcess({
      runId: 'run', opId: 'unsupported', name: 'unsupported budget',
      command: { execPath: process.execPath, cwd: root, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`] },
      resourceBudget: { enforcement: 'soft', maxMemoryBytes: 2 ** 30 },
    })).rejects.toThrow(/resourceMetrics/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(domain.getStore().getOperation('unsupported')).toBeNull();
  });
});
