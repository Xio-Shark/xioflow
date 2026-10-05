import type { ExecuteProcessOptions } from '../supervisor/types.js';
import type { IndeterminateResult, ProcessOperationResult } from '../types.js';

export type AgentCommandOptions = Omit<ExecuteProcessOptions, 'runId'>;
export type AgentCommandResult = ProcessOperationResult | IndeterminateResult;

export interface AgentExecution {
  /** Cooperative cancellation for provider calls and other adapter-owned work. */
  readonly signal: AbortSignal;
  executeProcess(options: AgentCommandOptions): Promise<AgentCommandResult>;
}

/** One quantum owns its submitted commands, even if the adapter forgets to await them. */
export class AgentCommandGroup {
  private open = true;
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  readonly context: AgentExecution;

  constructor(
    submit: (options: AgentCommandOptions) => Promise<AgentCommandResult>,
    signal: AbortSignal = new AbortController().signal,
    reserve: () => () => void = () => () => {},
  ) {
    this.context = Object.freeze({ signal, executeProcess: (options: AgentCommandOptions) => {
      if (!this.open) return Promise.reject(new Error('Agent command context is closed'));
      // A failed batch cannot accumulate an unbounded stream of handled rejections.
      if (this.failures.length > 0) {
        const rejected = Promise.reject<AgentCommandResult>(this.failures[0]);
        void rejected.catch(() => {});
        return rejected;
      }
      let release: () => void;
      try { signal.throwIfAborted(); release = reserve(); }
      catch (error) {
        this.failures.push(error);
        const rejected = Promise.reject<AgentCommandResult>(error);
        void rejected.catch(() => {});
        return rejected;
      }
      // Promise.resolve also captures synchronous admission failures in the batch.
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return submit({ ...options, abortSignal: options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal });
      }).finally(release);
      const pending = operation.then((result) => {
        if (result.status === 'indeterminate') this.failures.push(new Error(`Agent operation "${options.opId}" has an indeterminate outcome: ${result.reason}`));
      }, (error: unknown) => { this.failures.push(error); }).finally(() => {
        this.pending.delete(pending);
      });
      this.pending.add(pending);
      return operation;
    } });
  }

  async finish(): Promise<readonly unknown[]> {
    this.open = false;
    await Promise.all(this.pending);
    return this.failures;
  }
}
