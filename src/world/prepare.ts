import type { AgentData } from '../agents/runtime.js';
import type { AgentExecution, DependencyCoverage, PreparationResult, WorldAgent, WorldVersion } from './contract.js';
import { executeWorldStep } from './step.js';
import { verifyWorldArtifactBody } from './artifacts.js';
import type { openWorldState } from './state.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;

/** Internal adapter for the frozen WorldAgent contract; preparation never publishes. */
export async function prepareWorldStep(world: WorldState, agent: WorldAgent,
  input: { task: string }): Promise<PreparationResult> {
  const { state, domain } = world;
  const version: WorldVersion = { worldId: state.worldId, id: state.snapshotId,
    atSeq: state.atSeq, snapshotId: state.snapshotId, manifestHash: state.manifestHash,
    fingerprint: state.fingerprint };
  const result = await executeWorldStep(world, { task: input.task }, async ({ forkRoot, record }) => {
    const nodes = new Map<number, { dependsOn: readonly number[] | null; kind: string }>();
    const execution = await agent.execute({ forkRoot, version: Object.freeze(version), refresh: null,
      record: async (entry, dependsOn) => {
        if (!entry.resultHash?.trim()) throw new Error('World observations require a result hash');
        const seq = record({ ...entry, resultHash: entry.resultHash }, dependsOn === null ? null : [...dependsOn]);
        nodes.set(seq, { dependsOn: dependsOn === null ? null : [...dependsOn], kind: entry.kind });
        return seq;
      },
    }, { task: input.task });
    // Copy declarations before yielding control: later host mutation must not alter evidence.
    const saved = JSON.parse(JSON.stringify(execution)) as AgentExecution;
    const reasons: string[] = [];
    if (saved.coverage.status === 'unknown') {
      if (!Array.isArray(saved.coverage.reasons) || saved.coverage.reasons.some(r => typeof r !== 'string' || !r.trim())) {
        throw new Error('Invalid coverage reasons');
      }
      reasons.push(...saved.coverage.reasons, 'host_coverage_unknown');
    } else if (saved.coverage.status !== 'complete') {
      throw new Error('Invalid dependency coverage');
    } else if (saved.coverage.manifestHash !== state.manifestHash) reasons.push('manifest_mismatch');
    const checkDependencies = (deps: readonly number[] | null) => {
      if (deps === null) { reasons.push('untracked_dependencies'); return; }
      if (!Array.isArray(deps) || deps.some(seq => !nodes.has(seq))) {
        throw new Error('Dependency is outside this world step');
      }
    };
    checkDependencies(saved.heads);
    const reachable = new Set<number>();
    const visit = (seq: number) => {
      if (reachable.has(seq)) return;
      reachable.add(seq);
      for (const parent of nodes.get(seq)!.dependsOn ?? []) visit(parent);
    };
    for (const seq of saved.heads ?? []) visit(seq);
    const ids = new Set<string>();
    if (!Array.isArray(saved.artifacts)) throw new Error('Invalid artifacts');
    for (const artifact of saved.artifacts) {
      if (typeof artifact.id !== 'string' || !artifact.id.trim() || ids.has(artifact.id)
          || !['model_response', 'tool_result', 'file'].includes(artifact.kind)
          || typeof artifact.hash !== 'string' || !artifact.hash.trim()) throw new Error('Invalid artifact declaration');
      ids.add(artifact.id);
      if (!verifyWorldArtifactBody(artifact)) reasons.push('artifact_body_missing');
      checkDependencies(artifact.dependsOn);
      if (artifact.dependsOn?.some((seq: number) => !reachable.has(seq))) reasons.push('artifact_dependency_outside_heads');
    }
    for (const [seq, node] of nodes) {
      if (node.dependsOn === null) reasons.push('untracked_dependencies');
      if (node.kind === 'mutate' && !reachable.has(seq)) reasons.push('mutation_outside_heads');
    }
    const coverage: DependencyCoverage = reasons.length
      ? { status: 'unknown', reasons: [...new Set(reasons)] }
      : { status: 'complete', manifestHash: state.manifestHash };
    return { checkpoint: { ...saved, coverage } as unknown as AgentData,
      causalHeads: saved.heads === null || reasons.includes('untracked_dependencies') ? null : [...saved.heads] };
  });
  if (result.status === 'failed') return { status: 'failed', reason: result.reason,
    ref: { worldId: state.worldId, id: result.id, atSeq: result.atSeq } };
  const execution = result.checkpoint as unknown as AgentExecution;
  const candidate = { worldId: state.worldId, id: result.id, txId: result.txId, version,
    heads: result.causalHeads ?? null, outputFingerprint: result.outputFingerprint, coverage: execution.coverage };
  const atSeq = domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: result.id,
    type: execution.coverage.status === 'complete' ? 'WORLD_STEP_PREPARED' : 'WORLD_STEP_UNKNOWN',
    payload: { ...candidate, artifacts: execution.artifacts }, timestamp: new Date().toISOString() });
  return execution.coverage.status === 'complete'
    ? { status: 'prepared', candidate: { ...candidate, atSeq } }
    : { status: 'unknown', candidate: { ...candidate, atSeq }, reasons: execution.coverage.reasons };
}
