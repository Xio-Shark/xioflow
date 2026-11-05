import { describe, expect, it } from 'vitest';
import {
  decodeCbor,
  decodeExecutionResult,
  decodeExecutionResultCbor,
  decodeProgram,
  decodeProgramCbor,
  encodeCbor,
  encodeExecutionResult,
  encodeExecutionResultCbor,
  encodeJson,
  encodeProgram,
  encodeProgramCbor,
  type ExecutionResult,
  type Program,
} from '../../src/isa/index.js';

const program: Program = {
  isa: 'xio/1',
  requestId: 'request-1',
  programId: 'program-1',
  mode: 'pipeline',
  capability: 'cap:workspace-read',
  workspace: 'workspace:root',
  instructions: [{
    id: 'read',
    op: 'fs.read',
    args: { workspace: 'workspace:root', path: 'README.md', range: { start: 0, end: 20 } },
    dependsOn: [],
    precondition: [],
    output: 'read-result',
    opId: 'op:read-1',
  }],
  options: { wait: 'until_terminal', maxOutputBytes: 2048, eventCursor: null },
};

const result: ExecutionResult = {
  isa: 'xio/1',
  requestId: 'request-1',
  programId: 'program-1',
  status: 'succeeded',
  committed: false,
  results: [{
    id: 'read',
    opId: 'op:read-1',
    status: 'succeeded',
    atomicity: 'pure',
    observation: { status: 'proven', driver: 'node' },
    effects: {},
    evidence: ['artifact:read-1'],
    artifactRefs: ['artifact:read-1'],
    replay: { mode: 'none' },
    rollback: { status: 'not_applicable' },
    value: { artifact: 'artifact:read-1', sha256: 'a'.repeat(64) },
  }],
  events: { nextCursor: null, omitted: 0 },
};

describe('ISA JSON and CBOR codec', () => {
  it('round-trips Program and ExecutionResult without changing fields', () => {
    expect(decodeProgram(encodeProgram(program))).toEqual(program);
    expect(decodeProgramCbor(encodeProgramCbor(program))).toEqual(program);
    expect(decodeExecutionResult(encodeExecutionResult(result))).toEqual(result);
    expect(decodeExecutionResultCbor(encodeExecutionResultCbor(result))).toEqual(result);
  });

  it('supports canonical JSON and preserves JSON-only values in CBOR', () => {
    expect(encodeJson({ z: 1, a: { z: true, a: null } }, { canonical: true })).toBe('{"a":{"a":null,"z":true},"z":1}');
    expect(decodeCbor(encodeCbor({ text: '中文', integer: -12, decimal: 1.25, values: [true, null] }))).toEqual({
      text: '中文', integer: -12, decimal: 1.25, values: [true, null],
    });
  });

  it('fails closed instead of silently dropping non-JSON values or trailing CBOR', () => {
    expect(() => encodeJson({ missing: undefined } as never)).toThrow('non-JSON');
    expect(() => encodeCbor({ value: Number.NaN } as never)).toThrow('finite');
    expect(() => decodeProgram('[]')).toThrow('must be a JSON object');
    const encoded = encodeProgramCbor(program);
    expect(() => decodeProgramCbor(Uint8Array.from([...encoded, 0]))).toThrow('trailing');
  });
});
