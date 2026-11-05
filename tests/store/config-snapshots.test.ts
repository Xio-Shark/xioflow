import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } from '../../src/index.js';
import { assertRequestConfigSnapshot, createRequestConfigSnapshot } from '../../src/config/snapshot.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('immutable request configuration snapshots', () => {
  it('binds schema, capability, driver, retention and redaction facts across reopen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-config-snapshot-'));
    roots.push(root);
    let domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'config');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: 'config', name: 'config', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: 'config', owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    const driver = new NodePlatformDriver();
    const supervisor = new ProcessSupervisor(domain, driver);
    const result = await supervisor.executeProcess({
      runId: 'run', opId: 'config-op', name: 'config-op',
      command: { execPath: process.execPath, args: ['-e', 'process.stdout.write("ok")'], cwd: root, envWhiteList: { API_TOKEN: 'never-persist' } },
    });
    expect(result.status).toBe('succeeded');

    const operationSnapshot = store.getOperation('config-op')?.configSnapshot;
    const runSnapshot = store.getRun('run')?.configSnapshot;
    expect(operationSnapshot).toBeDefined();
    expect(operationSnapshot).toEqual(runSnapshot);
    expect(operationSnapshot).toMatchObject({
      schemaVersion: 'xio/config/1',
      driverName: driver.name,
      driverVersion: `${driver.name}/1.0`,
      retentionVersion: 'xio/retention/1',
      redactionVersion: 'xio/redaction/1',
      config: { command: { envKeys: ['API_TOKEN'], secretEnvKeys: [] } },
    });
    expect(JSON.stringify(operationSnapshot)).not.toContain('never-persist');
    assertRequestConfigSnapshot(operationSnapshot!);

    const digest = operationSnapshot!.digest;
    domain.close();
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'config');
    expect(domain.getStore().getOperation('config-op')?.configSnapshot?.digest).toBe(digest);
    expect(domain.getStore().getRun('run')?.configSnapshot?.digest).toBe(digest);
    domain.close();
  });

  it('rejects a tampered snapshot digest before it can be used', () => {
    const driver = new NodePlatformDriver();
    const snapshot = createRequestConfigSnapshot({ driver, config: { timeoutMs: 1000 } });
    expect(() => assertRequestConfigSnapshot({ ...snapshot, driverName: 'replacement-driver' })).toThrow(/digest mismatch/);
    expect(() => assertRequestConfigSnapshot({ ...snapshot, createdAt: new Date(0).toISOString() })).toThrow(/digest mismatch/);
    expect(() => assertRequestConfigSnapshot({ ...snapshot, config: undefined as never })).toThrow(/config is invalid/);
  });
});

