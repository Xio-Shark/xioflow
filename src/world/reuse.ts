import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import { replayObservationLog } from '../workspace/observation-replay.js';
import { readWorldArtifacts } from './artifacts.js';
import { prepareWorldStep } from './prepare.js';
import { readWorldCandidateValidation } from './validation.js';
import { fingerprintWorldOutput, restoreWorldRevision, type openWorldState } from './state.js';
import type { FileWorldAdapter, WorldCandidate, WorldRef } from './contract.js';

/** Rebase matched evidence onto its fixed probe version without calling the model. */
export async function prepareMatchedWorldCandidate(world: Awaited<ReturnType<typeof openWorldState>>,
  validation: WorldRef, adapter: Pick<FileWorldAdapter, 'id' | 'version' | 'replay'>) {
  const { domain, state } = world;
  if (adapter.id !== state.adapter.id || adapter.version !== state.adapter.version) {
    throw new Error('World adapter mismatch');
  }
  const probe = readWorldCandidateValidation(world, validation);
  if (probe.status !== 'matched' || !probe.version || !probe.plan || probe.plan.invalidated.length) {
    throw new Error('Reuse requires matched validation with a fixed version');
  }
  const store = domain.getStore();
  const previous = probe.previous;
  const artifacts = structuredClone(readWorldArtifacts(world, previous));
  const candidate = structuredClone(store.getJournalEvent(domain.domainId, previous.atSeq)!.payload) as unknown as WorldCandidate;
  if (candidate.heads === null || candidate.coverage.status !== 'complete'
      || candidate.coverage.manifestHash !== state.manifestHash) throw new Error('Reuse coverage incomplete');
  const events = store.getJournalEvents(domain.domainId);
  const started = events.find(e => e.seq <= previous.atSeq && e.type === 'WORLD_STEP_STARTED'
    && e.payload.worldId === state.worldId && e.payload.id === previous.id);
  const completed = events.find(e => e.seq <= previous.atSeq && e.type === 'WORLD_STEP_COMPLETED'
    && e.payload.worldId === state.worldId && e.payload.id === previous.id);
  const input = started?.payload.input as { task?: unknown } | undefined;
  if (!completed || typeof input?.task !== 'string') throw new Error('Candidate execution evidence missing');
  const checkSource = async () => {
    await restoreWorldRevision(world, candidate.version);
    readWorldArtifacts(world, previous);
    if (await fingerprintWorldOutput(completed.payload.forkRoot as string, state.coverage,
      store.getSnapshot(candidate.version.snapshotId)!) !== candidate.outputFingerprint) {
      throw new Error('Candidate output changed');
    }
  };
  await checkSource();
  const revision = await restoreWorldRevision(world, probe.version);
  const nodes = new WorkspaceCausalGraph(domain).view(candidate.heads, previous.atSeq).nodes;
  const mapped = new Map<number, number>();
  const remap = (deps: readonly number[] | null) => deps === null ? null : deps.map(seq => {
    const replacement = mapped.get(seq);
    if (replacement === undefined) throw new Error('Reuse dependency outside candidate history');
    return replacement;
  });
  const result = await prepareWorldStep(revision, { execute: async ({ forkRoot, record }) => {
    for (const node of nodes) {
      const replay = await replayObservationLog({ log: [structuredClone(node.observation)],
        replay: (entry, root) => adapter.replay(entry, root) }, forkRoot);
      if (replay.status !== 'matched') {
        throw new Error(`Reuse validation failed at node ${node.seq}: ${replay.error ?? replay.reason}`);
      }
      mapped.set(node.seq, await record(node.observation, remap(node.dependsOn)));
    }
    await checkSource();
    return { coverage: candidate.coverage, heads: remap(candidate.heads),
      artifacts: artifacts.map(artifact => ({ ...artifact, dependsOn: remap(artifact.dependsOn) })) };
  } }, { task: input.task });
  store.recordJournalEvent({ domainId: domain.domainId,
    type: result.status === 'prepared' ? 'WORLD_REUSE_PREPARED' : 'WORLD_REUSE_FAILED',
    payload: { worldId: state.worldId, previous, validation: probe.ref, version: probe.version, result,
      replacements: [...mapped].map(([sourceSeq, replacementSeq]) => ({ sourceSeq, replacementSeq })) },
    timestamp: new Date().toISOString() });
  return result;
}
