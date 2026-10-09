import type { WorldCandidate, WorldExplanation, WorldRef } from './contract.js';
import type { openWorldState } from './state.js';
import { readWorldCandidateValidation, type WorldCandidateValidation } from './validation.js';
import { readWorldRefresh, type WorldRefreshReport } from './refresh.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;

/** Preparation evidence only; publication, binding and cleanup are not yet integrated. */
export interface WorldPreparationExplanation extends Pick<WorldExplanation, 'ref' | 'coverage' | 'plan'> {
  candidate: WorldCandidate;
  /** The plan describes validation.previous, which can differ from candidate after a full refresh. */
  validation: WorldCandidateValidation | null;
  refresh: WorldRefreshReport | null;
}

/** Read a fixed preparation/validation/refresh cutoff without inspecting today's files. */
export function explainWorldPreparation(world: WorldState, target: WorldRef): WorldPreparationExplanation {
  if (world.domain.isClosed()) throw new Error('World is closed');
  const ref = { worldId: target.worldId, id: target.id, atSeq: target.atSeq };
  const store = world.domain.getStore();
  const read = (reference: WorldRef) => {
    const event = store.getJournalEvent(world.domain.domainId, reference.atSeq);
    if (reference.worldId !== world.state.worldId || reference.atSeq > ref.atSeq || !event
        || event.payload.worldId !== reference.worldId || event.payload.id !== reference.id) {
      throw new Error('Explanation history reference mismatch');
    }
    return event;
  };
  const candidateAt = (reference: WorldRef): WorldCandidate => {
    const event = read(reference);
    if (!['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN'].includes(event.type)) {
      throw new Error('Explanation requires a prepared or unknown candidate');
    }
    const { txId, version, heads, outputFingerprint, coverage } = event.payload;
    return structuredClone({ worldId: reference.worldId, id: reference.id, atSeq: reference.atSeq,
      txId, version, heads, outputFingerprint, coverage }) as WorldCandidate;
  };
  const event = read(ref);
  let candidate: WorldCandidate;
  let validation: WorldCandidateValidation | null = null;
  let refresh: WorldRefreshReport | null = null;
  if (event.type === 'WORLD_REFRESH_COMPLETED') {
    refresh = readWorldRefresh(world, ref);
    const previous = candidateAt(refresh.previous);
    if (refresh.validation) {
      read(refresh.validation);
      validation = readWorldCandidateValidation(world, refresh.validation);
      if (validation.previous.worldId !== previous.worldId || validation.previous.id !== previous.id
          || validation.previous.atSeq !== previous.atSeq) throw new Error('Explanation validation target mismatch');
    }
    candidate = refresh.result.status === 'failed' ? previous : candidateAt(refresh.result.candidate);
  } else if (event.type === 'WORLD_VALIDATION_COMPLETED') {
    validation = readWorldCandidateValidation(world, ref);
    candidate = candidateAt(validation.previous);
  } else {
    candidate = candidateAt(ref);
  }
  return structuredClone({ ref, candidate, coverage: candidate.coverage,
    plan: validation?.plan ?? null, validation, refresh });
}
