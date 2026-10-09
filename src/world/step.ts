import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime, type AgentData } from '../agents/runtime.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import type { ObservationEntry } from '../workspace/transactions.js';
import type { openWorldState } from './state.js';

type WorldState = Awaited<ReturnType<typeof openWorldState>>;
const active = new WeakSet<WorldState['domain']>();

/** Internal execution foundation. Completion is not a coverage or publication claim. */
export async function executeWorldStep(world: WorldState, input: AgentData, execute: (context: {
  forkRoot: string;
  record(entry: ObservationEntry & { resultHash: string }, dependsOn: number[] | null): number;
}) => Promise<{ checkpoint: AgentData; causalHeads: number[] | null }>) {
  const { domain, state } = world;
  if (domain.isClosed()) throw new Error('World is closed');
  if (active.has(domain)) throw new Error('World step already running');
  active.add(domain);
  const id = `world-step-${randomUUID()}`;
  const store = domain.getStore();
  const append = (type: string, payload: Record<string, unknown>) => store.recordJournalEvent({
    domainId: domain.domainId, runId: id, type, payload: { worldId: state.worldId, id, txId: id, ...payload },
    timestamp: new Date().toISOString(),
  });
  let runtime: AgentRuntime | undefined;
  let recording = false;
  try {
    const timestamp = new Date().toISOString();
    store.transaction(() => {
      store.saveTask({ id, domainId: domain.domainId, name: 'world step', createdAt: timestamp });
      store.saveRun({ id, taskId: id, domainId: domain.domainId, owner: state.worldId,
        status: 'running', startedAt: timestamp });
      append('WORLD_STEP_STARTED', { input, snapshotId: state.snapshotId });
    });
    const workspace = await new ProcessSupervisor(domain).beginWorkspaceTransaction({
      txId: id, runId: id, root: state.root, baseSnapshotId: state.snapshotId,
      forkPath: path.join(domain.domainPath, 'forks', id),
    });
    const graph = new WorkspaceCausalGraph(domain);
    const recorded = new Set<number>();
    let untracked = false;
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async () => {
      recording = true;
      try {
        const result = await execute({ forkRoot: workspace.forkRoot, record: (entry, dependsOn) => {
          if (!recording) throw new Error('World step recording is closed');
          if (!['observe', 'mutate'].includes(entry.kind) || !entry.resultHash?.trim()) {
            throw new Error('World observations require a kind and result hash');
          }
          if (dependsOn === null) {
            untracked = true;
            return append('WORLD_OBSERVATION_UNTRACKED', { observation: entry, dependsOn: null });
          }
          if (dependsOn.some(seq => !recorded.has(seq))) throw new Error('Dependency is outside this world step');
          const node = graph.record({ txId: id, actorId: id, observation: entry, dependsOn });
          recorded.add(node.seq);
          return node.seq;
        } });
        if (result.causalHeads !== null && result.causalHeads.some(seq => !recorded.has(seq))) {
          throw new Error('Head is outside this world step');
        }
        return { status: 'completed', checkpoint: result.checkpoint,
          causalHeads: untracked ? null : result.causalHeads };
      } finally { recording = false; }
    } });
    runtime.create({ id, runId: id, input, checkpoint: null, workspace, causalHeads: null, maxSteps: 1 });
    await runtime.drain();
    const agent = runtime.get(id)!;
    if (agent.status !== 'completed') throw new Error(agent.error ?? agent.reason ?? 'World agent did not complete');
    const snapshot = store.getSnapshot(state.snapshotId)!;
    const outputFingerprint = await new GitShadowSnapshotDriver().fingerprint([workspace.forkRoot], { against: snapshot });
    const atSeq = append('WORLD_STEP_COMPLETED', { snapshotId: state.snapshotId, outputFingerprint,
      checkpoint: agent.checkpoint, causalHeads: agent.causalHeads, forkRoot: workspace.forkRoot });
    return { status: 'executed' as const, id, txId: id, atSeq, outputFingerprint,
      checkpoint: agent.checkpoint, causalHeads: agent.causalHeads, forkRoot: workspace.forkRoot };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const atSeq = append('WORLD_STEP_FAILED', { reason, resources: 'retained' });
    return { status: 'failed' as const, id, txId: id, atSeq, reason };
  } finally {
    recording = false;
    try { runtime?.close(); } finally { active.delete(domain); }
  }
}
