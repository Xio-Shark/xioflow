import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from './store/sqlite.js';
import {
  DomainLockMetadata,
  Operation,
  ResourceLease,
} from './types.js';

export class DomainLockedError extends Error {
  constructor(
    public readonly domainId: string,
    public readonly ownerPid: number,
    public readonly acquiredAt: string
  ) {
    super(
      `Execution domain '${domainId}' is already locked by process ${ownerPid} (acquired at ${acquiredAt})`
    );
    this.name = 'DomainLockedError';
  }
}

export class ResourceConflictError extends Error {
  constructor(
    public readonly resourceId: string,
    public readonly existingOwnerOpId: string,
    public readonly requestingOpId: string,
    public readonly waitedDurationMs: number = 0
  ) {
    super(
      `Resource conflict: resource '${resourceId}' is held by operation '${existingOwnerOpId}', requested by '${requestingOpId}' (waited ${waitedDurationMs}ms)`
    );
    this.name = 'ResourceConflictError';
  }
}

export class ExecutionDomain {
  public readonly domainPath: string;
  public readonly domainId: string;
  private readonly lockFilePath: string;
  private store: SqliteStore;
  private lockFd: number | null = null;
  // 内存隔离表：resourceId -> operationId
  private inMemoryLockedResources: Map<string, string> = new Map();

  private constructor(domainPath: string, domainId: string, lockFilePath: string, lockFd: number) {
    this.domainPath = domainPath;
    this.domainId = domainId;
    this.lockFilePath = lockFilePath;
    this.lockFd = lockFd;

    const dbPath = path.join(domainPath, 'domain.db');
    this.store = new SqliteStore(dbPath);
    this.rebuildIsolationFromStore();
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

  /**
   * 启动时优先重建隔离屏障 (Recovery-Before-Execution)
   */
  public rebuildIsolationFromStore(): void {
    this.inMemoryLockedResources.clear();

    // 1. 读取持久化未释放的 resource_leases
    const leases = this.store.getPersistedResourceLeases(this.domainId);
    for (const lease of leases) {
      this.inMemoryLockedResources.set(lease.resourceId, lease.operationId);
    }

    // 2. 核对未终结操作声明的所有资源
    const unfinishedOps = this.store.getUnfinishedOperations(this.domainId);
    for (const op of unfinishedOps) {
      for (const res of op.requiredResources) {
        this.inMemoryLockedResources.set(res, op.id);
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

  /**
   * 申请占用资源（支持隔离检查）
   */
  public allocateResources(
    operationId: string,
    resources: string[],
    waitedDurationMs: number = 0
  ): void {
    for (const res of resources) {
      const existingOwner = this.inMemoryLockedResources.get(res);
      if (existingOwner && existingOwner !== operationId) {
        throw new ResourceConflictError(res, existingOwner, operationId, waitedDurationMs);
      }
    }

    for (const res of resources) {
      this.inMemoryLockedResources.set(res, operationId);
    }
  }

  /**
   * 释放资源占用
   */
  public releaseResources(operationId: string, resources?: string[]): void {
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
    // 1. 检查资源隔离
    this.allocateResources(op.id, op.requiredResources);

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
