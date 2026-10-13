/** An unavailable process observation is not an empty process tree. */
export class ProcessObservationError extends Error {
  constructor(message: string, cause: unknown) {
    super(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ProcessObservationError';
  }
}
