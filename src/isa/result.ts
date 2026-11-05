import type {
  ArtifactRef,
  EventCursor,
  ExecutionResult,
  InstructionResult,
  InstructionStatus,
  JsonObject,
  ProgramStatus,
} from './types.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const ARTIFACT_PATTERN = /^artifact:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const EVENT_CURSOR_PATTERN = /^event:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

export interface ResultEnvelopeInput {
  isa: ExecutionResult['isa'];
  requestId: string;
  programId?: string;
  status: ProgramStatus;
  committed?: boolean;
  results: readonly InstructionResult[];
  events?: { nextCursor: EventCursor | null; omitted: number };
}

export interface ResultJournalEvent {
  sequence: number;
  cursor: EventCursor;
  type: 'instruction.result' | 'program.status';
  instructionId?: string;
  result?: InstructionResult;
  status?: ProgramStatus;
  payload?: JsonObject;
}

export function createInstructionResult(input: InstructionResult): InstructionResult {
  if (!ID_PATTERN.test(input.id)) throw new TypeError(`invalid instruction result id '${input.id}'`);
  if (!Array.isArray(input.evidence) || !Array.isArray(input.artifactRefs)) throw new TypeError(`instruction '${input.id}' must include evidence and artifactRefs arrays`);
  for (const artifact of input.artifactRefs) if (!ARTIFACT_PATTERN.test(artifact)) throw new TypeError(`instruction '${input.id}' contains an invalid artifactRef`);
  if (new Set(input.artifactRefs).size !== input.artifactRefs.length) throw new TypeError(`instruction '${input.id}' contains duplicate artifactRefs`);
  if (input.status === 'indeterminate') {
    if (!input.lease || input.possibleEffects === undefined || input.nextActions === undefined) {
      throw new TypeError(`indeterminate instruction '${input.id}' requires lease, possibleEffects and nextActions`);
    }
    if (input.observation.status !== 'indeterminate') throw new TypeError(`indeterminate instruction '${input.id}' requires indeterminate observation`);
  }
  return input;
}

export function createExecutionResult(input: ResultEnvelopeInput): ExecutionResult {
  if (!ID_PATTERN.test(input.requestId)) throw new TypeError('invalid requestId');
  if (input.programId !== undefined && !ID_PATTERN.test(input.programId)) throw new TypeError('invalid programId');
  if (input.results.length > 256) throw new RangeError('execution result contains too many instruction results');
  const ids = new Set<string>();
  const results = input.results.map((result) => {
    const checked = createInstructionResult(result);
    if (ids.has(checked.id)) throw new TypeError(`duplicate instruction result '${checked.id}'`);
    ids.add(checked.id);
    return checked;
  });
  const events = input.events ?? { nextCursor: null, omitted: 0 };
  if (events.nextCursor !== null && !EVENT_CURSOR_PATTERN.test(events.nextCursor)) throw new TypeError('invalid event cursor');
  if (!Number.isSafeInteger(events.omitted) || events.omitted < 0) throw new TypeError('invalid omitted event count');
  return { ...input, results, events };
}

function cloneResult(result: ExecutionResult): ExecutionResult {
  return {
    ...result,
    results: result.results.map((item) => ({
      ...item,
      evidence: [...item.evidence],
      artifactRefs: [...item.artifactRefs],
      effects: {
        ...item.effects,
        changedPaths: item.effects.changedPaths ? [...item.effects.changedPaths] : undefined,
        createdRefs: item.effects.createdRefs ? [...item.effects.createdRefs] : undefined,
        possibleEffects: item.effects.possibleEffects ? [...item.effects.possibleEffects] : undefined,
      },
      rollback: {
        ...item.rollback,
        residual: item.rollback.residual ? [...item.rollback.residual] : undefined,
      },
      nextActions: item.nextActions ? [...item.nextActions] : undefined,
    })),
    events: { ...result.events },
  };
}

/** Replay only journal facts; it never re-executes an opcode or invents a final state. */
export function replayExecutionResult(seed: ExecutionResult, events: readonly ResultJournalEvent[]): ExecutionResult {
  const replayed = cloneResult(seed);
  let lastSequence = -1;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) throw new TypeError('journal events must have strictly increasing sequence numbers');
    if (!EVENT_CURSOR_PATTERN.test(event.cursor)) throw new TypeError(`invalid journal cursor '${event.cursor}'`);
    lastSequence = event.sequence;
    if (event.type === 'program.status') {
      if (!event.status) throw new TypeError('program.status event is missing status');
      replayed.status = event.status;
    } else {
      if (!event.result) throw new TypeError('instruction.result event is missing result');
      const result = createInstructionResult(event.result);
      const index = replayed.results.findIndex((item) => item.id === (event.instructionId ?? result.id));
      if (index < 0) replayed.results.push(result);
      else replayed.results[index] = result;
    }
    replayed.events.nextCursor = event.cursor;
  }
  return createExecutionResult(replayed);
}

export function indeterminateInstructionResult(
  input: Omit<InstructionResult, 'status' | 'observation' | 'lease' | 'possibleEffects' | 'nextActions'> & {
    lease: NonNullable<InstructionResult['lease']>;
    possibleEffects: string[];
    nextActions: string[];
  },
): InstructionResult {
  return createInstructionResult({
    ...input,
    status: 'indeterminate' as InstructionStatus,
    observation: { status: 'indeterminate', reason: 'execution outcome is not yet proven' },
  });
}

export function artifactRefsFromEvidence(evidence: readonly string[]): ArtifactRef[] {
  return [...new Set(evidence.filter((value): value is ArtifactRef => ARTIFACT_PATTERN.test(value)))];
}
