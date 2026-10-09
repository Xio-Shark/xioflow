import type { ProcessSupervisor } from '../supervisor/supervisor.js';
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
  /** Fork-only review; baseline snapshots are never released by this API. */
  fork?: { disposition: 'retain' | 'review'; reasons: AgentCausalResourceRetentionReason[] };
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
  return { atSeq, resources: [...resources.values()].map(resource => {
    const reasons = [...new Set(resource.reasons)];
    const forkReasons = reasons.filter(reason => reason !== 'historical_checkpoint' && reason !== 'referenced_baseline');
    return { ...resource, disposition: reasons.length ? 'retain' as const : 'review' as const, reasons,
      ...(resource.forkRoot ? { fork: { disposition: forkReasons.length ? 'retain' as const : 'review' as const,
        reasons: forkReasons } } : {}),
    };
  }) };
}

export interface AgentCausalForkCleanup {
  requestSeq: number;
  txId: string;
  runId?: string;
  atSeq: number;
  forkRoot: string;
  baseSnapshotId: string;
  preserveBaseline: true;
  /** Journal evidence only; pending does not imply that files still exist. */
  status: 'pending' | 'aborted' | 'failed';
  outcomeSeq?: number;
  error?: string;
}

/** Reconstruct cleanup outcomes without accessing the filesystem or retrying deletion. */
export function listAgentCausalForkCleanups(
  domain: ExecutionDomain, options: { atSeq?: number; runId?: string; txId?: string } = {},
): AgentCausalForkCleanup[] {
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid cleanup history sequence');
  const events = domain.getStore().getJournalEvents(domain.domainId).filter(event => event.seq <= atSeq);
  const runIds = new Map<string, string | undefined>();
  const requests = new Map<number, AgentCausalForkCleanup>();
  for (const event of events) {
    const txId = event.payload.txId as string;
    if (event.type === 'TX_BEGUN') runIds.set(txId, event.runId);
    if (event.type === 'AGENT_CAUSAL_FORK_CLEANUP_REQUESTED') {
      requests.set(event.seq, { requestSeq: event.seq, txId, runId: runIds.get(txId),
        atSeq: event.payload.atSeq as number, forkRoot: event.payload.forkRoot as string,
        baseSnapshotId: event.payload.baseSnapshotId as string, preserveBaseline: true, status: 'pending' });
    } else if (event.type === 'AGENT_CAUSAL_FORK_CLEANUP_FAILED') {
      const request = requests.get(event.payload.requestSeq as number);
      if (request?.txId === txId && request.status === 'pending') {
        request.status = 'failed'; request.outcomeSeq = event.seq; request.error = event.payload.error as string;
      }
    } else if (event.type === 'TX_ABORTED') {
      const match = /^causal fork cleanup request ([1-9]\d*)$/.exec(String(event.payload.reason));
      const request = match ? requests.get(Number(match[1])) : undefined;
      if (request?.txId === txId && request.status === 'pending') {
        request.status = 'aborted'; request.outcomeSeq = event.seq;
      }
    }
  }
  return [...requests.values()].filter(request => (options.runId === undefined || request.runId === options.runId)
    && (options.txId === undefined || request.txId === options.txId));
}

/** Explicit host reconciliation: call while workspace writers and agent publication are quiescent.
 * The cutoff is an optimistic preflight, not a lock over asynchronous filesystem operations.
 * Only registered open/conflicted forks are released; historical baseline snapshots survive.
 */
export async function cleanupAgentCausalFork(
  supervisor: ProcessSupervisor, options: { txId: string; atSeq: number },
): Promise<{ txId: string; requestSeq: number }> {
  const domain = supervisor.getDomain();
  const plan = planAgentCausalResourceCleanup(domain);
  if (!Number.isSafeInteger(options.atSeq) || options.atSeq < 0) throw new Error('Invalid cleanup sequence');
  if (plan.atSeq !== options.atSeq) throw new Error('Causal resource cleanup evidence is stale; replan');
  const resource = plan.resources.find(entry => entry.txId === options.txId);
  if (!resource) throw new Error('Unknown registered causal resource');
  if (resource.fork?.disposition !== 'review') throw new Error('Causal workspace fork must be retained');
  if (resource.state !== 'open' && resource.state !== 'conflicted') {
    throw new Error('Causal workspace fork requires an open or conflicted transaction');
  }
  const requestSeq = domain.getStore().recordJournalEvent({ domainId: domain.domainId,
    type: 'AGENT_CAUSAL_FORK_CLEANUP_REQUESTED', timestamp: new Date().toISOString(),
    payload: { txId: resource.txId, atSeq: plan.atSeq, forkRoot: resource.forkRoot,
      baseSnapshotId: resource.baseSnapshotId, preserveBaseline: true } });
  try {
    await supervisor.abortWorkspaceTransaction(resource.txId, `causal fork cleanup request ${requestSeq}`);
  } catch (error) {
    try {
      domain.getStore().recordJournalEvent({ domainId: domain.domainId,
        type: 'AGENT_CAUSAL_FORK_CLEANUP_FAILED', timestamp: new Date().toISOString(),
        payload: { txId: resource.txId, requestSeq, error: error instanceof Error ? error.message : String(error) } });
    } catch (journalError) {
      throw new AggregateError([error, journalError], 'Causal fork cleanup failed and its outcome could not be recorded');
    }
    throw error;
  }
  return { txId: resource.txId, requestSeq };
}
