/**
 * xioflow 核心领域模型与实体契约
 */

/**
 * 逻辑工作单元
 */
export interface Task {
  id: string;                      // 任务唯一标识
  domainId: string;                // 所属执行域
  name: string;
  createdAt: string;               // ISO8601
  meta?: Record<string, unknown>;  // 发行版元数据
}

/**
 * 单次执行尝试
 */
export interface Run {
  id: string;
  taskId: string;
  domainId: string;
  owner: string;                   // 执行所有者（session-id / agent-runner）
  status: KernelRunStatus;
  terminationReason?: TerminationReason;
  startedAt: string;
  endedAt?: string;
  configSnapshotWhiteList?: Record<string, unknown>; // 白名单安全配置快照
}

export type KernelRunStatus =
  | 'queued'        // 已排队
  | 'starting'      // 正在启动准备
  | 'running'       // 正常执行中
  | 'stopping'      // 停止中，等待底层驱动确认
  | 'succeeded'     // 成功收尾（所有操作已结清）
  | 'failed'        // 显式执行失败
  | 'cancelled'     // 已确认停止
  | 'indeterminate';// 结果不确定（无法确认是否停止或副作用未明）

export type TerminationReason = 
  | 'completed'
  | 'user_cancelled'
  | 'timed_out'
  | 'resource_preempted'
  | 'crash_detected'
  /**
   * 进程已确认不在，但退出事实从未被观察到（监督者在结果落盘前崩溃）。结局未知：它可能已成功完成副作用。
   * 状态记为 failed 只表示「不再占用资源」，宿主不得据此换 opId 重试；同 opId 重放返回此记录。
   */
  | 'exit_unobserved'
  | 'memory_exceeded'
  | 'cpu_exceeded'
  | 'pids_exceeded'
  | 'output_exceeded';

/**
 * 资源治理预算契约
 */
export interface ResourceBudget {
  maxMemoryBytes?: number;         // 进程树总内存 (RSS/cgroup memory)
  maxPids?: number;                // 后代进程总数 (cgroup pids.max)
  maxCpuTimeMs?: number;           // CPU 时间
  maxOutputBytes?: number;         // stdout+stderr 落盘上限 (spill 封顶)
  enforcement: 'observe' | 'soft' | 'hard';
}

/**
 * 执行域级别配额
 */
export interface DomainBudget {
  maxTotalMemoryBytes?: number;
  maxConcurrentOps?: number;
  maxTotalOutputBytes?: number;
}

/**
 * 受监督原子操作
 */
export interface Operation {
  id: string;
  runId: string;
  kind: 'process' | 'filesystem' | 'gate' | 'custom' | 'service' | 'snapshot' | 'rollback';
  name: string;
  inputFingerprint: string;        // 输入与配置哈希指纹
  requiredResources: string[];     // 申请占用的资源（如 ["workspace:write:root"]）
  mutationRoots?: string[];        // 声明发生修改的根目录列表
  capabilityId?: string;           // 绑定的授权 Capability 标识
  timeoutMs?: number;
  resourceBudget?: ResourceBudget; // 显式声明的资源治理预算
  /** Recorded with the intent: the driver holds exec until identity is durable; EOF must not exec. */
  spawnGated?: boolean;
  outputRef?: string;              // 产物文件引用路径
  status: OperationStatus;
  result?: OperationResult;
  processIdentity?: {
    pid: number;
    /** 进程组 id：崩溃恢复时按组定向清场，避免 leader 已死但后代还活着。 */
    pgid?: number;
    startTimeMonotonic?: number;
    spawnTime: string;
    /** spawn 时读取的 OS 进程创建时间，跨重启身份核验的唯一肯定证据（§4.1.1）。 */
    osStartTime?: string;
    commandFingerprint?: string;
    bootId?: string;
    /** 专属 cgroup（CgroupPlatformDriver）：恢复时据此判断整棵树是否已空。 */
    cgroupPath?: string;
  };
}

export type OperationStatus =
  | 'pending'
  | 'intent_registered'
  | 'active'
  | 'stopping'
  | 'done';

/**
 * 多态执行结果
 */
export type OperationResult =
  | ProcessOperationResult
  | FilesystemOperationResult
  | GenericOperationResult
  | IndeterminateResult
  | SnapshotOperationResult
  | RollbackOperationResult;

