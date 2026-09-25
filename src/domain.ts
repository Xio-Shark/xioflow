import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from './store/sqlite.js';
import {
  DomainLockMetadata,
  Operation,
  ResourceLease,
  OwnerRecord,
  ResourceBudget,
  DomainBudget,
  DomainLockedError,
  ResourceConflictError,
  EpochFencedError,
} from './types.js';

export { DomainLockedError, ResourceConflictError, EpochFencedError };

export class ExecutionDomain {
  public readonly domainPath: string;
  public readonly domainId: string;
  private readonly lockFilePath: string;
  private store: SqliteStore;
  private lockFd: number | null = null;
  private ownerRecord!: OwnerRecord;
  private domainBudget?: DomainBudget;
  // 内存隔离表：resourceId -> operationId
  private inMemoryLockedResources: Map<string, string> = new Map();
  // 内存活跃操作预算
  private inMemoryBudgets: Map<string, ResourceBudget> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isFenced: boolean = false;

  private constructor(domainPath: string, domainId: string, lockFilePath: string, lockFd: number) {
    this.domainPath = domainPath;
    this.domainId = domainId;
    this.lockFilePath = lockFilePath;
    this.lockFd = lockFd;

    const dbPath = path.join(domainPath, 'domain.db');
    this.store = new SqliteStore(dbPath);
    const ownerId = `owner-${process.pid}-${Date.now()}`;
    this.ownerRecord = this.store.acquireOwnerLease(domainId, ownerId, os.hostname(), 60000);
    this.rebuildIsolationFromStore();

    // 周期心跳续约租约 (每 10s 续约一次，TTL 60s)
    this.heartbeatInterval = setInterval(() => {
      try {
        if (!this.isClosed() && this.store && this.ownerRecord) {
          this.ownerRecord = this.store.acquireOwnerLease(
            this.domainId,
            this.ownerRecord.ownerId,
            os.hostname(),
            60000
          );
        }
      } catch (err) {
        this.isFenced = true;
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        try {
          this.store.unsafeSetCurrentEpochForTesting(-1);
        } catch {}
      }
    }, 10000);
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  public static acquire(domainPath: string, domainId: string = 'default'): ExecutionDomain {
    if (!fs.existsSync(domainPath)) {
      fs.mkdirSync(domainPath, { recursive: true });
    }

    const lockFilePath = path.join(domainPath, 'domain.lock');
    let fd: number | null = null;

    try {
      // 尝试独占创建锁文件
      fd = fs.openSync(lockFilePath, 'wx');
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // 锁文件已存在，读取元数据核验进程是否存活
        let lockMeta: DomainLockMetadata | null = null;
        try {
          const content = fs.readFileSync(lockFilePath, 'utf8');
          lockMeta = JSON.parse(content) as DomainLockMetadata;
        } catch {
          // 损坏的锁文件视为失效
        }

        if (lockMeta) {
          const isAlive = ExecutionDomain.checkProcessAlive(lockMeta.ownerPid);
          if (isAlive) {
            throw new DomainLockedError(
              lockMeta.domainId,
              lockMeta.ownerPid,
              lockMeta.acquiredAt
            );
          }
        }

        // 旧进程已死亡，安全覆盖锁
        try {
          fs.unlinkSync(lockFilePath);
        } catch {}
        fd = fs.openSync(lockFilePath, 'wx');
      } else {
        throw err;
      }
    }

    const metadata: DomainLockMetadata = {
      domainId,
      ownerPid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: os.hostname(),
    };

    fs.writeSync(fd, JSON.stringify(metadata, null, 2));

    return new ExecutionDomain(domainPath, domainId, lockFilePath, fd);
  }

