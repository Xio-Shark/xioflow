import type { ExecutionDomain } from '../domain.js';
import type { ObservationEntry, WriteEntry } from './transactions.js';

export interface CausalStep {
  txId: string;
  /** Host identity; may identify an AgentRuntime agent or an external strategy. */
  actorId: string;
  observation: ObservationEntry & { resultHash: string };
  /** All inputs used by this step, including observations of earlier mutations. */
  dependsOn: number[];
  /** Declared provenance; transaction commit still computes its own actual write set. */
  writes?: WriteEntry[];
}

export interface CausalNode extends CausalStep {
  seq: number;
  runId: string;
  baseSnapshotId: string;
}

export interface RecomputationPlan {
  /** Topological order, including the changed evidence itself. */
  invalidated: CausalNode[];
  /** Unaffected by these seeds under the host's declared dependency graph. */
  unaffected: CausalNode[];
}

export interface CausalView {
  /** Selected results, including independent outputs that should survive repair. */
  heads: number[];
  /** Heads and all their ancestors, in journal/topological order. */
  nodes: CausalNode[];
}

/** Journal-backed provenance, not a replacement for transaction commit validation. */
export class WorkspaceCausalGraph {
  constructor(private readonly domain: ExecutionDomain) {}

  /** Record a completed tool result while its transaction is still open. */
  public record(step: CausalStep): CausalNode {
    if (!step.actorId.trim() || !step.observation.resultHash?.trim()) {
      throw new Error('Causal steps require an actor and a nonempty result hash');
    }
    if (!['observe', 'mutate'].includes(step.observation.kind)) throw new Error('Invalid causal observation kind');
    if (step.observation.kind === 'observe' && step.writes?.length) throw new Error('An observation cannot declare writes');
    const events = this.domain.getStore().getJournalEvents(this.domain.domainId);
    const history = events.filter((event) => event.payload.txId === step.txId && event.type.startsWith('TX_'));
    const begun = history.find((event) => event.type === 'TX_BEGUN');
    if (!begun || history.some((event) => ['TX_COMMITTING', 'TX_COMMITTED', 'TX_CONFLICTED', 'TX_ABORTED'].includes(event.type))) {
      throw new Error('Causal steps require an open workspace transaction');
    }
    const nodes = new Set(this.nodes().map((node) => node.seq));
    if (step.dependsOn.some((seq) => !Number.isSafeInteger(seq) || !nodes.has(seq))) {
      throw new Error('Causal dependencies must reference existing nodes in this domain');
    }
    const node = structuredClone({ ...step, dependsOn: [...new Set(step.dependsOn)],
      runId: begun.runId!, baseSnapshotId: begun.payload.baseSnapshotId as string });
    const seq = this.domain.getStore().recordJournalEvent({
      domainId: this.domain.domainId, runId: node.runId, type: 'CAUSAL_STEP',
      payload: { version: 1, node }, timestamp: new Date().toISOString(),
    });
    return { ...node, seq };
  }

  /** Inclusive historical cut. No in-memory cache: reopening a domain preserves the graph. */
  public nodes(atSeq = Number.MAX_SAFE_INTEGER): CausalNode[] {
    if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid causal history sequence');
    return this.domain.getStore().getJournalEvents(this.domain.domainId)
      .filter((event) => event.type === 'CAUSAL_STEP' && event.seq <= atSeq)
      .map((event) => {
        if (event.payload.version !== 1) throw new Error('Unsupported causal journal version');
        return { ...event.payload.node as Omit<CausalNode, 'seq'>, seq: event.seq };
      });
  }

  /** Transitive evidence for one action, in journal/topological order. */
  public ancestors(seq: number): CausalNode[] {
    const nodes = this.nodes(seq);
    const target = nodes.find((node) => node.seq === seq);
    if (!target) throw new Error(`Unknown causal node ${seq}`);
    const needed = new Set(target.dependsOn);
    for (const node of [...nodes].reverse()) {
      if (needed.has(node.seq)) for (const dependency of node.dependsOn) needed.add(dependency);
    }
    return nodes.filter((node) => needed.has(node.seq));
  }

  /** Select an execution branch explicitly, without including sibling candidates
   * or inferring that the most recent repair was committed.
   */
  public view(heads: readonly number[], atSeq = Number.MAX_SAFE_INTEGER): CausalView {
    const nodes = this.nodes(atSeq);
    const known = new Set(nodes.map((node) => node.seq));
    if (heads.some((seq) => !Number.isSafeInteger(seq) || !known.has(seq))) {
      throw new Error('Causal view heads are absent from this causal history');
    }
    const needed = new Set(heads);
    for (const node of [...nodes].reverse()) {
      if (needed.has(node.seq)) for (const dependency of node.dependsOn) needed.add(dependency);
    }
    return { heads: [...new Set(heads)], nodes: nodes.filter((node) => needed.has(node.seq)) };
  }

  /** Seeds are results the host has found changed; independent branches remain unaffected. */
  public planRecomputation(
    changed: readonly number[], atSeq = Number.MAX_SAFE_INTEGER, heads?: readonly number[],
  ): RecomputationPlan {
    const nodes = heads === undefined ? this.nodes(atSeq) : this.view(heads, atSeq).nodes;
    const known = new Set(nodes.map((node) => node.seq));
    if (changed.some((seq) => !known.has(seq))) throw new Error('Changed evidence is absent from this causal history');
    const invalid = new Set(changed);
    const invalidated: CausalNode[] = [];
    const unaffected: CausalNode[] = [];
    for (const node of nodes) {
      if (node.dependsOn.some((seq) => invalid.has(seq))) invalid.add(node.seq);
      (invalid.has(node.seq) ? invalidated : unaffected).push(node);
    }
    return { invalidated, unaffected };
  }

  /** Adapter to existing observation replay. Completeness/closedWorld remains a host assertion. */
  public observationLog(txId: string, atSeq = Number.MAX_SAFE_INTEGER): ObservationEntry[] {
    return this.nodes(atSeq).filter((node) => node.txId === txId).map((node) => node.observation);
  }
}
