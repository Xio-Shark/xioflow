import type { PlatformDriver, StopProcessResult } from '../driver/types.js';
import { ExecutionDomain } from '../domain.js';
import type { Operation, RecoveryEvidence } from '../types.js';
import type {
  ControlCancelArgs,
  ControlResolveArgs,
  ControlResumeArgs,
  ControlStatusArgs,
  LeaseRef,
  ResumeToken,
} from './types.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';

export interface ControlStatusReport {
  found: boolean;
  target: ControlStatusArgs;
  domainId: string;
  run?: { id: string; status: string; terminationReason?: string };
  operations: Array<{
    id: string;
    runId: string;
    kind: Operation['kind'];
    status: Operation['status'];
    resultStatus?: string;
    recoveryEvidence?: RecoveryEvidence;
  }>;
  leases: string[];
}

export interface ControlHealthReport {
  status: 'healthy' | 'degraded';
  domainId: string;
  epoch: number;
  driver?: { name: string; capabilities: PlatformDriver['capabilities'] };
  runs: { active: number; total: number };
  operations: { unfinished: number; total: number };
  leases: number;
}

export interface ControlCancelReport {
  operationId: string;
  status: 'cancelled' | 'indeterminate' | 'already_terminal';
  stop?: StopProcessResult;
  operation?: (Operation & { domainId: string }) | null;
}

export interface ControlResolveReport {
  operationId: string;
  status: 'resolved';
  decision: ControlResolveArgs['decision'];
  adjudication: Awaited<ReturnType<ExecutionDomain['adjudicate']>>;
  leasesReleased: boolean;
}

export interface ControlResumeReport {
  operationId: string;
  status: string;
  resumed: false;
  replay: 'journal_only';
  nextActions: string[];
}

function operationIdFromLease(lease: LeaseRef): string {
  const operationId = lease.slice('lease:'.length);
  if (!operationId) throw new Error('control target lease is empty');
  return operationId;
}

function operationIdFromTarget(target: ControlStatusArgs): string | undefined {
  if (target.lease) return operationIdFromLease(target.lease);
  return target.instruction;
}

function summary(operation: Operation & { domainId: string }) {
  return {
    id: operation.id,
    runId: operation.runId,
    kind: operation.kind,
    status: operation.status,
    resultStatus: operation.result?.status,
    recoveryEvidence: operation.recoveryEvidence,
  };
}

/** Durable control-plane façade. It never re-executes an uncertain operation. */
export class IsaControlPlane {
  constructor(
    private readonly domain: ExecutionDomain,
    private readonly supervisor?: ProcessSupervisor,
    private readonly driver: PlatformDriver | undefined = domain.getDriver?.(),
  ) {}

  public status(target: ControlStatusArgs): ControlStatusReport {
    const store = this.domain.getStore();
    const opId = operationIdFromTarget(target);
    const operation = opId ? store.getOperation(opId) : null;
    const run = target.program ? store.getRun(target.program) : operation ? store.getRun(operation.runId) : null;
    const operations = operation
      ? [summary(operation)]
      : run
        ? store.getOperationsByRun(run.id).map(summary)
        : target.lease
          ? store.getPersistedResourceLeases(this.domain.domainId)
            .filter((lease) => lease.operationId === operationIdFromLease(target.lease!))
            .map((lease) => store.getOperation(lease.operationId))
            .filter((entry): entry is Operation & { domainId: string } => entry !== null)
            .map(summary)
          : [];
    const leases = store.getPersistedResourceLeases(this.domain.domainId)
      .filter((lease) => operations.some((entry) => entry.id === lease.operationId))
      .map((lease) => lease.resourceId);
    return {
      found: operation !== null || run !== null || operations.length > 0,
      target,
      domainId: this.domain.domainId,
      run: run ? { id: run.id, status: run.status, terminationReason: run.terminationReason } : undefined,
      operations,
      leases,
    };
  }

