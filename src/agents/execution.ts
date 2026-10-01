import type { ExecuteProcessOptions } from '../supervisor/types.js';
import type { IndeterminateResult, ProcessOperationResult } from '../types.js';

export type AgentCommandOptions = Omit<ExecuteProcessOptions, 'runId'>;
export type AgentCommandResult = ProcessOperationResult | IndeterminateResult;

export interface AgentExecution {
  executeProcess(options: AgentCommandOptions): Promise<AgentCommandResult>;
}

/** One quantum owns its submitted commands, even if the adapter forgets to await them. */
export class AgentCommandGroup {
  private open = true;
  private readonly pending: Promise<void>[] = [];
  private readonly failures: unknown[] = [];
  readonly context: AgentExecution;

  constructor(submit: (options: AgentCommandOptions) => Promise<AgentCommandResult>) {
    this.context = Object.freeze({ executeProcess: (options: AgentCommandOptions) => {
      if (!this.open) return Promise.reject(new Error('Agent command context is closed'));
      // Promise.resolve also captures synchronous admission failures in the batch.
      const operation = Promise.resolve().then(() => submit(options));
      this.pending.push(operation.then((result) => {
        if (result.status === 'indeterminate') this.failures.push(new Error(`Agent operation "${options.opId}" has an indeterminate outcome: ${result.reason}`));
      }, (error: unknown) => { this.failures.push(error); }));
      return operation;
    } });
  }

  async finish(): Promise<readonly unknown[]> {
    this.open = false;
    await Promise.all(this.pending);
    return this.failures;
  }
}
