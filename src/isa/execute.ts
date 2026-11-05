import { executePipeline, type PipelineExecutor, type PipelineRunOptions, type PipelineRunResult } from './pipeline.js';
import { executePlan, type PlanExecutionOptions, type PlanReport } from './plan.js';
import type { JsonObject, Program } from './types.js';
import { executeKernelPipeline, type KernelExecutionBinding } from './kernel-executor.js';

export interface ExecuteOptions extends PlanExecutionOptions, Omit<PipelineRunOptions, keyof PlanExecutionOptions> {
  /** Explicit mode override used by adapters; the input object is never mutated. */
  mode?: Program['mode'];
  executor?: PipelineExecutor;
  /** Internal preview: bind supported ISA instructions to one durable kernel. */
  kernel?: KernelExecutionBinding;
}

export interface UnsupportedExecuteResult {
  status: 'unsupported';
  mode?: string;
  issues: [{ code: 'invalid_value'; path: string; message: string }];
}

export type ExecuteResponse = PlanReport | PipelineRunResult | UnsupportedExecuteResult;

function withMode(input: unknown, mode: Program['mode'] | undefined): unknown {
  if (!mode || input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  return { ...(input as JsonObject), mode };
}

/**
 * Unified ISA execution façade. Plan mode is always zero-side-effect; pipeline mode
 * requires an explicit executor supplied by the host. Transaction mode remains
 * unsupported until the durable kernel adapter is wired in a later milestone.
 */
export async function execute(input: unknown, options: ExecuteOptions = {}): Promise<ExecuteResponse> {
  const request = withMode(input, options.mode);
  const mode = request !== null && typeof request === 'object' && !Array.isArray(request)
    ? (request as Record<string, unknown>).mode
    : undefined;
  if (mode === 'plan' || mode === undefined) return executePlan(request, options);
  if (mode === 'pipeline') {
    if (options.kernel) {
      if (options.executor) return { status: 'unsupported', mode, issues: [{ code: 'invalid_value', path: 'executor', message: 'choose either kernel binding or a custom executor' }] };
      return executeKernelPipeline(request, options.kernel, options);
    }
    if (!options.executor) {
      return { status: 'unsupported', mode, issues: [{ code: 'invalid_value', path: 'executor', message: 'pipeline execute requires an explicit executor adapter' }] };
    }
    return executePipeline(request, options.executor, options);
  }
  return { status: 'unsupported', mode: typeof mode === 'string' ? mode : undefined, issues: [{ code: 'invalid_value', path: 'mode', message: 'transaction execution is not implemented in the current kernel' }] };
}
