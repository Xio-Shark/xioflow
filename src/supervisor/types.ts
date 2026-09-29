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
