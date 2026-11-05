import type { JsonObject, JsonValue } from '../isa/types.js';

export type EventSensitivity = 'public' | 'internal' | 'sensitive' | 'secret';

export interface EventEnvelopeInput {
  schemaVersion?: string;
  domainId: string;
  requestId?: string;
  programId?: string;
  instructionId?: string;
  opId?: string;
  event: string;
  payload?: Record<string, unknown>;
  sensitivity?: EventSensitivity;
  createdAt?: string;
}

export interface EventEnvelope {
  seq?: number;
  schemaVersion: string;
  domainId: string;
  requestId?: string;
  programId?: string;
  instructionId?: string;
  opId?: string;
  event: string;
  payload: JsonObject;
  sensitivity: EventSensitivity;
  createdAt: string;
}

const SECRET_KEY = /(prompt|secret|token|password|authorization|credential|api[_-]?key|environment|(?:^|[_-])env(?:$|[_-])|content|body|stdin|stdout|stderr)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'number') throw new TypeError(`${path} contains a non-finite number`);
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  if (!isRecord(value)) throw new TypeError(`${path} contains a non-JSON value`);
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (item === undefined) continue;
    output[key] = jsonValue(item, `${path}.${key}`);
  }
  return output;
}

export function redactEventPayload(payload: Record<string, unknown> | undefined, sensitivity: EventSensitivity): JsonObject {
  if (sensitivity === 'secret') return { redacted: true };
  const value = jsonValue(payload ?? {}, 'payload');
  if (!isRecord(value)) throw new TypeError('event payload must be an object');
  return value;
}

export function createEventEnvelope(input: EventEnvelopeInput): EventEnvelope {
  if (!input.domainId || !input.event) throw new TypeError('event envelope requires domainId and event');
  const schemaVersion = input.schemaVersion ?? 'xio/event/1.0';
  const sensitivity = input.sensitivity ?? 'internal';
  if (!/^[A-Za-z][A-Za-z0-9._/-]{0,63}$/.test(schemaVersion)) throw new TypeError('invalid event schemaVersion');
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input.event)) throw new TypeError('invalid event name');
  return {
    schemaVersion,
    domainId: input.domainId,
    requestId: input.requestId,
    programId: input.programId,
    instructionId: input.instructionId,
    opId: input.opId,
    event: input.event,
    payload: redactEventPayload(input.payload, sensitivity),
    sensitivity,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
