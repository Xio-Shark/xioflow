import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDomain, NodePlatformDriver, RecoveryEngine, ResourceConflictError } from '../../src/index.js';

describe('durable recovery evidence', () => {
  let root: string;
  let domain: ExecutionDomain;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-recovery-evidence-'));
    domain = ExecutionDomain.acquire(root, 'recovery');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: 'recovery', name: 'task', createdAt: new Date().toISOString() });
    store.saveRun({
      id: 'run', taskId: 'task', domainId: 'recovery', owner: 'test',
      status: 'running', startedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function reopen() {
    domain.close();
    domain = ExecutionDomain.acquire(root, 'recovery');
  }

  function intent(spawnGated: boolean | undefined, kind: 'process' | 'service' = 'process', id = 'op') {
    domain.registerOperationIntent({
      id, runId: 'run', kind, name: id, inputFingerprint: 'fingerprint',
      requiredResources: ['res:workspace'], status: 'pending', spawnGated,
    });
  }

  it.each([false, undefined])('isolates missing identity when recorded gated spawn is %s', async (spawnGated) => {
    intent(spawnGated);
    reopen();
    // The recovery driver's capabilities are not evidence about the original launch.
    const driver = new NodePlatformDriver();
    const verify = vi.spyOn(driver, 'verifyIdentity');
    const terminate = vi.spyOn(driver, 'terminate');
    const report = await new RecoveryEngine(domain, driver).recover();
    expect(report.recoveredOperations).toEqual([
      { opId: 'op', action: 'isolated_indeterminate', resourcesReleased: false },
    ]);
    expect(domain.getStore().getOperation('op')?.result?.status).toBe('indeterminate');
    expect(domain.getStore().getRun('run')?.status).toBe('indeterminate');
    expect(verify).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(() => domain.allocateResources('another', ['res:workspace'])).toThrow(ResourceConflictError);
    reopen();
    await new RecoveryEngine(domain, driver).recover();
    expect(domain.isResourceLocked('res:workspace')).toBe(true);
    expect(domain.getStore().getJournalEvents('recovery').filter((event) =>
      event.operationId === 'op' && event.type === 'OPERATION_RESULT_RECORDED')).toHaveLength(1);
  });

  it('uses persisted gated evidence even when the recovery driver is not gated', async () => {
    intent(true);
    reopen();
    const driver = new NodePlatformDriver();
    driver.capabilities.gatedSpawn = false;
    const report = await new RecoveryEngine(domain, driver).recover();
    expect(report.recoveredOperations).toEqual([
      { opId: 'op', action: 'cleaned_unspawned', resourcesReleased: true },
    ]);
    expect(domain.isResourceLocked('res:workspace')).toBe(false);
    expect(domain.getStore().getOperation('op')).toMatchObject({ spawnGated: true });
    const event = domain.getStore().getJournalEvents('recovery')
      .find((entry) => entry.type === 'OPERATION_INTENT_REGISTERED');
    expect(event?.payload.spawnGated).toBe(true);
  });

  it('does not infer non-execution from gated evidence once the identity is recorded', async () => {
    intent(true);
    domain.getStore().updateOperationStatus('op', 'active', { pid: 99999999, spawnTime: new Date().toISOString() });
    const driver = new NodePlatformDriver();
    vi.spyOn(driver, 'verifyIdentity').mockResolvedValue('cannot_determine');
    const report = await new RecoveryEngine(domain, driver).recover();
    expect(report.recoveredOperations[0]?.action).toBe('isolated_indeterminate');
    expect(domain.isResourceLocked('res:workspace')).toBe(true);
  });

  it('isolates an active operation with missing identity instead of leaving it unfinished', async () => {
    intent(true);
    domain.getStore().updateOperationStatus('op', 'active');
    const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(report.recoveredOperations[0]?.action).toBe('isolated_indeterminate');
    expect(domain.getStore().getUnfinishedOperations('recovery')).toEqual([]);
    expect(domain.isResourceLocked('res:workspace')).toBe(true);
  });

  it('retains a service-level lease for an uncertain instance across repeated recovery', async () => {
    intent(false, 'service', 'service#nested#1');
    // Seed the persisted service-level lease supported by backoff recovery.
    const db = new DatabaseSync(path.join(root, 'domain.db'));
    try {
      db.prepare('INSERT INTO resource_leases (resource_id, operation_id, domain_id, acquired_at) VALUES (?, ?, ?, ?)')
        .run('res:service', 'service:service#nested', 'recovery', new Date().toISOString());
    } finally {
      db.close();
    }
    for (let i = 0; i < 2; i++) {
      reopen();
      const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
      expect(report.recoveredServices).toContainEqual({
        serviceId: 'service#nested', instanceOpIds: ['service#nested#1'],
        action: 'isolated_indeterminate', resourcesReleased: false,
      });
      expect(domain.isResourceLocked('res:workspace')).toBe(true);
      expect(domain.isResourceLocked('res:service')).toBe(true);
    }
  });

  it('does not classify a process as a service just because its operation ID contains #', async () => {
    intent(true, 'process', 'workflow#step');
    const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(report.recoveredServices).toEqual([]);
    expect(domain.getStore().getJournalEvents('recovery').filter((event) => event.type === 'SERVICE_STOPPED')).toEqual([]);
  });

  it('preserves a directly registered service ID without an instance suffix', async () => {
    intent(false, 'service', 'direct-service');
    const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(report.recoveredServices?.[0]?.serviceId).toBe('direct-service');
  });

  it('migrates a legacy database without inventing gated-spawn evidence', async () => {
    intent(undefined);
    domain.close();
    const db = new DatabaseSync(path.join(root, 'domain.db'));
    try {
      db.exec('ALTER TABLE operations DROP COLUMN spawn_gated');
    } finally {
      db.close();
    }
    domain = ExecutionDomain.acquire(root, 'recovery');
    expect(domain.getStore().getOperation('op')?.spawnGated).toBeUndefined();
    await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(domain.getStore().getOperation('op')?.result?.status).toBe('indeterminate');
    reopen();
    expect(domain.isResourceLocked('res:workspace')).toBe(true);
  });

  it('rejects malformed launch evidence instead of coercing it to a safety guarantee', () => {
    expect(() => intent('true' as unknown as boolean)).toThrow('spawnGated must be a boolean');
    expect(domain.getStore().getOperation('op')).toBeNull();
    expect(domain.isResourceLocked('res:workspace')).toBe(false);
    expect(domain.getStore().getPersistedResourceLeases('recovery')).toEqual([]);
  });

  it('cleans a backoff lease only after its uncertain instance is adjudicated', async () => {
    intent(false, 'service', 'service#1');
    const db = new DatabaseSync(path.join(root, 'domain.db'));
    try {
      db.prepare('INSERT INTO resource_leases (resource_id, operation_id, domain_id, acquired_at) VALUES (?, ?, ?, ?)')
        .run('res:service', 'service:service', 'recovery', new Date().toISOString());
    } finally {
      db.close();
    }
    reopen();
    await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    await domain.adjudicate('service#1', 'abandon_with_residuals', 'test-operator', 'Explicitly accept unresolved execution');
    reopen();
    const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(report.recoveredServices).toContainEqual({
      serviceId: 'service', instanceOpIds: [], action: 'stopped_alive_process', resourcesReleased: true,
    });
    expect(domain.isResourceLocked('res:service')).toBe(false);
    expect(domain.isResourceLocked('res:workspace')).toBe(false);
    expect(domain.getStore().getOperation('service#1')?.result?.status).toBe('indeterminate');
  });

  it('does not release a service lease when a later instance remains uncertain', async () => {
    intent(true, 'service', 'service#1');
    domain.getStore().registerOperationIntent({
      id: 'service#2', runId: 'run', kind: 'service', name: 'service#2', inputFingerprint: 'second',
      requiredResources: ['res:workspace'], status: 'pending', spawnGated: false,
    }, domain.domainId);
    const db = new DatabaseSync(path.join(root, 'domain.db'));
    try {
      db.prepare('INSERT INTO resource_leases (resource_id, operation_id, domain_id, acquired_at) VALUES (?, ?, ?, ?)')
        .run('res:workspace', 'service:service', 'recovery', new Date().toISOString());
    } finally {
      db.close();
    }
    reopen();
    await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(domain.isResourceLocked('res:workspace')).toBe(true);
    reopen();
    expect(domain.isResourceLocked('res:workspace')).toBe(true);
    expect(domain.getStore().getPersistedResourceLeases('recovery')).toContainEqual(expect.objectContaining({
      resourceId: 'res:workspace', operationId: 'service:service',
    }));
  });
});
