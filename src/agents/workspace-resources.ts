import type { ExecutionDomain } from '../domain.js';
import type { AgentState } from './runtime.js';
import { isAgentCheckpoint } from './journal.js';
import { listAgentCausalBindingAttempts, listAgentCausalRefreshExecutions } from './causal-recovery-history.js';

export interface AgentCheckpointWorkspaceReference {
  checkpointSeq: number;
  agentId: string;
  runId: string;
  txId: string;
  forkRoot: string;
  /** Latest checkpoint at the cutoff, including completed and failed agents. */
  current: boolean;
  /** Absent when the transaction baseline was not recorded before this checkpoint. */
  baseline?: { beginSeq: number; snapshotId: string; root: string };
}

/** Journal-only references: baseline metadata does not assert that files still exist. */
export function listAgentCheckpointWorkspaceReferences(
  domain: ExecutionDomain, options: { atSeq?: number; runId?: string; txId?: string } = {},
): AgentCheckpointWorkspaceReference[] {
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid workspace resource history sequence');
  const events = domain.getStore().getJournalEvents(domain.domainId).filter(event => event.seq <= atSeq);
  const beginnings = new Map<string, typeof events[number]>();
  const latest = new Map<string, number>();
  const references: AgentCheckpointWorkspaceReference[] = [];
  for (const event of events) {
    if (event.type === 'TX_BEGUN') beginnings.set(event.payload.txId as string, event);
    if (event.type !== 'AGENT_STATE' || !isAgentCheckpoint(event.payload.transition)) continue;
    const state = event.payload.state as AgentState;
    latest.set(state.id, event.seq);
    if (!state.workspace) continue;
    const begun = beginnings.get(state.workspace.txId);
    references.push({ checkpointSeq: event.seq, agentId: state.id, runId: state.runId,
      ...state.workspace, current: false,
      ...(begun ? { baseline: { beginSeq: begun.seq, snapshotId: begun.payload.baseSnapshotId as string,
        root: begun.payload.root as string } } : {}),
    });
  }
  return references.filter(ref => (options.runId === undefined || ref.runId === options.runId)
    && (options.txId === undefined || ref.txId === options.txId))
    .map(ref => ({ ...ref, current: latest.get(ref.agentId) === ref.checkpointSeq }));
}

export type AgentCausalResourceRetentionReason =
  | 'shared_repair' | 'pending_publication' | 'current_checkpoint' | 'historical_checkpoint'
  | 'referenced_baseline' | 'commit_in_progress';

export interface AgentCausalResourceReview {
  txId: string;
  state: 'reserved' | 'open' | 'committing' | 'committed' | 'aborted' | 'conflicted';
  forkRoot?: string;
  baseSnapshotId?: string;
  attemptSeqs: number[];
  preparationSeqs: number[];
  /** Includes other Runs and transactions sharing this baseline. */
  references: AgentCheckpointWorkspaceReference[];
  disposition: 'retain' | 'review';
  reasons: AgentCausalResourceRetentionReason[];
}

/** Freeze a review plan, never a deletion authorization. Scope filters select owners;
 * reference checks always cover the entire domain at the same journal cutoff.
 * Unregistered allocations and external consumers require host reconciliation.
 */
export function planAgentCausalResourceCleanup(
  domain: ExecutionDomain, options: { atSeq?: number; runId?: string; planSeq?: number } = {},
): { atSeq: number; resources: AgentCausalResourceReview[] } {
  const allEvents = domain.getStore().getJournalEvents(domain.domainId);
  const atSeq = options.atSeq ?? allEvents.at(-1)?.seq ?? 0;
  const references = listAgentCheckpointWorkspaceReferences(domain, { atSeq });
  const events = allEvents.filter(event => event.seq <= atSeq);
  const executions = listAgentCausalRefreshExecutions(domain, { ...options, atSeq })
    .filter(entry => options.planSeq === undefined || entry.seq === options.planSeq);
  const attempts = listAgentCausalBindingAttempts(domain, { ...options, atSeq });
  const resources = new Map<string, AgentCausalResourceReview>();
  const add = (txId: string): AgentCausalResourceReview => {
    const existing = resources.get(txId);
    if (existing) return existing;
    const transitions = { TX_BEGUN: 'open', TX_COMMITTING: 'committing', TX_COMMITTED: 'committed',
      TX_ABORTED: 'aborted', TX_CONFLICTED: 'conflicted' } as const;
    const lifecycle = events.filter(event => event.payload.txId === txId && Object.hasOwn(transitions, event.type));
    const begun = lifecycle.find(event => event.type === 'TX_BEGUN');
    const latest = lifecycle.at(-1);
    const baseSnapshotId = begun?.payload.baseSnapshotId as string | undefined;
    const refs = references.filter(ref => ref.txId === txId
      || (baseSnapshotId !== undefined && ref.baseline?.snapshotId === baseSnapshotId));
    const reasons: AgentCausalResourceRetentionReason[] = [];
    if (refs.some(ref => ref.txId === txId && ref.current)) reasons.push('current_checkpoint');
    if (refs.some(ref => ref.txId === txId && !ref.current)) reasons.push('historical_checkpoint');
    if (refs.some(ref => ref.txId !== txId)) reasons.push('referenced_baseline');
    const state = latest ? transitions[latest.type as keyof typeof transitions] : 'reserved';
    if (state === 'committing') reasons.push('commit_in_progress');
    const resource: AgentCausalResourceReview = { txId, state, attemptSeqs: [], preparationSeqs: [],
      ...(begun ? { forkRoot: begun.payload.forkRoot as string, baseSnapshotId } : {}),
      references: refs, disposition: 'review', reasons };
    resources.set(txId, resource);
    return resource;
  };
  for (const execution of executions) if (execution.repair) {
    const resource = add(execution.repair.txId);
    resource.preparationSeqs.push(execution.repair.seq);
    resource.reasons.push('shared_repair');
  }
  for (const attempt of attempts) for (const reservation of attempt.reservations) {
    const resource = add(reservation.txId);
    resource.attemptSeqs.push(attempt.seq);
    const execution = executions.find(entry => entry.seq === attempt.planSeq)!;
    if (execution.publications.some(entry => entry.agentId === attempt.agentId && entry.status === 'pending')) {
      resource.reasons.push('pending_publication');
    }
  }
  return { atSeq, resources: [...resources.values()].map(resource => ({ ...resource,
    disposition: resource.reasons.length ? 'retain' : 'review', reasons: [...new Set(resource.reasons)],
  })) };
}