  private static checkProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err.code === 'EPERM'; // 存在但无权限发送信号，也算存活
    }
  }

  public getOwnerRecord(): OwnerRecord {
    return this.ownerRecord;
  }

  public getEpoch(): number {
    return this.ownerRecord.epoch;
  }

  public setDomainBudget(budget: DomainBudget): void {
    this.domainBudget = budget;
  }

  public getDomainBudget(): DomainBudget | undefined {
    return this.domainBudget;
  }

  /**
   * 启动时优先重建隔离屏障 (Recovery-Before-Execution)
   */
  public rebuildIsolationFromStore(): void {
    this.inMemoryLockedResources.clear();
    this.inMemoryBudgets.clear();

    // 1. 读取持久化未释放的 resource_leases
    const leases = this.store.getPersistedResourceLeases(this.domainId);
    for (const lease of leases) {
      this.inMemoryLockedResources.set(lease.resourceId, lease.operationId);
      if (lease.budget) {
        this.inMemoryBudgets.set(lease.operationId, lease.budget);
      }
    }

    // 2. 核对未终结操作声明的所有资源
    const unfinishedOps = this.store.getUnfinishedOperations(this.domainId);
    for (const op of unfinishedOps) {
      for (const res of op.requiredResources) {
        this.inMemoryLockedResources.set(res, op.id);
      }
      if (op.resourceBudget) {
        this.inMemoryBudgets.set(op.id, op.resourceBudget);
      }
    }
  }

  public getStore(): SqliteStore {
    return this.store;
  }

  public isResourceLocked(resourceId: string): boolean {
    return this.inMemoryLockedResources.has(resourceId);
  }

  public getResourceOwner(resourceId: string): string | undefined {
    return this.inMemoryLockedResources.get(resourceId);
  }

  public getAllocatedResources(): Map<string, string> {
    return new Map(this.inMemoryLockedResources);
  }

  public isDomainFenced(): boolean {
    return this.isFenced;
  }

  private assertNotFenced(): void {
    if (this.isFenced) {
      const owner = this.store.getOwner(this.domainId);
      throw new EpochFencedError(
        this.domainId,
        this.ownerRecord ? this.ownerRecord.epoch : 0,
        owner ? owner.epoch : -1
      );
    }
  }

  /**
   * 刷新租约心跳，若失败则触发代际栅栏与写凭证销毁
   */
  public renewHeartbeat(): void {
    try {
      if (!this.isClosed() && this.store && this.ownerRecord) {
        this.ownerRecord = this.store.acquireOwnerLease(
          this.domainId,
          this.ownerRecord.ownerId,
          os.hostname(),
          60000
        );
      }
    } catch (err) {
      this.isFenced = true;
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      try {
        this.store.unsafeSetCurrentEpochForTesting(-1);
      } catch {}
      throw err;
    }
  }

  /**
   * 申请占用资源（支持隔离检查与配额校验）
   */
  public allocateResources(
    operationId: string,
    resources: string[],
    waitedDurationMs: number = 0,
    budget?: ResourceBudget
  ): void {
    this.assertNotFenced();
    // 1. 检查资源冲突
    for (const res of resources) {
      const existingOwner = this.inMemoryLockedResources.get(res);
      if (existingOwner && existingOwner !== operationId) {
        throw new ResourceConflictError(res, existingOwner, operationId, waitedDurationMs);
      }
    }

    // 2. 检查域级配额（并发数）
    if (this.domainBudget) {
      const activeOps = new Set(this.inMemoryLockedResources.values());
      if (
        this.domainBudget.maxConcurrentOps &&
        activeOps.size >= this.domainBudget.maxConcurrentOps &&
        !activeOps.has(operationId)
      ) {
        const holder = Array.from(activeOps)[0] || 'domain-concurrency-cap';
        throw new ResourceConflictError('domain:max_concurrent_ops', holder, operationId, waitedDurationMs);
      }
    }

    for (const res of resources) {
      this.inMemoryLockedResources.set(res, operationId);
    }
    if (budget) {
      this.inMemoryBudgets.set(operationId, budget);
    }
  }

  /**
   * 具备排队等待与诊断的异步资源分配
   */
  public async allocateResourcesWithWait(
    operationId: string,
    resources: string[],
    maxWaitMs: number = 0,
    budget?: ResourceBudget,
    isCancelled?: () => boolean
  ): Promise<void> {
    const startTime = Date.now();
    while (true) {
      if (isCancelled && isCancelled()) {
        return;
      }
      try {
        this.allocateResources(operationId, resources, Date.now() - startTime, budget);
        return;
      } catch (err) {
        if (err instanceof ResourceConflictError) {
          if (isCancelled && isCancelled()) {
            return;
          }
          const elapsed = Date.now() - startTime;
          if (elapsed >= maxWaitMs) {
            throw new ResourceConflictError(err.resourceId, err.existingOwnerOpId, operationId, elapsed);
          }
          await new Promise((r) => setTimeout(r, 50));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * 释放资源占用
   */
  public releaseResources(operationId: string, resources?: string[]): void {
    this.inMemoryBudgets.delete(operationId);
    if (resources) {
      for (const res of resources) {
        if (this.inMemoryLockedResources.get(res) === operationId) {
          this.inMemoryLockedResources.delete(res);
          this.store.releaseResourceLease(operationId, res);
        }
      }
    } else {
      for (const [res, owner] of Array.from(this.inMemoryLockedResources.entries())) {
        if (owner === operationId) {
          this.inMemoryLockedResources.delete(res);
        }
      }
      this.store.releaseResourceLease(operationId);
    }
  }

  /**
   * 意图登记协议：先持久化意图与占用，再允许驱动调用
   */
  public registerOperationIntent(op: Operation): void {
    this.assertNotFenced();
    // 1. 检查资源隔离
    this.allocateResources(op.id, op.requiredResources, 0, op.resourceBudget);

    // 2. 事务写入 SQLite
    try {
      this.store.registerOperationIntent(op, this.domainId);
    } catch (err) {
      // 写入失败回滚内存状态
      this.releaseResources(op.id, op.requiredResources);
      throw err;
    }
  }

  public isClosed(): boolean {
    return this.lockFd === null;
  }

  public close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.store && this.ownerRecord) {
      try {
        this.store.releaseOwnerLease(this.domainId, this.ownerRecord.ownerId);
      } catch {}
    }

    if (this.store) {
      try {
        this.store.close();
      } catch {}
    }

    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {}
      this.lockFd = null;
    }

    if (fs.existsSync(this.lockFilePath)) {
      try {
        // 仅在自己持有时移除
        const content = fs.readFileSync(this.lockFilePath, 'utf8');
        const meta = JSON.parse(content);
        if (meta.ownerPid === process.pid) {
          fs.unlinkSync(this.lockFilePath);
        }
      } catch {}
    }
  }
}
