import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import { WorkspacePublicationError, type WorkspaceCommitReceipt } from '../workspace/transactions.js';
import { readWorldArtifacts } from './artifacts.js';
import type { FileWorldAdapter, WorldCandidate, WorldRef } from './contract.js';
import { fingerprintWorldOutput, restoreWorldRevision, type openWorldState } from './state.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;
export type StrictWorldPublication =
  | { status: 'committed'; receipt: WorkspaceCommitReceipt }
  | { status: 'unknown' | 'conflict' | 'rejected' | 'validation_failed' | 'undetermined'; reason: string };
const supervisors = new WeakMap<WorldState['domain'], ProcessSupervisor>();

/** Internal strict publication bridge. Independent keys and checkpoint binding are
 * not implemented here; txId remains the durable file-publication identity. */
export async function commitWorldCandidate(world: WorldState, ref: WorldRef,
  adapter: Pick<FileWorldAdapter, 'id' | 'version' | 'replay' | 'accept'>): Promise<StrictWorldPublication> {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  if (adapter.id !== state.adapter.id || adapter.version !== state.adapter.version) {
    throw new Error('World adapter mismatch');
  }
  const store = domain.getStore();
  const event = store.getJournalEvent(domain.domainId, ref.atSeq);
  if (ref.worldId !== state.worldId || !event
      || !['WORLD_STEP_PREPARED', 'WORLD_STEP_UNKNOWN'].includes(event.type)
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Candidate history reference mismatch');
  }
  const candidate = structuredClone(event.payload) as unknown as WorldCandidate;
  let supervisor = supervisors.get(domain);
  if (!supervisor) { supervisor = new ProcessSupervisor(domain); supervisors.set(domain, supervisor); }
  const prior = supervisor.getWorkspaceCommitResult(candidate.txId);
  if (prior) return { status: 'committed', receipt: prior };
  const finish = (result: StrictWorldPublication) => {
    store.recordJournalEvent({ domainId: domain.domainId, runId: candidate.id,
      type: 'WORLD_PUBLICATION_RESULT', payload: { worldId: state.worldId, id: candidate.id,
        txId: candidate.txId, previous: ref, result }, timestamp: new Date().toISOString() });
    return result;
  };
  let replayError: string | undefined;
  try {
    if (candidate.coverage.status !== 'complete' || candidate.heads === null
        || candidate.coverage.manifestHash !== state.manifestHash) {
      return finish({ status: 'unknown', reason: 'coverage_unknown' });
    }
    await restoreWorldRevision(world, candidate.version);
    readWorldArtifacts(world, ref);
    const snapshot = store.getSnapshot(candidate.version.snapshotId)!;
    const completed = store.getJournalEvents(domain.domainId).find(e => e.seq <= ref.atSeq
      && e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id);
    if (!completed) throw new Error('Candidate execution evidence missing');
    const checkOutput = async () => {
      if (await fingerprintWorldOutput(completed.payload.forkRoot as string, state.coverage, snapshot)
          !== candidate.outputFingerprint) throw new WorkspacePublicationError('output_changed');
    };
    await checkOutput();
    const log = new WorkspaceCausalGraph(domain).view(candidate.heads, ref.atSeq).nodes.map(n => n.observation);
    const result = await supervisor.commitWorkspaceTransaction(candidate.txId, {
      observationPolicy: 'always', observations: { closedWorld: true, log,
        replay: async (entry, root) => {
          try { return await adapter.replay(entry, root); }
          catch (error) { replayError = error instanceof Error ? error.message : String(error); throw error; }
        } },
      publication: { coverage: 'complete', outputFingerprint: candidate.outputFingerprint,
        accept: async root => {
          await restoreWorldRevision(world, candidate.version);
          readWorldArtifacts(world, ref);
          await checkOutput();
          const before = await fingerprintWorldOutput(root, state.coverage, snapshot);
          const accepted = await adapter.accept(root);
          if (await fingerprintWorldOutput(root, state.coverage, snapshot) !== before) {
            throw new WorkspacePublicationError('output_changed');
          }
          await checkOutput();
          return accepted;
        } },
    });
    if (replayError !== undefined) return finish({ status: 'validation_failed', reason: replayError });
    return finish(result.status === 'committed' ? { status: 'committed', receipt: result }
      : { status: 'conflict', reason: result.observation?.reason ?? 'workspace_conflict' });
  } catch (error) {
    // Cleanup can fail after publication; the durable receipt takes precedence.
    const receipt = supervisor.getWorkspaceCommitResult(candidate.txId);
    if (receipt) return finish({ status: 'committed', receipt });
    const pending = store.getJournalEvents(domain.domainId).some(e => e.type === 'TX_COMMITTING'
      && e.payload.txId === candidate.txId);
    if (pending) return finish({ status: 'undetermined', reason: error instanceof Error ? error.message : String(error) });
    if (error instanceof WorkspacePublicationError) return finish({
      status: error.reason === 'output_changed' || error.reason === 'acceptance_rejected' ? 'rejected' : 'validation_failed',
      reason: error.reason,
    });
    return finish({ status: 'validation_failed', reason: error instanceof Error ? error.message : String(error) });
  }
}
