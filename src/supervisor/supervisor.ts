import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExecutionDomain } from '../domain.js';
import {
  PlatformDriver,
  StructuredCommand,
  ManagedProcessHandle,
  ProcessIdentity,
  StopProcessResult,
} from '../driver/types.js';
import {
  Operation,
  OperationResult,
  ProcessOperationResult,
  IndeterminateResult,
  KernelRunStatus,
  TerminationReason,
  ResourceBudget,
  UnsupportedCapabilityError,
  OperationNotActiveError,
  DuplicateOperationError,
  OperationIdConflictError,
  RecoveryRequiredError,
  ServiceSpec,
  ServiceHandle,
  SnapshotDriver,
  SnapshotRef,
  SnapshotOperationResult,
  RollbackOperationResult,
  ResourceConflictError,
  ConfinementDriver,
} from '../types.js';
import { NodePlatformDriver } from '../driver/node-driver.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { ServiceSupervisor } from './service.js';
import { setupStreamDrainer, StreamDrainer } from './drainer.js';
import { isPathContained, resolveRealPath } from '../capability/index.js';
import { createConfinementDriver } from '../confinement/index.js';

export interface ExecuteProcessOptions {
  runId: string;
  opId: string;
  name: string;
  command: StructuredCommand;
  requiredResources?: string[];
  mutationRoots?: string[];
  capabilityId?: string;
  confinement?: boolean | string;
  confinementDriver?: ConfinementDriver;
  timeoutMs?: number;
  inputFingerprint?: string;
  maxOutputBytes?: number;
  drainTimeoutMs?: number;
  resourceBudget?: ResourceBudget;
  waitTimeoutMs?: number;
  artifactsDir?: string;
  abortSignal?: AbortSignal;
  /**
   * 流式投影：每个 stdout/stderr chunk 原样转发，不做缓冲或截断。
   * 回调抛错不会中断排空，首个错误以 result.streamCallbackError 记录。
   */
  onStreamChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
}

export interface CaptureSnapshotOptions {
  runId: string;
  opId: string;
  roots?: string[];
  capabilityId?: string;
  includeIgnored?: boolean;
  maxTreeSizeBytes?: number;
  timeoutMs?: number;
}

export interface RollbackOptions {
  runId: string;
  opId: string;
  snapshotId: string;
  roots?: string[];
  capabilityId?: string;
  force?: boolean;
  timeoutMs?: number;
}

export function normalizeResourceName(res: string): string {
  if (res.startsWith('workspace:write:')) {
    const raw = res.slice('workspace:write:'.length);
    try {
      return `workspace:write:${fs.realpathSync(raw)}`;
    } catch {
      return `workspace:write:${path.resolve(raw)}`;
    }
  }
  return res;
}

/**
 * 规范化计算完整输入的 SHA-256 指纹 (ARCHITECTURE §2 / P0-12)
 * 覆盖 execPath, args, cwd, 键排序的 envWhiteList, inheritEnv, sha256(stdin), 排序后的 requiredResources, timeoutMs, resourceBudget.
 */
