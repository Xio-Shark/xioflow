import { describe, expect, it } from 'vitest';
import {
  artifactRefsFromEvidence,
  createExecutionResult,
  createInstructionResult,
  indeterminateInstructionResult,
  replayExecutionResult,
  type ExecutionResult,
  type InstructionResult,
} from '../../src/isa/index.js';

function instruction(status: InstructionResult['status'] = 'succeeded'): InstructionResult {
  return {
    id: 'step', status, atomicity: 'external', observation: { status: status === 'indeterminate' ? 'indeterminate' : 'proven' },
    effects: {}, evidence: ['artifact:step'], artifactRefs: ['artifact:step'], replay: { mode: 'none' }, rollback: { status: 'impossible' },
    ...(status === 'indeterminate' ? { lease: 'lease:step', possibleEffects: ['process may still exist'], nextActions: ['control.status'] } : {}),
  };
}

function seed(): ExecutionResult {
  return createExecutionResult({ isa: 'xio/1', requestId: 'request', programId: 'program', status: 'partial', results: [instruction('partial')], events: { nextCursor: null, omitted: 0 } });
}

describe('ISA result envelope', () => {
  it('requires evidence fields for indeterminate results and preserves artifactRefs', () => {
    expect(() => createInstructionResult({ ...instruction('indeterminate'), lease: undefined })).toThrow('requires lease');
    expect(indeterminateInstructionResult({
      ...instruction('succeeded'), lease: 'lease:step', possibleEffects: ['unknown'], nextActions: ['control.resolve'],
    })).toMatchObject({ status: 'indeterminate', lease: 'lease:step', observation: { status: 'indeterminate' } });
    expect(artifactRefsFromEvidence(['artifact:a', 'workspace:w', 'artifact:a'])).toEqual(['artifact:a']);
  });

  it('replays partial and terminal journal facts without executing anything', () => {
    const replayed = replayExecutionResult(seed(), [
      { sequence: 1, cursor: 'event:1', type: 'instruction.result', result: { ...instruction('succeeded'), id: 'step' } },
      { sequence: 2, cursor: 'event:2', type: 'program.status', status: 'succeeded' },
    ]);
    expect(replayed.status).toBe('succeeded');
    expect(replayed.results[0]?.status).toBe('succeeded');
    expect(replayed.events.nextCursor).toBe('event:2');
  });

  it('rejects duplicate results and out-of-order journal events', () => {
    expect(() => createExecutionResult({ ...seed(), results: [instruction(), instruction()] })).toThrow('duplicate instruction result');
    expect(() => replayExecutionResult(seed(), [
      { sequence: 2, cursor: 'event:2', type: 'program.status', status: 'partial' },
      { sequence: 1, cursor: 'event:1', type: 'program.status', status: 'succeeded' },
    ])).toThrow('strictly increasing');
  });
});
