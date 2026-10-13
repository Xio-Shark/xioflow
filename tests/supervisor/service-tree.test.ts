import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '../../src/index.js';
import { buildReaperHelper } from '../support/reaper-helper.js';
import type { ProcessIdentity } from '../../src/driver/types.js';

const helperPath = buildReaperHelper();

describe('service process-tree settlement', () => {
  let root: string;
  let domain: ExecutionDomain;
  let driver: ReaperPlatformDriver;
  let identity: ProcessIdentity | undefined;
  let childPid = 0;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-service-tree-'));
    domain = ExecutionDomain.acquire(root, 'service-tree');
    driver = new ReaperPlatformDriver({ helperPath });
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (identity) await driver.terminate(identity, 100);
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
    }
    identity = undefined; childPid = 0;
    domain.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('settles descendants after natural root exit before releasing service leases (unconfirmed=%s)', async (unconfirmed) => {
    if (unconfirmed) {
      const terminate = driver.terminate.bind(driver);
      vi.spyOn(driver, 'terminate').mockImplementation(async (id, graceMs) => {
        const actual = await terminate(id, graceMs);
        return { ...actual, stopped: 'cannot_determine', errorDetails: 'injected missing stop receipt' };
      });
    }
    const supervisor = new ProcessSupervisor(domain, driver);
    const pidFile = path.join(root, 'child.pid');
    const handle = await supervisor.startService({
      serviceId: 'tree', runId: 'run', readiness: 'spawned', requiredResources: ['service-resource'],
      command: { execPath: process.execPath, cwd: root, args: ['-e', `
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        child.unref();
      `] },
    });
    identity = domain.getStore().getOperation(handle.currentInstanceOpId)?.processIdentity;
    await handle.onInstanceExit;
    childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const result = domain.getStore().getOperation(handle.currentInstanceOpId)?.result;
    expect(result?.status).toBe(unconfirmed ? 'indeterminate' : 'succeeded');
    expect(domain.isResourceLocked('service-resource')).toBe(unconfirmed);
    if (!unconfirmed) {
      expect(result).toMatchObject({ treeSettlement: 'reaped', residualProcessesReaped: true });
      await vi.waitFor(() => { expect(() => process.kill(childPid, 0)).toThrow(); });
    }
    await handle.stop(100);
  });
});
