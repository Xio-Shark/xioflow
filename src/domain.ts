import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from './store/sqlite.js';
import { PlatformDriver } from './driver/types.js';
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
  TerminationReason,
  AdjudicationRecord,
  Task,
  Run,
} from './types.js';

export { DomainLockedError, ResourceConflictError, EpochFencedError, AdjudicationRecord };

export interface DomainStatus {
  domainId: string;
  domainPath: string;
  epoch: number;
  owner: OwnerRecord;
  tasks: Task[];
  runs: Run[];
  activeRuns: Run[];
  operations: (Operation & { domainId: string })[];
  unfinishedOperations: (Operation & { domainId: string })[];
  leases: (ResourceLease & { budget?: ResourceBudget })[];
}

export class ExecutionDomain {
  public readonly domainPath: string;
  public readonly domainId: string;
  private readonly lockFilePath: string;
  private store: SqliteStore;
  private lockFd: number | null = null;
  private ownerRecord!: OwnerRecord;
  private domainBudget?: DomainBudget;
  private driver?: PlatformDriver;
  // 内存隔离表：resourceId -> operationId
  private inMemoryLockedResources: Map<string, string> = new Map();
  // 内存活跃操作（独立于资源租约，用于 domain:max_concurrent_ops）
  private inMemoryAllocatedOps: Set<string> = new Set();
  // 内存活跃操作预算
  private inMemoryBudgets: Map<string, ResourceBudget> = new Map();
  // FIFO 等待队列
  private waitQueue: Array<{
    operationId: string;
    resources: string[];
    budget?: ResourceBudget;
    resolve: () => void;
    reject: (err: any) => void;
    isCancelled?: () => boolean;
    startTime: number;
    maxWaitMs: number;
    timer?: NodeJS.Timeout;
  }> = [];
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
          this.store.fence();
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
    const dbPath = path.join(domainPath, 'domain.db');
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
          let leaseExpired = false;

          // 结合 owners 表判定租约是否过期 (P0-11)
          if (fs.existsSync(dbPath)) {
            try {
              const tempStore = new SqliteStore(dbPath);
              const owner = tempStore.getOwner(domainId);
              if (owner && new Date(owner.expiresAt).getTime() < Date.now()) {
                leaseExpired = true;
              }
              tempStore.close();
            } catch {}
          }

