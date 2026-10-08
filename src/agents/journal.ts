import type { JournalEvent } from '../types.js';
import type { AgentData, AgentState } from './runtime.js';

export const isAgentCheckpoint = (transition: unknown): boolean =>
  transition === 'created' || transition === 'step_completed' || transition === 'restored' || transition === 'causal_repaired';

/** v1 stored complete states; v2 stores data once and projects control-only events. */
export function projectAgentEvent(
  event: JournalEvent,
  previous: AgentState | undefined,
  readCheckpoint: (seq: number, agentId: string) => AgentData
): AgentState {
  const { payload } = event;
  if (payload.version === 1) return payload.state as AgentState;
  if (payload.version !== 2) throw new Error('Unsupported agent journal version');
  const state = payload.state as Omit<AgentState, 'input' | 'checkpoint'>;
  const hasInput = Object.hasOwn(payload, 'input');
  const hasCheckpoint = Object.hasOwn(payload, 'checkpoint');
  if (payload.transition === 'created' && (!hasInput || !hasCheckpoint)) throw new Error('Agent creation data is missing');
  if (['step_completed', 'causal_repaired'].includes(String(payload.transition)) && !hasCheckpoint) throw new Error('Agent checkpoint data is missing');
  if (!hasInput && !previous) throw new Error('Agent control event has no prior state');
  let checkpoint: AgentData;
  if (payload.transition === 'restored') {
    const ref = payload.checkpointRef;
    if (!Number.isSafeInteger(ref) || (ref as number) < 1 || (ref as number) >= event.seq) throw new Error('Invalid agent checkpoint reference');
    checkpoint = readCheckpoint(ref as number, state.id);
  } else if (hasCheckpoint) {
    checkpoint = payload.checkpoint as AgentData;
  } else {
    if (!previous) throw new Error('Agent checkpoint data is missing');
    checkpoint = previous.checkpoint;
  }
  return { ...state, input: hasInput ? payload.input as AgentData : previous!.input, checkpoint };
}

export function readAgentCheckpoint(
  seq: number,
  agentId: string,
  getEvent: (seq: number) => JournalEvent | null
): AgentData {
  for (;;) {
    const event = getEvent(seq);
    if (!event || event.type !== 'AGENT_STATE' || (event.payload.state as { id: string }).id !== agentId) {
      throw new Error(`Agent checkpoint ${seq} is missing or belongs to another agent`);
    }
    if (event.payload.version === 1) return (event.payload.state as AgentState).checkpoint;
    if (event.payload.version !== 2) throw new Error('Unsupported agent journal version');
    if (Object.hasOwn(event.payload, 'checkpoint')) return event.payload.checkpoint as AgentData;
    const ref = event.payload.checkpointRef;
    if (!Number.isSafeInteger(ref) || (ref as number) < 1 || (ref as number) >= seq) throw new Error('Invalid agent checkpoint reference');
    seq = ref as number;
  }
}