export interface BaseResult {
  durationMs: number;
  completedAt: string;
  replayed?: true;
  runId?: string;
  capabilityId?: string;           // 关联的授权 Capability 标识
}

export interface ProcessOperationResult extends BaseResult {
  kind: 'process';
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  confinementDriver?: string;      // 写入限制驱动名称
  confined?: boolean;              // 是否在写入限制下执行
  isTruncated: boolean;            // 任一输出流达到有界上限（聚合标记）
  stdoutTruncated?: boolean;       // stdout 逐流截断标记
  stderrTruncated?: boolean;       // stderr 逐流截断标记
  stdoutRef?: string;              // stdout 被截断时的完整流转储文件
  stderrRef?: string;              // stderr 被截断时的完整流转储文件
  stdoutBytes?: number;            // stdout 实际总字节数（含未保留部分）
  stderrBytes?: number;            // stderr 实际总字节数（含未保留部分）
  stdoutHash?: string;             // stdout 全流 SHA-256
  stderrHash?: string;             // stderr 全流 SHA-256
  outputRef?: string;              // 兼容字段：第一个被截断流的转储引用
  outputHash?: string;             // 兼容字段：stdout 哈希（无 stdout 时为 stderr 哈希）
  terminationReason?: TerminationReason;
  spawnFailure?: string;           // 非空表示可执行文件根本没起来（与子进程自己返回 127 区分）
  peakMemoryBytes?: number;
  cpuTimeMs?: number;
  residualProcessesReaped?: boolean; // 根进程退出后仍存活的后代（持有管道或已脱离）已被停止流水线回收
  /**
   * 根进程自然退出后，「没有后代残留」这一结论的依据：`empty` 驱动证明树已空；
   * `reaped` 发现残留并确认回收；`unverified` 驱动无法证明（可能存在换了进程组的逃逸者）。
   * 停止 / 超时路径不出现：那里由停止结果的 scope 说明。
   */
  treeSettlement?: 'empty' | 'reaped' | 'unverified';
  streamCallbackError?: string;      // onStreamChunk 回调抛出的首个错误（不中断排空）
  spillError?: string;               // 转储打开/写入/fsync/关闭失败记录（P0-9）
  stdoutSpillError?: string;         // stdout 转储失败错误
  stderrSpillError?: string;         // stderr 转储失败错误
  residualPids?: number[];           // 逃逸或未完全停止的残留进程 PID 列表
  identityVerification: IdentityVerificationResult;
  evidence?: 'observed' | 'unobserved';
  /** 仅在 `trackReads` 时出现：这条命令读过什么的证据摘要，详情在 `ref` 指向的文件里。 */
  readEvidence?: ReadEvidence;
}

/**
 * 命令在 `roots` 里读过的文件与目录（`content_reads`：读了内容或列了目录；只 stat 的不算）。
 * `tracking` 不是 `atime` 时没有读集，证据只剩命令结束时的全树 stat 清单。
 */
export interface ReadEvidence {
  tracking: 'atime' | 'unobserved' | 'failed';
  /** unobserved 的原因：文件系统不推进 atime，或同一个根上另一条被观测的命令正在运行。 */
  reason?: 'no_atime' | 'roots_busy';
  scope: 'content_reads';
  /** 调用方是否声明已排除只靠 stat 校验的缓存。`possible` 时读集之外的改动只能答 `unknown`。 */
  statCaches: 'ruled_out' | 'possible';
  roots: string[];
  entryCount?: number;
  digest?: string;
  ref?: string;
  /** tracking 为 failed 时：收集证据失败的原因。 */
  error?: string;
}

export type EvidenceStatus =
  | { status: 'fresh'; basis: 'tree_unchanged' | 'reads_unchanged' }
  | { status: 'stale'; changed: string[]; truncated: boolean }
  | {
      status: 'unknown';
      reason: 'not_tracked' | 'reads_unobserved' | 'evidence_missing' | 'evidence_unreadable' | 'changed_outside_read_set';
      changedOutside?: string[];
      truncated?: boolean;
    };

export interface FilesystemOperationResult extends BaseResult {
  kind: 'filesystem';
  status: 'succeeded' | 'failed';
  targetPath: string;
  action: 'create' | 'modify' | 'delete';
  bytesWritten?: number;
  outputRef?: string;
  errorMessage?: string;
}

