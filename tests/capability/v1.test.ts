import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionDomain } from '../../src/domain.js';
import { CapabilityViolationError } from '../../src/types.js';

describe('Capability v1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-capability-v1-'));
    roots.push(root);
    const domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'cap-v1');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    return { domain, workspace };
  }

  it('persists the v1 scope, policy, limits and epoch in the capability record', () => {
    const { domain, workspace } = setup();
    const capability = domain.issueCapability({
      scope: {
        opcodes: ['proc.spawn'],
        workspaces: ['workspace:root'],
        paths: [workspace],
        secrets: ['secret:npm-readonly'],
      },
      issuer: 'host-policy',
      policyVersion: 'policy-2026-11',
      reason: 'refactor-task-42',
      limits: { cpuMs: 600_000, memoryBytes: 1_000_000, outputBytes: 10_000, concurrentOps: 2, processes: 1 },
      ttlMs: 60_000,
    });

    expect(capability.id).toMatch(/^cap:/);
    expect(capability.scope.paths).toEqual([fs.realpathSync(workspace)]);
    expect(capability.policyVersion).toBe('policy-2026-11');
    expect(capability.reason).toBe('refactor-task-42');
    expect(capability.limits.processes).toBe(1);
    expect(domain.getCapability(capability.id)).toMatchObject({
      issuer: 'host-policy', policyVersion: 'policy-2026-11', epoch: domain.getEpoch(),
    });
    domain.close();
  });

  it('enforces opcode/workspace/path/secret/policy/budget scope and journals rejection', () => {
    const { domain, workspace } = setup();
    const capability = domain.issueCapability({
      scope: {
        opcodes: ['proc.spawn'],
        workspaces: ['workspace:root'],
        paths: [workspace],
        secrets: ['secret:npm-readonly'],
      },
      issuer: 'host-policy',
      policyVersion: 'policy-2026-11',
      reason: 'test',
      limits: { cpuMs: 100, memoryBytes: 100, outputBytes: 100, concurrentOps: 1, processes: 1 },
      ttlMs: 60_000,
    });

    expect(() => domain.checkCapabilityAdmission({
      capabilityId: capability.id,
      opcode: 'fs.write',
      workspace: 'workspace:root',
      mutationRoots: [workspace],
      secretRefs: ['secret:npm-readonly'],
      requestedLimits: { cpuMs: 100 },
      policyVersion: 'policy-2026-11',
    })).toThrow(CapabilityViolationError);
    expect(() => domain.checkCapabilityAdmission({
      capabilityId: capability.id,
      opcode: 'proc.spawn',
      workspace: 'workspace:other',
    })).toThrow(CapabilityViolationError);
    expect(() => domain.checkCapabilityAdmission({
      capabilityId: capability.id,
      opcode: 'proc.spawn',
      workspace: 'workspace:root',
      mutationRoots: [path.join(workspace, '..')],
    })).toThrow(CapabilityViolationError);
    expect(() => domain.checkCapabilityAdmission({
      capabilityId: capability.id,
      opcode: 'proc.spawn',
      workspace: 'workspace:root',
      mutationRoots: [workspace],
      secretRefs: ['secret:other'],
    })).toThrow(CapabilityViolationError);
    expect(() => domain.checkCapabilityAdmission({
      capabilityId: capability.id,
      opcode: 'proc.spawn',
      workspace: 'workspace:root',
      mutationRoots: [workspace],
      requestedLimits: { cpuMs: 101 },
    })).toThrow(CapabilityViolationError);
    expect(() => domain.checkCapabilityAdmission({
      capabilityId: capability.id,
      opcode: 'proc.spawn',
      workspace: 'workspace:root',
      mutationRoots: [workspace],
      policyVersion: 'policy-old',
    })).toThrow(CapabilityViolationError);

    const rejected = domain.getStore().getJournalEvents(domain.domainId).filter((event) => event.type === 'CAPABILITY_REJECTED');
    expect(rejected.length).toBe(6);
    expect(rejected.every((event) => (event.payload as any).capabilityId === capability.id)).toBe(true);
    domain.close();
  });

  it('attenuates opcode/path/secret/limit scope and rejects widening', () => {
    const { domain, workspace } = setup();
    const parent = domain.issueCapability({
      scope: {
        opcodes: ['proc.spawn', 'proc.wait'],
        workspaces: ['workspace:root'],
        paths: [workspace],
        secrets: ['secret:npm-readonly'],
      },
      issuer: 'host-policy', policyVersion: 'policy-2026-11', reason: 'parent',
      limits: { cpuMs: 1000, memoryBytes: 1000, outputBytes: 1000, concurrentOps: 4, processes: 2 }, ttlMs: 60_000,
    });
    const child = domain.attenuate(parent.id, {
      opcodes: ['proc.spawn'],
      paths: [path.join(workspace, 'src')],
      secrets: [],
    }, 'agent', { reason: 'child', limits: { cpuMs: 100, processes: 1 } });
    expect(child.parentId).toBe(parent.id);
    expect(child.scope.opcodes).toEqual(['proc.spawn']);
    expect(child.scope.paths).toEqual([fs.realpathSync(path.join(workspace, 'src'))]);
    expect(child.limits).toMatchObject({ cpuMs: 100, processes: 1, memoryBytes: 1000 });

    expect(() => domain.attenuate(parent.id, { opcodes: ['fs.write'] }, 'bad')).toThrow(CapabilityViolationError);
    expect(() => domain.attenuate(parent.id, { paths: [path.join(workspace, '..')] }, 'bad')).toThrow(CapabilityViolationError);
    expect(() => domain.attenuate(parent.id, { secrets: ['secret:other'] }, 'bad')).toThrow(CapabilityViolationError);
    expect(() => domain.attenuate(parent.id, {}, 'bad', { limits: { processes: 3 } })).toThrow(CapabilityViolationError);
    const attenuated = domain.getStore().getJournalEvents(domain.domainId).find((event) => event.type === 'CAPABILITY_ATTENUATED');
    expect(attenuated?.payload).toMatchObject({ parentId: parent.id, policyVersion: 'policy-2026-11', reason: 'child' });
    domain.close();
  });
});
