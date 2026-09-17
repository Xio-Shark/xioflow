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
  sanitizeConfigSnapshot,
} from '../types.js';

export class SqliteStore {
  private db: DatabaseSync;

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

  public transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public saveTask(task: Task): void {
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
      const stmt = this.db.prepare(`
        UPDATE runs
        SET status = ?, termination_reason = COALESCE(?, termination_reason), ended_at = COALESCE(?, ended_at)
        WHERE id = ?
      `);
      stmt.run(status, terminationReason || null, endedAt || null, runId);

      const run = this.getRun(runId);
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

  public registerOperationIntent(op: Operation, domainId: string): void {
    this.transaction(() => {
      // 1. 写入 operation 记录，初始状态 intent_registered
      const opStmt = this.db.prepare(`
        INSERT INTO operations (id, run_id, domain_id, kind, name, input_fingerprint, status, required_resources, timeout_ms, process_identity, result)
        VALUES (?, ?, ?, ?, ?, ?, 'intent_registered', ?, ?, ?, ?)
      `);
      opStmt.run(
        op.id,
        op.runId,
        domainId,
        op.kind,
        op.name,
        op.inputFingerprint,
        JSON.stringify(op.requiredResources),
        op.timeoutMs || null,
        op.processIdentity ? JSON.stringify(op.processIdentity) : null,
        op.result ? JSON.stringify(op.result) : null
      );

      // 2. 写入 resource_leases 表记录排他资源占用
      const leaseStmt = this.db.prepare(`
        INSERT INTO resource_leases (resource_id, operation_id, domain_id, acquired_at)
        VALUES (?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const res of op.requiredResources) {
        leaseStmt.run(res, op.id, domainId, now);
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
        },
        timestamp: now,
      });
    });
  }

  public updateOperationStatus(
    opId: string,
    status: OperationStatus,
    processIdentity?: Operation['processIdentity']
  ): void {
    this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE operations
        SET status = ?, process_identity = COALESCE(?, process_identity)
        WHERE id = ?
      `);
      stmt.run(status, processIdentity ? JSON.stringify(processIdentity) : null, opId);

      const op = this.getOperation(opId);
      if (op) {
        this.recordEventAndTransitionState({
          domainId: (op as any).domainId || 'default',
          runId: op.runId,
          operationId: opId,
          type: 'OPERATION_STATUS_TRANSITION',
          payload: { status, processIdentity },
          timestamp: new Date().toISOString(),
        });
      }
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

      const stmt = this.db.prepare(`
        UPDATE operations
        SET status = 'done', result = ?
        WHERE id = ?
      `);
      stmt.run(JSON.stringify(result), opId);

      // 若确认完成且允许释放资源，结清资源
      if (releaseResources && result.status !== 'indeterminate') {
        const delLeases = this.db.prepare('DELETE FROM resource_leases WHERE operation_id = ?');
        delLeases.run(opId);
      }

      this.recordEventAndTransitionState({
        domainId: (op as any).domainId || 'default',
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
      status: row.status as OperationStatus,
      processIdentity: row.process_identity ? JSON.parse(row.process_identity) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    };
  }

  public getUnfinishedOperations(domainId: string): Operation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM operations
      WHERE domain_id = ? AND status IN ('intent_registered', 'active', 'stopping')
    `);
    const rows = stmt.all(domainId) as any[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      name: row.name,
      inputFingerprint: row.input_fingerprint,
      requiredResources: JSON.parse(row.required_resources),
      timeoutMs: row.timeout_ms || undefined,
      status: row.status as OperationStatus,
      processIdentity: row.process_identity ? JSON.parse(row.process_identity) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    }));
  }

  public getPersistedResourceLeases(domainId: string): ResourceLease[] {
    const stmt = this.db.prepare('SELECT * FROM resource_leases WHERE domain_id = ?');
    const rows = stmt.all(domainId) as any[];
    return rows.map((row) => ({
      resourceId: row.resource_id,
      operationId: row.operation_id,
      domainId: row.domain_id,
      acquiredAt: row.acquired_at,
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

  public close(): void {
    this.db.close();
  }
}
