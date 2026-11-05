export * from './opcodes.generated.js';
export * from './registry.generated.js';
export * from './control.js';
export * from './types.js';
export { execute } from './execute.js';
export type { ExecuteOptions, ExecuteResponse, UnsupportedExecuteResult } from './execute.js';
export type { KernelExecutionBinding } from './kernel-executor.js';
export {
  compileArtifactGet,
  compileArtifactPut,
  compileArtifactStream,
  compileExecuteProcess,
  compileWorkspaceDiff,
  compileWorkspaceRollback,
  compileWorkspaceSnapshot,
} from './compiler.js';
export type {
  ArtifactGetCompileSpec,
  ArtifactPutCompileSpec,
  ArtifactStreamCompileSpec,
  ProcessCompileSpec,
  ProgramIdentity,
  WorkspaceDiffCompileSpec,
  WorkspaceRollbackCompileSpec,
  WorkspaceSnapshotCompileSpec,
} from './compiler.js';
export {
  artifactRefsFromEvidence,
  createExecutionResult,
  createInstructionResult,
  indeterminateInstructionResult,
  replayExecutionResult,
} from './result.js';
export type { ResultEnvelopeInput, ResultJournalEvent } from './result.js';
export {
  executePipeline,
  PipelineDomainCoordinator,
} from './pipeline.js';
export type {
  PipelineExecutionContext,
  PipelineExecutor,
  PipelineInstructionOutcome,
  PipelineInstructionResult,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineStatus,
  ExternalPrecondition,
  PreconditionVerdict,
} from './pipeline.js';
export { executePlan, planProgram } from './plan.js';
export type {
  DriverCheckStatus,
  PlanDriver,
  PlanDriverCheck,
  PlanExecutionOptions,
  PlanReport,
  PlanSchemaInfo,
  PlanStatus,
} from './plan.js';
export {
  assertValidProgram,
  lookupOpcode,
  ProgramValidationError,
  validateProgram,
} from './validator.js';
export type {
  ProgramValidationFailure,
  ProgramValidationResult,
  ProgramValidationSuccess,
  ResourceEstimate,
  ValidateProgramOptions,
  ValidationIssue,
  ValidationIssueCode,
  ValidationPlan,
} from './validator.js';
export {
  decodeCbor,
  decodeExecutionResult,
  decodeExecutionResultCbor,
  decodeJson,
  decodeProgram,
  decodeProgramCbor,
  encodeCbor,
  encodeExecutionResult,
  encodeExecutionResultCbor,
  encodeJson,
  encodeProgram,
  encodeProgramCbor,
} from './codec.js';
export type { JsonCodecOptions } from './codec.js';
