import type { StopProcessResult } from '../driver/types.js';
import type { AdjudicationRecord, ReadEvidence } from '../types.js';
import type { MutationValidationFailure, StaleReadNotice } from './session-view.js';

export type SyscallName = 'exec' | 'await' | 'vfs_tx' | 'blob' | 'observe' | 'adjudicate';

export interface BlobDescriptor {
  blobRef: string;
  sha256: string;
  totalBytes: number;
  totalLines: number;
}

export type LeafAwaitCondition =
  | { kind: 'process_exit'; opId: string }
  | { kind: 'port_open'; port: number; host?: string; opId?: string }
  | {
      kind: 'http_ready';
      url: string;
      expectedStatus?: number | number[];
      bodyPattern?: string;
      opId?: string;
    }
  | {
      kind: 'output_match';
      opId: string;
      pattern: string;
      stream?: 'stdout' | 'stderr' | 'any';
    }
  | { kind: 'file_change'; path: string; sinceRev?: string; opId?: string };

export type AwaitCondition =
  | LeafAwaitCondition
  | { kind: 'any'; conditions: AwaitCondition[] }
  | { kind: 'all'; conditions: AwaitCondition[] };

export interface ExecSyscallRequest {
  sessionId?: string;
  opId?: string;
  /** Shell command string (executed via `/bin/sh -c` unless `shell` is specified). Mutually exclusive with `execPath` unless `stopOpId` is used. */
  cmd?: string;
  shell?: string;
  /** Structured executable path (bypasses shell). */
  execPath?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  stdin?: string;
  timeoutMs?: number;
  /** Launch as a managed background process held by the reaper tree without blocking for exit. */
  background?: boolean;
  /** Optional inline readiness condition to await right after launching (short-circuits immediately if the process exits early). */
  waitUntil?: AwaitCondition;
  /** Stop or signal an existing background process instead of spawning a new one. */
  stopOpId?: string;
  graceMs?: number;
  signal?: NodeJS.Signals;
  /** Enable kernel write confinement (sandbox-exec on macOS, Landlock/bubblewrap/srt on Linux). */
  confinement?: boolean | { writableRoots?: string[] };
  /** Record content read evidence (VFS syscall trace on Linux, atime fallback elsewhere). */
  trackReads?: boolean;
  /** Max inline characters/bytes per stream before spilling full stream to a paged `blobRef` (default 16KB). */
  inlineMaxBytes?: number;
}

export interface ExecSyscallResult {
  opId: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' | 'running' | 'stopped';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid?: number;
  pgid?: number;
  stdout: string;
  stderr: string;
  confined?: boolean;
  confinementDriver?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutBlob?: BlobDescriptor;
  stderrBlob?: BlobDescriptor;
  durationMs: number;
  replayed?: boolean;
  treeSettlement?: 'empty' | 'reaped' | 'unverified';
  stopResult?: StopProcessResult;
  waitOutcome?: AwaitSyscallResult;
  readEvidence?: ReadEvidence;
  staleReads: StaleReadNotice[];
}

export interface AwaitSyscallRequest {
  sessionId?: string;
  condition: AwaitCondition;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AwaitSyscallResult {
  status: 'satisfied' | 'timeout' | 'process_exited_early';
  satisfiedCondition?: AwaitCondition['kind'];
  durationMs: number;
  detail?: string;
  processExit?: {
    opId: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdoutPreview: string;
    stderrPreview: string;
  };
  fileRev?: string;
  httpStatus?: number;
  matchedLine?: string;
  staleReads: StaleReadNotice[];
}

export type VfsMutation =
  | {
      kind: 'write';
      path: string;
      content: string;
      expectedRev?: string;
    }
  | {
      kind: 'patch';
      path: string;
      oldText?: string;
      newText?: string;
      edits?: Array<{ oldText: string; newText: string; replaceAll?: boolean }>;
      replaceAll?: boolean;
      expectedRev?: string;
    }
  | {
      kind: 'delete';
      path: string;
      expectedRev?: string;
    };

export interface VfsTxSyscallRequest {
  sessionId?: string;
  txId?: string;
  /** Atomic file mutations (`write`, `patch`, `delete`) validated against `expectedRev` / `SessionView`. */
  mutations?: VfsMutation[];
  /**
   * Run in an isolated `git-shadow` worktree fork (`true`) and merge via OCC read/write set validation.
   * Automatically enabled when `branchCmd` is provided.
   */
  isolated?: boolean;
  /** Command to run inside the isolated `git-shadow` branch before running `gateCmd` and committing. */
  branchCmd?: string;
  /** Verification gate command (e.g. `pnpm typecheck && vitest run ...`). Non-zero exit automatically rolls back all changes! */
  gateCmd?: string;
  gateTimeoutMs?: number;
  /** When `false` in `isolated` mode, evaluates mutations + `branchCmd` + `gateCmd` and returns the diff without merging into the main workspace. */
  commit?: boolean;
}

export interface VfsTxSyscallResult {
  txId: string;
  status: 'committed' | 'rolled_back' | 'conflict' | 'dry_run';
  changedFiles: string[];
  revisions: Record<string, string>;
  conflicts?: Array<
    | MutationValidationFailure
    | { path: string; kind: 'write_write' | 'read_write' | 'external_write'; otherTxId?: string }
  >;
  branchResult?: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    stdoutBlob?: BlobDescriptor;
    stderrBlob?: BlobDescriptor;
  };
  gateResult?: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    stdoutBlob?: BlobDescriptor;
    stderrBlob?: BlobDescriptor;
  };
  errorMessage?: string;
  durationMs: number;
  staleReads: StaleReadNotice[];
}