  public health(): ControlHealthReport {
    const status = this.domain.status;
    const driver = this.driver ?? this.domain.getDriver?.();
    const degraded = status.unfinishedOperations.length > 0
      || status.leases.length > 0
      || status.operations.some((operation) => operation.result?.status === 'indeterminate' && !operation.result.adjudication);
    return {
      status: degraded ? 'degraded' : 'healthy',
      domainId: status.domainId,
      epoch: status.epoch,
      driver: driver ? { name: driver.name, capabilities: driver.capabilities } : undefined,
      runs: { active: status.activeRuns.length, total: status.runs.length },
      operations: { unfinished: status.unfinishedOperations.length, total: status.operations.length },
      leases: status.leases.length,
    };
  }

  public async cancel(target: ControlCancelArgs): Promise<ControlCancelReport> {
    const opId = operationIdFromTarget(target);
    if (!opId) throw new Error('control.cancel requires an instruction or lease target');
    const operation = this.domain.getStore().getOperation(opId);
    if (!operation) throw new Error(`Operation "${opId}" not found`);
    if (operation.status === 'done') {
      return { operationId: opId, status: 'already_terminal', operation };
    }
    if (!this.supervisor) throw new Error('control.cancel requires a ProcessSupervisor');
    this.domain.getStore().recordEventAndTransitionState({
      domainId: this.domain.domainId,
      runId: operation.runId,
      operationId: opId,
      type: 'CONTROL_CANCEL_REQUESTED',
      payload: { operationId: opId, graceMs: target.graceMs ?? 2000 },
      timestamp: new Date().toISOString(),
    });
    const stop = await this.supervisor.cancelOperation(opId, target.graceMs ?? 2000);
    const updated = this.domain.getStore().getOperation(opId);
    return {
      operationId: opId,
      status: stop.stopped === 'confirmed_stopped' ? 'cancelled' : 'indeterminate',
      stop,
      operation: updated ?? operation,
    };
  }

  public async resolve(args: ControlResolveArgs, actor = 'control-plane'): Promise<ControlResolveReport> {
    const opId = operationIdFromLease(args.lease);
    const operation = this.domain.getStore().getOperation(opId);
    if (!operation) throw new Error(`Operation "${opId}" not found`);
    const verdict = args.decision === 'succeeded' ? 'confirmed_stopped' : 'abandon_with_residuals';
    const adjudication = await this.domain.adjudicate(opId, verdict, actor, args.reason, {
      decision: args.decision,
      evidence: args.evidence,
    });
    const leasesReleased = this.domain.getStore().getPersistedResourceLeases(this.domain.domainId)
      .some((lease) => lease.operationId === opId) === false;
    return { operationId: opId, status: 'resolved', decision: args.decision, adjudication, leasesReleased };
  }

  public async resume(args: ControlResumeArgs, actor = 'control-plane'): Promise<ControlResumeReport> {
    const opId = operationIdFromResumeToken(args.resumeToken);
    const operation = this.domain.getStore().getOperation(opId);
    if (!operation) throw new Error(`Operation "${opId}" not found for resume token`);
    this.domain.getStore().recordEventAndTransitionState({
      domainId: this.domain.domainId,
      runId: operation.runId,
      operationId: opId,
      type: 'CONTROL_RESUMED',
      payload: { operationId: opId, resumeToken: args.resumeToken, actor, status: operation.result?.status ?? operation.status },
      timestamp: new Date().toISOString(),
    });
    const nextActions = operation.result?.status === 'indeterminate'
      ? ['control.status', 'control.resolve']
      : [];
    return {
      operationId: opId,
      status: operation.result?.status ?? operation.status,
      resumed: false,
      replay: 'journal_only',
      nextActions,
    };
  }
}

function operationIdFromResumeToken(token: ResumeToken): string {
  const opId = token.slice('resume:'.length);
  if (!opId) throw new Error('resume token does not identify an operation');
  return opId;
}

