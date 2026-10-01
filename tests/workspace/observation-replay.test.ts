import { describe, expect, it, vi } from 'vitest';
import { replayObservationLog } from '../../src/workspace/observation-replay.js';
import type { ObservationEntry } from '../../src/workspace/transactions.js';

const observe = (hash: string): ObservationEntry => ({
  kind: 'observe', call: { tool: 'read', args: {} }, resultHash: hash,
});
const mutate: ObservationEntry = { kind: 'mutate', call: { tool: 'edit', args: {} } };

describe('observation replay boundary', () => {
  it('matches an empty trace without executing anything', async () => {
    const replay = vi.fn();
    expect(await replayObservationLog({ log: [], replay }, '/fork')).toEqual({ status: 'matched', matchedSteps: 0 });
    expect(replay).not.toHaveBeenCalled();
  });

  it('replays mutations in order so later reads see their effects', async () => {
    let content = 'before';
    const roots: string[] = [];
    const result = await replayObservationLog({
      log: [observe('before'), mutate, observe('after')],
      replay: async (entry, root) => {
        roots.push(root);
        if (entry.kind === 'mutate') content = 'after';
        else return content;
      },
    }, '/fork');
    expect(result).toEqual({ status: 'matched', matchedSteps: 3 });
    expect(roots).toEqual(['/fork', '/fork', '/fork']);
  });

  it('stops at the first changed observation without replaying its dependent mutation', async () => {
    const replay = vi.fn(async () => 'current');
    const result = await replayObservationLog({ log: [observe('current'), observe('old'), mutate], replay }, '/fork');
    expect(result).toEqual({ status: 'diverged', matchedSteps: 1, divergedAt: 1, reason: 'observation_changed' });
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it.each(['observe', 'mutate'] as const)('stops when a %s callback throws', async (kind) => {
    const replay = vi.fn(async () => { throw new Error('not applicable'); });
    const result = await replayObservationLog({ log: [{ ...mutate, kind }, mutate], replay }, '/fork');
    expect(result).toEqual({
      status: 'diverged', matchedSteps: 0, divergedAt: 0,
      reason: kind === 'observe' ? 'observation_changed' : 'mutation_not_applicable',
      error: 'not applicable',
    });
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('does not include a mutation with a changed return value in the reusable prefix', async () => {
    let mutated = false;
    const replay = vi.fn(async () => { mutated = true; return 'new references'; });
    const result = await replayObservationLog({
      log: [{ ...mutate, resultHash: 'old references' }, observe('later')], replay,
    }, '/fork');
    expect(result).toEqual({ status: 'diverged', matchedSteps: 0, divergedAt: 0, reason: 'observation_changed' });
    expect(mutated).toBe(true); // This fork cannot be handed to a resumed agent as a clean prefix.
    expect(replay).toHaveBeenCalledTimes(1);
  });
});
