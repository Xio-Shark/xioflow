import { readWorldCheckpointBinding, type WorldCheckpointBinding } from './binding.js';
import type { CommitIdentity, WorldCandidate, WorldExplanation, WorldRef } from './contract.js';
import { readWorldPublication, type KeyedWorldPublication } from './commit.js';
import type { openWorldState } from './state.js';
import { readWorldCandidateValidation, type WorldCandidateValidation } from './validation.js';
import { readWorldRefresh, type WorldRefreshReport } from './refresh.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;

/** Internal evidence view; resource disposition remains separate work. */
export interface WorldPublicationExplanation {
  ref: WorldRef;
  preparation: WorldPreparationExplanation;
  publication: KeyedWorldPublication | null;
  bindings: WorldCheckpointBinding[];
}

/** Resolve publication and its preparation from one immutable journal prefix. */
export function explainWorldPublication(world: WorldState,
  target: WorldRef | { identity: CommitIdentity; atSeq?: number }): WorldPublicationExplanation {
  if (world.domain.isClosed()) throw new Error('World is closed');
  const events = world.domain.getStore().getJournalEvents(world.domain.domainId);
  const cutoff = target.atSeq ?? events.at(-1)?.seq ?? 0;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0
      || (cutoff !== 0 && !events.some(e => e.seq === cutoff))) throw new Error('Explanation history cutoff missing');
  const history = events.filter(e => e.seq <= cutoff);
  let preparationRef: WorldRef;
  let publication: KeyedWorldPublication | null;
  if ('identity' in target) {
    const identity = target.identity;
    const binding = history.find(e => e.type === 'WORLD_PUBLICATION_KEY_BOUND'
      && e.payload.worldId === world.state.worldId && e.payload.key === identity.key);
    const saved = binding?.payload.identity as CommitIdentity | undefined;
    if (!saved || saved.worldId !== identity.worldId || saved.candidateId !== identity.candidateId
        || saved.txId !== identity.txId || saved.key !== identity.key) {
      throw new Error('Explanation publication identity mismatch');
    }
    preparationRef = binding!.payload.previous as unknown as WorldRef;
    publication = readWorldPublication(world, identity.key, cutoff).result;
    // A refreshed candidate must retain the validation paths and actual reuse evidence.
    const refresh = history.find(e => e.type === 'WORLD_REFRESH_COMPLETED'
      && e.payload.worldId === identity.worldId
      && (e.payload.result as { candidate?: WorldRef } | undefined)?.candidate?.id === identity.candidateId);
    if (refresh) preparationRef = { worldId: identity.worldId, id: refresh.payload.id as string, atSeq: refresh.seq };
  } else {
    // The query cutoff need not be the event that created its target. Resolve
    // that event within the frozen prefix so returned refs can be queried again.
    const event = history.find(e => e.payload.worldId === target.worldId
      && e.payload.id === target.id && ['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN',
        'WORLD_VALIDATION_COMPLETED', 'WORLD_REFRESH_COMPLETED'].includes(e.type));
    if (target.worldId !== world.state.worldId || !event) {
      throw new Error('Explanation history reference mismatch');
    }
    preparationRef = { worldId: target.worldId, id: target.id, atSeq: event.seq };
    const candidate = explainWorldPreparation(world, preparationRef).candidate;
    const binding = history.find(e => e.type === 'WORLD_PUBLICATION_KEY_BOUND'
      && e.payload.worldId === candidate.worldId && e.payload.candidateId === candidate.id);
    publication = binding ? readWorldPublication(world, binding.payload.key as string, cutoff).result : null;
  }
  const preparation = explainWorldPreparation(world, preparationRef);
  return structuredClone({ ref: { worldId: world.state.worldId, id: preparationRef.id, atSeq: cutoff },
    preparation, publication, bindings: publication?.status === 'committed'
      ? [readWorldCheckpointBinding(world, publication.identity, publication.receipt.commitSeq, cutoff)] : [] });
}

/** Preparation evidence only; publication, binding and cleanup are not yet integrated. */
export interface WorldPreparationExplanation extends Pick<WorldExplanation, 'ref' | 'coverage' | 'plan'> {
  candidate: WorldCandidate;
  /** The plan describes validation.previous, which can differ from candidate after a full refresh. */
  validation: WorldCandidateValidation | null;
  refresh: WorldRefreshReport | null;
  reuse: { mode: 'matched' | 'incremental'; replacements: { sourceSeq: number; replacementSeq: number }[] } | null;
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
  const reuseEvent = refresh?.validation && store.getJournalEvents(world.domain.domainId).find(e => {
    if (e.seq > ref.atSeq || !['WORLD_REUSE_PREPARED', 'WORLD_REUSE_UNKNOWN', 'WORLD_REUSE_FAILED'].includes(e.type)) return false;
    const validationRef = e.payload.validation as WorldRef | undefined;
    return validationRef?.worldId === refresh!.validation!.worldId
      && validationRef?.id === refresh!.validation!.id && validationRef?.atSeq === refresh!.validation!.atSeq;
  });
  const reuse = reuseEvent ? { mode: reuseEvent.payload.mode,
    replacements: reuseEvent.payload.replacements } as WorldPreparationExplanation['reuse'] : null;
  return structuredClone({ ref, candidate, reuse, coverage: candidate.coverage,
    plan: validation?.plan ?? null, validation, refresh });
}
