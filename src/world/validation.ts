import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { WorkspaceCausalGraph, type ExplainedRecomputationPlan } from '../workspace/causal-graph.js';
import { validateWorkspaceCausalBranches } from '../workspace/causal-validation.js';
import { readWorldArtifacts } from './artifacts.js';
import type { FileWorldAdapter, WorldCandidate, WorldRef } from './contract.js';
import type { openWorldState } from './state.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;
export interface WorldCandidateValidation {
  ref: WorldRef;
  previous: WorldRef;
  status: 'matched' | 'changed' | 'unknown' | 'failed';
  reasons: string[];
  validationSeq: number | null;
  plan: ExplainedRecomputationPlan | null;
}

/** Internal refresh probe, not a refreshed candidate or permission to publish. */
export async function validateWorldCandidate(world: WorldState, ref: WorldRef,
  adapter: Pick<FileWorldAdapter, 'id' | 'version' | 'replay'>): Promise<WorldCandidateValidation> {
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
  // Caller-supplied heads, coverage or fingerprints never override durable evidence.
  const candidate = structuredClone(event.payload) as unknown as WorldCandidate;
  const previous = { worldId: ref.worldId, id: ref.id, atSeq: ref.atSeq };
  const id = `world-validation-${randomUUID()}`;
  const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
    domainId: domain.domainId, runId: candidate.id, type,
    payload: { worldId: state.worldId, id, previous, ...payload }, timestamp: new Date().toISOString(),
  });
  append('WORLD_VALIDATION_STARTED', {});
  let status: WorldCandidateValidation['status'] = 'failed';
  let reasons: string[] = [];
  let validationSeq: number | null = null;
  let plan: ExplainedRecomputationPlan | null = null;
  try {
    if (candidate.coverage.status === 'unknown' || candidate.heads === null
        || candidate.coverage.manifestHash !== state.manifestHash) {
      status = 'unknown';
      reasons = candidate.coverage.status === 'unknown' ? [...candidate.coverage.reasons] : [];
      if (candidate.heads === null) reasons.push('untracked_dependencies');
      if (candidate.coverage.status === 'complete' && candidate.coverage.manifestHash !== state.manifestHash) {
        reasons.push('manifest_mismatch');
      }
    } else {
      readWorldArtifacts(world, previous);
      const completed = store.getJournalEvents(domain.domainId).find(e => e.seq <= ref.atSeq
        && e.type === 'WORLD_STEP_COMPLETED' && e.payload.id === candidate.id
        && e.payload.worldId === state.worldId);
      const snapshot = store.getSnapshot(candidate.version.snapshotId);
      if (!completed || !snapshot) throw new Error('Candidate execution evidence missing');
      const checkOutput = async () => {
        const actual = await new GitShadowSnapshotDriver().fingerprint(
          [completed.payload.forkRoot as string], { against: snapshot });
        if (actual !== candidate.outputFingerprint) throw new Error('Candidate output changed');
      };
      await checkOutput();
      const validation = await validateWorkspaceCausalBranches(new ProcessSupervisor(domain), {
        txId: id, runId: candidate.id, root: state.root,
        forkPath: path.join(domain.domainPath, 'forks', id), atSeq: ref.atSeq,
        branches: [{ id: candidate.id, heads: [...candidate.heads] }],
        closedWorld: true, replayPolicy: 'deterministic', replay: (entry, root) => adapter.replay(entry, root),
      });
      validationSeq = validation.seq;
      await checkOutput();
      const branch = validation.branches[0];
      status = branch.status;
      if (branch.status === 'failed') reasons = [branch.error];
      else plan = new WorkspaceCausalGraph(domain).explainRecomputation(
        validation.changed, ref.atSeq, candidate.heads);
    }
  } catch (error) {
    status = 'failed';
    reasons = [error instanceof Error ? error.message : String(error)];
    plan = null;
  }
  reasons = [...new Set(reasons)];
  const atSeq = append('WORLD_VALIDATION_COMPLETED', { status, reasons, validationSeq, plan });
  return { ref: { worldId: state.worldId, id, atSeq }, previous, status, reasons, validationSeq, plan };
}

/** Exact historical report; does not probe files, call tools or advance the journal. */
export function readWorldCandidateValidation(world: WorldState, ref: WorldRef): WorldCandidateValidation {
  if (world.domain.isClosed()) throw new Error('World is closed');
  const event = world.domain.getStore().getJournalEvent(world.domain.domainId, ref.atSeq);
  if (ref.worldId !== world.state.worldId || !event || event.type !== 'WORLD_VALIDATION_COMPLETED'
      || event.payload.worldId !== ref.worldId || event.payload.id !== ref.id) {
    throw new Error('Validation history reference mismatch');
  }
  const { previous, status, reasons, validationSeq, plan } = event.payload;
  return structuredClone({ ref, previous, status, reasons, validationSeq, plan }) as WorldCandidateValidation;
}
