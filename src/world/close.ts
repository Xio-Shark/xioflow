import { randomUUID } from 'node:crypto';
import { cleanupAgentCausalFork, planAgentCausalResourceCleanup } from '../agents/workspace-resources.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { ResourceDisposition, WorldCloseResult, WorldRef } from './contract.js';
import { explainWorldResources } from './resources.js';
import type { openWorldState } from './state.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;
export interface WorldCloseReport extends WorldCloseResult { readonly ref: WorldRef }
const closures = new WeakMap<WorldState, Promise<WorldCloseReport>>();

/** Internal finalizer: callers must first drain all operations and exclude writers.
 * Abandonment releases only owned checkpoints; unresolved publication stays retained.
 */
export function closeWorldResources(world: WorldState): Promise<WorldCloseReport> {
  const previous = closures.get(world);
  if (previous) return previous.then(report => structuredClone(report));
  const operation = Promise.resolve().then(async (): Promise<WorldCloseReport> => {
    const { domain, state } = world;
    if (domain.isClosed()) throw new Error('World is closed');
    const store = domain.getStore();
    const id = `world-close-${randomUUID()}`;
    const allocations = store.getJournalEvents(domain.domainId).filter(e =>
      e.payload.worldId === state.worldId && ['WORLD_STEP_STARTED', 'WORLD_REPAIR_STARTED'].includes(e.type));
    const ids = new Set(allocations.map(e => e.payload.id as string));
    const supervisor = new ProcessSupervisor(domain);
    for (const txId of ids) {
      let plan = planAgentCausalResourceCleanup(domain);
      let resource = plan.resources.find(r => r.txId === txId);
      const history = store.getJournalEvents(domain.domainId);
      const bindings = history.filter(e => e.type === 'WORLD_PUBLICATION_KEY_BOUND'
        && e.payload.worldId === state.worldId && e.payload.candidateId === txId);
      const unresolved = bindings.some(binding => {
        const result = history.filter(e => e.type === 'WORLD_PUBLICATION_KEY_RESULT'
          && e.payload.worldId === state.worldId && e.payload.key === binding.payload.key).at(-1);
        return !result || (result.payload.result as { status?: string })?.status === 'undetermined';
      });
      if (resource && ['open', 'conflicted'].includes(resource.state) && !unresolved
          && !history.some(e => e.type === 'WORLD_CANDIDATE_ABANDONED'
            && e.payload.worldId === state.worldId && e.payload.id === txId)) {
        const checkpointSeqs = resource.references.filter(ref => ref.txId === txId
          && ref.agentId === txId && ref.runId === txId && ref.current).map(ref => ref.checkpointSeq);
        store.recordJournalEvent({ domainId: domain.domainId, runId: txId,
          type: 'WORLD_CANDIDATE_ABANDONED', timestamp: new Date().toISOString(),
          payload: { worldId: state.worldId, id: txId, txId, checkpointSeqs, reason: 'world_closed' } });
        plan = planAgentCausalResourceCleanup(domain);
        resource = plan.resources.find(r => r.txId === txId);
      }
      if (resource?.fork?.disposition !== 'review'
          || !['open', 'conflicted'].includes(resource.state)) continue;
      try { await cleanupAgentCausalFork(supervisor, { txId, atSeq: plan.atSeq }); }
      catch (error) {
        // Only a durably recorded failure can become a cleanup_failed report.
        const last = store.getJournalEvents(domain.domainId).at(-1);
        if (last?.type !== 'AGENT_CAUSAL_FORK_CLEANUP_FAILED' || last.payload.txId !== txId) throw error;
      }
    }
    const cutoff = store.getJournalEvents(domain.domainId).at(-1)!.seq;
    const resources: ResourceDisposition[] = [];
    for (const txId of ids) resources.push(...explainWorldResources(world,
      { worldId: state.worldId, id: txId, atSeq: cutoff }));
    const recovery = { worldId: state.worldId, id: state.worldId, atSeq: state.atSeq };
    if (!ids.size) resources.push(
      { id: state.snapshotId, kind: 'snapshot', status: 'retained', reason: 'historical_baseline', recovery },
      { id: state.worldId, kind: 'journal', status: 'retained', reason: 'recovery_history', recovery });
    const unique = [...new Map(resources.map(r => [`${r.kind}:${r.id}`, r])).values()];
    const result = { status: 'closed' as const, resources: unique };
    const atSeq = store.recordJournalEvent({ domainId: domain.domainId, type: 'WORLD_RESOURCES_CLOSED',
      timestamp: new Date().toISOString(), payload: { worldId: state.worldId, id, result } });
    world.close();
    return { ...result, ref: { worldId: state.worldId, id, atSeq } };
  });
  closures.set(world, operation);
  void operation.catch(() => closures.delete(world));
  return operation.then(report => structuredClone(report));
}

/** Exact persisted report; no cleanup, replay, or filesystem inspection. */
export function readWorldClose(world: WorldState, ref: WorldRef): WorldCloseReport {
  if (world.domain.isClosed()) throw new Error('World is closed');
  const event = world.domain.getStore().getJournalEvent(world.domain.domainId, ref.atSeq);
  if (ref.worldId !== world.state.worldId || event?.type !== 'WORLD_RESOURCES_CLOSED'
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Close history reference mismatch');
  }
  return structuredClone({ ...event.payload.result as WorldCloseResult, ref });
}
