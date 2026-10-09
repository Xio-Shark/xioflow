/** Frozen world contract shared by internal adapters and the M1 draft; not a package export. */
import type { ObservationEntry, WorkspaceCommitReceipt } from '../workspace/transactions.js';
import type { ExplainedRecomputationPlan } from '../workspace/causal-graph.js';

export interface WorldRef {
  readonly worldId: string;
  readonly id: string;
  /** Frozen journal cutoff, never implicitly replaced with the latest event. */
  readonly atSeq: number;
}

export interface WorldVersion extends WorldRef {
  readonly snapshotId: string;
  readonly manifestHash: string;
  readonly fingerprint: string;
}

export type { FileCoverage } from './state.js';
import type { FileCoverage } from './state.js';

export type DependencyCoverage =
  | { readonly status: 'complete'; readonly manifestHash: string }
  | { readonly status: 'unknown'; readonly reasons: readonly string[] };

export interface WorldArtifact {
  readonly id: string;
  /** Model responses are saved artifacts; they are never deterministic replay calls. */
  readonly kind: 'model_response' | 'tool_result' | 'file';
  readonly hash: string;
  /** UTF-8 text, hashed with SHA-256. Required evidence for non-file artifacts. */
  readonly body?: string;
  /** null means untracked; [] explicitly declares no causal inputs. */
  readonly dependsOn: readonly number[] | null;
}

export interface AgentExecution {
  readonly coverage: DependencyCoverage;
  readonly heads: readonly number[] | null;
  readonly artifacts: readonly WorldArtifact[];
}

export interface AgentStepContext {
  readonly forkRoot: string;
  readonly version: WorldVersion;
  /** null for initial/full execution; otherwise only invalidated work is regenerated. */
  readonly refresh: {
    readonly previous: WorldCandidate;
    readonly plan: ExplainedRecomputationPlan;
    readonly reusableArtifacts: readonly WorldArtifact[];
  } | null;
  /** Recording precedes exposure to the model; returns a durable causal node seq. */
  record(entry: ObservationEntry, dependsOn: readonly number[] | null): Promise<number>;
}

export interface WorldAgent {
  execute(context: AgentStepContext, input: { task: string }): Promise<AgentExecution>;
}

export interface FileWorldAdapter {
  /** Versioned identity of replay, normalization and acceptance semantics. */
  readonly id: string;
  readonly version: string;
  declareCoverage(root: string): Promise<FileCoverage>;
  replay(entry: ObservationEntry, forkRoot: string): Promise<string | void>;
  /** Receives the actual publication source; must be read-only. */
  accept(publicationRoot: string): Promise<boolean>;
}

export interface WorldCandidate extends WorldRef {
  readonly txId: string;
  readonly version: WorldVersion;
  readonly heads: readonly number[] | null;
  readonly outputFingerprint: string;
  readonly coverage: DependencyCoverage;
}

export type PreparationResult =
  | { readonly status: 'prepared'; readonly candidate: WorldCandidate }
  | { readonly status: 'unknown'; readonly candidate: WorldCandidate; readonly reasons: readonly string[] }
  | { readonly status: 'failed'; readonly ref: WorldRef; readonly reason: string };

export interface CommitIdentity {
  readonly worldId: string;
  readonly candidateId: string;
  readonly txId: string;
  /** Independent of txId; durably bound before the first publication attempt. */
  readonly key: string;
}

export type WorldCommitResult =
  | { readonly status: 'committed'; readonly identity: CommitIdentity;
      readonly receipt: WorkspaceCommitReceipt & { readonly validation: 'observations' } }
  | { readonly status: 'unknown'; readonly identity: CommitIdentity; readonly reason: 'coverage_unknown' }
  | { readonly status: 'conflict'; readonly identity: CommitIdentity; readonly reason: string }
  | { readonly status: 'rejected'; readonly identity: CommitIdentity; readonly reason: 'output_changed' | 'acceptance_rejected' }
  | { readonly status: 'validation_failed'; readonly identity: CommitIdentity; readonly reason: string }
  | { readonly status: 'undetermined'; readonly identity: CommitIdentity; readonly reason: string }
  | { readonly status: 'key_conflict'; readonly identity: CommitIdentity; readonly requestedCandidateId: string; readonly reason: string };

export interface WorldExplanation {
  readonly ref: WorldRef;
  readonly coverage: DependencyCoverage;
  readonly plan: ExplainedRecomputationPlan | null;
  /** File publication and checkpoint binding are separate durable facts. */
  readonly publication: WorldCommitResult | null;
  readonly bindings: readonly { agentId: string; status: 'pending' | 'bound' | 'failed' }[];
  readonly resources: readonly ResourceDisposition[];
}

export interface ResourceDisposition {
  readonly id: string;
  readonly kind: 'fork' | 'snapshot' | 'journal';
  readonly status: 'reclaimed' | 'retained' | 'cleanup_failed';
  readonly reason: string;
  readonly recovery: CommitIdentity | WorldRef;
}

export interface WorldCloseResult {
  readonly status: 'closed';
  readonly resources: readonly ResourceDisposition[];
}

export interface WorldHandle {
  readonly worldId: string;
  runAgentStep(agent: WorldAgent, input: { task: string }): Promise<PreparationResult>;
  refresh(candidate: WorldCandidate, options: { onUnknown: 'reject' | 'recompute' }): Promise<PreparationResult>;
  /** An omitted cutoff captures the current head once and returns it in ref.atSeq. */
  explain(target: WorldRef | { identity: CommitIdentity; atSeq?: number }): Promise<WorldExplanation>;
  commit(candidate: WorldCandidate, options: { validation: 'strict'; key: string }): Promise<WorldCommitResult>;
  close(): Promise<WorldCloseResult>;
}

/** Signature draft, deliberately not a callable export from @xioflow/kernel. */
export type OpenWorld = (options: {
  root: string;
  /** Durable metadata directory outside snapshot coverage; reopening preserves worldId. */
  statePath: string;
  adapter: FileWorldAdapter;
}) => Promise<WorldHandle>;