export interface GenericOperationResult extends BaseResult {
  kind: 'generic';
  status: 'succeeded' | 'failed' | 'cancelled';
  outputRef?: string;              // 不可变产物引用
  errorMessage?: string;
}

export interface IndeterminateResult extends BaseResult {
  kind: 'indeterminate';
  status: 'indeterminate';
  reason: string;                  // 未知原因
  recoveryGuidance: string;        // 人工恢复或现场排查指引
  adjudication?: AdjudicationRecord;
}

export type IdentityVerificationResult =
  | 'is_original_process'          // 确认为原启动进程
  | 'not_original_process'         // 确定已不是原进程
  | 'cannot_determine';            // 无法可靠判断

/**
 * 域所有权记录（用于代际栅栏与防脑裂）
 */
export interface OwnerRecord {
  domainId: string;
  ownerId: string;
  epoch: number;
  heartbeatAt: string;
  expiresAt: string;
  hostname: string;
}

export class UnsupportedCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    public readonly platform: string,
    public readonly requestedEnforcement: string = 'hard'
  ) {
    super(
      `Unsupported capability: '${capability}' with enforcement '${requestedEnforcement}' is not supported on platform '${platform}'`
    );
    this.name = 'UnsupportedCapabilityError';
  }
}

export class EpochFencedError extends Error {
  constructor(
    public readonly domainId: string,
    public readonly expectedEpoch: number,
    public readonly actualEpoch: number
  ) {
    super(
      `Epoch fenced: write rejected in domain '${domainId}'. Expected epoch ${expectedEpoch}, but current epoch is ${actualEpoch}`
    );
    this.name = 'EpochFencedError';
  }
}

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

/**
 * 持久化资源占用
 */
export interface ResourceLease {
  resourceId: string;
  operationId: string;
  domainId: string;
  acquiredAt: string;
}

/**
 * 单调自增序号事件日志
 */
