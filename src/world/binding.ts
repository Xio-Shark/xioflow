import { isDeepStrictEqual } from 'node:util';
import type { AgentState } from '../agents/runtime.js';
import type { CommitIdentity, WorldCandidate, WorldRef } from './contract.js';
import type { openWorldState } from './state.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;
export interface WorldCheckpointBinding {
  agentId: string;
  status: 'pending' | 'bound' | 'failed';
  checkpointSeq: number | null;
  commitSeq: number;
  reason?: string;
}

/** Associate an immutable completed checkpoint with publication, never restore a spent Run. */
export function bindWorldCheckpoint(world: WorldState, ref: WorldRef,
  identity: CommitIdentity, commitSeq: number): void {
  const store = world.domain.getStore();
  store.transaction(() => {
    const events = store.getJournalEvents(world.domain.domainId);
    if (events.some(e => e.type === 'WORLD_CHECKPOINT_BINDING' && e.payload.worldId === identity.worldId
        && e.payload.key === identity.key)) return;
    const candidate = store.getJournalEvent(world.domain.domainId, ref.atSeq)?.payload as unknown as WorldCandidate;
    const completed = events.find(e => e.seq < ref.atSeq && e.type === 'WORLD_STEP_COMPLETED'
      && e.payload.worldId === identity.worldId && e.payload.id === identity.candidateId);
    const checkpoint = events.filter(e => e.seq < ref.atSeq && e.type === 'AGENT_STATE'
      && (e.payload.state as AgentState).id === identity.candidateId).at(-1);
    const current = events.filter(e => e.type === 'AGENT_STATE'
      && (e.payload.state as AgentState).id === identity.candidateId).at(-1);
    const state = checkpoint?.payload.state as AgentState | undefined;
    let reason: string | undefined;
    if (!completed || !checkpoint || checkpoint.payload.transition !== 'step_completed'
        || state?.status !== 'completed' || state.runId !== identity.candidateId
        || state.workspace?.txId !== identity.txId
        || !isDeepStrictEqual(checkpoint.payload.checkpoint, completed.payload.checkpoint)
        || !isDeepStrictEqual(state.causalHeads, candidate.heads)) reason = 'checkpoint_evidence_mismatch';
    else if (current?.seq !== checkpoint.seq) reason = 'checkpoint_changed';
    const binding: WorldCheckpointBinding = { agentId: identity.candidateId,
      status: reason ? 'failed' : 'bound', checkpointSeq: checkpoint?.seq ?? null, commitSeq,
      ...(reason ? { reason } : {}) };
    store.recordJournalEvent({ domainId: world.domain.domainId, runId: identity.candidateId,
      type: 'WORLD_CHECKPOINT_BINDING', payload: { worldId: identity.worldId, key: identity.key,
        identity, previous: ref, binding }, timestamp: new Date().toISOString() });
  });
}

/** Missing post-publication evidence means pending, including a crash before binding. */
export function readWorldCheckpointBinding(world: WorldState, identity: CommitIdentity,
  commitSeq: number, atSeq: number): WorldCheckpointBinding {
  const event = world.domain.getStore().getJournalEvents(world.domain.domainId).find(e => e.seq <= atSeq
    && e.type === 'WORLD_CHECKPOINT_BINDING' && e.payload.worldId === identity.worldId
    && isDeepStrictEqual(e.payload.identity, identity));
  return event ? structuredClone(event.payload.binding) as unknown as WorldCheckpointBinding
    : { agentId: identity.candidateId, status: 'pending', checkpointSeq: null, commitSeq };
}
