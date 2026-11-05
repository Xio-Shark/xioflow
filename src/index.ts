export * from './types.js';
/** Preview ISA façade; legacy exports remain compatibility surface until I-09 adapter migration completes. */
export { execute } from './isa/execute.js';
export type { ExecuteOptions, ExecuteResponse, UnsupportedExecuteResult } from './isa/execute.js';
export type {
  ArtifactRef,
  CapabilityLimits,
  CapabilityRef,
  EventCursor,
  ExecutionResult,
  Evidence,
  Instruction,
  InstructionResult,
  IsaVersion,
  Opcode,
  Program,
  ProcessRef,
  SnapshotRef,
  WorkspaceRef,
} from './isa/types.js';
export type { Capability as IsaCapability, CapabilityScope as IsaCapabilityScope } from './isa/types.js';
export * from './isa/control.js';
export * from './domain.js';
export * from './store/schema.js';
export * from './store/migrations.js';
export { createEventEnvelope, redactEventPayload } from './store/event-envelope.js';
export type { EventEnvelope, EventEnvelopeInput, EventSensitivity } from './store/event-envelope.js';
export * from './store/sqlite.js';
export * from './driver/types.js';
export * from './driver/contract.js';
export { SecretResolutionError } from './driver/secret-env.js';
export { ProcessObservationError } from './driver/observation.js';
export * from './driver/node-driver.js';
export * from './driver/reaper-driver.js';
export * from './driver/cgroup-driver.js';
export * from './supervisor/supervisor.js';
export * from './recovery/engine.js';
export * from './quick-run.js';
export * from './agents/runtime.js';
export * from './agents/run-budget.js';
export type { AgentExecution, AgentCommandOptions, AgentCommandResult } from './agents/execution.js';
export * from './agents/workspace-recovery.js';
export * from './snapshot/git-shadow.js';
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
  WorkspaceTransaction,
  WriteEntry,
} from './workspace/transactions.js';
export {
  replayObservationLog,
  computeSymbolSliceCutoffHash,
  computeDiscoverySetCutoff,
} from './workspace/observation-replay.js';
export type { ObservationReplayResult } from './workspace/observation-replay.js';
export type { ReadTracking } from './workspace/read-tracking.js';
export type { TrackReadsSpec } from './supervisor/read-evidence.js';
export * from './workspace/incremental-index.js';
export type { WorkspaceIndexHints } from './workspace/transactions.js';
export * from './capability/index.js';
export * from './ipc/index.js';
export * from './config/snapshot.js';
export { createConfigOverlay } from './config/overlay.js';
export type { ConfigOverlay } from './config/overlay.js';
export * from './confinement/index.js';
export * from './otel/otlp.js';
export { KernelMcpServer, SUPPORTED_PROTOCOL_VERSIONS } from './mcp/server.js';
export type { KernelMcpServerOptions } from './mcp/server.js';
export * from './workspace/causal-graph.js';
export * from './gateway/wire-proxy.js';
export * from './gateway/shell-shim.js';
export * from './gateway/http304-cache.js';
export * from './gateway/virtual-workspace.js';
export * from './gateway/time-fork.js';
