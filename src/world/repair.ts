import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { prepareWorkspaceRepair, type WorkspaceRepairOptions, type WorkspaceRepairResult } from '../workspace/causal-repair.js';
import { replayObservationLog } from '../workspace/observation-replay.js';
import { readWorldArtifacts } from './artifacts.js';
import { readWorldCandidateValidation } from './validation.js';
import { fingerprintWorldOutput, restoreWorldRevision, type openWorldState } from './state.js';
import type { AgentStepContext, FileWorldAdapter, WorldCandidate, WorldRef } from './contract.js';

type RepairContext = NonNullable<AgentStepContext['refresh']>;
type RepairExecutor = (...args: [...Parameters<WorkspaceRepairOptions['execute']>, RepairContext]) =>
  ReturnType<WorkspaceRepairOptions['execute']>;

/** Internal repair foundation. Returns an open transaction, not a WorldCandidate or publication permission. */
export async function prepareWorldRepair(world: Awaited<ReturnType<typeof openWorldState>>,
  validation: WorldRef, adapter: Pick<FileWorldAdapter, 'id' | 'version' | 'replay'>,
  execute: RepairExecutor) {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  if (adapter.id !== state.adapter.id || adapter.version !== state.adapter.version) {
    throw new Error('World adapter mismatch');
  }
  const probe = readWorldCandidateValidation(world, validation);
  if (probe.status !== 'changed' || probe.scope !== 'selected_nodes' || !probe.version || !probe.plan) {
    throw new Error('Repair requires a changed selected-nodes validation with a fixed version');
  }
  const store = domain.getStore();
  const previous = probe.previous;
  // This also checks the exact candidate reference and saved artifact bodies.
  const artifacts = structuredClone(readWorldArtifacts(world, previous));
  const candidate = structuredClone(store.getJournalEvent(domain.domainId, previous.atSeq)!.payload) as unknown as WorldCandidate;
  if (candidate.coverage.status !== 'complete' || candidate.heads === null
      || candidate.coverage.manifestHash !== state.manifestHash) throw new Error('Repair coverage incomplete');
  const unaffected = new Set(probe.plan.unaffected.map(node => node.seq));
  // An artifact is reusable only when ALL its declared inputs survived. In particular,
  // null is not an empty dependency list, and invalidated model text is never replayed.
  const reusableArtifacts = artifacts.filter(artifact => artifact.dependsOn !== null
    && artifact.dependsOn.every(seq => unaffected.has(seq)));
  const refresh: RepairContext = {
    // Project the public metadata: the journal payload also holds invalidated artifacts.
    previous: { ...previous, txId: candidate.txId, version: candidate.version,
      heads: candidate.heads, outputFingerprint: candidate.outputFingerprint, coverage: candidate.coverage },
    plan: probe.plan, reusableArtifacts,
  };
  const completed = store.getJournalEvents(domain.domainId).find(e => e.seq <= previous.atSeq
    && e.type === 'WORLD_STEP_COMPLETED' && e.payload.worldId === state.worldId && e.payload.id === previous.id);
  if (!completed) throw new Error('Candidate execution evidence missing');
  const version = probe.version;
  const id = `world-repair-${randomUUID()}`;
  const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
    domainId: domain.domainId, runId: candidate.id, type,
    payload: { worldId: state.worldId, id, previous, validation: probe.ref, version, ...payload },
    timestamp: new Date().toISOString(),
  });
  const checkSource = async () => {
    await restoreWorldRevision(world, candidate.version);
    await restoreWorldRevision(world, version);
    readWorldArtifacts(world, previous);
    const snapshot = store.getSnapshot(candidate.version.snapshotId)!;
    if (await fingerprintWorldOutput(completed.payload.forkRoot as string, state.coverage, snapshot)
        !== candidate.outputFingerprint) throw new Error('Candidate output changed');
  };
  const supervisor = new ProcessSupervisor(domain);
  let repair: WorkspaceRepairResult | undefined;
  append('WORLD_REPAIR_STARTED', {});
  try {
    await checkSource();
    const changed = [...new Set(probe.plan.explanations.flatMap(e => e.causes.map(c => c.changedSeq)))];
    repair = await prepareWorkspaceRepair(supervisor, {
      txId: id, runId: candidate.id, root: state.root, forkPath: path.join(domain.domainPath, 'forks', id),
      baseSnapshotId: version.snapshotId, atSeq: previous.atSeq, heads: candidate.heads, changed,
      validateReuse: async (transaction, unaffected) => {
        const snapshot = store.getSnapshot(version.snapshotId)!;
        if (await fingerprintWorldOutput(transaction.forkRoot, state.coverage, snapshot) !== version.fingerprint) {
          throw new Error('Repair fork baseline fingerprint mismatch');
        }
        // Replaying mutations materializes reusable outputs in this fresh baseline.
        // Every result hash must match, including mutations; exceptions never mean changed.
        const result = await replayObservationLog({ log: unaffected.map(n => structuredClone(n.observation)),
          replay: (entry, root) => adapter.replay(entry, root) }, transaction.forkRoot);
        if (result.status !== 'matched') {
          throw new Error(`Reuse validation failed at node ${unaffected[result.divergedAt].seq}: ${result.error ?? result.reason}`);
        }
        await checkSource();
        await fingerprintWorldOutput(transaction.forkRoot, state.coverage, snapshot);
      },
      // Each callback gets isolated declarations; host mutation cannot change the plan,
      // later callbacks, persisted eligibility, or the historical source candidate.
      execute: (source, transaction, dependencies) => execute(source, transaction, dependencies,
        structuredClone(refresh)),
    });
    await checkSource();
    const outputFingerprint = await fingerprintWorldOutput(repair.transaction.forkRoot, state.coverage,
      store.getSnapshot(version.snapshotId)!);
    const atSeq = append('WORLD_REPAIR_PREPARED', { txId: id, outputFingerprint,
      heads: repair.heads, reused: repair.reused.map(n => n.seq),
      reusableArtifacts: reusableArtifacts.map(artifact => artifact.id),
      invalidatedArtifacts: artifacts.filter(artifact => !reusableArtifacts.includes(artifact)).map(artifact => artifact.id),
      replacements: repair.replacements.map(r => ({ sourceSeq: r.sourceSeq, replacementSeq: r.node.seq })) });
    return { ref: { worldId: state.worldId, id, atSeq }, version, outputFingerprint, repair,
      refresh: structuredClone(refresh) };
  } catch (error) {
    // The lower executor aborts failures during reuse/recomputation; this handles final checks.
    let failure = error;
    if (repair) {
      try { await supervisor.abortWorkspaceTransaction(id, 'world repair verification failed'); }
      catch (cleanupError) { failure = new AggregateError([error, cleanupError], `Repair cleanup incomplete for ${id}`); }
    }
    append('WORLD_REPAIR_FAILED', { txId: id, reason: failure instanceof Error ? failure.message : String(failure),
      resources: 'retained' });
    throw failure;
  }
}