export interface JournalEvent {
  seq: number;
  domainId: string;
  runId?: string;
  operationId?: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * 域所有权锁元数据
 */
export interface DomainLockMetadata {
  domainId: string;
  ownerPid: number;
  acquiredAt: string;
  hostname: string;
}

/**
 * 白名单安全配置过滤：杜绝密码、密钥等敏感信息落盘
 */
const SAFE_CONFIG_WHITELIST = new Set([
  'model',
  'temperature',
  'maxTokens',
  'cwd',
  'timeoutMs',
  'maxRetries',
  'mode',
  'environment',
  'permissionScope',
  'toolsAllowed'
]);

export function sanitizeConfigSnapshot(config?: Record<string, unknown>): Record<string, unknown> {
  if (!config) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const lowerKey = key.toLowerCase();
    // 过滤包含敏感关键词的字段
    if (
      lowerKey.includes('token') ||
      lowerKey.includes('key') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('credential')
    ) {
      continue;
    }
    if (SAFE_CONFIG_WHITELIST.has(key) || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 对非活跃操作发起停止时抛出的显式异常（契约 #12）
 */
export class OperationNotActiveError extends Error {
  constructor(
    public readonly opId: string,
    public readonly reason: 'not_found' | 'already_completed' | 'domain_closed',
    message?: string
  ) {
    super(
      message ??
        `Operation "${opId}" is not active (reason: ${reason}). Stop requests must target active operations.`
    );
    this.name = 'OperationNotActiveError';
  }
}

/**
 * 重复提交相同 opId 时抛出的显式异常（契约 #40 / N8）
 * @deprecated 0.3.0 起由 OperationIdConflictError 代替（仅在指纹不匹配时抛出）。保留此别名以保证向后兼容。
 */
export class DuplicateOperationError extends Error {
  public readonly opId: string;
  public readonly existingStatus: string;
  public readonly existingRunId: string;

  constructor(opId: string, existingStatus: string, existingRunId: string) {
    super(
      `Operation '${opId}' already exists with status '${existingStatus}' in run '${existingRunId}'`
    );
    this.name = 'DuplicateOperationError';
    this.opId = opId;
    this.existingStatus = existingStatus;
    this.existingRunId = existingRunId;
  }
}

/**
 * opId 冲突异常：相同 opId 再次提交但输入指纹不同（ARCHITECTURE §3.7 / 契约 #45）
 */
export class OperationIdConflictError extends DuplicateOperationError {
  public readonly existingFingerprint: string;
  public readonly requestedFingerprint: string;

  constructor(
    opId: string,
    existingFingerprint: string,
    requestedFingerprint: string,
    existingStatus: string,
    existingRunId: string
  ) {
    super(opId, existingStatus, existingRunId);
    this.name = 'OperationIdConflictError';
    this.existingFingerprint = existingFingerprint;
    this.requestedFingerprint = requestedFingerprint;
    this.message = `Operation ID conflict for '${opId}': existing operation in run '${existingRunId}' with status '${existingStatus}' has fingerprint '${existingFingerprint}', but requested fingerprint is '${requestedFingerprint}'`;
  }
}

/**
 * 恢复必需异常：已有操作处于未终结状态但不在内存中，需要先恢复再执行（ARCHITECTURE §3.7 / 契约 #49）
 */
export class RecoveryRequiredError extends Error {
  public readonly opId: string;
  public readonly status: string;
  public readonly runId: string;

  constructor(
    opId: string,
    status: string,
    runId: string
  ) {
    super(
      `Recovery required for operation '${opId}': operation is in unfinalized state '${status}' in run '${runId}', but is not active in process memory. Call recover() first.`
    );
    this.name = 'RecoveryRequiredError';
    this.opId = opId;
    this.status = status;
    this.runId = runId;
  }
}

/**
 * 人工裁决记录（§3.6 / P0-7）
 */
export interface AdjudicationRecord {
  operationId: string;
  verdict: 'confirmed_stopped' | 'abandon_with_residuals';
  actor: string;
  note?: string;
  residualPids?: number[];
  decidedAt: string;
}

/**
 * 长驻 service op 重启规格 (ARCHITECTURE §3.8 / D19)
 */
export type ServiceRestartPolicy =
  | 'never'
  | { policy: 'on-failure'; maxRestarts: number; backoffMs: number };

/**
 * 长驻 service op 规格 (ARCHITECTURE §3.8)
 */
export interface ServiceSpec {
  serviceId: string;
  runId: string;
  command: import('./driver/types.js').StructuredCommand;
  requiredResources?: string[];
  readiness?: 'spawned' | { stdoutLine: RegExp; timeoutMs?: number };
  restart?: ServiceRestartPolicy;
  maxStderrBytes?: number;
  artifactsDir?: string;
  graceMs?: number;
}

/**
 * service 就绪事实 (ARCHITECTURE §3.8)
 */
export interface ReadyFact {
  serviceId: string;
  instanceIndex: number;
  readyAt: string;
  matchedLine?: string;
}

/**
 * service 句柄 (ARCHITECTURE §3.8)
 */
export interface ServiceHandle {
  serviceId: string;
  runId: string;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  ready: Promise<ReadyFact>;
  stop: (graceMs?: number) => Promise<void>;
  onInstanceExit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  currentInstanceOpId: string;
}

/**
 * 快照引用契约（ARCHITECTURE §3.5 / 契约 #28–#32, #53）
 */
export interface SnapshotRef {
  id: string;
  domainId: string;
  opId: string;
  driver: string;
  roots: string[];
  coverage: 'worktree_non_ignored' | 'full_tree';
  treeFingerprint: string;
  commitHash?: string;
  journalSeq?: number;
  createdAt: string;
  treeSizeBytes?: number;
  /** 被忽略文件清单（captureSnapshot 的 trackIgnored: 'manifest'）的 sha256；清单本身在域的 artifacts 目录。 */
  ignoredManifestDigest?: string;
}

/**
 * 回滚时被忽略文件相对快照清单的变化。路径为绝对路径；每类最多列 50 条，`counts` 是未截断的总数。
 * `metadataOnly`：大小、mtime、mode 都没变而 ctime 变了，既不能证明内容未变，也不能断言已变。
 */
export interface IgnoredChanges {
  added: string[];
  removed: string[];
  modified: string[];
  metadataOnly: string[];
  truncated: boolean;
  counts: { added: number; removed: number; modified: number; metadataOnly: number };
}

export interface SnapshotOperationResult extends BaseResult {
  kind: 'snapshot';
  status: 'succeeded' | 'failed';
  snapshot?: SnapshotRef;
  errorMessage?: string;
}

export interface RollbackOperationResult extends BaseResult {
  kind: 'rollback';
  status: 'restored' | 'partial' | 'failed';
  snapshotId: string;
  unrestoredPaths?: string[];
  /**
   * `complete`：根内全部内容（含被忽略文件）已恢复或被证明未变，且根外不可能有副作用。
   * `non_ignored`：根内未被忽略的内容已恢复、根外不可能有副作用，但被忽略文件不在快照内，也没有证据说明它们未变。
   */
  coverage: 'complete' | 'non_ignored' | 'declared_roots' | 'none';
  outOfScopeEffects: 'none_possible' | 'possible';
  /**
   * 回滚对被忽略文件能说什么：`restored` 在快照内且已恢复；`unchanged_verified` 不在快照内、清单证明未变；
   * `not_captured` 不在快照内、未证明未变；`unverified` 在快照内但核验没通过（status 为 failed）。
   */
  ignoredFiles: 'restored' | 'unchanged_verified' | 'not_captured' | 'unverified';
  ignoredChanges?: IgnoredChanges;
  /** 得出 coverage 的依据，供上层解释「为什么是 / 不是 complete」。 */
  coverageBasis: string[];
  errorMessage?: string;
}

export interface SnapshotDriver {
  name: string;
  coverage: 'worktree_non_ignored' | 'full_tree';
  capture(
    roots: string[],
    options?: {
      id?: string;
      domainId?: string;
      opId?: string;
      includeIgnored?: boolean;
      maxTreeSizeBytes?: number;
    }
  ): Promise<SnapshotRef>;
  /**
   * `newIgnoredPaths`：full_tree 快照之后才出现、且被忽略的路径（整个目录都是新的则折叠为以分隔符结尾的一项）。
   * 默认保留它们；`removeNewIgnored` 为 true 时删除，删不掉的进 `unrestoredPaths`。
   */
  restore(
    snapshot: SnapshotRef,
    options?: { force?: boolean; removeNewIgnored?: boolean }
  ): Promise<{ unrestoredPaths: string[]; newIgnoredPaths?: string[] }>;
  /**
   * 计算 roots 当前内容的树指纹。
   * 回滚核验时应传入 `against: snapshot`：以快照树为基线、按快照的 coverage 口径只重算 roots，
   * 这样 roots 之外的变化（例如 HEAD 前进）和被忽略文件不会让核验失真。
   * `excludeNewIgnored`：full_tree 口径下不把快照之后新出现的被忽略文件算进指纹（快照里已有的照常比较）。
   */
  fingerprint(roots: string[], options?: { against?: SnapshotRef; excludeNewIgnored?: boolean }): Promise<string>;
  /** 列出 roots 内被忽略的文件（绝对路径，逐文件、不折叠目录）。不支持时不实现，调用方据此拒绝清单请求。 */
  listIgnored?(roots: string[]): Promise<string[]>;
  prune(snapshotIds: string[], options?: { repoRoot?: string }): Promise<void>;
  materialize?(snapshotId: string, newRoot: string, options?: { repoRoot?: string }): Promise<{ worktreePath: string }>;
  dematerialize?(newRoot: string, options?: { force?: boolean; repoRoot?: string }): Promise<void>;
}

/**
 * 授权 Capability 契约（ARCHITECTURE §0.2 裁决 9 / 契约 #55, #56）
 */
export interface CapabilityScope {
  write: string[];                 // 允许写入的工作区路径根列表（先 realpath 后判定包含）
  exclusive: string[];             // 允许独占申请的受管资源列表
}

export interface Capability {
  id: string;
  domainId: string;
  scope: CapabilityScope;
  issuedBy: string;
  expiresAt: string;
  parentId?: string;
  epoch: number;
  createdAt: string;
  revokedAt?: string;
}

export class CapabilityViolationError extends Error {
  constructor(
    public readonly reason:
      | 'expired'
      | 'revoked'
      | 'epoch_mismatch'
      | 'out_of_scope_resource'
      | 'out_of_scope_path'
      | 'attenuation_widened',
    message: string
  ) {
    super(message);
    this.name = 'CapabilityViolationError';
  }
}

/**
 * 写入限制驱动（可选，服务于回滚正确性，不是安全边界）
 */
export interface ConfinementDriver {
  name: string;
  wrap(command: import('./driver/types.js').StructuredCommand, writableRoots: string[]): import('./driver/types.js').StructuredCommand;
}

