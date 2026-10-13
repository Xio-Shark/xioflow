import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ReaperPlatformDriver } from '../../src/driver/reaper-driver.js';
import { buildReaperHelper } from '../support/reaper-helper.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import type { ManagedProcessHandle } from '../../src/driver/types.js';
import type { ServiceHandle, ServiceSpec } from '../../src/types.js';

const helperPath = buildReaperHelper();

describe('domain-wide service ownership', () => {
  let root: string;
  let domain: ExecutionDomain;
  const handles = new Set<ServiceHandle>();
  const processes = new Set<ManagedProcessHandle>();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-service-coordination-'));
    domain = ExecutionDomain.acquire(root, 'services');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'services', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(async () => {
    try { await Promise.all([...handles].map((handle) => handle.stop(100))); }
    finally {
      handles.clear();
      for (const processHandle of processes) {
        processHandle.destroyGate?.();
        try { process.kill(-processHandle.identity.pid, 'SIGKILL'); } catch (error: any) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      processes.clear(); domain.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function spec(): ServiceSpec {
    return {
      serviceId: 'shared-service', runId: 'run', readiness: 'spawned',
      command: { execPath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root },
      requiredResources: ['port:shared'],
    };
  }

  it('joins service handles across supervisors and stops with the original driver', async () => {
    const firstDriver = new ReaperPlatformDriver({ helperPath });
    const secondDriver = new NodePlatformDriver();
    const firstStop = vi.spyOn(firstDriver, 'terminate');
    const secondStop = vi.spyOn(secondDriver, 'terminate');
    const firstSpawn = vi.spyOn(firstDriver, 'spawn');
    const secondSpawn = vi.spyOn(secondDriver, 'spawn');
    const first = new ProcessSupervisor(domain, firstDriver);
    const second = new ProcessSupervisor(domain, secondDriver);
    const handle = await first.startService(spec());
    handles.add(handle);
    await handle.ready;
    const joined = await second.startService(spec());
    expect(joined).toBe(handle);
    expect(firstSpawn).toHaveBeenCalledTimes(1);
    expect(secondSpawn).not.toHaveBeenCalled();
    expect(domain.isResourceLocked('port:shared')).toBe(true);
    await joined.stop(100);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();
    expect(domain.isResourceLocked('port:shared')).toBe(false);
  });

  it('rejects conflicting service configuration without disturbing the live lease', async () => {
    const first = new ProcessSupervisor(domain);
    const second = new ProcessSupervisor(domain);
    const original = spec();
    const handle = await first.startService(original);
    handles.add(handle);
    await handle.ready;
    await expect(second.startService({
      ...original, command: { ...original.command, envWhiteList: { MODE: 'different' } },
    })).rejects.toThrow(/conflict/i);
    expect(domain.isResourceLocked('port:shared')).toBe(true);
    expect(domain.getStore().getOperation(handle.currentInstanceOpId)?.status).toBe('active');
  });

  it('joins equivalent restart policies regardless of object field order', async () => {
    const first = new ProcessSupervisor(domain);
    const second = new ProcessSupervisor(domain);
    const original = spec();
    const handle = await first.startService({
      ...original, restart: { policy: 'on-failure', maxRestarts: 2, backoffMs: 50 },
    });
    handles.add(handle);
    await handle.ready;
    const joined = await second.startService({
      ...original, restart: { backoffMs: 50, maxRestarts: 2, policy: 'on-failure' },
    });
    expect(joined).toBe(handle);
  });

  it.each([0, 3])('settles stop after the service naturally exits with code %s', async (code) => {
    const supervisor = new ProcessSupervisor(domain);
    const original = spec();
    const handle = await supervisor.startService({ ...original,
      command: { ...original.command, args: ['-e', `process.exit(${code})`] }, restart: 'never',
    });
    await handle.onInstanceExit;
    await handle.stop(100);
    expect(domain.isResourceLocked('port:shared')).toBe(false);
    expect(domain.getStore().getOperation(handle.currentInstanceOpId)?.status).toBe('done');
  }, 3000);

  it('rejects the joined readiness and exit observers when spawn fails', async () => {
    const driver = new NodePlatformDriver();
    const spawn = driver.spawn.bind(driver);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(driver, 'spawn').mockImplementation(async (command) => { await gate; return spawn(command); });
    const first = new ProcessSupervisor(domain, driver);
    const second = new ProcessSupervisor(domain);
    const original = spec();
    const missing = { ...original, command: { ...original.command, execPath: path.join(root, 'missing-executable') } };
    const starting = first.startService(missing);
    const rejectedStart = expect(starting).rejects.toThrow();
    const joined = await second.startService(missing);
    const rejectedReady = expect(joined.ready).rejects.toThrow();
    const rejectedExit = expect(joined.onInstanceExit).rejects.toThrow();
    release();
    await rejectedStart;
    await rejectedReady;
    await rejectedExit;
    await joined.stop(100);
    expect(domain.isResourceLocked('port:shared')).toBe(false);
    expect(domain.getStore().getOperation(joined.currentInstanceOpId)?.result?.status).toBe('failed');
  }, 3000);

  it.each([false, true])('cleans up failed identity registration, keeping leases when stop is unconfirmed: %s', async (unconfirmed) => {
    const driver = new ReaperPlatformDriver({ helperPath });
    const spawn = driver.spawn.bind(driver);
    vi.spyOn(driver, 'spawn').mockImplementation(async (command) => {
      const handle = await spawn(command); processes.add(handle); return handle;
    });
    if (unconfirmed) {
      const terminate = driver.terminate.bind(driver);
      vi.spyOn(driver, 'terminate').mockImplementation(async (identity, graceMs) => {
        const result = await terminate(identity, graceMs);
        return { ...result, stopped: 'cannot_determine', errorDetails: 'injected unconfirmed evidence' };
      });
    }
    const store = domain.getStore();
    const update = store.updateOperationStatus.bind(store);
    vi.spyOn(store, 'updateOperationStatus').mockImplementation((...args) => {
      if (args[1] === 'active') throw new Error('injected identity registration failure');
      return update(...args);
    });
    const supervisor = new ProcessSupervisor(domain, driver);
    await expect(supervisor.startService(spec())).rejects.toThrow('injected identity registration failure');
    expect(domain.isResourceLocked('port:shared')).toBe(unconfirmed);
    expect(store.getOperation('shared-service#1')?.result?.status).toBe(unconfirmed ? 'indeterminate' : 'failed');
    if (!unconfirmed) {
      for (const handle of processes) expect(() => process.kill(handle.identity.pid, 0)).toThrow();
    }
  });
});