          if (isAlive && !leaseExpired) {
            throw new DomainLockedError(
              lockMeta.domainId,
              lockMeta.ownerPid,
              lockMeta.acquiredAt
            );
          }
        }

        // 旧进程已死亡或租约已过期，安全覆盖锁
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

    try {
      return new ExecutionDomain(domainPath, domainId, lockFilePath, fd);
    } catch (ctorErr) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockFilePath);
        } catch {}
      }
      throw ctorErr;
    }
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

  public get status(): DomainStatus {
    return this.getStatus();
  }

  public getStatus(): DomainStatus {
    return {
      domainId: this.domainId,
      domainPath: this.domainPath,
      epoch: this.getEpoch(),
      owner: this.getOwnerRecord(),
      tasks: this.store.getAllTasks(this.domainId),
      runs: this.store.getAllRuns(this.domainId),
      activeRuns: this.store.getActiveRuns(this.domainId),
      operations: this.store.getAllOperations(this.domainId),
      unfinishedOperations: this.store.getUnfinishedOperations(this.domainId),
      leases: this.store.getPersistedResourceLeases(this.domainId),
    };
  }

  /**
   * 启动时优先重建隔离屏障 (Recovery-Before-Execution)
   */
  public rebuildIsolationFromStore(): void {
    this.inMemoryLockedResources.clear();
    this.inMemoryBudgets.clear();
    this.inMemoryAllocatedOps.clear();

    // 1. 读取持久化未释放的 resource_leases
    const leases = this.store.getPersistedResourceLeases(this.domainId);
    for (const lease of leases) {
      this.inMemoryLockedResources.set(lease.resourceId, lease.operationId);
      if (lease.budget) {
        this.inMemoryBudgets.set(lease.operationId, lease.budget);
      }
    }

    // 2. 核对未终结操作声明的所有资源与活跃操作集合 (独立于 resource_leases)
    const unfinishedOps = this.store.getUnfinishedOperations(this.domainId);
    for (const op of unfinishedOps) {
      this.inMemoryAllocatedOps.add(op.id);
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
        this.store.fence();
      } catch {}
      throw err;
    }
  }

  private getActiveOperationIds(): Set<string> {
    const set = new Set<string>(this.inMemoryAllocatedOps);
    const unfinishedOps = this.store.getUnfinishedOperations(this.domainId);
    for (const op of unfinishedOps) {
      set.add(op.id);
    }
    return set;
  }

  private diagnoseConflict(
    operationId: string,
    resources: string[],
    waitedDurationMs: number = 0,
    budget?: ResourceBudget
  ): ResourceConflictError {
    for (const res of resources) {
      const existingOwner = this.inMemoryLockedResources.get(res);
      if (existingOwner && existingOwner !== operationId) {
        return new ResourceConflictError(res, existingOwner, operationId, waitedDurationMs);
      }
    }

    if (this.domainBudget && this.domainBudget.maxConcurrentOps) {
      const activeOps = this.getActiveOperationIds();
      if (activeOps.size >= this.domainBudget.maxConcurrentOps && !activeOps.has(operationId)) {
        const holder = Array.from(activeOps)[0] || 'domain-concurrency-cap';
        return new ResourceConflictError('domain:max_concurrent_ops', holder, operationId, waitedDurationMs);
      }
    }

    return new ResourceConflictError(resources[0] || 'domain:resource', 'unknown', operationId, waitedDurationMs);
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
      // 注（N8）：现有持有人等于当前 opId 仅当同一调用内部阶段重入（如子操作或多阶段申请）时合法；
      // 在飞 opId 的重复提交已由 supervisor 入口守卫拦截，绝不可能在此被当作合法持有人放行。
      if (existingOwner && existingOwner !== operationId) {
        throw new ResourceConflictError(res, existingOwner, operationId, waitedDurationMs);
      }
    }

    // 2. 检查域级配额（并发数独立于 resource_leases）
    if (this.domainBudget && this.domainBudget.maxConcurrentOps) {
      const activeOps = this.getActiveOperationIds();
      if (
        activeOps.size >= this.domainBudget.maxConcurrentOps &&
        !activeOps.has(operationId)
      ) {
        const holder = Array.from(activeOps)[0] || 'domain-concurrency-cap';
        throw new ResourceConflictError('domain:max_concurrent_ops', holder, operationId, waitedDurationMs);
      }
    }

    this.inMemoryAllocatedOps.add(operationId);
    for (const res of resources) {
      this.inMemoryLockedResources.set(res, operationId);
    }
    if (budget) {
      this.inMemoryBudgets.set(operationId, budget);
    }
  }

  /**
   * 具备 FIFO 排队等待与诊断的异步资源分配 (P0-5, P0-13)
   */
  public async allocateResourcesWithWait(
    operationId: string,
    resources: string[],
    maxWaitMs: number = 0,
    budget?: ResourceBudget,
    isCancelled?: () => boolean
  ): Promise<void> {
    this.assertNotFenced();

    if (isCancelled && isCancelled()) {
      return;
    }

    const startTime = Date.now();

    // 如果队列为空，尝试直接分配
    if (this.waitQueue.length === 0) {
      try {
        this.allocateResources(operationId, resources, 0, budget);
        return;
      } catch (err) {
        if (!(err instanceof ResourceConflictError)) {
          throw err;
        }
        if (maxWaitMs <= 0) {
          throw err;
        }
      }
    } else {
      // 队列中已有排队者：若不愿等待则直接抛出诊断
      if (maxWaitMs <= 0) {
        throw this.diagnoseConflict(operationId, resources, 0, budget);
      }
    }

    // 必须入队等待 (严格 FIFO)
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const item = {
        operationId,
        resources,
        budget,
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err: any) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
        isCancelled,
        startTime,
        maxWaitMs,
        timer: undefined as NodeJS.Timeout | undefined,
      };

      timer = setTimeout(() => {
        const idx = this.waitQueue.indexOf(item);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        if (item.isCancelled && item.isCancelled()) {
          item.resolve();
          return;
        }
        const elapsed = Date.now() - item.startTime;
        const err = this.diagnoseConflict(item.operationId, item.resources, elapsed, item.budget);
        item.reject(err);
      }, maxWaitMs);

      item.timer = timer;
      this.waitQueue.push(item);
    });
  }

  /**
   * 取消在等待队列中的操作 (立即唤醒以完成取消协议)
   */
  public cancelWait(operationId: string): boolean {
    const idx = this.waitQueue.findIndex((item) => item.operationId === operationId);
    if (idx !== -1) {
      const item = this.waitQueue[idx];
      this.waitQueue.splice(idx, 1);
      if (item.timer) clearTimeout(item.timer);
      item.resolve();
      return true;
    }
    return false;
  }

  private processWaitQueue(): void {
    if (this.waitQueue.length === 0 || this.isFenced) {
      return;
    }

    const reservedResources = new Set<string>();
    let concurrencyBlocked = false;

    let i = 0;
    while (i < this.waitQueue.length) {
      const item = this.waitQueue[i];

      // 1. 检查取消
      if (item.isCancelled && item.isCancelled()) {
        this.waitQueue.splice(i, 1);
        item.resolve();
        continue;
      }

      // 2. 检查是否与更早等待者的资源发生争抢
      const hasConflictWithEarlierWaiters = item.resources.some((r) => reservedResources.has(r));

      if (hasConflictWithEarlierWaiters || concurrencyBlocked) {
        for (const res of item.resources) {
          reservedResources.add(res);
        }
        i++;
        continue;
      }

      // 3. 尝试分配
      try {
        const elapsed = Date.now() - item.startTime;
        this.allocateResources(item.operationId, item.resources, elapsed, item.budget);
        // 分配成功：移出等待队列并唤醒
        this.waitQueue.splice(i, 1);
        item.resolve();
      } catch (err) {
        if (err instanceof ResourceConflictError) {
          for (const res of item.resources) {
            reservedResources.add(res);
          }
          if (err.resourceId === 'domain:max_concurrent_ops') {
            concurrencyBlocked = true;
          }
          i++;
        } else {
          this.waitQueue.splice(i, 1);
          item.reject(err);
        }
      }
    }
  }

  public setDriver(driver: PlatformDriver): void {
    this.driver = driver;
  }

  /**
   * 内部私有资源释放（走代际栅栏并记录 RESOURCES_RELEASED 事件，§0.2 裁决 1 / N6）
   * @internal 仅供 supervisor、recovery engine 与 adjudicate 等内核内部组件调用
   */
  public internalReleaseResources(operationId: string, resources?: string[]): void {
    this.assertNotFenced();
    this.store.verifyEpochFencing(this.domainId);

    const releasedList: string[] = [];

    this.inMemoryAllocatedOps.delete(operationId);
    this.inMemoryBudgets.delete(operationId);

    if (resources && resources.length > 0) {
      for (const res of resources) {
        if (this.inMemoryLockedResources.get(res) === operationId) {
          this.inMemoryLockedResources.delete(res);
          this.store.releaseResourceLease(operationId, res);
          releasedList.push(res);
        }
      }
    } else {
      for (const [res, owner] of Array.from(this.inMemoryLockedResources.entries())) {
        if (owner === operationId) {
          this.inMemoryLockedResources.delete(res);
          releasedList.push(res);
        }
      }
      this.store.releaseResourceLease(operationId);
    }

    this.store.recordEventAndTransitionState({
      domainId: this.domainId,
      operationId,
      type: 'RESOURCES_RELEASED',
      payload: {
        operationId,
        resources: releasedList,
      },
      timestamp: new Date().toISOString(),
    });

    this.processWaitQueue();
  }

  /**
   * 人工裁决协议：对 indeterminate 状态进行有审计记录的唯一收口 (ARCHITECTURE §3.6 / P0-7)
   */
  public async adjudicate(
    opId: string,
    verdict: 'confirmed_stopped' | 'abandon_with_residuals',
    actor: string,
    note?: string
  ): Promise<AdjudicationRecord> {
    this.assertNotFenced();
    this.store.verifyEpochFencing(this.domainId);

    const op = this.store.getOperation(opId);
    if (!op) {
      throw new Error(`Operation "${opId}" not found`);
    }

    if (op.status !== 'done' || op.result?.status !== 'indeterminate') {
      throw new Error(
        `Cannot adjudicate operation "${opId}": status must be 'indeterminate' (current status: '${op.status}', result: '${op.result?.status}')`
      );
    }

    // 2. 事实补全：驱动再做一次身份核验与残留扫描
    const residualPids: number[] = [];
    const pid = op.processIdentity?.pid;
    const pgid = op.processIdentity?.pgid;

    if (pid) {
      try {
        process.kill(pid, 0);
        residualPids.push(pid);
      } catch {}
    }

    if (pgid !== undefined) {
      if (this.driver && (this.driver as any).getGroupEvidence) {
        try {
          const members = await (this.driver as any).getGroupEvidence(pgid);
          for (const m of members) {
            if (!residualPids.includes(m.pid)) {
              residualPids.push(m.pid);
            }
          }
        } catch {}
      } else {
        try {
          process.kill(-pgid, 0);
          if (pid && !residualPids.includes(pid)) {
            residualPids.push(pid);
          }
        } catch {}
      }
    }

    if (verdict === 'confirmed_stopped' && residualPids.length > 0) {
      throw new Error(
        `Cannot adjudicate operation "${opId}" as 'confirmed_stopped': residual processes are still alive: [${residualPids.join(', ')}]. Use 'abandon_with_residuals' or ensure processes are terminated first.`
      );
    }

    const record: AdjudicationRecord = {
      operationId: opId,
      verdict,
      actor,
      note,
      residualPids: residualPids.length > 0 ? residualPids : undefined,
      decidedAt: new Date().toISOString(),
    };

    // 3. 事务提交：写入 AdjudicationRecord 与 journal 事件 OPERATION_ADJUDICATED
    this.store.recordEventAndTransitionState({
      domainId: this.domainId,
      runId: op.runId,
      operationId: opId,
      type: 'OPERATION_ADJUDICATED',
      payload: {
        ...record,
        processIdentity: op.processIdentity,
      },
      timestamp: record.decidedAt,
    });

    const updatedResult = {
      ...op.result,
      adjudication: record,
    };
    this.store.updateOperationResult(opId, updatedResult);

    // 释放租约 (走内部私有释放 API，带 epoch 栅栏与 RESOURCES_RELEASED 事件)
    this.internalReleaseResources(opId, op.requiredResources);

    return record;
  }

  /**
   * Run 完成与取消协议 (ARCHITECTURE §3.3)
   */
  public reportRunCancelled(runId: string, reason: TerminationReason = 'user_cancelled'): void {
    this.assertNotFenced();
    this.store.reportRunCancelled(runId, reason);
  }

  public reportRunSucceeded(runId: string): void {
    this.assertNotFenced();
    this.store.reportRunSucceeded(runId);
  }

  public reportRunFailed(runId: string, reason: TerminationReason = 'completed'): void {
    this.assertNotFenced();
    this.store.reportRunFailed(runId, reason);
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
      this.internalReleaseResources(op.id, op.requiredResources);
      throw err;
    }
  }

  /**
   * 产物回收防线 (ARCHITECTURE §4.3 / N7)
   * 只回收已终态且未被引用的产物，严格拒绝回收未终结或 indeterminate 状态的产物。
   */
  public pruneArtifacts(filter?: { olderThanMs?: number; prefix?: string }): {
    deleted: string[];
    retained: string[];
  } {
    this.assertNotFenced();
    const artifactsDir = path.join(this.domainPath, 'artifacts');
    if (!fs.existsSync(artifactsDir)) {
      return { deleted: [], retained: [] };
    }

    const protectedFiles = new Set<string>();
    const allOps = this.store.getAllOperations(this.domainId);
    for (const op of allOps) {
      const isIndet = op.result?.status === 'indeterminate' || (op.result as any)?.kind === 'indeterminate';
      const isDone = op.status === 'done';

      if (!isDone || isIndet) {
        // 未终结或 indeterminate：保护所有可能关联的产物
        protectedFiles.add(`${op.id}-stdout.log`);
        protectedFiles.add(`${op.id}-stderr.log`);
        if (op.outputRef) protectedFiles.add(path.basename(op.outputRef));
        if ((op.result as any)?.stdoutRef) protectedFiles.add(path.basename((op.result as any).stdoutRef));
        if ((op.result as any)?.stderrRef) protectedFiles.add(path.basename((op.result as any).stderrRef));
      } else {
        // 已终态：仅保护仍被引用的产物
        if (op.outputRef) protectedFiles.add(path.basename(op.outputRef));
        if ((op.result as any)?.stdoutRef) protectedFiles.add(path.basename((op.result as any).stdoutRef));
        if ((op.result as any)?.stderrRef) protectedFiles.add(path.basename((op.result as any).stderrRef));
      }
    }

    const files = fs.readdirSync(artifactsDir);
    const deleted: string[] = [];
    const retained: string[] = [];
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(artifactsDir, file);
      if (protectedFiles.has(file)) {
        retained.push(filePath);
        continue;
      }

      if (filter?.prefix && !file.startsWith(filter.prefix)) {
        retained.push(filePath);
        continue;
      }

      if (filter?.olderThanMs !== undefined) {
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs < filter.olderThanMs) {
            retained.push(filePath);
            continue;
          }
        } catch {
          retained.push(filePath);
          continue;
        }
      }

      try {
        fs.unlinkSync(filePath);
        deleted.push(filePath);
      } catch {
        retained.push(filePath);
      }
    }

    return { deleted, retained };
  }

  public isClosed(): boolean {
    return this.lockFd === null;
  }

  public close(): void {
    for (const item of this.waitQueue) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(new Error(`Domain ${this.domainId} closed while waiting for resources`));
    }
    this.waitQueue = [];

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
