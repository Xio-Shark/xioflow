import { randomUUID } from 'node:crypto';
import type { FileWorldAdapter, PreparationResult, WorldAgent, WorldCandidate, WorldRef } from './contract.js';
import type { openWorldState } from './state.js';
import { validateWorldCandidate } from './validation.js';
import { prepareMatchedWorldCandidate, prepareRepairedWorldCandidate } from './reuse.js';
import { recomputeWorldCandidate } from './recompute.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;
export interface WorldRefreshReport {
  ref: WorldRef;
  previous: WorldRef;
  validation: WorldRef | null;
  strategy: 'reuse' | 'incremental' | 'reject' | 'full' | 'failed';
  result: PreparationResult;
}

/** Internal refresh coordinator. Preparation never grants publication permission. */
export async function refreshWorldCandidate(world: WorldState, ref: WorldRef,
  adapter: Pick<FileWorldAdapter, 'id' | 'version' | 'replay'>, agent: WorldAgent,
  options: { onUnknown: 'reject' | 'recompute' }): Promise<WorldRefreshReport> {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  if (adapter.id !== state.adapter.id || adapter.version !== state.adapter.version) {
    throw new Error('World adapter mismatch');
  }
  if (!['reject', 'recompute'].includes(options.onUnknown)) throw new Error('Invalid unknown policy');
  const store = domain.getStore();
  const event = store.getJournalEvent(domain.domainId, ref.atSeq);
  if (ref.worldId !== state.worldId || !event
      || !['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN'].includes(event.type)
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Candidate history reference mismatch');
  }
  // Use the durable declaration even if the caller supplies forged candidate fields.
  const candidate = { ...structuredClone(event.payload), atSeq: ref.atSeq } as unknown as WorldCandidate;
  const previous = { worldId: ref.worldId, id: ref.id, atSeq: ref.atSeq };
  const id = `world-refresh-${randomUUID()}`;
  const onUnknown = options.onUnknown;
  const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
    domainId: domain.domainId, type, payload: { worldId: state.worldId, id, previous, ...payload },
    timestamp: new Date().toISOString(),
  });
  append('WORLD_REFRESH_STARTED', { onUnknown });
  let validation: WorldRef | null = null;
  let strategy: WorldRefreshReport['strategy'] = 'failed';
  let result: PreparationResult;
  try {
    const probe = await validateWorldCandidate(world, previous, adapter, 'selected_nodes');
    validation = probe.ref;
    if (probe.status === 'failed') throw new Error(probe.reasons.join('; ') || 'Validation failed');
    if (probe.status === 'matched') {
      strategy = 'reuse';
      result = await prepareMatchedWorldCandidate(world, probe.ref, adapter);
    } else if (probe.status === 'unknown' && onUnknown === 'reject') {
      strategy = 'reject';
      result = { status: 'unknown', candidate, reasons: probe.reasons };
    } else if (probe.status === 'changed') {
      strategy = 'incremental';
      append('WORLD_REFRESH_RECOMPUTING', { validation, cause: probe.status, strategy });
      result = await prepareRepairedWorldCandidate(world, probe.ref, adapter, agent);
    } else {
      // Keep the explanation and execution on the same durable baseline.
      strategy = 'full';
      append('WORLD_REFRESH_RECOMPUTING', { validation, cause: probe.status });
      result = await recomputeWorldCandidate(world, previous, agent);
    }
  } catch (error) {
    strategy = 'failed';
    const reason = error instanceof Error ? error.message : String(error);
    const atSeq = append('WORLD_REFRESH_FAILED', { validation, reason, resources: 'retained' });
    result = { status: 'failed', ref: { worldId: state.worldId, id, atSeq }, reason };
  }
  const atSeq = append('WORLD_REFRESH_COMPLETED', { validation, strategy, result });
  return { ref: { worldId: state.worldId, id, atSeq }, previous, validation, strategy, result };
}

/** Read an exact completed refresh, without replay, execution or journal mutation. */
export function readWorldRefresh(world: WorldState, ref: WorldRef): WorldRefreshReport {
  if (world.domain.isClosed()) throw new Error('World is closed');
  const event = world.domain.getStore().getJournalEvent(world.domain.domainId, ref.atSeq);
  if (ref.worldId !== world.state.worldId || !event || event.type !== 'WORLD_REFRESH_COMPLETED'
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Refresh history reference mismatch');
  }
  const { previous, validation, strategy, result } = event.payload;
  return structuredClone({ ref: { worldId: ref.worldId, id: ref.id, atSeq: ref.atSeq },
    previous, validation, strategy, result }) as WorldRefreshReport;
}