export function computeInputFingerprint(options: ExecuteProcessOptions): string {
  const cmd = options.command;
  let stdinHash: string | null = null;
  if (cmd.stdin !== undefined && cmd.stdin !== null) {
    stdinHash = crypto.createHash('sha256').update(cmd.stdin).digest('hex');
  }

  let envSorted: [string, string][] | null = null;
  if (cmd.envWhiteList) {
    const keys = Object.keys(cmd.envWhiteList).sort();
    envSorted = keys.map((k) => [k, cmd.envWhiteList![k]]);
  }

  const canonical = {
    args: cmd.args || [],
    cwd: cmd.cwd || '',
    envWhiteList: envSorted,
    execPath: cmd.execPath || '',
    inheritEnv: cmd.inheritEnv ?? null,
    requiredResources: [...(options.requiredResources || [])].sort(),
    resourceBudget: options.resourceBudget
      ? {
          enforcement: options.resourceBudget.enforcement ?? null,
          maxCpuTimeMs: options.resourceBudget.maxCpuTimeMs ?? null,
          maxMemoryBytes: options.resourceBudget.maxMemoryBytes ?? null,
          maxOutputBytes: options.resourceBudget.maxOutputBytes ?? null,
          maxPids: options.resourceBudget.maxPids ?? null,
        }
      : null,
    stdinHash,
    timeoutMs: options.timeoutMs ?? null,
    capabilityId: options.capabilityId ?? null,
  };

  const canonicalJson = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

interface ActiveOperationState {
  opId: string;
  runId: string;
  phase: 'waiting_resources' | 'intent_registered' | 'spawning' | 'active' | 'stopping' | 'done';
  startTime: number;
  inputFingerprint: string;
  resultPromise?: Promise<ProcessOperationResult>;
  streamSubscribers: Set<(stream: 'stdout' | 'stderr', chunk: Buffer) => void>;
  handle?: ManagedProcessHandle;
  command?: StructuredCommand;
  cancelRequested: boolean;
  cancelGraceMs?: number;
  timedOut: boolean;
  terminationReason?: TerminationReason;
  stopPromise?: Promise<StopProcessResult>;
  stopResolve?: (res: StopProcessResult) => void;
}

export class ProcessSupervisor {
  private activeOperations: Map<string, ActiveOperationState> = new Map();
  private serviceSupervisor: ServiceSupervisor;
  private snapshotDriver: SnapshotDriver;
  private confinementDriver?: ConfinementDriver;

  constructor(
    private readonly domain: ExecutionDomain,
    private readonly driver: PlatformDriver = domain.getDriver?.() || new NodePlatformDriver(),
    snapshotDriver?: SnapshotDriver,
    confinementDriver?: ConfinementDriver
  ) {
    this.domain.setDriver?.(driver);
    this.serviceSupervisor = new ServiceSupervisor(domain, driver, this);
    this.snapshotDriver = snapshotDriver || new GitShadowSnapshotDriver();
    this.confinementDriver = confinementDriver;
    this.domain.setSnapshotDriver?.(this.snapshotDriver);
  }

  public getDomain(): ExecutionDomain {
    return this.domain;
  }

  public getDriver(): PlatformDriver {
    return this.driver;
  }

  public getSnapshotDriver(): SnapshotDriver {
    return this.snapshotDriver;
  }

  public setConfinementDriver(driver: ConfinementDriver): void {
    this.confinementDriver = driver;
  }

  public getConfinementDriver(): ConfinementDriver | undefined {
    return this.confinementDriver;
  }

  public async startService(spec: ServiceSpec): Promise<ServiceHandle> {
    return this.serviceSupervisor.startService(spec);
  }

  /**
   * 快照捕获协议 (ARCHITECTURE §3.5 / 契约 #32, #53)
   */
  public async captureSnapshot(options: CaptureSnapshotOptions): Promise<SnapshotOperationResult> {
    const startTime = Date.now();
    let targetRoots = options.roots;
    let capAdmission: any;

    if (options.capabilityId) {
      capAdmission = this.domain.checkCapabilityAdmission({
        capabilityId: options.capabilityId,
        mutationRoots: targetRoots,
        runId: options.runId,
        opId: options.opId,
      });
      if (!targetRoots || targetRoots.length === 0) {
        targetRoots = capAdmission.effectiveMutationRoots;
      }
    }

    if (!targetRoots || targetRoots.length === 0) {
      throw new Error('captureSnapshot requires at least one root directory');
    }

    const realRoots = targetRoots.map((r) => path.resolve(r));
    const requiredResources = realRoots.map((r) => `workspace:write:${r}`);

    if (this.snapshotDriver instanceof GitShadowSnapshotDriver) {
      try {
        const { commonDir } = await this.snapshotDriver.assertGitRepo(realRoots[0]);
        requiredResources.push(`git:objects:${commonDir}`);
      } catch {}
    }

    const inputFingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          kind: 'snapshot',
          roots: realRoots,
          includeIgnored: !!options.includeIgnored,
          maxTreeSizeBytes: options.maxTreeSizeBytes,
          capabilityId: options.capabilityId ?? null,
        })
      )
      .digest('hex');

    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'snapshot',
      name: `snapshot:${realRoots[0]}`,
      inputFingerprint,
      requiredResources,
      mutationRoots: realRoots,
      capabilityId: options.capabilityId,
      timeoutMs: options.timeoutMs,
      status: 'intent_registered',
    };

    this.domain.registerOperationIntent(op);
    this.domain.getStore().updateOperationStatus(options.opId, 'active');
    this.domain.getStore().recordEventAndTransitionState({
      domainId: this.domain.domainId,
      runId: options.runId,
      operationId: options.opId,
      type: 'OPERATION_STATUS_TRANSITION',
      payload: { status: 'active' },
      timestamp: new Date().toISOString(),
    });

    if (options.capabilityId && capAdmission) {
      this.domain.getStore().recordJournalEvent({
        domainId: this.domain.domainId,
        runId: options.runId,
        operationId: options.opId,
        type: 'CAPABILITY_USED',
        payload: {
          capabilityId: options.capabilityId,
          scope: capAdmission.capability.scope,
          actor: capAdmission.capability.issuedBy,
        },
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const snapRef = await this.snapshotDriver.capture(realRoots, {
        id: options.opId,
        domainId: this.domain.domainId,
        opId: options.opId,
        includeIgnored: options.includeIgnored,
        maxTreeSizeBytes: options.maxTreeSizeBytes,
      });

      let result: SnapshotOperationResult;

      this.domain.getStore().transaction(() => {
        const seq = this.domain.getStore().recordEventAndTransitionState({
          domainId: this.domain.domainId,
          runId: options.runId,
          operationId: options.opId,
          type: 'SNAPSHOT_CAPTURED',
          payload: {
            snapshotId: snapRef.id,
            roots: snapRef.roots,
            treeFingerprint: snapRef.treeFingerprint,
            commitHash: snapRef.commitHash,
          },
          timestamp: new Date().toISOString(),
        });
        snapRef.journalSeq = seq;
        this.domain.getStore().recordSnapshot(snapRef);

        result = {
          kind: 'snapshot',
          status: 'succeeded',
          snapshot: snapRef,
          capabilityId: options.capabilityId,
          durationMs: Date.now() - startTime,
          completedAt: new Date().toISOString(),
        };

        this.domain.getStore().recordOperationResult(options.opId, result);
        this.domain.getStore().updateOperationStatus(options.opId, 'done');
        this.domain.getStore().recordEventAndTransitionState({
          domainId: this.domain.domainId,
          runId: options.runId,
          operationId: options.opId,
          type: 'OPERATION_RESULT_RECORDED',
          payload: { status: 'succeeded', snapshotId: snapRef.id },
          timestamp: new Date().toISOString(),
        });
      });

      this.domain.internalReleaseResources(options.opId);
      return result!;
    } catch (err: any) {
      const failResult: SnapshotOperationResult = {
        kind: 'snapshot',
        status: 'failed',
        errorMessage: err.message,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };
      let recordError: unknown;
      try {
        this.domain.getStore().recordOperationResult(options.opId, failResult);
        this.domain.getStore().updateOperationStatus(options.opId, 'done');
      } catch (recErr) {
        recordError = recErr;
      }
      this.domain.internalReleaseResources(options.opId);
      if (recordError !== undefined) {
        // 失败事实没能落盘时不能只抛原始错误：调用方需要知道 journal 里没有这条结果
        const recMsg = recordError instanceof Error ? recordError.message : String(recordError);
        throw new Error(`${err.message} (additionally, recording the failed snapshot result failed: ${recMsg})`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  /**
   * 回滚协议 (ARCHITECTURE §3.5 / 契约 #28–#30, #56)
   */
  public async rollback(options: RollbackOptions): Promise<RollbackOperationResult> {
    const startTime = Date.now();
    const snapshot = this.domain.getStore().getSnapshot(options.snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${options.snapshotId}`);
    }

    let targetRoots = (options.roots || snapshot.roots).map((r) => path.resolve(r));
    let capAdmission: any;

    if (options.capabilityId) {
      capAdmission = this.domain.checkCapabilityAdmission({
        capabilityId: options.capabilityId,
        mutationRoots: targetRoots,
        runId: options.runId,
        opId: options.opId,
      });
      targetRoots = capAdmission.effectiveMutationRoots;
    }

    // 0. 前置条件检查（契约 #30）：目标根目录上不存在 active / stopping / 未裁决 indeterminate 的操作
    for (const root of targetRoots) {
      let realRoot = root;
      try {
        realRoot = fs.realpathSync(root);
      } catch {}
      const res1 = `workspace:write:${root}`;
      const res2 = `workspace:write:${realRoot}`;

      if (this.domain.isResourceLocked(res1)) {
        throw new ResourceConflictError(res1, this.domain.getResourceOwner(res1) || 'unknown', options.opId, 0);
      }
      if (this.domain.isResourceLocked(res2)) {
        throw new ResourceConflictError(res2, this.domain.getResourceOwner(res2) || 'unknown', options.opId, 0);
      }
    }

    const unfinishedOps = this.domain.getStore().getUnfinishedOperations(this.domain.domainId);
    for (const op of unfinishedOps) {
      if (op.id === options.opId) continue;
      for (const root of targetRoots) {
        let realRoot = root;
        try {
          realRoot = fs.realpathSync(root);
        } catch {}
        const writeRes1 = `workspace:write:${root}`;
        const writeRes2 = `workspace:write:${realRoot}`;
        if (
          op.requiredResources.includes(writeRes1) ||
          op.requiredResources.includes(writeRes2) ||
          op.mutationRoots?.some((mr) => {
            const resolved = path.resolve(mr);
            return resolved === root || resolved === realRoot;
          })
        ) {
          throw new ResourceConflictError(
            writeRes1,
            op.id,
            options.opId,
            0
          );
        }
      }
    }

    // 检查是否有未裁决的 indeterminate op 占用该 root
    const leases = this.domain.getStore().getPersistedResourceLeases(this.domain.domainId);
    for (const lease of leases) {
      for (const root of targetRoots) {
        let realRoot = root;
        try {
          realRoot = fs.realpathSync(root);
        } catch {}
        const writeRes1 = `workspace:write:${root}`;
        const writeRes2 = `workspace:write:${realRoot}`;
        if ((lease.resourceId === writeRes1 || lease.resourceId === writeRes2) && lease.operationId !== options.opId) {
          throw new ResourceConflictError(
            lease.resourceId,
            lease.operationId,
            options.opId,
            0
          );
        }
      }
    }

    const requiredResources = targetRoots.map((r) => `workspace:write:${r}`);
    const inputFingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          kind: 'rollback',
          snapshotId: options.snapshotId,
          targetRoots,
          capabilityId: options.capabilityId ?? null,
        })
      )
      .digest('hex');

    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'rollback',
      name: `rollback:${options.snapshotId}`,
      inputFingerprint,
      requiredResources,
      mutationRoots: targetRoots,
      capabilityId: options.capabilityId,
      outputRef: options.snapshotId,
      timeoutMs: options.timeoutMs,
      status: 'intent_registered',
    };

    this.domain.registerOperationIntent(op);
    this.domain.getStore().updateOperationStatus(options.opId, 'active');
    this.domain.getStore().recordEventAndTransitionState({
      domainId: this.domain.domainId,
      runId: options.runId,
      operationId: options.opId,
      type: 'OPERATION_STATUS_TRANSITION',
      payload: { status: 'active' },
      timestamp: new Date().toISOString(),
    });

    if (options.capabilityId && capAdmission) {
      this.domain.getStore().recordJournalEvent({
        domainId: this.domain.domainId,
        runId: options.runId,
        operationId: options.opId,
        type: 'CAPABILITY_USED',
        payload: {
          capabilityId: options.capabilityId,
          scope: capAdmission.capability.scope,
          actor: capAdmission.capability.issuedBy,
        },
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const { unrestoredPaths } = await this.snapshotDriver.restore(snapshot, { force: options.force });

      const currentFp = await this.snapshotDriver.fingerprint(targetRoots, { against: snapshot });
      const isMatch = currentFp === snapshot.treeFingerprint;
      let status: 'restored' | 'partial' | 'failed';
      if (!isMatch) {
        status = 'failed';
      } else if (unrestoredPaths.length > 0) {
        status = 'partial';
      } else {
        status = 'restored';
      }

      let allOpsConfined = false;
      const eventsSince = snapshot.journalSeq !== undefined
        ? this.domain.getStore().getJournalEvents(this.domain.domainId, snapshot.journalSeq)
        : [];
      const opResults = eventsSince.filter(
        (e) => e.type === 'OPERATION_RESULT_RECORDED' && e.operationId !== options.opId
      );

      if (opResults.length === 0) {
        allOpsConfined = true;
      } else {
        allOpsConfined = opResults.every((e) => {
          const res = (e.payload as any)?.result || e.payload;
          const storedOp = this.domain.getStore().getOperation(e.operationId!);
          if (storedOp?.kind === 'snapshot' || storedOp?.kind === 'rollback') {
            return true;
          }
          if (res?.confined !== true) {
            return false;
          }
          const opRoots = storedOp?.mutationRoots || [];
          if (opRoots.length === 0) return true;
          return opRoots.every((opr) => targetRoots.some((sr) => isPathContained(sr, opr)));
        });
      }

      let coverage: 'complete' | 'declared_roots' | 'none';
      let outOfScopeEffects: 'none_possible' | 'possible';

      if (status !== 'restored') {
        coverage = status === 'partial' ? 'declared_roots' : 'none';
        outOfScopeEffects = 'possible';
      } else if (allOpsConfined) {
        coverage = 'complete';
        outOfScopeEffects = 'none_possible';
      } else {
        coverage = 'declared_roots';
        outOfScopeEffects = 'possible';
      }

      let result: RollbackOperationResult;

      this.domain.getStore().transaction(() => {
        result = {
          kind: 'rollback',
          status,
          snapshotId: options.snapshotId,
          unrestoredPaths: unrestoredPaths.length > 0 ? unrestoredPaths : undefined,
          coverage,
          outOfScopeEffects,
          capabilityId: options.capabilityId,
          durationMs: Date.now() - startTime,
          completedAt: new Date().toISOString(),
        };

        this.domain.getStore().recordOperationResult(options.opId, result);
        this.domain.getStore().updateOperationStatus(options.opId, 'done');
      });

      this.domain.internalReleaseResources(options.opId);
      return result!;
    } catch (err: any) {
      this.domain.internalReleaseResources(options.opId);
      throw err;
    }
  }

  /**
   * 分叉工作区 Materialize (ARCHITECTURE §3.5 / 契约 #54)
   */
  public async materialize(snapshotId: string, newRoot: string): Promise<{ worktreePath: string }> {
    const absNewRoot = path.resolve(newRoot);
    const writeRes = `workspace:write:${absNewRoot}`;
    if (this.domain.isResourceLocked(writeRes)) {
      throw new ResourceConflictError(
        writeRes,
        this.domain.getResourceOwner(writeRes) || 'unknown',
        'materialize'
      );
    }
    const opId = `mat-${snapshotId}-${Date.now()}`;
    this.domain.allocateResources(opId, [writeRes]);

    try {
      if (!this.snapshotDriver.materialize) {
        throw new Error(`Snapshot driver ${this.snapshotDriver.name} does not support materialize`);
      }
      const snapshot = this.domain.getStore().getSnapshot(snapshotId);
      const repoRoot = snapshot?.roots[0];
      return await this.snapshotDriver.materialize(snapshotId, absNewRoot, { repoRoot });
    } catch (err) {
      this.domain.internalReleaseResources(opId);
      throw err;
    }
  }

  /**
   * 回收分叉工作区 Dematerialize (ARCHITECTURE §3.5 / 契约 #54)
   */
  public async dematerialize(newRoot: string, options?: { force?: boolean }): Promise<void> {
    const absNewRoot = path.resolve(newRoot);
    let realNewRoot = absNewRoot;
    try {
      realNewRoot = fs.realpathSync(absNewRoot);
    } catch {}

    if (!this.snapshotDriver.dematerialize) {
      throw new Error(`Snapshot driver ${this.snapshotDriver.name} does not support dematerialize`);
    }
    await this.snapshotDriver.dematerialize(absNewRoot, options);

    const writeRes = `workspace:write:${absNewRoot}`;
    const writeResReal = `workspace:write:${realNewRoot}`;
    const owner1 = this.domain.getResourceOwner(writeRes);
    const owner2 = this.domain.getResourceOwner(writeResReal);
    if (owner1) {
      this.domain.internalReleaseResources(owner1, [writeRes]);
    }
    if (owner2 && owner2 !== owner1) {
      this.domain.internalReleaseResources(owner2, [writeResReal]);
    }

    const leases = this.domain.getStore().getPersistedResourceLeases(this.domain.domainId);
    for (const lease of leases) {
      if (lease.resourceId === writeRes || lease.resourceId === writeResReal) {
        this.domain.internalReleaseResources(lease.operationId, [lease.resourceId]);
      }
    }
  }

  /**
   * 启动协议：准入检查 -> 先持久化意图 -> 请求驱动启动 -> 登记身份并转 active -> 监督运行 -> 记录结果
   */
  public async executeProcess(options: ExecuteProcessOptions): Promise<ProcessOperationResult> {
    // 0. Capability 准入校验与字段推导（契约 #55）
    let effectiveMutationRoots = options.mutationRoots;
    let capAdmission: any;

    if (options.capabilityId) {
      let candidateRoots = options.mutationRoots ? [...options.mutationRoots] : [];
      if (candidateRoots.length === 0 && options.command.cwd) {
        candidateRoots = [options.command.cwd];
      }
      capAdmission = this.domain.checkCapabilityAdmission({
        capabilityId: options.capabilityId,
        requiredResources: options.requiredResources,
        mutationRoots: candidateRoots.length > 0 ? candidateRoots : undefined,
        runId: options.runId,
        opId: options.opId,
      });
      options.requiredResources = capAdmission.effectiveResources;
      effectiveMutationRoots = capAdmission.effectiveMutationRoots;
    } else {
      options.requiredResources = (options.requiredResources || []).map(normalizeResourceName);
      if (!effectiveMutationRoots || effectiveMutationRoots.length === 0) {
        effectiveMutationRoots = options.requiredResources
          .filter((r) => r.startsWith('workspace:write:'))
          .map((r) => r.slice('workspace:write:'.length));
      }
    }

    // 0. ConfinementDriver 驱动解析与包装（契约 #56）
    let activeConfinementDriver: ConfinementDriver | undefined;
    if (options.confinementDriver) {
      activeConfinementDriver = options.confinementDriver;
    } else if (typeof options.confinement === 'string') {
      const driver = createConfinementDriver(options.confinement);
      if (!driver) {
        throw new Error(`Confinement driver '${options.confinement}' is not available on this platform`);
      }
      activeConfinementDriver = driver;
    } else if (options.confinement === true) {
      const driver = this.confinementDriver || createConfinementDriver();
      if (!driver) {
        throw new Error('Confinement was requested but no confinement driver is available on this platform');
      }
      activeConfinementDriver = driver;
    } else if (this.confinementDriver) {
      activeConfinementDriver = this.confinementDriver;
    }

    let effectiveCommand = options.command;
    const isConfined = activeConfinementDriver !== undefined;
    const confinementDriverName = activeConfinementDriver?.name;

    if (activeConfinementDriver) {
      effectiveCommand = activeConfinementDriver.wrap(options.command, effectiveMutationRoots || []);
    }

    const startTime = Date.now();
    const maxBytes = options.maxOutputBytes ?? 10 * 1024 * 1024; // 默认 10MB
    const drainTimeoutMs = options.drainTimeoutMs ?? 2000;      // 默认 2000ms

    let stdoutDrainer: StreamDrainer | undefined;
    let stderrDrainer: StreamDrainer | undefined;

    // 0. [准入期强校验 Pre-admission Capability Check]
    if (options.resourceBudget?.enforcement === 'hard') {
      if (options.resourceBudget.maxMemoryBytes && !this.driver.capabilities.memoryHardLimit) {
        throw new UnsupportedCapabilityError('memoryHardLimit', this.driver.name, 'hard');
      }
      if (options.resourceBudget.maxPids && !this.driver.capabilities.pidsLimit) {
        throw new UnsupportedCapabilityError('pidsLimit', this.driver.name, 'hard');
      }
      if (options.resourceBudget.maxCpuTimeMs && !this.driver.capabilities.cpuLimit) {
        throw new UnsupportedCapabilityError('cpuLimit', this.driver.name, 'hard');
      }
    }

    const inputFingerprint = options.inputFingerprint || computeInputFingerprint(options);

    // 0. 验证调用 Run 状态（N3 契约）：终态 Run 禁止登记或重放操作
    const callingRun = this.domain.getStore().getRun(options.runId);
    if (!callingRun) {
      throw new Error(
        `Run "${options.runId}" is not registered in domain "${this.domain.domainId}". ` +
          'Register the task and run first (store.saveTask() + store.saveRun()), then execute operations for that run.'
      );
    }
    if (
      callingRun.status === 'succeeded' ||
      callingRun.status === 'failed' ||
      callingRun.status === 'cancelled' ||
      callingRun.status === 'indeterminate'
    ) {
      throw new Error(
        `Cannot register operation "${options.opId}" for Run "${options.runId}" because the Run is already finalized with status "${callingRun.status}".`
      );
    }

    // 1. 在飞操作重放判定（ARCHITECTURE §3.7 / 契约 #46）
    if (this.activeOperations.has(options.opId)) {
      const inFlight = this.activeOperations.get(options.opId)!;
      if (inFlight.inputFingerprint !== inputFingerprint) {
        throw new OperationIdConflictError(
          options.opId,
          inFlight.inputFingerprint,
          inputFingerprint,
          inFlight.phase,
          inFlight.runId
        );
      }

      this.domain.getStore().recordReplay(this.domain.domainId, options.opId, 'joined', options.runId);
      if (options.onStreamChunk) {
        inFlight.streamSubscribers.add(options.onStreamChunk);
      }

      if (options.abortSignal) {
        const signal = options.abortSignal;
        if (signal.aborted) {
          if (options.onStreamChunk) {
            inFlight.streamSubscribers.delete(options.onStreamChunk);
          }
          throw signal.reason || new Error('Operation wait aborted');
        }
        return await new Promise<ProcessOperationResult>((resolve, reject) => {
          const onAbort = () => {
            if (options.onStreamChunk) {
              inFlight.streamSubscribers.delete(options.onStreamChunk);
            }
            reject(signal.reason || new Error('Operation wait aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          inFlight.resultPromise!.then(
            (res) => {
              signal.removeEventListener('abort', onAbort);
              if (options.onStreamChunk) {
                inFlight.streamSubscribers.delete(options.onStreamChunk);
              }
              resolve({ ...res, replayed: true });
            },
            (err) => {
              signal.removeEventListener('abort', onAbort);
              if (options.onStreamChunk) {
                inFlight.streamSubscribers.delete(options.onStreamChunk);
              }
              reject(err);
            }
          );
        });
      }

      const res = await inFlight.resultPromise!;
      if (options.onStreamChunk) {
        inFlight.streamSubscribers.delete(options.onStreamChunk);
      }
      return {
        ...res,
        replayed: true,
      };
    }

    // 2. 已持久化操作重放判定（ARCHITECTURE §3.7 / 契约 #45, #47, #48, #49）
    const existingRecorded = this.domain.getStore().getOperation(options.opId);
    if (existingRecorded) {
      if (existingRecorded.inputFingerprint !== inputFingerprint) {
        throw new OperationIdConflictError(
          options.opId,
          existingRecorded.inputFingerprint,
          inputFingerprint,
          existingRecorded.status,
          existingRecorded.runId
        );
      }

      // 未终结状态且不在内存中 → 必须先执行恢复（崩溃残留现场）
      if (existingRecorded.status !== 'done') {
        throw new RecoveryRequiredError(
          options.opId,
          existingRecorded.status,
          existingRecorded.runId
        );
      }

      // indeterminate 状态：绝不重跑，原样返回，保留租约
      if (existingRecorded.result?.status === 'indeterminate') {
        this.domain.getStore().recordReplay(this.domain.domainId, options.opId, 'indeterminate', options.runId);
        return {
          ...existingRecorded.result,
          replayed: true,
          runId: existingRecorded.runId,
        } as unknown as ProcessOperationResult;
      }

      // 已结清终态 (succeeded / failed / cancelled)：返回已持久化结果
      this.domain.getStore().recordReplay(this.domain.domainId, options.opId, 'recorded', options.runId);
      return {
        ...existingRecorded.result,
        replayed: true,
        runId: existingRecorded.runId,
      } as ProcessOperationResult;
    }

    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'process',
      name: options.name,
      inputFingerprint,
      requiredResources: options.requiredResources || [],
      mutationRoots: effectiveMutationRoots,
      capabilityId: options.capabilityId,
      timeoutMs: options.timeoutMs,
      resourceBudget: options.resourceBudget,
      status: 'pending',
    };

    const streamSubscribers = new Set<(stream: 'stdout' | 'stderr', chunk: Buffer) => void>();
    if (options.onStreamChunk) {
      streamSubscribers.add(options.onStreamChunk);
    }

    const opState: ActiveOperationState = {
      opId: options.opId,
      runId: options.runId,
      phase: 'waiting_resources',
      startTime,
      inputFingerprint,
      streamSubscribers,
      cancelRequested: false,
      timedOut: false,
    };
    this.activeOperations.set(options.opId, opState);

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        opState.cancelRequested = true;
      } else {
        const onAbort = () => {
          this.cancelOperation(options.opId).catch(() => {});
        };
        options.abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const executionPromise = (async (): Promise<ProcessOperationResult> => {
      let timeoutTimer: NodeJS.Timeout | null = null;
      let samplingInterval: NodeJS.Timeout | null = null;
      let stdoutDrainer: StreamDrainer | undefined;
      let stderrDrainer: StreamDrainer | undefined;

      try {
        // 1. [资源分配与排队等待]
        await this.domain.allocateResourcesWithWait(
          options.opId,
          options.requiredResources || [],
          options.waitTimeoutMs ?? 0,
          options.resourceBudget,
          () => opState.cancelRequested === true
        );

        if (opState.cancelRequested) {
          return this.handlePreSpawnCancellation(options, opState, startTime);
        }

      // 2. [启动协议步骤 1] 写入 SQLite (status: intent_registered)
      try {
        this.domain.getStore().registerOperationIntent(op, this.domain.domainId);
        opState.phase = 'intent_registered';
      } catch (err) {
        this.domain.internalReleaseResources(options.opId, options.requiredResources);
        throw err;
      }

      if (opState.cancelRequested) {
        return this.handlePreSpawnCancellation(options, opState, startTime);
      }

      let handle: ManagedProcessHandle;
      opState.phase = 'spawning';
      try {
        // 3. [启动协议步骤 2] 请求平台驱动启动
        handle = await this.driver.spawn(effectiveCommand);
        opState.handle = handle;
        opState.command = effectiveCommand;
      } catch (spawnError: any) {
        opState.phase = 'done';
        opState.stopResolve?.({ stopped: 'confirmed_stopped', scope: 'direct_child', errorDetails: spawnError?.message });
        opState.stopResolve = undefined;
        // 启动失败（如可执行文件不存在），不产生假运行状态，直接失败收尾并释放资源
        const failResult: ProcessOperationResult = {
          kind: 'process',
          status: 'failed',
          exitCode: 127,
          signal: null,
          stdout: '',
          stderr: spawnError?.message || String(spawnError),
          spawnFailure: spawnError?.message || String(spawnError),
          capabilityId: options.capabilityId,
          confined: isConfined,
          confinementDriver: confinementDriverName,
          isTruncated: false,
          identityVerification: 'not_original_process',
          durationMs: Date.now() - startTime,
          completedAt: new Date().toISOString(),
        };
        return this.finalizeOperation(options.opId, failResult, options.requiredResources, true);
      }

      // 4. [启动协议步骤 3] 登记执行身份，状态推进为 active
      try {
        this.domain.getStore().updateOperationStatus(options.opId, 'active', handle.identity);
        opState.phase = 'active';
        handle.releaseGate?.();

        if (options.capabilityId && capAdmission) {
          this.domain.getStore().recordJournalEvent({
            domainId: this.domain.domainId,
            runId: options.runId,
            operationId: options.opId,
            type: 'CAPABILITY_USED',
            payload: {
              capabilityId: options.capabilityId,
              scope: capAdmission.capability.scope,
              actor: capAdmission.capability.issuedBy,
            },
            timestamp: new Date().toISOString(),
          });
        }
      } catch (statusError: any) {
        handle.destroyGate?.();
        // N4: spawn 成功但登记 active 失败，防止产生孤儿进程
        opState.phase = 'stopping';
        const stopRes = await this.driver.terminate(handle.identity, 2000);
        // 有界等待退出与关闭流，防止管道悬挂
        await Promise.race([
          (handle.onRootExit ?? handle.onExit).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
        try {
          (handle.stdout as any).destroy?.();
          (handle.stderr as any).destroy?.();
        } catch {}

        opState.phase = 'done';
        if (opState.stopResolve) {
          const resolveFn = opState.stopResolve;
          opState.stopResolve = undefined;
          resolveFn(stopRes);
        }

        if (stopRes.stopped === 'confirmed_stopped') {
          const failResult: ProcessOperationResult = {
            kind: 'process',
            status: 'failed',
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: `Failed to register active status: ${statusError?.message || String(statusError)}`,
            spawnFailure: statusError?.message || String(statusError),
            isTruncated: false,
            identityVerification: 'not_original_process',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          this.finalizeOperation(options.opId, failResult, options.requiredResources, true);
        } else {
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Failed to register active status: ${statusError?.message || String(statusError)}, and process ${handle.identity.pid} could not be confirmed stopped: ${stopRes.errorDetails || 'residual processes still alive'}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }
        throw statusError;
      }

      // 准备 artifacts 溢出转储目录
      const artifactsDir = options.artifactsDir || path.join(this.domain.domainPath, 'artifacts');
      let artifactsDirError: string | undefined = undefined;
      if (!fs.existsSync(artifactsDir)) {
        try {
          fs.mkdirSync(artifactsDir, { recursive: true });
        } catch (dirErr: any) {
          artifactsDirError = dirErr.message || String(dirErr);
        }
      }
      const stdoutSpillPath = path.join(artifactsDir, `${options.opId}-stdout.log`);
      const stderrSpillPath = path.join(artifactsDir, `${options.opId}-stderr.log`);

      // 5. [正常监督、有界排空与流式转储 (Spill to Artifacts)]
      let totalOutputBytes = 0;
      const onChunk = (bytes: number) => {
        totalOutputBytes += bytes;
        if (
          options.resourceBudget?.enforcement === 'soft' &&
          options.resourceBudget.maxOutputBytes &&
          totalOutputBytes > options.resourceBudget.maxOutputBytes &&
          !opState.terminationReason
        ) {
          opState.terminationReason = 'output_exceeded';
          this.handleStopPipeline(options.opId, 'output_exceeded', 1000).catch(() => {});
        }
      };

      let streamCallbackError: string | undefined;
      const forwardChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        for (const subscriber of opState.streamSubscribers) {
          try {
            subscriber(stream, chunk);
          } catch (err) {
            streamCallbackError ??= err instanceof Error ? err.message : String(err);
          }
        }
      };
      stdoutDrainer = setupStreamDrainer(
        handle.stdout,
        maxBytes,
        stdoutSpillPath,
        onChunk,
        forwardChunk('stdout'),
        artifactsDirError
      );
      stderrDrainer = setupStreamDrainer(
        handle.stderr,
        maxBytes,
        stderrSpillPath,
        onChunk,
        forwardChunk('stderr'),
        artifactsDirError
      );

      // 检查在 spawn 途中是否已被请求取消：若已请求取消，立即触发停止流水线向底层发送终止信号
      if (opState.cancelRequested) {
        this.handleStopPipeline(options.opId, 'user_cancelled', opState.cancelGraceMs ?? 2000).catch(() => {});
      }

      const timeoutPromise =
        options.timeoutMs && options.timeoutMs > 0
          ? new Promise<'timeout'>((resolve) => {
              timeoutTimer = setTimeout(() => resolve('timeout'), options.timeoutMs);
            })
          : new Promise<'timeout'>(() => {});

      // Soft / Observe 模式资源采样治理
      let peakMemoryBytes = 0;
      let peakCpuTimeMs = 0;
      if (
        this.driver.sampleMetrics &&
        options.resourceBudget &&
        (options.resourceBudget.enforcement === 'soft' || options.resourceBudget.enforcement === 'observe')
      ) {
        samplingInterval = setInterval(async () => {
          try {
            const metrics = await this.driver.sampleMetrics!(handle.identity);
            peakMemoryBytes = Math.max(peakMemoryBytes, metrics.rssBytes);
            peakCpuTimeMs = Math.max(peakCpuTimeMs, metrics.cpuTimeMs);

            if (options.resourceBudget?.enforcement === 'soft') {
              if (options.resourceBudget.maxMemoryBytes && metrics.rssBytes > options.resourceBudget.maxMemoryBytes) {
                opState.terminationReason = 'memory_exceeded';
                if (samplingInterval) clearInterval(samplingInterval);
                await this.handleStopPipeline(options.opId, 'memory_exceeded', 1000);
              } else if (options.resourceBudget.maxCpuTimeMs && metrics.cpuTimeMs > options.resourceBudget.maxCpuTimeMs) {
                opState.terminationReason = 'cpu_exceeded';
                if (samplingInterval) clearInterval(samplingInterval);
                await this.handleStopPipeline(options.opId, 'cpu_exceeded', 1000);
              } else if (options.resourceBudget.maxPids && metrics.pidsCount > options.resourceBudget.maxPids) {
                opState.terminationReason = 'pids_exceeded';
                if (samplingInterval) clearInterval(samplingInterval);
                await this.handleStopPipeline(options.opId, 'pids_exceeded', 1000);
              }
            }
          } catch {}
        }, 100);
      }
      let notifyStop: ((res: StopProcessResult) => void) | undefined;
      const stopTriggerPromise = new Promise<StopProcessResult>((resolve) => {
        notifyStop = resolve;
      });
      const previousResolve = opState.stopResolve;
      opState.stopResolve = (res: StopProcessResult) => {
        previousResolve?.(res);
        notifyStop?.(res);
      };

      // 等待根进程退出、超时触发、或外部停止完成
      const rootExitPromise = handle.onRootExit ?? handle.onExit;
      const stopCandidate = opState.stopPromise ? opState.stopPromise : stopTriggerPromise;

      const exitOrTimeout = await Promise.race([
        rootExitPromise.then((res) => ({ type: 'exit' as const, res, stopRes: null as any })),
        timeoutPromise.then((type) => ({ type, res: null as any, stopRes: null as any })),
        stopCandidate.then((stopRes) => ({ type: 'stop' as const, res: null as any, stopRes })),
      ]);

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (samplingInterval) clearInterval(samplingInterval);

      let exitResult: { exitCode: number | null; signal: NodeJS.Signals | null };

      if (exitOrTimeout.type === 'stop') {
        const stopRes = exitOrTimeout.stopRes;
        if (stopRes.stopped !== 'confirmed_stopped') {
          if (handle.rawProcess && typeof handle.rawProcess.kill === 'function') {
            try { handle.rawProcess.kill('SIGKILL'); } catch {}
          }
          try {
            (handle.stdout as any).destroy?.();
            (handle.stderr as any).destroy?.();
          } catch {}
          const stored = this.domain.getStore().getOperation(options.opId);
          if (stored && stored.status === 'done') {
            return (stored.result ?? null) as unknown as ProcessOperationResult;
          }
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} was cancelled or stopped but could not be confirmed: ${stopRes.errorDetails || 'residual processes still alive'}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }
        const rootExitWaitMs = 1000;
        const rootExitOrTimeout = await Promise.race([
          rootExitPromise.then((res) => ({ exited: true as const, res })),
          new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), rootExitWaitMs)),
        ]);
        exitResult = rootExitOrTimeout.exited ? rootExitOrTimeout.res : { exitCode: null, signal: 'SIGKILL' as NodeJS.Signals };
      } else if (exitOrTimeout.type === 'timeout') {
        opState.timedOut = true;
        opState.terminationReason = 'timed_out';
        const stopRes = await this.handleStopPipeline(options.opId, 'timed_out', 1500);

        // 超时路径：根进程已由停止流水线终止，等待根进程退出事实（避免被持有管道的逃逸后代挂死）
        // 关键防护（问题 4）：给等待根进程退出增加有界上限（1000ms），
        // 若驱动停止未确认（stopped !== 'confirmed_stopped'）或根进程超出上限仍未退出，转入 indeterminate
        const rootExitWaitMs = 1000;
        const rootExitOrTimeout = await Promise.race([
          (handle.onRootExit ?? handle.onExit).then((res) => ({ exited: true as const, res })),
          new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), rootExitWaitMs)),
        ]);

        if (stopRes.stopped !== 'confirmed_stopped' || !rootExitOrTimeout.exited) {
          const stored = this.domain.getStore().getOperation(options.opId);
          if (stored && stored.status === 'done' && stored.result?.status === 'indeterminate') {
            return stored.result as unknown as ProcessOperationResult;
          }
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} timed out and root process could not be confirmed exited within ${rootExitWaitMs}ms bound: ${stopRes.errorDetails || 'root process still alive'}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }

        exitResult = rootExitOrTimeout.res;
      } else {
        exitResult = exitOrTimeout.res!;
      }

      // 有界等待流排空
      const drainPromise = Promise.all([stdoutDrainer.finishPromise, stderrDrainer.finishPromise]);
      const drainTimeoutPromise = new Promise((resolve) => setTimeout(resolve, drainTimeoutMs));

      let drained = await Promise.race([
        drainPromise.then(() => true),
        drainTimeoutPromise.then(() => false),
      ]);

      // 排空超时说明根进程已退出但仍有后代持有管道：回收整个进程组，
      // 否则操作会一直挂到超时，且 root 的真实退出事实会被超时掩盖。
      let residualProcessesReaped = false;
      if (!drained && exitOrTimeout.type === 'exit') {
        const reapResult = await this.driver.terminate(handle.identity, 1500);
        if (reapResult.stopped !== 'confirmed_stopped') {
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} exited but residual descendants could not be confirmed stopped: ${reapResult.errorDetails}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }
        residualProcessesReaped = true;
        // 被杀死的后代释放管道后，给排空最后一次机会
        drained = await Promise.race([
          drainPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
        ]);
      }

      if (!drained) {
        // 排空超时路径强制调用 fsyncSync + closeSync 结清刷盘
        stdoutDrainer.forceFinalize();
        stderrDrainer.forceFinalize();
        // 走到这里时进程组已被确认停止，管道写端却仍被持有：
        // 必然存在一个驱动未观测到的逃逸进程（例如 setsid 后被 init 收养、采样器没来得及记录）。
        // 无法确认隔离，不能报告 succeeded / residualProcessesReaped，必须如实判 indeterminate 并保留租约。
        const indetResult: IndeterminateResult = {
          kind: 'indeterminate',
          status: 'indeterminate',
          reason: `Process ${handle.identity.pid} exited (exitCode=${exitResult.exitCode}, signal=${exitResult.signal}) and its process group was confirmed stopped, but stdout/stderr pipes are still held by an unobserved escaped process`,
          recoveryGuidance: 'An escaped process outside the observed process tree still holds the output pipes. Inspect system processes manually before adjudicating and releasing resources.',
          capabilityId: options.capabilityId,
          durationMs: Date.now() - startTime,
          completedAt: new Date().toISOString(),
        };
        return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
      }

      const stdoutData = stdoutDrainer.getResult();
      const stderrData = stderrDrainer.getResult();
      const isTruncated = stdoutData.isTruncated || stderrData.isTruncated;
      const spillError = stdoutData.spillError || stderrData.spillError || artifactsDirError;
      const outputRef = (!spillError && (stdoutData.outputRef || stderrData.outputRef)) || undefined;
      const outputHash = (!spillError && (stdoutData.outputHash || stderrData.outputHash)) || undefined;

      // 校验进程身份
      const idVerify = await this.driver.verifyIdentity(handle.identity);

      const isResourceOrTimeoutStopped =
        opState.timedOut ||
        opState.terminationReason === 'memory_exceeded' ||
        opState.terminationReason === 'cpu_exceeded' ||
        opState.terminationReason === 'pids_exceeded' ||
        opState.terminationReason === 'output_exceeded';

      const isSucceeded =
        exitResult.exitCode === 0 &&
        !isResourceOrTimeoutStopped &&
        !opState.cancelRequested;

      const finalStatus = isResourceOrTimeoutStopped
        ? 'failed'
        : opState.cancelRequested
        ? 'cancelled'
        : isSucceeded
        ? 'succeeded'
        : 'failed';

      const terminationReason =
        opState.terminationReason || (finalStatus === 'succeeded' ? 'completed' : undefined);

      const result: ProcessOperationResult = {
        kind: 'process',
        status: finalStatus,
        exitCode: exitResult.exitCode,
        signal: exitResult.signal,
        stdout: stdoutData.content,
        stderr: stderrData.content,
        capabilityId: options.capabilityId,
        confined: isConfined,
        confinementDriver: confinementDriverName,
        isTruncated,
        stdoutTruncated: stdoutData.isTruncated,
        stderrTruncated: stderrData.isTruncated,
        stdoutRef: !stdoutData.spillError ? stdoutData.outputRef : undefined,
        stderrRef: !stderrData.spillError ? stderrData.outputRef : undefined,
        stdoutBytes: stdoutData.bytesSeen,
        stderrBytes: stderrData.bytesSeen,
        stdoutHash: !stdoutData.spillError ? stdoutData.outputHash : undefined,
        stderrHash: !stderrData.spillError ? stderrData.outputHash : undefined,
        ...(residualProcessesReaped ? { residualProcessesReaped: true } : {}),
        ...(streamCallbackError ? { streamCallbackError } : {}),
        ...(spillError ? { spillError } : {}),
        ...(stdoutData.spillError ? { stdoutSpillError: stdoutData.spillError } : {}),
        ...(stderrData.spillError ? { stderrSpillError: stderrData.spillError } : {}),
        outputRef,
        outputHash,
        terminationReason,
        peakMemoryBytes,
        cpuTimeMs: peakCpuTimeMs,
        identityVerification: idVerify,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };

      if (opState.stopPromise) {
        const stopRes = await opState.stopPromise;
        if (stopRes.stopped !== 'confirmed_stopped') {
          const stored = this.domain.getStore().getOperation(options.opId);
          if (stored && stored.status === 'done') {
            return (stored.result ?? null) as unknown as ProcessOperationResult;
          }
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${handle.identity.pid} was cancelled or stopped but could not be confirmed: ${stopRes.errorDetails || 'residual processes still alive'}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            capabilityId: options.capabilityId,
            durationMs: Date.now() - startTime,
            completedAt: new Date().toISOString(),
          };
          return this.finalizeOperation(options.opId, indetResult, options.requiredResources, false);
        }
      }

      // 6. [事务提交结果与释放资源 - Single Writer]
      // 统一由 finalizeOperation 写入事实与处理资源
      return this.finalizeOperation(options.opId, result, options.requiredResources, true, artifactsDir);
    } finally {
      stdoutDrainer?.forceFinalize();
      stderrDrainer?.forceFinalize();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (samplingInterval) clearInterval(samplingInterval);
      if (opState.stopResolve) {
        const resolveFn = opState.stopResolve;
        opState.stopResolve = undefined;
        resolveFn({
          stopped: 'confirmed_stopped',
          scope: 'direct_child',
          errorDetails: opState.phase === 'done' ? undefined : 'Operation terminated before process activation',
        });
      }
      this.activeOperations.delete(options.opId);
    }
  })();

  opState.resultPromise = executionPromise;
  return await executionPromise;
}

  /**
   * 停止确认流水线 (Stopping Pipeline)
   */
  public async cancelOperation(opId: string, graceMs: number = 2000): Promise<StopProcessResult> {
    const active = this.ensureActiveOperation(opId);
    active.cancelRequested = true;
    if (active.cancelGraceMs === undefined) {
      active.cancelGraceMs = graceMs;
    }
    active.terminationReason = 'user_cancelled';

    // 若操作仍在等待队列中排队，立刻唤醒
    this.domain.cancelWait(opId);

    if (active.phase === 'active' || active.phase === 'stopping') {
      return this.handleStopPipeline(opId, 'user_cancelled', graceMs);
    }

    // 操作仍在等资源、intent_registered 或 spawn 途中，返回已有的或新建的 stopPromise
    if (!active.stopPromise) {
      active.stopPromise = new Promise((resolve) => {
        active.stopResolve = resolve;
      });
    }
    return active.stopPromise;
  }

  public async handleStopPipeline(
    opId: string,
    reason: TerminationReason,
    graceMs: number
  ): Promise<StopProcessResult> {
    const active = this.ensureActiveOperation(opId);

    if (active.phase === 'stopping' && active.stopPromise) {
      return active.stopPromise;
    }

    active.phase = 'stopping';
    if (reason === 'user_cancelled') {
      active.cancelRequested = true;
    }
    active.terminationReason = reason;

    const existingResolve = active.stopResolve;
    const runPipeline = (async () => {
      if (!active.handle) {
        const res: StopProcessResult = { stopped: 'confirmed_stopped', scope: 'direct_child' };
        existingResolve?.(res);
        return res;
      }

      // 1. 进入 stopping 中间态（保持排他资源锁定，阻断新操作）
      this.domain.getStore().updateOperationStatus(opId, 'stopping');

      // 2. 调用驱动停止流水线 (SIGINT -> grace -> SIGTERM -> SIGKILL)
      const stopResult = await this.driver.terminate(active.handle.identity, graceMs);

      // 3. 驱动无法确认停止 -> 立即转入 indeterminate，绝对保留隔离屏障与锁！
      if (stopResult.stopped !== 'confirmed_stopped') {
        const op = this.domain.getStore().getOperation(opId);
        if (op && op.status !== 'done') {
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: `Process ${active.handle.identity.pid} could not be confirmed stopped: ${stopResult.errorDetails}`,
            recoveryGuidance: 'Residual PID detected. Inspect system processes manually before releasing resources.',
            durationMs: Date.now() - active.startTime,
            completedAt: new Date().toISOString(),
          };
          this.finalizeOperation(opId, indetResult, undefined, false);
        }
      }

      existingResolve?.(stopResult);
      return stopResult;
    })();

    active.stopPromise = runPipeline;
    return runPipeline;
  }

  private ensureActiveOperation(opId: string): ActiveOperationState {
    if (this.domain.isClosed()) {
      throw new OperationNotActiveError(opId, 'domain_closed');
    }

    const active = this.activeOperations.get(opId);
    if (!active || active.phase === 'done') {
      const stored = this.domain.getStore().getOperation(opId);
      if (!stored) {
        throw new OperationNotActiveError(opId, 'not_found');
      }
      if (stored.status === 'done') {
        throw new OperationNotActiveError(opId, 'already_completed');
      }
      throw new OperationNotActiveError(
        opId,
        'not_found',
        `Operation "${opId}" is not active (current status: ${stored.status}).`
      );
    }

    return active;
  }

  private handlePreSpawnCancellation(
    options: ExecuteProcessOptions,
    opState: ActiveOperationState,
    startTime: number
  ): ProcessOperationResult {
    opState.phase = 'done';
    const stopRes: StopProcessResult = { stopped: 'confirmed_stopped', scope: 'direct_child' };
    opState.stopResolve?.(stopRes);
    opState.stopResolve = undefined;

    const cancelResult: ProcessOperationResult = {
      kind: 'process',
      status: 'cancelled',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      capabilityId: options.capabilityId,
      isTruncated: false,
      terminationReason: 'user_cancelled',
      evidence: 'unobserved',
      identityVerification: 'not_original_process',
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };

    const stored = this.domain.getStore().getOperation(options.opId);
    if (!stored) {
      // 此时操作是在 waiting_resources 阶段就被取消，尚未获取资源租约，亦未正常注册意图。
      // 为保证 store 中有该操作记录以便写入 cancelled 结果，直接记录预意图取消操作，
      // 绝不向 resource_leases 写入虚假租约，亦不产生虚假的 OPERATION_INTENT_REGISTERED 事件。
      const op: Operation = {
        id: options.opId,
        runId: options.runId,
        kind: 'process',
        name: options.name,
        inputFingerprint: options.inputFingerprint || computeInputFingerprint(options),
        requiredResources: options.requiredResources || [],
        status: 'done',
      };
      this.domain.getStore().recordPreIntentCancelledOperation(op, this.domain.domainId, cancelResult);
      this.domain.internalReleaseResources(options.opId, options.requiredResources);
      return cancelResult;
    }

    return this.finalizeOperation(options.opId, cancelResult, options.requiredResources, true);
  }

  public pruneArtifacts(filter?: { olderThanMs?: number; prefix?: string }): {
    deleted: string[];
    retained: string[];
  } {
    return this.domain.pruneArtifacts(filter);
  }

  private finalizeOperation(
    opId: string,
    result: OperationResult,
    requiredResources?: string[],
    releaseResourceLock: boolean = true,
    artifactsDir?: string
  ): ProcessOperationResult {
    const existing = this.domain.getStore().getOperation(opId);
    if (existing && existing.status === 'done') {
      throw new Error(
        `Cannot finalize operation "${opId}": operation is already finalized with status "${existing.status}"`
      );
    }
    if (existing) {
      result.runId = existing.runId;
      if (existing.capabilityId && !result.capabilityId) {
        result.capabilityId = existing.capabilityId;
      }
    }

    if (result.kind === 'process') {
      const procRes = result as ProcessOperationResult;
      const targetDir = artifactsDir || path.join(this.domain.domainPath, 'artifacts');
      const stdoutSpillPath = path.join(targetDir, `${opId}-stdout.log`);
      const stderrSpillPath = path.join(targetDir, `${opId}-stderr.log`);

      if (!procRes.stdoutRef && fs.existsSync(stdoutSpillPath)) {
        try {
          fs.unlinkSync(stdoutSpillPath);
        } catch (unlinkErr: any) {
          procRes.spillError = procRes.spillError || unlinkErr.message || String(unlinkErr);
        }
      }

      if (!procRes.stderrRef && fs.existsSync(stderrSpillPath)) {
        try {
          fs.unlinkSync(stderrSpillPath);
        } catch (unlinkErr: any) {
          procRes.spillError = procRes.spillError || unlinkErr.message || String(unlinkErr);
        }
      }
    }

    if (result.status === 'indeterminate') {
      this.domain.getStore().recordOperationResult(opId, result, false);
      const op = this.domain.getStore().getOperation(opId);
      if (op) {
        const termReason = (result as any).terminationReason as TerminationReason | undefined;
        this.domain.getStore().updateRunStatus(op.runId, 'indeterminate', termReason);
      }
    } else {
      this.domain.getStore().recordOperationResult(opId, result, true);
      if (releaseResourceLock) {
        this.domain.internalReleaseResources(opId, requiredResources);
      }
    }
    return result as ProcessOperationResult;
  }
}

