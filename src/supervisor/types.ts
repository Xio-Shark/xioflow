import { ManagedProcessHandle, StructuredCommand, StopProcessResult } from '../driver/types.js';
import { ConfinementDriver, ProcessOperationResult, ResourceBudget, TerminationReason } from '../types.js';

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
  /**
   * 'manifest'：不复制被忽略文件的内容，只记录每个文件的 size / mtime / ctime / mode。
   * 回滚时清单未变，默认快照也能证明 `complete`。与 includeIgnored 同时给出时无效（内容已在快照内）。
   */
  trackIgnored?: 'manifest';
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
  /** full_tree 快照之后新出现的被忽略文件：默认保留并列入 unrestoredPaths（status 为 partial）；true 时删除。 */
  removeNewIgnored?: boolean;
  timeoutMs?: number;
}

export type StreamSubscriber = (stream: 'stdout' | 'stderr', chunk: Buffer) => void;

/** 在飞操作的内存态；字段名被共享契约套件经 `activeOperations` 读取（handle.rawProcess），改名即破坏契约。 */
export interface ActiveOperationState {
  opId: string;
  runId: string;
  phase: 'waiting_resources' | 'intent_registered' | 'spawning' | 'active' | 'stopping' | 'done';
  startTime: number;
  inputFingerprint: string;
  resultPromise?: Promise<ProcessOperationResult>;
  streamSubscribers: Set<StreamSubscriber>;
  handle?: ManagedProcessHandle;
  command?: StructuredCommand;
  cancelRequested: boolean;
  cancelGraceMs?: number;
  timedOut: boolean;
  terminationReason?: TerminationReason;
  stopPromise?: Promise<StopProcessResult>;
  stopResolve?: (res: StopProcessResult) => void;
}
