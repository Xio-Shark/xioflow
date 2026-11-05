/** Preview SDK surface. Internal drivers, stores and compatibility state machines are not re-exported. */
export { execute } from './execute.js';
export type { ExecuteOptions, ExecuteResponse, UnsupportedExecuteResult } from './execute.js';
export type { KernelExecutionBinding } from './kernel-executor.js';
export type { PlanExecutionOptions, PlanReport } from './plan.js';
export type { PipelineRunResult, PipelineInstructionResult } from './pipeline.js';
export type { Program, Instruction, Capability, CapabilityRef, WorkspaceRef, JsonObject, JsonValue, Opcode } from './types.js';
