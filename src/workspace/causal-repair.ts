import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph, type CausalNode, type CausalStep } from './causal-graph.js';
import type { WorkspaceTransaction } from './transactions.js';

export interface WorkspaceRepairOptions {
  txId: string;
  runId: string;
  root: string;
  forkPath: string;
  changed: readonly number[];
  /** Freeze the source history; later repair nodes must not enter this plan. */
  atSeq: number;
  /** Selected branch results. Omit only when the entire domain history is intended. */
  heads?: readonly number[];
  /** Verify that unchanged evidence and its outputs are reusable in this baseline.
   * Throw on missing outputs, incomplete dependencies or invalid evidence.
   */
  validateReuse(transaction: WorkspaceTransaction, unaffected: readonly CausalNode[]): Promise<void>;
  /** Execute only in forkRoot. Dependencies contain freshly recomputed nodes where available. */
  execute(source: CausalNode, transaction: WorkspaceTransaction, dependencies: readonly CausalNode[]): Promise<
    Pick<CausalStep, 'actorId' | 'observation' | 'writes'>
  >;
}

export interface WorkspaceRepairResult {
  /** Prepared, still open: inspect and commit through the existing OCC API. */
  transaction: WorkspaceTransaction;
  replacements: { sourceSeq: number; node: CausalNode }[];
  reused: CausalNode[];
  /** Remapped branch results for the next repair; preparation does not imply commit. */
  heads: number[];
}

/** Recompute a frozen invalidation closure in a fresh workspace transaction.
 * Does not restore agent contexts or infer dependency completeness. The host
 * must include reused evidence in its commit validation when it is an input.
 */
export async function prepareWorkspaceRepair(
  supervisor: ProcessSupervisor,
  options: WorkspaceRepairOptions,
): Promise<WorkspaceRepairResult> {
  const domain = supervisor.getDomain();
  const graph = new WorkspaceCausalGraph(domain);
  const changed = [...options.changed];
  const atSeq = options.atSeq;
  const plan = graph.planRecomputation(changed, atSeq, options.heads);
  if (!plan.invalidated.length) throw new Error('Workspace repair requires changed causal evidence');
  const current = new Map([...plan.invalidated, ...plan.unaffected].map((node) => [node.seq, node]));
  const dependedOn = new Set([...current.values()].flatMap((node) => node.dependsOn));
  const sourceHeads = options.heads === undefined
    ? [...current.keys()].filter((seq) => !dependedOn.has(seq)).sort((a, b) => a - b)
    : [...new Set(options.heads)];
  const transaction = await supervisor.beginWorkspaceTransaction({
    txId: options.txId, runId: options.runId, root: options.root, forkPath: options.forkPath,
  });
  const replacements: WorkspaceRepairResult['replacements'] = [];
  try {
    await options.validateReuse({ ...transaction }, structuredClone(plan.unaffected));
    for (const source of plan.invalidated) {
      const dependencies = source.dependsOn.map((seq) => current.get(seq)!);
      const result = await options.execute(structuredClone(source), { ...transaction }, structuredClone(dependencies));
      const node = graph.record({
        actorId: result.actorId, observation: result.observation, writes: result.writes,
        txId: transaction.txId, dependsOn: dependencies.map((dependency) => dependency.seq),
      });
      current.set(source.seq, node);
      replacements.push({ sourceSeq: source.seq, node });
    }
    const heads = sourceHeads.map((seq) => current.get(seq)!.seq);
    domain.getStore().recordJournalEvent({
      domainId: domain.domainId, runId: options.runId, type: 'CAUSAL_REPAIR_PREPARED',
      payload: { version: 1, txId: transaction.txId, atSeq, sourceHeads, heads,
        changed, reused: plan.unaffected.map((node) => node.seq),
        replacements: replacements.map(({ sourceSeq, node }) => ({ sourceSeq, replacementSeq: node.seq })) },
      timestamp: new Date().toISOString(),
    });
    return { transaction, replacements, reused: plan.unaffected, heads };
  } catch (error) {
    // No commit has started, so a failed repair can discard its isolated writes.
    try {
      await supervisor.abortWorkspaceTransaction(transaction.txId, 'causal repair failed');
      await supervisor.pruneSnapshots([transaction.baseSnapshotId], { runId: options.runId });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Repair failed; cleanup incomplete for ${transaction.txId}`);
    }
    throw error;
  }
}
