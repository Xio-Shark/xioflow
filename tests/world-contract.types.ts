// Compile-only acceptance for the M1 draft; does not claim runtime coverage.
import type { OpenWorld, WorldAgent, WorldCommitResult } from '../spec/world-contract.js';

export async function contractExample(openWorld: OpenWorld, agent: WorldAgent,
  options: Parameters<OpenWorld>[0]) {
  const world = await openWorld(options);
  try {
    const step = await world.runAgentStep(agent, { task: 'Generate quotes' });
    if (step.status === 'failed') return await world.explain(step.ref);
    const refreshed = await world.refresh(step.candidate, { onUnknown: 'recompute' });
    if (refreshed.status === 'failed') return await world.explain(refreshed.ref);
    const result = await world.commit(refreshed.candidate, { validation: 'strict', key: refreshed.candidate.id });
    if (result.status === 'committed') return result.receipt.commitSeq;
    return result.status;
  } finally {
    await world.close();
  }
}

export function requireExplicitOutcome(result: WorldCommitResult): string {
  switch (result.status) {
    case 'committed': return String(result.receipt.commitSeq);
    case 'unknown':
    case 'conflict':
    case 'rejected':
    case 'validation_failed':
    case 'undetermined':
    case 'key_conflict': return result.reason;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}

export function rejectUnsafeAssumptions(result: WorldCommitResult) {
  // @ts-expect-error A nonterminal outcome has no success receipt.
  const receipt = result.receipt;
  // @ts-expect-error Unknown evidence is not a committed result.
  const committed: Extract<WorldCommitResult, { status: 'committed' }> = result;
  return { receipt, committed };
}

export function requireStrictPublication(result: Extract<WorldCommitResult, { status: 'committed' }>) {
  const validation: 'observations' = result.receipt.validation;
  return validation;
}
