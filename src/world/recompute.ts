import { randomUUID } from 'node:crypto';
import { captureWorldRevision, type openWorldState } from './state.js';
import { prepareWorldStep } from './prepare.js';
import type { PreparationResult, WorldAgent, WorldRef } from './contract.js';

/** Explicit full recomputation: no old output or dependency evidence is reused. */
export async function recomputeWorldCandidate(world: Awaited<ReturnType<typeof openWorldState>>,
  ref: WorldRef, agent: WorldAgent): Promise<PreparationResult> {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  const store = domain.getStore();
  const event = store.getJournalEvent(domain.domainId, ref.atSeq);
  if (ref.worldId !== state.worldId || !event
      || !['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN'].includes(event.type)
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Candidate history reference mismatch');
  }
  const started = store.getJournalEvents(domain.domainId).find(e => e.seq <= ref.atSeq
    && e.type === 'WORLD_STEP_STARTED' && e.payload.worldId === state.worldId && e.payload.id === ref.id);
  const input = started?.payload.input as { task?: unknown } | undefined;
  if (typeof input?.task !== 'string') throw new Error('Candidate task evidence missing');
  const previous = { worldId: ref.worldId, id: ref.id, atSeq: ref.atSeq };
  const id = `world-recompute-${randomUUID()}`;
  const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
    domainId: domain.domainId, type, payload: { worldId: state.worldId, id, previous, mode: 'full', ...payload },
    timestamp: new Date().toISOString(),
  });
  append('WORLD_RECOMPUTE_STARTED', {});
  let result: PreparationResult;
  try {
    const revision = await captureWorldRevision(world);
    // The ordinary preparation path checks fresh coverage, artifacts and dependencies.
    result = await prepareWorldStep(revision, agent, { task: input.task });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const atSeq = append('WORLD_RECOMPUTE_FAILED', { reason, resources: 'retained' });
    return { status: 'failed', ref: { worldId: state.worldId, id, atSeq }, reason };
  }
  append('WORLD_RECOMPUTE_COMPLETED', { result });
  return result;
}
