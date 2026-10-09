import type { CommitIdentity, FileWorldAdapter, WorldAgent, WorldCandidate, WorldHandle, WorldRef } from './contract.js';
import { closeWorldResources, type WorldCloseReport } from './close.js';
import { commitWorldCandidate } from './commit.js';
import { explainWorldPublication } from './explain.js';
import { prepareWorldStep } from './prepare.js';
import { refreshWorldCandidate } from './refresh.js';
import { openWorldState } from './state.js';

/** Internal implementation of the frozen WorldHandle contract; not a package export.
 * close drains accepted work before abandoning unpublished candidates.
 */
export async function openWorld(options: { root: string; statePath: string; adapter: FileWorldAdapter }) {
  const world = await openWorldState(options);
  const adapter = options.adapter;
  const agents = new Map<string, WorldAgent>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let closure: Promise<WorldCloseReport> | undefined;

  // Register synchronously, before invoking user code or yielding to close().
  const accept = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('World is closing or closed'));
    const result = Promise.resolve().then(operation);
    pending.add(result);
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  return {
    worldId: world.state.worldId,
    runAgentStep(agent: WorldAgent, input: { task: string }) {
      const task = input.task;
      return accept(async () => {
        const result = await prepareWorldStep(world, agent, { task });
        if (result.status !== 'failed') agents.set(result.candidate.id, agent);
        return result;
      });
    },
    refresh(candidate: WorldCandidate, options: { onUnknown: 'reject' | 'recompute' }) {
      const ref = structuredClone(candidate);
      const policy = { ...options };
      return accept(async () => {
        // Reopened history can still be validated/reused. Missing host code only
        // fails if refresh actually needs new inference; never guess a driver.
        const agent = agents.get(ref.id);
        const report = await refreshWorldCandidate(world, ref, adapter, agent ?? {
          async execute() { throw new Error('World agent is not attached after reopening'); },
        }, policy);
        if (report.result.status !== 'failed' && agent) agents.set(report.result.candidate.id, agent);
        // Successful/unknown refreshes expose the completed report separately
        // from the older candidate identity. Failed results keep their failure cutoff.
        return report.result.status === 'failed' ? report.result : { ...report.result, ref: report.ref };
      });
    },
    explain(target: WorldRef | { identity: CommitIdentity; atSeq?: number }) {
      const ref = structuredClone(target);
      return accept(() => {
        const explanation = explainWorldPublication(world, ref);
        return { ...explanation, coverage: explanation.preparation.coverage, plan: explanation.preparation.plan };
      });
    },
    commit(candidate: WorldCandidate, options: { validation: 'strict'; key: string }) {
      const ref = structuredClone(candidate);
      const policy = { ...options };
      return accept(() => {
        if (policy.validation !== 'strict') throw new Error('World publication requires strict validation');
        return commitWorldCandidate(world, ref, adapter, { key: policy.key });
      });
    },
    close(): Promise<WorldCloseReport> {
      closing = true;
      if (!closure) {
        closure = Promise.allSettled([...pending]).then(() => closeWorldResources(world));
        // Failed persistence allows another close, but never reopens admission.
        void closure.catch(() => { closure = undefined; });
      }
      return closure.then(report => structuredClone(report));
    },
  } satisfies WorldHandle;
}
