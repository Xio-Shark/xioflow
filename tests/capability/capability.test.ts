import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { CapabilityViolationError } from '../../src/types.js';
import { resolveRealPath } from '../../src/capability/path-utils.js';

describe('Capability Scope & Admission (Steps 1, 2, 3)', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-capability-test-'));
    const domainPath = path.join(tempDir, 'domain');
    domain = ExecutionDomain.acquire(domainPath, 'cap-domain');
    supervisor = new ProcessSupervisor(domain);
  });

  afterEach(() => {
    try {
      domain.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function ensureTaskAndRun(runId: string = 'run-1') {
    const store = domain.getStore();
    store.saveTask({
      id: 'task-1',
      domainId: domain.domainId,
      name: 'Capability Test Task',
      createdAt: new Date().toISOString(),
    });
    store.saveRun({
      id: runId,
      taskId: 'task-1',
      domainId: domain.domainId,
      owner: 'tester',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }

  it('2.1 签发 Capability 写入 SQLite 与 CAPABILITY_ISSUED 事件（含 actor、scope、过期时间、epoch）', () => {
    const workDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workDir, { recursive: true });

    const cap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['workspace:write:main', 'db:schema'],
      },
      'actor-alice',
      60000
    );

    expect(cap.id).toMatch(/^cap-/);
    expect(cap.issuedBy).toBe('actor-alice');
    expect(cap.epoch).toBe(domain.getEpoch());
    expect(cap.scope.write).toEqual([resolveRealPath(workDir)]);
    expect(cap.scope.exclusive).toEqual(['workspace:write:main', 'db:schema']);

    const stored = domain.getCapability(cap.id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(cap.id);

    const events = domain.getStore().getJournalEvents(domain.domainId);
    const issueEvent = events.find((e) => e.type === 'CAPABILITY_ISSUED');
    expect(issueEvent).toBeDefined();
    expect((issueEvent?.payload as any)?.capabilityId).toBe(cap.id);
    expect((issueEvent?.payload as any)?.actor).toBe('actor-alice');
  });

  it('2.2 收窄成功；尝试放宽报错 attenuation_widened；父撤销后子同样失效', () => {
    const parentDir = path.join(tempDir, 'parent');
    const subDir = path.join(parentDir, 'sub');
    const outsideDir = path.join(tempDir, 'outside');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const parentCap = domain.issueCapability(
      {
        write: [parentDir],
        exclusive: ['res:a', 'res:b'],
      },
      'admin',
      60000
    );

    // 合法收窄：路径是子目录，资源是子集
    const childCap = domain.attenuate(
      parentCap.id,
      {
        write: [subDir],
        exclusive: ['res:a'],
      },
      'agent-bob'
    );

    expect(childCap.parentId).toBe(parentCap.id);
    expect(childCap.scope.write).toEqual([resolveRealPath(subDir)]);
    expect(childCap.scope.exclusive).toEqual(['res:a']);

    const events = domain.getStore().getJournalEvents(domain.domainId);
    const attEvent = events.find((e) => e.type === 'CAPABILITY_ATTENUATED');
    expect(attEvent).toBeDefined();
    expect((attEvent?.payload as any)?.parentId).toBe(parentCap.id);

    // 非法放宽路径：outsideDir 不在 parentDir 内
    expect(() =>
      domain.attenuate(
        parentCap.id,
        {
          write: [outsideDir],
        },
        'malicious-agent'
      )
    ).toThrow(CapabilityViolationError);

    // 非法放宽资源：res:c 不在 parent 独占资源内
    expect(() =>
      domain.attenuate(
        parentCap.id,
        {
          exclusive: ['res:c'],
        },
        'malicious-agent'
      )
    ).toThrow(CapabilityViolationError);

    // 父撤销后，子 capability 在准入检查中级联失效
    domain.revokeCapability(parentCap.id, 'admin');

    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: childCap.id,
      })
    ).toThrow(CapabilityViolationError);
  });

  it('2.3 所有权换代（epoch 变化）后旧 capability 失效', () => {
    const workDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workDir, { recursive: true });

    const cap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['res:work'],
      },
      'owner-1',
      60000
    );

    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: cap.id,
      })
    ).not.toThrow();

    const domainPath = domain.domainPath;
    const oldEpoch = domain.getEpoch();
    domain.close();

    // 重新获取新 domain 实例，自动触发 epoch + 1
    const domain2 = ExecutionDomain.acquire(domainPath, 'cap-domain');
    expect(domain2.getEpoch()).toBeGreaterThan(oldEpoch);

    expect(() =>
      domain2.checkCapabilityAdmission({
        capabilityId: cap.id,
      })
    ).toThrow(CapabilityViolationError);

    domain2.close();
  });

  it('3.1 准入校验：过期 / 撤销 / 越界资源各自被拒绝并写 CAPABILITY_REJECTED', () => {
    ensureTaskAndRun('run-31');

    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    // 1. 过期测试 (ttlMs = 1ms)
    const expiredCap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['res:allowed'],
      },
      'tester',
      1
    );

    // 等待 10ms 确保过期
    const start = Date.now();
    while (Date.now() - start < 10) {}

    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: expiredCap.id,
        runId: 'run-31',
        opId: 'op-expired',
      })
    ).toThrow(CapabilityViolationError);

    // 2. 撤销测试
    const revokedCap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['res:allowed'],
      },
      'tester',
      60000
    );
    domain.revokeCapability(revokedCap.id, 'tester');

    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: revokedCap.id,
        runId: 'run-31',
        opId: 'op-revoked',
      })
    ).toThrow(CapabilityViolationError);

    // 3. 越界资源测试
    const validCap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['res:allowed'],
      },
      'tester',
      60000
    );

    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: validCap.id,
        requiredResources: ['res:unauthorized'],
        runId: 'run-31',
        opId: 'op-out-of-scope-res',
      })
    ).toThrow(CapabilityViolationError);

    // 检查 CAPABILITY_REJECTED 事件
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const rejectedEvents = events.filter((e) => e.type === 'CAPABILITY_REJECTED');
    expect(rejectedEvents.length).toBe(3);
    expect(rejectedEvents.some((e) => (e.payload as any)?.reason === 'expired')).toBe(true);
    expect(rejectedEvents.some((e) => (e.payload as any)?.reason === 'revoked')).toBe(true);
    expect(rejectedEvents.some((e) => (e.payload as any)?.reason === 'out_of_scope_resource')).toBe(true);
  });

  it('3.2 路径越界校验：../ 逃逸、软链接逃逸与 /a/b vs /a/bc 前缀陷阱', () => {
    ensureTaskAndRun('run-32');

    const baseDir = path.join(tempDir, 'scope_base');
    const allowedDir = path.join(baseDir, 'allowed');
    const siblingDir = path.join(baseDir, 'allowed_extra'); // 前缀陷阱
    const secretDir = path.join(tempDir, 'secret');

    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });

    // 构造指向外部的符号链接
    const symlinkEscape = path.join(allowedDir, 'symlink_to_secret');
    try {
      fs.symlinkSync(secretDir, symlinkEscape, 'dir');
    } catch {}

    const cap = domain.issueCapability(
      {
        write: [allowedDir],
        exclusive: ['res:ok'],
      },
      'tester',
      60000
    );

    // 1. 前缀陷阱：allowed_extra 虽以 allowed 开头，但不是其子目录
    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: cap.id,
        mutationRoots: [siblingDir],
        runId: 'run-32',
        opId: 'op-prefix-trap',
      })
    ).toThrow(CapabilityViolationError);

    // 2. ../ 逃逸
    const dotDotEscape = path.join(allowedDir, '..', 'secret');
    expect(() =>
      domain.checkCapabilityAdmission({
        capabilityId: cap.id,
        mutationRoots: [dotDotEscape],
        runId: 'run-32',
        opId: 'op-dotdot-escape',
      })
    ).toThrow(CapabilityViolationError);

    // 3. 符号链接逃逸
    if (fs.existsSync(symlinkEscape)) {
      expect(() =>
        domain.checkCapabilityAdmission({
          capabilityId: cap.id,
          mutationRoots: [symlinkEscape],
          runId: 'run-32',
          opId: 'op-symlink-escape',
        })
      ).toThrow(CapabilityViolationError);
    }
  });

  it('3.3 缺省推导：只给 capabilityId ⇒ 租约与写根由 scope 推导；executeProcess 记录 CAPABILITY_USED', async () => {
    ensureTaskAndRun('run-33');

    const workDir = path.join(tempDir, 'work-33');
    fs.mkdirSync(workDir, { recursive: true });

    const cap = domain.issueCapability(
      {
        write: [workDir],
        exclusive: ['res:work-33'],
      },
      'agent-worker',
      60000
    );

    // 不提供 requiredResources 和 mutationRoots，完全由 capabilityId 推导
    const res = await supervisor.executeProcess({
      runId: 'run-33',
      opId: 'op-cap-deduce',
      name: 'test-cap-deduce',
      capabilityId: cap.id,
      command: {
        execPath: process.execPath,
        args: ['-e', 'console.log("deduced success")'],
        cwd: workDir,
      },
    });

    expect(res.status).toBe('succeeded');
    expect(res.capabilityId).toBe(cap.id);
    expect(res.stdout).toContain('deduced success');

    // 检查 journal 中的 CAPABILITY_USED 事件
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const usedEvent = events.find((e) => e.type === 'CAPABILITY_USED');
    expect(usedEvent).toBeDefined();
    expect((usedEvent?.payload as any)?.capabilityId).toBe(cap.id);
    expect((usedEvent?.payload as any)?.actor).toBe('agent-worker');

    // 检查 operations 表中的结果记录
    const op = domain.getStore().getOperation('op-cap-deduce');
    expect(op?.capabilityId).toBe(cap.id);
    expect(op?.mutationRoots).toEqual([resolveRealPath(workDir)]);
    expect(op?.requiredResources).toEqual(['res:work-33']);
  });
});