export type BlobSyscallRequest =
  | {
      sessionId?: string;
      op: 'put';
      content: string;
    }
  | {
      sessionId?: string;
      op: 'stat';
      target: string; // blobRef (`blob:...`) or workspace-relative/contained file path
    }
  | {
      sessionId?: string;
      op: 'slice';
      target: string; // blobRef (`blob:...`) or workspace file path
      startLine?: number; // 1-based inclusive
      endLine?: number; // 1-based inclusive
      symbols?: string[]; // Optional symbol scope for SessionView Early Cutoff
    }
  | {
      sessionId?: string;
      op: 'grep';
      target?: string; // blobRef, file path, or directory path (defaults to workspaceRoot)
      pattern: string;
      isRegex?: boolean;
      caseSensitive?: boolean;
      contextLines?: number;
      maxMatches?: number;
    };

export interface BlobGrepMatch {
  target: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface BlobSyscallResult {
  op: BlobSyscallRequest['op'];
  target: string;
  blobRef?: string;
  rev?: string;
  sha256?: string;
  totalBytes: number;
  totalLines: number;
  startLine?: number;
  endLine?: number;
  hasMore?: boolean;
  content?: string;
  matches?: BlobGrepMatch[];
  truncatedMatches?: boolean;
}

export interface ObserveSyscallRequest {
  sessionId?: string;
  includeAllStale?: boolean;
}

export interface ManagedProcessSummary {
  opId: string;
  pid: number;
  pgid?: number;
  command: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  completedAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutBlobRef?: string;
  stderrBlobRef?: string;
}

export interface ObserveSyscallResult {
  workspaceRoot: string;
  domainId: string;
  epoch: number;
  git: {
    isRepo: boolean;
    branch?: string;
    head?: string;
    dirtyFiles: string[];
  };
  activeProcesses: ManagedProcessSummary[];
  recentBackgroundProcesses: ManagedProcessSummary[];
  indeterminateOperations: Array<{
    opId: string;
    reason: string;
    recoveryGuidance: string;
  }>;
  sessionStats: {
    sessionId: string;
    trackedFiles: number;
    earlyCutoffHits: number;
  };
  staleReads: StaleReadNotice[];
}

export interface AdjudicateSyscallRequest {
  opId: string;
  verdict: 'confirmed_stopped' | 'abandon_with_residuals';
  actor: string;
  note?: string;
  evidence?: string;
}

export interface AdjudicateSyscallResult {
  adjudication: AdjudicationRecord;
}

export interface KernelPruneOptions {
  /** Minimum age in milliseconds before unreferenced blobs and orphaned forks are deleted (default 24h; 0 deletes all non-active items). */
  maxAgeMs?: number;
}

export interface KernelPruneResult {
  deletedArtifacts: number;
  deletedBlobs: number;
  deletedForks: number;
  freedBytes: number;
}

/**
 * Abstract interface implemented both by in-process `KernelMedium` and remote UDS `WorkspaceArbiterClient`.
 */
export interface OsMedium {
  readonly workspaceRoot: string;
  exec(req: ExecSyscallRequest): Promise<ExecSyscallResult>;
  await(req: AwaitSyscallRequest): Promise<AwaitSyscallResult>;
  vfs_tx(req: VfsTxSyscallRequest): Promise<VfsTxSyscallResult>;
  blob(req: BlobSyscallRequest): Promise<BlobSyscallResult>;
  observe(req?: ObserveSyscallRequest): Promise<ObserveSyscallResult>;
  adjudicate(req: AdjudicateSyscallRequest): Promise<AdjudicateSyscallResult>;
  close(): Promise<void>;
}
