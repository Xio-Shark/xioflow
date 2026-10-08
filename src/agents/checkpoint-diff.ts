import { isDeepStrictEqual } from 'node:util';
import type { CausalNode, CausalView } from '../workspace/causal-graph.js';
import type { AgentCheckpoint, AgentData, AgentRuntime } from './runtime.js';

export interface AgentCheckpointRef {
  agentId: string;
  checkpointSeq: number;
}

export type AgentContextChange =
  | { kind: 'added'; path: string; after: AgentData }
  | { kind: 'removed'; path: string; before: AgentData }
  | { kind: 'changed'; path: string; before: AgentData; after: AgentData };

export interface AgentCheckpointComparison {
  left: AgentCheckpointRef & { saved: AgentCheckpoint };
  right: AgentCheckpointRef & { saved: AgentCheckpoint };
  /** JSON Pointer paths. Arrays are compared as whole values, not edit scripts. */
  context: AgentContextChange[];
  evidence:
    | { status: 'untracked'; left: CausalView | null; right: CausalView | null }
    | {
      status: 'compared';
      leftHeads: number[];
      rightHeads: number[];
      shared: CausalNode[];
      leftOnly: CausalNode[];
      rightOnly: CausalNode[];
      /** Exclusive nodes with no exclusive parent: structural divergence boundaries. */
      leftRoots: number[];
      rightRoots: number[];
    };
}

/** Compare recorded context and provenance, without reading or restoring live files.
 * Node identity is the journal sequence, never tool/result hash equality.
 * Recorded writes are provenance declarations, not a historical filesystem diff.
 */
export function compareAgentCheckpoints(
  agents: AgentRuntime, left: AgentCheckpointRef, right: AgentCheckpointRef,
): AgentCheckpointComparison {
  const read = (ref: AgentCheckpointRef) => {
    const saved = agents.checkpoints(ref.agentId).find((entry) => entry.seq === ref.checkpointSeq);
    if (!saved) throw new Error(`No checkpoint ${ref.checkpointSeq} for agent "${ref.agentId}"`);
    return saved;
  };
  const leftSaved = read(left);
  const rightSaved = read(right);
  const leftView = agents.checkpointCausalView(left.agentId, left.checkpointSeq) ?? null;
  const rightView = agents.checkpointCausalView(right.agentId, right.checkpointSeq) ?? null;
  let evidence: AgentCheckpointComparison['evidence'];
  if (!leftView || !rightView) {
    evidence = { status: 'untracked', left: leftView, right: rightView };
  } else {
    const leftIds = new Set(leftView.nodes.map((node) => node.seq));
    const rightIds = new Set(rightView.nodes.map((node) => node.seq));
    const leftOnly = leftView.nodes.filter((node) => !rightIds.has(node.seq));
    const rightOnly = rightView.nodes.filter((node) => !leftIds.has(node.seq));
    const roots = (nodes: CausalNode[]) => {
      const ids = new Set(nodes.map((node) => node.seq));
      return nodes.filter((node) => !node.dependsOn.some((seq) => ids.has(seq))).map((node) => node.seq);
    };
    evidence = { status: 'compared', leftHeads: leftView.heads, rightHeads: rightView.heads,
      shared: leftView.nodes.filter((node) => rightIds.has(node.seq)), leftOnly, rightOnly,
      leftRoots: roots(leftOnly), rightRoots: roots(rightOnly) };
  }
  // All returned values are detached, including caller-owned references and journal payloads.
  return structuredClone({ left: { ...left, saved: leftSaved }, right: { ...right, saved: rightSaved },
    context: contextDiff(leftSaved.checkpoint, rightSaved.checkpoint), evidence });
}

function contextDiff(before: AgentData, after: AgentData, path = ''): AgentContextChange[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    const changes: AgentContextChange[] = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const child = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!Object.hasOwn(before, key)) changes.push({ kind: 'added', path: child, after: after[key] });
      else if (!Object.hasOwn(after, key)) changes.push({ kind: 'removed', path: child, before: before[key] });
      else changes.push(...contextDiff(before[key], after[key], child));
    }
    return changes;
  }
  return [{ kind: 'changed', path, before, after }];
}
