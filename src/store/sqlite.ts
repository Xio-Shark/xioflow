import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';
import {
  Task,
  Run,
  Operation,
  OperationResult,
  OperationStatus,
  KernelRunStatus,
  TerminationReason,
  ResourceLease,
  JournalEvent,
  OwnerRecord,
  ResourceBudget,
  EpochFencedError,
  DomainLockedError,
  sanitizeConfigSnapshot,
} from '../types.js';

export class SqliteStore {
  private db: DatabaseSync;
  private currentEpoch: number | null = null;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.configurePragmas();
    this.initSchema();
  }

  private configurePragmas(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
  }

  private inTransaction = false;

  public transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * 触发代际栅栏，永久阻断后续所有写操作 (P0-11)
   */
  public fence(): void {
    this.currentEpoch = -1;
  }

  /**
   * @internal 仅供测试套件模拟跨代/代际穿透场景，严禁在生产运行时直接调用
   */
  public unsafeSetCurrentEpochForTesting(epoch: number | null): void {
    this.currentEpoch = epoch;
  }

  /**
   * @deprecated 请使用 unsafeSetCurrentEpochForTesting (@internal)
   */
  public setCurrentEpoch(epoch: number | null): void {
    this.unsafeSetCurrentEpochForTesting(epoch);
  }

  public getCurrentEpoch(): number | null {
    return this.currentEpoch;
  }

  public getOwner(domainId: string): OwnerRecord | null {
    const stmt = this.db.prepare('SELECT * FROM owners WHERE domain_id = ?');
    const row = stmt.get(domainId) as any;
    if (!row) return null;
    return {
      domainId: row.domain_id,
      ownerId: row.owner_id,
      epoch: Number(row.epoch),
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      hostname: row.hostname,
    };
  }

  public acquireOwnerLease(
    domainId: string,
    ownerId: string,
    hostname: string,
    ttlMs: number = 30000,
    force: boolean = false
  ): OwnerRecord {
    return this.transaction(() => {
      const existing = this.getOwner(domainId);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const nowStr = now.toISOString();

      let newEpoch = 1;
      if (!existing) {
        const stmt = this.db.prepare(`
          INSERT INTO owners (domain_id, owner_id, epoch, heartbeat_at, expires_at, hostname)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(domainId, ownerId, newEpoch, nowStr, expiresAt, hostname);
      } else {
        const isExpired = new Date(existing.expiresAt).getTime() <= now.getTime();
        const oldPid = Number(existing.ownerId.split('-')[1]) || 0;
        let isOldProcessAlive = false;
        if (existing.hostname === hostname && oldPid > 0) {
          try {
            process.kill(oldPid, 0);
            isOldProcessAlive = true;
          } catch (err: any) {
            isOldProcessAlive = err.code === 'EPERM';
          }
        } else if (existing.hostname !== hostname || oldPid === 0) {
          // 跨主机或未编码本地 PID 的所有者租约：存活受租约过期时间 expiresAt 保护
          isOldProcessAlive = !isExpired;
        }

        if (existing.ownerId === ownerId) {
          newEpoch = existing.epoch;
          const stmt = this.db.prepare(`
            UPDATE owners
            SET heartbeat_at = ?, expires_at = ?, hostname = ?
            WHERE domain_id = ? AND owner_id = ?
          `);
          stmt.run(nowStr, expiresAt, hostname, domainId, ownerId);
        } else if (force || isExpired || !isOldProcessAlive) {
          // 强制接管、租约已过期或旧进程已死亡，代际自增：epoch = epoch + 1
          newEpoch = existing.epoch + 1;
          const stmt = this.db.prepare(`
            UPDATE owners
            SET owner_id = ?, epoch = ?, heartbeat_at = ?, expires_at = ?, hostname = ?
            WHERE domain_id = ?
          `);
          stmt.run(ownerId, newEpoch, nowStr, expiresAt, hostname, domainId);
        } else {
          throw new DomainLockedError(domainId, oldPid, existing.heartbeatAt);
        }
      }

      this.currentEpoch = newEpoch;
      return {
        domainId,
        ownerId,
        epoch: newEpoch,
        heartbeatAt: nowStr,
        expiresAt,
        hostname,
      };
    });
  }

  public releaseOwnerLease(domainId: string, ownerId: string): void {
    const stmt = this.db.prepare(`
      UPDATE owners
      SET expires_at = ?
      WHERE domain_id = ? AND owner_id = ?
    `);
    stmt.run(new Date(0).toISOString(), domainId, ownerId);
  }

  public verifyEpochFencing(domainId: string): void {
    if (this.currentEpoch !== null) {
      const owner = this.getOwner(domainId);
      if (owner && owner.epoch !== this.currentEpoch) {
        throw new EpochFencedError(domainId, this.currentEpoch, owner.epoch);
      }
    }
  }

  public saveTask(task: Task): void {
    this.verifyEpochFencing(task.domainId);
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, domain_id, name, created_at, meta)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        meta = excluded.meta
    `);
    stmt.run(
      task.id,
      task.domainId,
      task.name,
      task.createdAt,
      task.meta ? JSON.stringify(task.meta) : null
    );
  }

  public getTask(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      domainId: row.domain_id,
      name: row.name,
      createdAt: row.created_at,
      meta: row.meta ? JSON.parse(row.meta) : undefined,
    };
  }

  public saveRun(run: Run): void {
    this.verifyEpochFencing(run.domainId);
    const existing = this.getRun(run.id);
    if (existing && (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'cancelled' || existing.status === 'indeterminate')) {
      if (existing.status !== run.status) {
        throw new Error(
          `Cannot transition Run "${run.id}" from terminal status "${existing.status}" to "${run.status}".`
        );
      }
    }
    const sanitizedConfig = sanitizeConfigSnapshot(run.configSnapshotWhiteList);
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, task_id, domain_id, owner, status, termination_reason, started_at, ended_at, config_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        termination_reason = excluded.termination_reason,
        ended_at = excluded.ended_at,
        config_snapshot = excluded.config_snapshot
    `);
    stmt.run(
      run.id,
      run.taskId,
      run.domainId,
      run.owner,
      run.status,
      run.terminationReason || null,
      run.startedAt,
      run.endedAt || null,
      JSON.stringify(sanitizedConfig)
    );
  }

  public getRun(id: string): Run | null {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      domainId: row.domain_id,
      owner: row.owner,
      status: row.status as KernelRunStatus,
      terminationReason: row.termination_reason as TerminationReason | undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at || undefined,
      configSnapshotWhiteList: row.config_snapshot ? JSON.parse(row.config_snapshot) : undefined,
    };
  }

  public updateRunStatus(
    runId: string,
    status: KernelRunStatus,
    terminationReason?: TerminationReason,
    endedAt?: string
  ): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (run) {
        this.verifyEpochFencing(run.domainId);
        if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'indeterminate') {
          if (run.status === status) {
            return;
          }
          throw new Error(
            `Cannot transition Run "${runId}" from terminal status "${run.status}" to "${status}".`
          );
        }
      }
      const stmt = this.db.prepare(`
        UPDATE runs
        SET status = ?, termination_reason = COALESCE(?, termination_reason), ended_at = COALESCE(?, ended_at)
        WHERE id = ?
      `);
      stmt.run(status, terminationReason || null, endedAt || null, runId);

      if (run) {
        this.recordEventAndTransitionState({
          domainId: run.domainId,
          runId,
          type: 'RUN_STATUS_TRANSITION',
          payload: { status, terminationReason, endedAt },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  /**
   * Run 完成协议：业务验收与执行事实分离
   */
  public reportRunSucceeded(runId: string): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run '${runId}' not found`);
      this.verifyEpochFencing(run.domainId);

      if (run.status === 'succeeded') return;
      if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'indeterminate') {
        throw new Error(
          `Cannot report run '${runId}' succeeded: already finalized with status '${run.status}'`
        );
      }

      const ops = this.getOperationsByRun(runId);
      const unfinished = ops.filter((op) => op.status !== 'done');
      if (unfinished.length > 0) {
        throw new Error(
          `Cannot complete run '${runId}': operations [${unfinished.map((o) => o.id).join(', ')}] are not in terminal status`
        );
      }

      const indeterminate = ops.filter((op) => op.result?.status === 'indeterminate');
      if (indeterminate.length > 0) {
        const indetReason = (indeterminate[0].result as any)?.terminationReason || undefined;
        this.updateRunStatus(runId, 'indeterminate', indetReason, new Date().toISOString());
        return;
      }

      this.updateRunStatus(runId, 'succeeded', 'completed', new Date().toISOString());
    });
  }

  public reportRunFailed(runId: string, reason: TerminationReason = 'completed'): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run '${runId}' not found`);
      this.verifyEpochFencing(run.domainId);
      if (run.status === 'failed') return;
      if (run.status === 'succeeded' || run.status === 'cancelled' || run.status === 'indeterminate') {
        throw new Error(
          `Cannot report run '${runId}' failed: already finalized with status '${run.status}'`
        );
      }
      this.updateRunStatus(runId, 'failed', reason, new Date().toISOString());
    });
  }

  public reportRunCancelled(runId: string, reason: TerminationReason = 'user_cancelled'): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run '${runId}' not found`);
      this.verifyEpochFencing(run.domainId);
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'indeterminate') {
        throw new Error(
          `Cannot report run '${runId}' cancelled: already finalized with status '${run.status}'`
        );
      }
      this.updateRunStatus(runId, 'cancelled', reason, new Date().toISOString());
    });
  }

  public getActiveRuns(domainId: string): Run[] {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE domain_id = ? AND status = ?');
    const rows = stmt.all(domainId, 'running') as any[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      domainId: row.domain_id,
      owner: row.owner,
      status: row.status as KernelRunStatus,
      terminationReason: row.termination_reason as TerminationReason | undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at || undefined,
      configSnapshotWhiteList: row.config_snapshot ? JSON.parse(row.config_snapshot) : undefined,
    }));
  }

  public registerOperationIntent(op: Operation, domainId: string): void {
    const run = this.getRun(op.runId);
    if (!run) {
      throw new Error(
        `Run "${op.runId}" is not registered in domain "${domainId}". ` +
          'Register the task and run first (store.saveTask() + store.saveRun()), then execute operations for that run.'
      );
    }

    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'indeterminate') {
      throw new Error(
        `Cannot register operation "${op.id}" for Run "${op.runId}" because the Run is already finalized with status "${run.status}".`
      );
    }

    this.transaction(() => {
      this.verifyEpochFencing(domainId);
      const now = new Date().toISOString();
      // 1. 写入 operation 记录，初始状态 intent_registered
      const opStmt = this.db.prepare(`
        INSERT INTO operations (id, run_id, domain_id, kind, name, input_fingerprint, status, required_resources, timeout_ms, resource_budget, output_ref, process_identity, result)
        VALUES (?, ?, ?, ?, ?, ?, 'intent_registered', ?, ?, ?, ?, ?, ?)
      `);
      opStmt.run(
        op.id,
        op.runId,
        domainId,
        op.kind,
        op.name,
        op.inputFingerprint,
        JSON.stringify(op.requiredResources || []),
        op.timeoutMs || null,
        op.resourceBudget ? JSON.stringify(op.resourceBudget) : null,
        op.outputRef || null,
        op.processIdentity ? JSON.stringify(op.processIdentity) : null,
        op.result ? JSON.stringify(op.result) : null
      );

      // 2. 写入 resource_leases 表记录排他资源占用
      if (op.requiredResources && op.requiredResources.length > 0) {
        const leaseStmt = this.db.prepare(`
          INSERT INTO resource_leases (resource_id, operation_id, domain_id, acquired_at, budget)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const res of op.requiredResources) {
          leaseStmt.run(
            res,
            op.id,
            domainId,
            now,
            op.resourceBudget ? JSON.stringify(op.resourceBudget) : null
          );
        }
      }

      // 3. 记录领域事件
      this.recordEventAndTransitionState({
        domainId,
        runId: op.runId,
        operationId: op.id,
        type: 'OPERATION_INTENT_REGISTERED',
        payload: {
          kind: op.kind,
          name: op.name,
          requiredResources: op.requiredResources,
          inputFingerprint: op.inputFingerprint,
          resourceBudget: op.resourceBudget,
        },
        timestamp: now,
      });
    });
  }

  public recordPreIntentCancelledOperation(
    op: Operation,
    domainId: string,
    result: OperationResult
  ): void {
    const run = this.getRun(op.runId);
    if (!run) {
      throw new Error(
        `Run "${op.runId}" is not registered in domain "${domainId}". ` +
          'Register the task and run first (store.saveTask() + store.saveRun()), then execute operations for that run.'
      );
    }

    if (
      run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'indeterminate'
    ) {
      throw new Error(
        `Cannot register operation "${op.id}" for Run "${op.runId}" because the Run is already finalized with status "${run.status}".`
      );
    }

    this.transaction(() => {
      this.verifyEpochFencing(domainId);
      const existing = this.getOperation(op.id);
      if (existing) {
        throw new Error(`Operation "${op.id}" already exists`);
      }
      const opStmt = this.db.prepare(`
        INSERT INTO operations (id, run_id, domain_id, kind, name, input_fingerprint, status, required_resources, timeout_ms, resource_budget, output_ref, process_identity, result)
        VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?)
      `);
      opStmt.run(
        op.id,
        op.runId,
        domainId,
        op.kind,
        op.name,
        op.inputFingerprint,
        JSON.stringify(op.requiredResources || []),
        op.timeoutMs || null,
        op.resourceBudget ? JSON.stringify(op.resourceBudget) : null,
        op.outputRef || null,
        op.processIdentity ? JSON.stringify(op.processIdentity) : null,
        JSON.stringify(result)
      );

      this.recordEventAndTransitionState({
        domainId,
        runId: op.runId,
        operationId: op.id,
        type: 'OPERATION_RESULT_RECORDED',
        payload: { result, releaseResources: false },
        timestamp: result.completedAt || new Date().toISOString(),
      });
    });
  }

  public updateOperationStatus(
    opId: string,
    status: OperationStatus,
    processIdentity?: Operation['processIdentity'],
    outputRef?: string
  ): void {
    this.transaction(() => {
      const op = this.getOperation(opId);
      if (op) {
        this.verifyEpochFencing(op.domainId);
      }
      const stmt = this.db.prepare(`
        UPDATE operations
        SET status = ?, process_identity = COALESCE(?, process_identity), output_ref = COALESCE(?, output_ref)
        WHERE id = ?
      `);
      stmt.run(status, processIdentity ? JSON.stringify(processIdentity) : null, outputRef || null, opId);

      if (op) {
        this.recordEventAndTransitionState({
          domainId: op.domainId,
          runId: op.runId,
          operationId: opId,
          type: 'OPERATION_STATUS_TRANSITION',
          payload: { status, processIdentity, outputRef },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  public updateOperationResult(opId: string, result: OperationResult): void {
    this.transaction(() => {
      const op = this.getOperation(opId);
      if (!op) throw new Error(`Operation ${opId} not found`);
      this.verifyEpochFencing(op.domainId);
      const stmt = this.db.prepare(`
        UPDATE operations
        SET result = ?
        WHERE id = ?
      `);
      stmt.run(JSON.stringify(result), opId);
    });
  }

  public recordOperationResult(
    opId: string,
    result: OperationResult,
    releaseResources: boolean = true
  ): void {
    this.transaction(() => {
      const op = this.getOperation(opId);
      if (!op) {
        throw new Error(`Operation ${opId} not found`);
      }
      this.verifyEpochFencing(op.domainId);

      if (op.status === 'done') {
        throw new Error(
          `Cannot record result for operation "${opId}": operation is already finalized with status "done"`
        );
      }

      const stmt = this.db.prepare(`
        UPDATE operations
        SET status = 'done', result = ?, output_ref = COALESCE(?, output_ref)
        WHERE id = ?
      `);
      const outputRef = (result as any).outputRef || null;
      stmt.run(JSON.stringify(result), outputRef, opId);

      // 若确认完成且允许释放资源，结清资源
      if (releaseResources && result.status !== 'indeterminate') {
        const delLeases = this.db.prepare('DELETE FROM resource_leases WHERE operation_id = ?');
        delLeases.run(opId);
      }

      this.recordEventAndTransitionState({
        domainId: op.domainId,
        runId: op.runId,
        operationId: opId,
        type: 'OPERATION_RESULT_RECORDED',
        payload: { result, releaseResources },
        timestamp: result.completedAt || new Date().toISOString(),
      });
    });
  }

  public getOperation(id: string): (Operation & { domainId: string }) | null {
    const stmt = this.db.prepare('SELECT * FROM operations WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      domainId: row.domain_id,
      kind: row.kind,
      name: row.name,
      inputFingerprint: row.input_fingerprint,
      requiredResources: JSON.parse(row.required_resources),
      timeoutMs: row.timeout_ms || undefined,
      resourceBudget: row.resource_budget ? JSON.parse(row.resource_budget) : undefined,
      outputRef: row.output_ref || undefined,
      status: row.status as OperationStatus,
      processIdentity: row.process_identity ? JSON.parse(row.process_identity) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    };
  }

  public getOperationsByRun(runId: string): (Operation & { domainId: string })[] {
    const stmt = this.db.prepare('SELECT * FROM operations WHERE run_id = ?');
    const rows = stmt.all(runId) as any[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      domainId: row.domain_id,
      kind: row.kind,
      name: row.name,
      inputFingerprint: row.input_fingerprint,
      requiredResources: JSON.parse(row.required_resources),
      timeoutMs: row.timeout_ms || undefined,
      resourceBudget: row.resource_budget ? JSON.parse(row.resource_budget) : undefined,
      outputRef: row.output_ref || undefined,
      status: row.status as OperationStatus,
      processIdentity: row.process_identity ? JSON.parse(row.process_identity) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    }));
  }

  public getUnfinishedOperations(domainId: string): (Operation & { domainId: string })[] {
    const stmt = this.db.prepare(`
      SELECT * FROM operations
      WHERE domain_id = ? AND status IN ('intent_registered', 'active', 'stopping')
    `);
    const rows = stmt.all(domainId) as any[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      domainId: row.domain_id,
      kind: row.kind,
      name: row.name,
      inputFingerprint: row.input_fingerprint,
      requiredResources: JSON.parse(row.required_resources),
      timeoutMs: row.timeout_ms || undefined,
      resourceBudget: row.resource_budget ? JSON.parse(row.resource_budget) : undefined,
      outputRef: row.output_ref || undefined,
      status: row.status as OperationStatus,
      processIdentity: row.process_identity ? JSON.parse(row.process_identity) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    }));
  }

  public getAllOperations(domainId: string): (Operation & { domainId: string })[] {
    const stmt = this.db.prepare(`
      SELECT * FROM operations
      WHERE domain_id = ?
    `);
    const rows = stmt.all(domainId) as any[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      domainId: row.domain_id,
      kind: row.kind,
      name: row.name,
      inputFingerprint: row.input_fingerprint,
      requiredResources: JSON.parse(row.required_resources),
      timeoutMs: row.timeout_ms || undefined,
      resourceBudget: row.resource_budget ? JSON.parse(row.resource_budget) : undefined,
      outputRef: row.output_ref || undefined,
      status: row.status as OperationStatus,
      processIdentity: row.process_identity ? JSON.parse(row.process_identity) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    }));
  }

  public getPersistedResourceLeases(domainId: string): (ResourceLease & { budget?: ResourceBudget })[] {
    const stmt = this.db.prepare('SELECT * FROM resource_leases WHERE domain_id = ?');
    const rows = stmt.all(domainId) as any[];
    return rows.map((row) => ({
      resourceId: row.resource_id,
      operationId: row.operation_id,
      domainId: row.domain_id,
      acquiredAt: row.acquired_at,
      budget: row.budget ? JSON.parse(row.budget) : undefined,
    }));
  }

  public releaseResourceLease(operationId: string, resourceId?: string): void {
    if (resourceId) {
      const stmt = this.db.prepare('DELETE FROM resource_leases WHERE operation_id = ? AND resource_id = ?');
      stmt.run(operationId, resourceId);
    } else {
      const stmt = this.db.prepare('DELETE FROM resource_leases WHERE operation_id = ?');
      stmt.run(operationId);
    }
  }

  public recordEventAndTransitionState(event: Omit<JournalEvent, 'seq'>): number {
    this.verifyEpochFencing(event.domainId);
    const stmt = this.db.prepare(`
      INSERT INTO journal_events (domain_id, run_id, operation_id, type, payload, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      event.domainId,
      event.runId || null,
      event.operationId || null,
      event.type,
      JSON.stringify(event.payload),
      event.timestamp
    );
    return Number(res.lastInsertRowid);
  }

  public getJournalEvents(domainId: string, fromSeq: number = 0): JournalEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM journal_events
      WHERE domain_id = ? AND seq >= ?
      ORDER BY seq ASC
    `);
    const rows = stmt.all(domainId, fromSeq) as any[];
    return rows.map((row) => ({
      seq: row.seq,
      domainId: row.domain_id,
      runId: row.run_id || undefined,
      operationId: row.operation_id || undefined,
      type: row.type,
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp,
    }));
  }

  public getEventsByRun(runId: string): JournalEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM journal_events
      WHERE run_id = ?
      ORDER BY seq ASC
    `);
    const rows = stmt.all(runId) as any[];
    return rows.map((row) => ({
      seq: row.seq,
      domainId: row.domain_id,
      runId: row.run_id || undefined,
      operationId: row.operation_id || undefined,
      type: row.type,
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp,
    }));
  }

  public close(): void {
    this.db.close();
  }
}
