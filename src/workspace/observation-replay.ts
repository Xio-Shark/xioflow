import type { ObservationValidation } from './transactions.js';

export type ObservationReplayResult =
  | { status: 'matched'; matchedSteps: number }
  | {
      status: 'diverged';
      matchedSteps: number;
      divergedAt: number;
      reason: 'observation_changed' | 'mutation_not_applicable';
      /** Execution failures are not reusable evidence of a deterministic result change. */
      error?: string;
    };

/**
 * Revalidate a recorded prefix on a disposable fork, not on the live workspace.
 * A divergent mutation may already have changed the fork; matchedSteps describes
 * evidence, not a reusable filesystem checkpoint. The caller must rebuild that
 * prefix on a fresh fork before resuming. No model calls are replayed here.
 */
export async function replayObservationLog(
  observations: Pick<ObservationValidation, 'log' | 'replay'>,
  root: string
): Promise<ObservationReplayResult> {
  for (let i = 0; i < observations.log.length; i++) {
    const entry = observations.log[i];
    try {
      const seen = await observations.replay(entry, root);
      if ((entry.kind === 'observe' || entry.resultHash !== undefined) && seen !== entry.resultHash) {
        return { status: 'diverged', matchedSteps: i, divergedAt: i, reason: 'observation_changed' };
      }
    } catch (error) {
      return {
        status: 'diverged', matchedSteps: i, divergedAt: i,
        reason: entry.kind === 'mutate' ? 'mutation_not_applicable' : 'observation_changed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { status: 'matched', matchedSteps: observations.log.length };
}
