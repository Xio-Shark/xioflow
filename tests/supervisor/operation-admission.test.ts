import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain, ProcessSupervisor, DuplicateOperationError } from '../../src/index.js';

describe('domain-wide operation identity admission', () => {
  let root: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-operation-admission-'));
    domain = ExecutionDomain.acquire(root, 'operation-admission');
    supervisor = new ProcessSupervisor(domain);
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });
  afterEach(() => { domain.close(); fs.rmSync(root, { recursive: true, force: true }); });

  function intent(id: string) {
    return { id, runId: 'run', kind: 'process' as const, name: 'reserved intent', inputFingerprint: 'original', requiredResources: ['original-resource'], status: 'pending' as const };
  }

  it('rejects duplicate intent registration before changing the original leases', () => {
    domain.registerOperationIntent(intent('original'));
    const before = domain.getStore().getOperation('original');
    expect(() => domain.registerOperationIntent(intent('original'))).toThrow(DuplicateOperationError);
    expect(domain.getStore().getOperation('original')).toEqual(before);
    expect(domain.getResourceOwner('original-resource')).toBe('original');
    expect(domain.getStore().getPersistedResourceLeases(domain.domainId)).toMatchObject([{ operationId: 'original', resourceId: 'original-resource' }]);
  });

  it('service registration failure never records a result for another operation', async () => {
    domain.registerOperationIntent(intent('service#1'));
    const before = domain.getStore().getOperation('service#1');
    await expect(supervisor.startService({
      serviceId: 'service', runId: 'run', requiredResources: ['service-resource'], readiness: 'spawned',
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: root },
    })).rejects.toThrow(DuplicateOperationError);
    expect(domain.getStore().getOperation('service#1')).toEqual(before);
    expect(domain.getResourceOwner('original-resource')).toBe('service#1');
    expect(domain.isResourceLocked('service-resource')).toBe(false);
    expect(domain.getStore().getOperation('service#1')?.result).toBeUndefined();
  });

  it('rejects an operation ID reserved by an internal allocation before spawning', async () => {
    domain.allocateResources('service:existing', ['internal-resource']);
    const marker = path.join(root, 'unexpected');
    await expect(supervisor.executeProcess({
      runId: 'run', opId: 'service:existing', name: 'collision', requiredResources: ['internal-resource'],
      command: { execPath: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`], cwd: root },
    })).rejects.toThrow(DuplicateOperationError);
    expect(fs.existsSync(marker)).toBe(false);
    expect(domain.getResourceOwner('internal-resource')).toBe('service:existing');
    expect(domain.getStore().getOperation('service:existing')).toBeNull();
  });

  it.each(['snapshot', 'service'] as const)('does not reuse a queued process ID for %s', async (kind) => {
    domain.allocateResources('holder', ['blocked']);
    const running = supervisor.executeProcess({
      runId: 'run', opId: 'queued#1', name: 'queued', requiredResources: ['blocked'], waitTimeoutMs: 5000,
      command: { execPath: process.execPath, args: ['-e', '0'], cwd: root },
    });
    try {
      const conflicting = kind === 'snapshot'
        ? supervisor.captureSnapshot({ runId: 'run', opId: 'queued#1', roots: [root] })
        : supervisor.startService({ serviceId: 'queued', runId: 'run', command: { execPath: process.execPath, args: ['-e', '0'], cwd: root } });
      await expect(conflicting).rejects.toThrow(DuplicateOperationError);
      expect(domain.getStore().getOperation('queued#1')).toBeNull();
      expect(domain.getResourceOwner('blocked')).toBe('holder');
    } finally {
      await supervisor.cancelOperation('queued#1');
      await running;
      domain.internalReleaseResources('holder');
    }
  });
});
