import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain, IsaControlPlane } from '../../src/index.js';

describe('ISA control plane', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-control-'));
    roots.push(root);
    const domain = ExecutionDomain.acquire(root, 'control');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: 'control', name: 'control', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: 'control', owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    return { domain, control: new IsaControlPlane(domain) };
  }

  it('reports health/status and resolves an indeterminate lease with audit metadata', async () => {
    const { domain, control } = setup();
    const store = domain.getStore();
    store.registerOperationIntent({
      id: 'op:control', runId: 'run', kind: 'process', name: 'control', inputFingerprint: 'fp',
      requiredResources: ['res:control'], status: 'pending',
    }, domain.domainId);
    store.recordOperationResult('op:control', {
      kind: 'indeterminate', status: 'indeterminate', reason: 'test uncertainty', recoveryGuidance: 'inspect',
      durationMs: 0, completedAt: new Date().toISOString(),
    }, false);

    expect(control.health()).toMatchObject({ status: 'degraded', leases: 1, operations: { unfinished: 0, total: 1 } });
    expect(control.status({ lease: 'lease:op:control' })).toMatchObject({
      found: true,
      operations: [{ id: 'op:control', resultStatus: 'indeterminate' }],
      leases: ['res:control'],
    });

    const resolved = await control.resolve({
      lease: 'lease:op:control', decision: 'failed', reason: 'operator inspected residual state', evidence: 'artifact:evidence-1',
    }, 'operator-1');
    expect(resolved).toMatchObject({ status: 'resolved', decision: 'failed', leasesReleased: true });
    expect(resolved.adjudication).toMatchObject({ actor: 'operator-1', decision: 'failed', evidence: 'artifact:evidence-1' });
    expect(store.getJournalEvents(domain.domainId).some((event) =>
      event.type === 'OPERATION_ADJUDICATED' && (event.payload as any).actor === 'operator-1')).toBe(true);
    expect(control.health().status).toBe('healthy');

    const resumed = await control.resume({ resumeToken: 'resume:op:control' }, 'operator-1');
    expect(resumed).toMatchObject({ operationId: 'op:control', resumed: false, replay: 'journal_only' });
    expect(resumed.nextActions).toEqual(['control.status', 'control.resolve']);
    domain.close();
  });

  it('does not re-execute a terminal operation through control.cancel', async () => {
    const { domain, control } = setup();
    const store = domain.getStore();
    store.registerOperationIntent({
      id: 'op:done', runId: 'run', kind: 'process', name: 'done', inputFingerprint: 'fp',
      requiredResources: [], status: 'pending',
    }, domain.domainId);
    store.recordOperationResult('op:done', {
      kind: 'process', status: 'failed', exitCode: 1, signal: null, stdout: '', stderr: '',
      identityVerification: 'not_original_process', isTruncated: false, durationMs: 0, completedAt: new Date().toISOString(),
    });
    const result = await control.cancel({ instruction: 'op:done', graceMs: 1 });
    expect(result).toMatchObject({ operationId: 'op:done', status: 'already_terminal' });
    domain.close();
  });
});
