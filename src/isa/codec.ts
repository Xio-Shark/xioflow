import { Buffer } from 'node:buffer';
import type { ExecutionResult, JsonObject, JsonValue, Program } from './types.js';

export interface JsonCodecOptions {
  /** Sort object keys recursively for stable hashes and golden fixtures. */
  canonical?: boolean;
}

const MAX_CBOR_COLLECTION_LENGTH = 1_000_000;
const MAX_CBOR_DEPTH = 128;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path = 'value', ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} contains a non-JSON value (${typeof value})`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cyclic reference`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertJsonValue(value[index], `${path}[${index}]`, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must contain plain JSON objects`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${path} contains symbol keys`);
    for (const key of Object.keys(value)) assertJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const output: JsonObject = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

export function encodeJson(value: JsonValue, options: JsonCodecOptions = {}): string {
  assertJsonValue(value);
  const encoded = JSON.stringify(options.canonical ? canonicalize(value) : value);
  if (encoded === undefined) throw new TypeError('value could not be encoded as JSON');
  return encoded;
}

export function decodeJson<T extends JsonValue = JsonValue>(encoded: string): T {
  if (typeof encoded !== 'string') throw new TypeError('encoded JSON must be a string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new TypeError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertJsonValue(parsed);
  return parsed as T;
}

function encodeObject(value: unknown, name: string): JsonObject {
  assertJsonValue(value, name);
  if (!isJsonObject(value)) throw new TypeError(`${name} must be a JSON object`);
  return value;
}

export function encodeProgram(program: Program, options?: JsonCodecOptions): string {
  return encodeJson(encodeObject(program, 'program'), options);
}

export function decodeProgram(encoded: string): Program {
  return encodeObject(decodeJson(encoded), 'program') as unknown as Program;
}

export function encodeExecutionResult(result: ExecutionResult, options?: JsonCodecOptions): string {
  return encodeJson(encodeObject(result, 'execution result'), options);
}

export function decodeExecutionResult(encoded: string): ExecutionResult {
  return encodeObject(decodeJson(encoded), 'execution result') as unknown as ExecutionResult;
}

class CborWriter {
  private readonly bytes: number[] = [];

  write(value: JsonValue): void {
    if (value === null) {
      this.bytes.push(0xf6);
    } else if (typeof value === 'boolean') {
      this.bytes.push(value ? 0xf5 : 0xf4);
    } else if (typeof value === 'string') {
      const bytes = Buffer.from(value, 'utf8');
      this.writeHead(3, bytes.length);
      this.bytes.push(...bytes);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('CBOR cannot encode a non-finite number');
      if (Number.isSafeInteger(value)) {
        if (value >= 0) this.writeHead(0, value);
        else this.writeHead(1, -1 - value);
      } else {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, value, false);
        this.bytes.push(0xfb, ...new Uint8Array(buffer));
      }
    } else if (Array.isArray(value)) {
      this.writeHead(4, value.length);
      for (const item of value) this.write(item);
    } else {
      const keys = Object.keys(value).sort();
      this.writeHead(5, keys.length);
      for (const key of keys) {
        this.write(key);
        this.write(value[key]);
      }
    }
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private writeHead(major: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('CBOR length/value must be a nonnegative safe integer');
    const encoded = BigInt(value);
    if (value < 24) {
      this.bytes.push((major << 5) | value);
    } else if (value <= 0xff) {
      this.bytes.push((major << 5) | 24, Number(encoded));
    } else if (value <= 0xffff) {
      this.bytes.push((major << 5) | 25, Number((encoded >> 8n) & 0xffn), Number(encoded & 0xffn));
    } else if (value <= 0xffff_ffff) {
      this.bytes.push(
        (major << 5) | 26,
        Number((encoded >> 24n) & 0xffn),
        Number((encoded >> 16n) & 0xffn),
        Number((encoded >> 8n) & 0xffn),
        Number(encoded & 0xffn),
      );
    } else {
      this.bytes.push((major << 5) | 27);
      for (let shift = 56n; shift >= 0n; shift -= 8n) this.bytes.push(Number((encoded >> shift) & 0xffn));
    }
  }
}

class CborReader {
  private offset = 0;
  private readonly textDecoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly bytes: Uint8Array) {}

  readDocument(): JsonValue {
    const value = this.readValue(0);
    if (this.offset !== this.bytes.length) throw new TypeError('CBOR has trailing bytes');
    return value;
  }

  private readValue(depth: number): JsonValue {
    if (depth > MAX_CBOR_DEPTH) throw new RangeError('CBOR nesting depth exceeds the codec limit');
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (major === 7) return this.readSimple(additional);
    const length = this.readAdditional(additional);
    switch (major) {
      case 0: return length;
      case 1: return -1 - length;
      case 2: throw new TypeError('CBOR byte strings are outside the JSON value subset');
      case 3: return this.readText(length);
      case 4: return this.readArray(length, depth);
      case 5: return this.readMap(length, depth);
      case 6: throw new TypeError('CBOR tags are outside the ISA JSON value subset');
      default: throw new TypeError(`unsupported CBOR major type ${major}`);
    }
  }

  private readSimple(additional: number): JsonValue {
    switch (additional) {
      case 20: return false;
      case 21: return true;
      case 22: return null;
      case 25: return this.readFloat16();
      case 26: return this.readFloat32();
      case 27: return this.readFloat64();
      default: throw new TypeError(`unsupported CBOR simple value 0x${additional.toString(16)}`);
    }
  }

  private readAdditional(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 31) throw new TypeError('indefinite-length CBOR items are not supported');
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (width === 0) throw new TypeError(`unsupported CBOR additional information ${additional}`);
    let value = 0n;
    for (let index = 0; index < width; index++) value = (value << 8n) | BigInt(this.readByte());
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('CBOR integer exceeds JavaScript safe integer range');
    return Number(value);
  }

  private readText(length: number): string {
    this.ensureAvailable(length);
    const value = this.textDecoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  private readArray(length: number, depth: number): JsonValue[] {
    this.checkCollectionLength(length);
    const value: JsonValue[] = [];
    for (let index = 0; index < length; index++) value.push(this.readValue(depth + 1));
    return value;
  }

  private readMap(length: number, depth: number): JsonObject {
    this.checkCollectionLength(length);
    const value: JsonObject = {};
    for (let index = 0; index < length; index++) {
      const key = this.readValue(depth + 1);
      if (typeof key !== 'string') throw new TypeError('CBOR map keys must be strings');
      if (Object.hasOwn(value, key)) throw new TypeError(`CBOR contains duplicate map key ${JSON.stringify(key)}`);
      const entry = this.readValue(depth + 1);
      Object.defineProperty(value, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    return value;
  }

  private readFloat16(): number {
    const bits = (this.readByte() << 8) | this.readByte();
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 0x1f) {
      const value = fraction === 0 ? sign * Infinity : NaN;
      if (!Number.isFinite(value)) throw new TypeError('CBOR non-finite numbers are not JSON values');
    }
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }

  private readFloat32(): number {
    this.ensureAvailable(4);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getFloat32(0, false);
    this.offset += 4;
    if (!Number.isFinite(value)) throw new TypeError('CBOR non-finite numbers are not JSON values');
    return value;
  }

  private readFloat64(): number {
    this.ensureAvailable(8);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(0, false);
    this.offset += 8;
    if (!Number.isFinite(value)) throw new TypeError('CBOR non-finite numbers are not JSON values');
    return value;
  }

  private readByte(): number {
    this.ensureAvailable(1);
    return this.bytes[this.offset++];
  }

  private ensureAvailable(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.length) throw new TypeError('truncated CBOR input');
  }

  private checkCollectionLength(length: number): void {
    if (length > MAX_CBOR_COLLECTION_LENGTH) throw new RangeError('CBOR collection exceeds the codec limit');
  }
}

export function encodeCbor(value: JsonValue): Uint8Array {
  assertJsonValue(value);
  const writer = new CborWriter();
  writer.write(value);
  return writer.finish();
}

export function decodeCbor(encoded: Uint8Array): JsonValue {
  if (!(encoded instanceof Uint8Array)) throw new TypeError('encoded CBOR must be a Uint8Array');
  return new CborReader(encoded).readDocument();
}

export function encodeProgramCbor(program: Program): Uint8Array {
  return encodeCbor(encodeObject(program, 'program'));
}

export function decodeProgramCbor(encoded: Uint8Array): Program {
  return encodeObject(decodeCbor(encoded), 'program') as unknown as Program;
}

export function encodeExecutionResultCbor(result: ExecutionResult): Uint8Array {
  return encodeCbor(encodeObject(result, 'execution result'));
}

export function decodeExecutionResultCbor(encoded: Uint8Array): ExecutionResult {
  return encodeObject(decodeCbor(encoded), 'execution result') as unknown as ExecutionResult;
}
