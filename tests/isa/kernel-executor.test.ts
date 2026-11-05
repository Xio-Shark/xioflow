import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { execute } from '../../src/isa/execute.js';
import { compileWorkspaceRollback, compileWorkspaceSnapshot } from '../../src/isa/compiler.js';
import type { KernelExecutionBinding } from '../../src/isa/kernel-executor.js';
import type { PipelineRunResult } from '../../src/isa/pipeline.js';
import type { CapabilityRef, Program } from '../../src/isa/types.js';
import { DEFAULT_CAPABILITY_LIMITS } from '../../src/capability/check.js';

describe('domain-bound ISA preview execution', () => {
  const cleanup: Array<{ root: string; domain: ExecutionDomain }> = [];
  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      if (!item.domain.isClosed()) item.domain.close();
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-kernel-isa-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'before\n');
    const domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'kernel-isa');
    cleanup.push({ root, domain });
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'ISA preview', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'program', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    const cap = domain.issueCapability({
      issuer: 'test', policyVersion: 'test/1', reason: 'ISA test', ttlMs: 60_000,
      scope: { paths: [workspace], workspaces: ['workspace:root'], opcodes: ['workspace.snapshot', 'workspace.rollback', 'control.status', 'control.health'] },
      limits: { ...DEFAULT_CAPABILITY_LIMITS, concurrentOps: 4 },
    });
    const kernel: KernelExecutionBinding = { domain, supervisor: new ProcessSupervisor(domain), workspaces: { 'workspace:root': workspace } };
    const identity = { requestId: 'request', programId: 'program', capability: cap.id as CapabilityRef, workspace: 'workspace:root' as const };
    return { root, workspace, domain, store, kernel, cap, identity };
  }

  it('captures/replays a real git snapshot and rolls back through the existing core journal', async () => {
    const { workspace, store, kernel, identity } = setup();
    const program = compileWorkspaceSnapshot({ ...identity, label: 'before' });
    const first = await execute(program, { kernel }) as PipelineRunResult;
    expect(first.status, JSON.stringify(first)).toBe('succeeded');
    const ref = first.results[0]?.value?.snapshotRef;
    expect(ref).toBe('snapshot:op:program.workspace.snapshot');
    expect(store.getOperation('op:program.workspace.snapshot')?.kind).toBe('snapshot');
    const replayed = await execute(program, { kernel }) as PipelineRunResult;
    expect(replayed.status).toBe('succeeded');
    expect(replayed.results[0]?.value?.replayed).toBe(true);
    expect(store.getJournalEvents(kernel.domain.domainId).filter((event) => event.type === 'SNAPSHOT_CAPTURED')).toHaveLength(1);
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'changed\n');
    const rollback = compileWorkspaceRollback({ ...identity, snapshot: ref as `snapshot:${string}` });
    rollback.instructions.push({ id: 'after', op: 'control.status', args: { instruction: 'workspace.rollback' }, dependsOn: ['workspace.rollback'], precondition: [], output: 'after' });
    const restored = await execute(rollback, { kernel }) as PipelineRunResult;
    expect(restored.status).toBe('succeeded');
    expect(restored.results[0]?.status).toBe('rolled_back');
    expect(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8')).toBe('before\n');
    expect(restored.results[0]?.value?.coverage).toBeDefined();
    expect(restored.results[1]?.status).toBe('succeeded');
    expect(restored.results[1]?.value).toMatchObject({ found: true, operations: [{ id: 'op:program.workspace.rollback', resultStatus: 'restored' }] });
  });

  it('rejects reuse with changed snapshot input after completion', async () => {
    const { kernel, identity } = setup();
    expect((await execute(compileWorkspaceSnapshot({ ...identity, label: 'one' }), { kernel })).status).toBe('succeeded');
    const changed = await execute(compileWorkspaceSnapshot({ ...identity, label: 'two' }), { kernel });
    expect(changed.status).toBe('rejected');
    expect('issues' in changed && changed.issues[0]?.message).toContain('different ISA input');
  });

  it('does not trust a caller-supplied capability object over persisted revocation', async () => {
    const { domain, kernel, cap, identity } = setup();
    domain.revokeCapability(cap.id, 'test');
    const result = await execute(compileWorkspaceSnapshot({ ...identity, label: 'revoked' }), {
      kernel,
      capability: {
        id: cap.id as CapabilityRef, issuer: cap.issuer, policyVersion: cap.policyVersion, reason: cap.reason,
        limits: cap.limits, expiresAt: cap.expiresAt, epoch: cap.epoch,
        scope: { paths: cap.scope.paths, opcodes: ['workspace.snapshot'], workspaces: ['workspace:root'], secrets: [] },
      },
    });
    expect(result.status).toBe('rejected');
    expect(domain.getStore().getAllOperations(domain.domainId)).toHaveLength(0);
  });

  it('rejects an unsupported opcode before executing a supported prefix', async () => {
    const { kernel, identity } = setup();
    const program = compileWorkspaceSnapshot({ ...identity, label: 'prefix' });
    program.instructions.push({ id: 'read', op: 'fs.read', args: { path: 'file.txt' }, dependsOn: ['workspace.snapshot'], precondition: [], output: 'read' });
    const result = await execute(program, { kernel });
    expect(result.status).toBe('unsupported');
    expect(kernel.domain.getStore().getAllOperations(kernel.domain.domainId)).toHaveLength(0);
  });

  it('refuses workspace escape and missing registered Run', async () => {
    const { kernel, identity } = setup();
    const escaped = await execute(compileWorkspaceSnapshot({ ...identity, label: 'escape', roots: ['..'] }), { kernel });
    expect(escaped.status).toBe('rejected');
    const missingRun = await execute(compileWorkspaceSnapshot({ ...identity, programId: 'unregistered', label: 'missing' }), { kernel });
    expect(missingRun.status).toBe('rejected');
    expect(kernel.domain.getStore().getAllOperations(kernel.domain.domainId)).toHaveLength(0);
  });

  it('reads control facts and rejects external preconditions it cannot enforce', async () => {
    const { kernel, identity } = setup();
    const health: Program = { ...identity, isa: 'xio/1', mode: 'pipeline', instructions: [{
      id: 'health', op: 'control.health', args: {}, dependsOn: [], precondition: [], output: 'health',
    }] };
    const report = await execute(health, { kernel }) as PipelineRunResult;
    expect(report.status).toBe('succeeded');
    expect(report.results[0]?.value?.domainId).toBe(kernel.domain.domainId);
    health.instructions[0]!.precondition = [{ kind: 'file_hash', path: 'file.txt', sha256: 'a'.repeat(64) }];
    expect((await execute(health, { kernel })).status).toBe('unsupported');
  });

  it('does not reopen a terminal Run to replay work, while keeping read-only status available', async () => {
    const { kernel, domain, identity } = setup();
    const snapshot = compileWorkspaceSnapshot({ ...identity, label: 'terminal' });
    expect((await execute(snapshot, { kernel })).status).toBe('succeeded');
    domain.reportRunSucceeded(identity.programId);
    expect((await execute(snapshot, { kernel })).status).toBe('rejected');
    const status: Program = { ...identity, isa: 'xio/1', mode: 'pipeline', instructions: [{
      id: 'status', op: 'control.status', args: { program: identity.programId }, dependsOn: [], precondition: [], output: 'status',
    }] };
    const result = await execute(status, { kernel }) as PipelineRunResult;
    expect(result.status).toBe('succeeded');
    expect(result.results[0]?.value?.run).toMatchObject({ id: identity.programId, status: 'succeeded' });
    expect(domain.getStore().getRun(identity.programId)?.status).toBe('succeeded');
  });

  it('does not expose another Run through a lease control target', async () => {
    const { kernel, store, identity } = setup();
    store.saveRun({ id: 'other', taskId: 'task', domainId: kernel.domain.domainId, owner: 'other', status: 'running', startedAt: new Date().toISOString() });
    store.registerOperationIntent({ id: 'op:other', runId: 'other', kind: 'custom', name: 'private', inputFingerprint: 'private', requiredResources: [], status: 'pending' }, kernel.domain.domainId);
    const status: Program = { ...identity, isa: 'xio/1', mode: 'pipeline', instructions: [{
      id: 'status', op: 'control.status', args: { lease: 'lease:op:other' }, dependsOn: [], precondition: [], output: 'status',
    }] };
    const result = await execute(status, { kernel }) as PipelineRunResult;
    expect(result.status).toBe('failed');
    expect(result.results[0]?.value).toBeUndefined();
    expect(result.results[0]?.error?.message).toContain('another Run');
  });
});
