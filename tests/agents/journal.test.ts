import { describe, expect, it } from 'vitest';
import { projectAgentEvent, readAgentCheckpoint } from '../../src/agents/journal.js';
import type { AgentState } from '../../src/agents/runtime.js';
import type { JournalEvent } from '../../src/types.js';

const state: AgentState = { id: 'a', runId: 'run', parentId: null, input: null, checkpoint: false, workspace: null,
  status: 'paused', maxSteps: 4, stepsUsed: 1, pauseRequested: false, reason: null, error: null };
const { input: _input, checkpoint: _checkpoint, ...metadata } = state;
const event = (seq: number, payload: Record<string, unknown>): JournalEvent => ({
  seq, domainId: 'domain', type: 'AGENT_STATE', payload, timestamp: '2026-10-01T00:00:00Z',
});

describe('agent journal projection', () => {
  it('preserves null inputs and false checkpoints through data-free control events', () => {
    const created = projectAgentEvent(event(1, { version: 2, transition: 'created', state: metadata, input: null, checkpoint: false }),
      undefined, () => { throw new Error('unexpected reference'); });
    const paused = projectAgentEvent(event(2, { version: 2, transition: 'pause_requested', state: metadata }),
      created, () => { throw new Error('unexpected reference'); });
    expect(paused).toEqual(state);
  });

  it('does not substitute an older checkpoint when a data-bearing event is incomplete', () => {
    for (const transition of ['created', 'step_completed']) {
      expect(() => projectAgentEvent(event(2, { version: 2, transition, state: metadata }), state, () => null))
        .toThrow(/data is missing/);
    }
    expect(() => projectAgentEvent(event(2, { version: 2, transition: 'checking', state: metadata }), undefined, () => null))
      .toThrow('no prior state');
  });

  it('resolves backward aliases and fails if their source is missing', () => {
    const events = new Map([
      [1, event(1, { version: 2, transition: 'created', state: metadata, input: null, checkpoint: 0 })],
      [2, event(2, { version: 2, transition: 'restored', state: metadata, checkpointRef: 1 })],
      [3, event(3, { version: 2, transition: 'restored', state: metadata, checkpointRef: 2 })],
    ]);
    const get = (seq: number) => events.get(seq) ?? null;
    expect(readAgentCheckpoint(3, 'a', get)).toBe(0);
    events.delete(1);
    expect(() => readAgentCheckpoint(3, 'a', get)).toThrow('missing');
  });
});
