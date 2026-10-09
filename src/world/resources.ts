import { listAgentCausalForkCleanups, planAgentCausalResourceCleanup } from '../agents/workspace-resources.js';
import type { CommitIdentity, ResourceDisposition, WorldRef } from './contract.js';
import type { openWorldState } from './state.js';

/** Journal facts only: review eligibility and publication do not prove reclamation. */
export function explainWorldResources(world: Awaited<ReturnType<typeof openWorldState>>,
  target: WorldRef): ResourceDisposition[] {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  const events = domain.getStore().getJournalEvents(domain.domainId);
  if (!Number.isSafeInteger(target.atSeq) || target.atSeq < 0
      || !events.some(e => e.seq === target.atSeq)) throw new Error('Resource history cutoff missing');
  const history = events.filter(e => e.seq <= target.atSeq);
  const allocation = history.find(e => e.payload.worldId === target.worldId && e.payload.id === target.id
    && ['WORLD_STEP_STARTED', 'WORLD_REPAIR_STARTED'].includes(e.type));
  if (target.worldId !== state.worldId || !allocation) throw new Error('Resource history reference mismatch');
  const resource = planAgentCausalResourceCleanup(domain, { atSeq: target.atSeq }).resources
    .find(r => r.txId === target.id);
  if (!resource) throw new Error('World resource registration missing');
  const binding = history.find(e => e.type === 'WORLD_PUBLICATION_KEY_BOUND'
    && e.payload.worldId === state.worldId
    && (e.payload.identity as CommitIdentity | undefined)?.txId === resource.txId);
  const prepared = history.find(e => e.payload.worldId === state.worldId && e.payload.id === target.id
    && ['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN'].includes(e.type));
  const recovery = binding ? binding.payload.identity as unknown as CommitIdentity
    : { worldId: state.worldId, id: target.id, atSeq: prepared?.seq ?? allocation.seq };
  const cleanup = listAgentCausalForkCleanups(domain, { atSeq: target.atSeq, txId: resource.txId }).at(-1);
  let status: ResourceDisposition['status'] = 'retained';
  let reason = resource.fork?.reasons.join(',') || resource.reasons.join(',') || 'reclamation_not_recorded';
  // TX_ABORTED follows successful dematerialization. TX_COMMITTED precedes
  // best-effort cleanup and therefore cannot establish that a fork was removed.
  if (resource.state === 'aborted') { status = 'reclaimed'; reason = 'transaction_aborted'; }
  else if (cleanup?.status === 'failed') { status = 'cleanup_failed'; reason = cleanup.error ?? 'cleanup_failed'; }
  else if (cleanup?.status === 'pending') { reason = 'cleanup_outcome_unknown'; }
  const resources: ResourceDisposition[] = [{ id: resource.txId, kind: 'fork', status, reason, recovery }];
  for (const id of new Set([state.snapshotId, resource.baseSnapshotId].filter((id): id is string => !!id))) {
    resources.push({ id, kind: 'snapshot', status: 'retained', reason: 'historical_baseline', recovery });
  }
  resources.push({ id: state.worldId, kind: 'journal', status: 'retained', reason: 'recovery_history', recovery });
  return structuredClone(resources);
}
