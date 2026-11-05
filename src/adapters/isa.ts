import { execute, type ExecuteResponse } from '../isa/execute.js';
import type { KernelExecutionBinding } from '../isa/kernel-executor.js';
import type { PlanExecutionOptions } from '../isa/plan.js';
import type { Program } from '../isa/types.js';

/** Host configuration only. These objects are never accepted from tool arguments. */
export interface IsaAdapterOptions {
  plan?: PlanExecutionOptions;
  bindKernel?: (program: unknown, signal?: AbortSignal) => KernelExecutionBinding | undefined | Promise<KernelExecutionBinding | undefined>;
}

export interface IsaAdapterRequestOptions extends IsaAdapterOptions {
  mode?: Program['mode'];
  signal?: AbortSignal;
}

/** Shared SDK/transport boundary; it does not acquire domains, issue capabilities or create Runs. */
export async function executeIsaProgram(input: unknown, options: IsaAdapterRequestOptions = {}): Promise<ExecuteResponse> {
  const value = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined;
  const mode = options.mode ?? value?.mode;
  // A transport without host policy can perform structural planning only;
  // the returned capability=not_requested is not execution authority.
  const plan = { requireCapability: false, ...options.plan };
  if (mode === 'pipeline' && options.bindKernel) {
    options.signal?.throwIfAborted();
    const kernel = await options.bindKernel(input, options.signal);
    options.signal?.throwIfAborted();
    return execute(input, { ...plan, mode: options.mode, kernel, signal: options.signal });
  }
  return execute(input, { ...plan, mode: options.mode, signal: options.signal });
}

export function isaResultExitCode(result: ExecuteResponse): number {
  return result.status === 'admitted' || result.status === 'succeeded' ? 0 : 1;
}
