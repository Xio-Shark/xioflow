/**
 * @xioflow/kernel — OS Medium & Supervised Execution Kernel for LLMs.
 *
 * Root value surface is intentionally capped at <= 15 orthogonal symbols.
 * LLM tool schemas & dispatchers live at `@xioflow/kernel/surface` (`@xioflow/surface`),
 * external CLI agent wrapping at `@xioflow/kernel/wrap` (`@xioflow/wrap`),
 * OpenTelemetry trace export at `@xioflow/kernel/otel`, and ISA preview at `@xioflow/kernel/isa`.
 */

// 1-5: OS Medium, Workspace Micro-Arbiter & Causal Session View
export {
  connectWorkspace,
  WorkspaceArbiterClient,
  WorkspaceArbiterServer,
} from './arbiter/index.js';
export { KernelMedium } from './kernel/medium.js';
export { SessionView } from './kernel/session-view.js';

// 6-8: Core Execution Domain, Process Supervisor & Honest Recovery Engine
export { ExecutionDomain } from './domain.js';
export { ProcessSupervisor } from './supervisor/supervisor.js';
export { RecoveryEngine } from './recovery/engine.js';

// 9-13: OS Process Tree & Filesystem Confinement Drivers
export { ReaperPlatformDriver } from './driver/reaper-driver.js';
export { NodePlatformDriver } from './driver/node-driver.js';
export { CgroupPlatformDriver, CgroupUnavailableError } from './driver/cgroup-driver.js';
export { LandlockConfinementDriver } from './confinement/landlock.js';

// 14-15: Core Domain Fencing & Resource Contention Errors
export { DomainLockedError, ResourceConflictError } from './types.js';

// Pure TypeScript types (zero runtime footprint)
export type * from './types.js';
export type * from './driver/types.js';
export type * from './kernel/syscalls.js';
export type {
  FileReadRecord,
  MutationValidationFailure,
  StaleReadNotice,
} from './kernel/session-view.js';
export type { KernelMediumOptions } from './kernel/medium.js';
export type {
  ArbiterManifest,
  ConnectWorkspaceOptions,
  WorkspaceArbiterServerOptions,
} from './arbiter/index.js';
export type {
  CaptureSnapshotOptions,
  ExecuteProcessOptions,
  RollbackOptions,
} from './supervisor/supervisor.js';
export type { TrackReadsSpec } from './supervisor/read-evidence.js';
export type { ReadTracking } from './workspace/read-tracking.js';
export type {
  CommitOptions,
  CommitResult,
  CommitValidation,
  ObservationEntry,
  ObservationOutcome,
  ObservationStepOutcome,
  ObservationValidation,
  TransactionConflict,
  TransactionEffects,
  WorkspaceIndexHints,
  WorkspaceTransaction,
  WriteEntry,
} from './workspace/transactions.js';
