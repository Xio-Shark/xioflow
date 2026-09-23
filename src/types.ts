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
  kind: 'process' | 'filesystem' | 'gate' | 'custom';
  name: string;
  inputFingerprint: string;        // 输入与配置哈希指纹
  requiredResources: string[];     // 申请占用的资源（如 ["workspace:write:root"]）
  timeoutMs?: number;
  resourceBudget?: ResourceBudget; // 显式声明的资源治理预算
  outputRef?: string;              // 产物文件引用路径
  status: OperationStatus;
  result?: OperationResult;
  processIdentity?: {
    pid: number;
    /** 进程组 id：崩溃恢复时按组定向清场，避免 leader 已死但后代还活着。 */
    pgid?: number;
    startTimeMonotonic?: number;
    spawnTime: string;
    commandFingerprint?: string;
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
  | IndeterminateResult;

export interface BaseResult {
  durationMs: number;
  completedAt: string;
}

export interface ProcessOperationResult extends BaseResult {
  kind: 'process';
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
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
  residualProcessesReaped?: boolean; // 根进程退出后仍持有管道的后代已被停止流水线回收
  streamCallbackError?: string;      // onStreamChunk 回调抛出的首个错误（不中断排空）
  identityVerification: IdentityVerificationResult;
}

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
