import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain, DomainLockedError, ResourceConflictError } from '../../src/domain.js';
import { SqliteStore } from '../../src/store/sqlite.js';
import { Task, Run, Operation } from '../../src/types.js';

describe('Task 01: ExecutionDomain & SQLite Transactional Store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-test-domain-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. 域所有权互斥：同一域禁止双重获取', () => {
    const domain1 = ExecutionDomain.acquire(tempDir, 'test-domain');
    expect(domain1).toBeDefined();

    // 尝试第二次获取同一域，必须抛出 DomainLockedError
    expect(() => {
      ExecutionDomain.acquire(tempDir, 'test-domain');
    }).toThrowError(DomainLockedError);

    domain1.close();

    // 关闭后应能再次获取
    const domain2 = ExecutionDomain.acquire(tempDir, 'test-domain');
    expect(domain2).toBeDefined();
    domain2.close();
  });

  it('2. 事务原子提交与回滚：失败时不残留脏数据', () => {
    const dbPath = path.join(tempDir, 'domain.db');
    const store = new SqliteStore(dbPath);

    expect(() => {
      store.transaction(() => {
        store.recordEventAndTransitionState({
          domainId: 'test-domain',
          type: 'TEST_EVENT_ROLLBACK',
          payload: { foo: 'bar' },
          timestamp: new Date().toISOString(),
        });
        throw new Error('Forced transaction failure');
      });
    }).toThrow('Forced transaction failure');

    const events = store.getJournalEvents('test-domain');
    expect(events.length).toBe(0);

    store.close();
  });

  it('3. 序号严格连续单调自增', () => {
    const dbPath = path.join(tempDir, 'domain.db');
    const store = new SqliteStore(dbPath);

    const seq1 = store.recordEventAndTransitionState({
      domainId: 'test-domain',
      type: 'EVENT_1',
      payload: { step: 1 },
      timestamp: new Date().toISOString(),
    });

    const seq2 = store.recordEventAndTransitionState({
      domainId: 'test-domain',
      type: 'EVENT_2',
      payload: { step: 2 },
      timestamp: new Date().toISOString(),
    });

    const seq3 = store.recordEventAndTransitionState({
      domainId: 'test-domain',
      type: 'EVENT_3',
      payload: { step: 3 },
      timestamp: new Date().toISOString(),
    });

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);

    const events = store.getJournalEvents('test-domain');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);

    store.close();
  });

  it('4. 意图先于动作协议：落盘 intent_registered 与持久化资源租约', () => {
    const domain = ExecutionDomain.acquire(tempDir, 'test-domain');
    const store = domain.getStore();

    const task: Task = {
      id: 'task-1',
      domainId: 'test-domain',
      name: 'Test Task',
      createdAt: new Date().toISOString(),
    };
    store.saveTask(task);

    const run: Run = {
      id: 'run-1',
      taskId: 'task-1',
      domainId: 'test-domain',
      owner: 'session-runner',
      status: 'starting',
      startedAt: new Date().toISOString(),
      configSnapshotWhiteList: {
        model: 'gemini-pro',
        api_token: 'SECRET_NEVER_PERSIST', // 白名单过滤测试
      },
    };
    store.saveRun(run);

    // 验证敏感 key 未落盘
    const savedRun = store.getRun('run-1');
    expect(savedRun?.configSnapshotWhiteList?.model).toBe('gemini-pro');
    expect(savedRun?.configSnapshotWhiteList?.api_token).toBeUndefined();

    // 登记操作意图
    const op: Operation = {
      id: 'op-1',
      runId: 'run-1',
      kind: 'process',
      name: 'build-step',
      inputFingerprint: 'sha256-abc',
      requiredResources: ['workspace:write:root', 'port:8080'],
      status: 'pending',
    };

    domain.registerOperationIntent(op);

    // 验证数据库状态
    const savedOp = store.getOperation('op-1');
    expect(savedOp).toBeDefined();
    expect(savedOp?.status).toBe('intent_registered');
    expect(savedOp?.requiredResources).toEqual(['workspace:write:root', 'port:8080']);

    // 验证资源已被锁定
    expect(domain.isResourceLocked('workspace:write:root')).toBe(true);
    expect(domain.getResourceOwner('workspace:write:root')).toBe('op-1');

    // 验证资源争抢冲突报错
    const conflictingOp: Operation = {
      id: 'op-2',
      runId: 'run-1',
      kind: 'process',
      name: 'conflict-step',
      inputFingerprint: 'sha256-def',
      requiredResources: ['workspace:write:root'],
      status: 'pending',
    };
    expect(() => {
      domain.registerOperationIntent(conflictingOp);
    }).toThrowError(ResourceConflictError);

    domain.close();
  });

  it('5. 启动先建隔离协议：重启时从持久化存储重建资源锁', () => {
    // 首次运行：意图登记但未收尾（模拟崩溃前状态）
    const domain1 = ExecutionDomain.acquire(tempDir, 'test-domain');
    const store1 = domain1.getStore();

    store1.saveTask({
      id: 'task-crash',
      domainId: 'test-domain',
      name: 'Crash Task',
      createdAt: new Date().toISOString(),
    });
    store1.saveRun({
      id: 'run-crash',
      taskId: 'task-crash',
      domainId: 'test-domain',
      owner: 'runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    domain1.registerOperationIntent({
      id: 'op-uncompleted',
      runId: 'run-crash',
      kind: 'process',
      name: 'heavy-calc',
      inputFingerprint: 'fp-1',
      requiredResources: ['gpu:device:0'],
      status: 'pending',
    });

    // 模拟非正常关闭（不释放资源，直接断开连接）
    domain1.close();

    // 重启内核域
    const domain2 = ExecutionDomain.acquire(tempDir, 'test-domain');
    // 验证重启后隔离屏障已生效
    expect(domain2.isResourceLocked('gpu:device:0')).toBe(true);
    expect(domain2.getResourceOwner('gpu:device:0')).toBe('op-uncompleted');

    // 新操作申请相同资源必须被阻断
    expect(() => {
      domain2.allocateResources('op-new', ['gpu:device:0']);
    }).toThrowError(ResourceConflictError);

    // 独立资源应能正常申请
    expect(() => {
      domain2.allocateResources('op-new', ['gpu:device:1']);
    }).not.toThrow();

    domain2.close();
  });
});
