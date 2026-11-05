import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const wireBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export class ObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ObservationError';
    this.code = code;
  }
}

function requireCondition(ok, code, message) {
  if (!ok) throw new ObservationError(code, message);
}

function readRegularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireCondition(stat.isFile(), 'unsupported_source', 'Only regular files are supported');
    requireCondition(stat.size <= MAX_SOURCE_BYTES, 'source_too_large', 'Source exceeds 16 MiB');
    const data = fs.readFileSync(fd);
    requireCondition(data.length <= MAX_SOURCE_BYTES, 'source_too_large', 'Source grew beyond 16 MiB');
    return { data, mode: stat.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

function budget(value) {
  requireCondition(Number.isSafeInteger(value) && value >= 256 && value <= 65536,
    'invalid_budget', 'maxBytes must be an integer from 256 through 65536');
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Research adapter over a real file; intentionally independent of the kernel. */
export class FileObservation {
  #file;
  #data;
  #records;
  #fields;
  #cursors = new Map();
  #writable;
  #mode;
  #recordsKey;

  constructor(file, { writable = false, recordsKey } = {}) {
    this.#file = path.resolve(file);
    const { data, mode } = readRegularFile(this.#file);
    let records;
    try {
      records = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch (error) {
      throw new ObservationError('invalid_source', `Expected UTF-8 JSON: ${error.message}`);
    }
    if (recordsKey !== undefined) {
      requireCondition(typeof recordsKey === 'string' && records !== null && typeof records === 'object' && Object.hasOwn(records, recordsKey),
        'invalid_collection', 'Expected an existing top-level recordsKey');
      requireCondition(!writable, 'unsupported_mode', 'Nested collections are read-only in this experiment');
      records = records[recordsKey];
      this.#recordsKey = recordsKey;
    }
    requireCondition(Array.isArray(records) && records.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row)),
      'invalid_source', 'Expected a JSON array of objects');
    this.#data = data;
    this.#mode = mode;
    this.#records = records;
    this.#fields = [...new Set(records.flatMap(Object.keys))].sort();
    this.#writable = writable;
    Object.defineProperty(this, 'version', { value: digest(data), enumerable: true });
  }

  describe() {
    return { version: this.version, bytes: this.#data.length, records: this.#records.length,
      fields: [...this.#fields], freshness: 'snapshot_only',
      ...(this.#recordsKey === undefined ? {} : { recordsKey: this.#recordsKey }) };
  }

  full() {
    return { version: this.version, records: clone(this.#records) };
  }

  /** Feed the exact captured bytes to the external jq baseline. */
  sourceText() {
    return this.#data.toString('utf8');
  }

  #cursor(binding, offset) {
    const cursor = randomUUID();
    this.#cursors.set(cursor, { binding, offset });
    return cursor;
  }

  #offset(cursor, binding) {
    if (cursor === undefined || cursor === null) return 0;
    const entry = this.#cursors.get(cursor);
    requireCondition(entry && entry.binding === binding, 'invalid_cursor', 'Cursor belongs to a different observation or query');
    return entry.offset;
  }

  #index(ref, version) {
    requireCondition(version === this.version, 'invalid_version', 'Pass the version that produced this row reference');
    requireCondition(typeof ref === 'string' && /^r(0|[1-9][0-9]*)$/.test(ref), 'invalid_ref', 'Expected a row reference');
    const index = Number(ref.slice(1));
    requireCondition(Number.isSafeInteger(index) && index < this.#records.length, 'invalid_ref', 'Row reference is out of range');
    return index;
  }

  query({ where = {}, select, maxBytes = 2048, cursor } = {}) {
    budget(maxBytes);
    requireCondition(where !== null && typeof where === 'object' && !Array.isArray(where), 'invalid_query', 'where must be an object');
    requireCondition(Array.isArray(select) && select.length > 0 && select.every((key) => typeof key === 'string' && this.#fields.includes(key)),
      'invalid_query', 'select must contain known fields');
    const entries = Object.entries(where).sort(([a], [b]) => a.localeCompare(b));
    requireCondition(entries.every(([key, value]) => this.#fields.includes(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))),
      'invalid_query', 'where must contain known fields and scalar equality values');
    const fields = [...new Set(select)].sort();
    const binding = JSON.stringify(['query', entries, fields]);
    const offset = this.#offset(cursor, binding);
    const matches = this.#records.flatMap((row, index) => entries.every(([key, value]) => Object.hasOwn(row, key) && row[key] === value) ? [index] : []);
    const result = { version: this.version, scope: 'snapshot', totalRecords: this.#records.length,
      matchedCount: matches.length, offset, rows: [], complete: false, nextCursor: '0'.repeat(36) };
    let end = offset;
    let rowsBytes = 0;
    while (end < matches.length) {
      const index = matches[end];
      const row = this.#records[index];
      const present = fields.filter((key) => Object.hasOwn(row, key));
      const projected = { ref: `r${index}`, values: Object.fromEntries(present.map((key) => [key, clone(row[key])])), missing: fields.filter((key) => !Object.hasOwn(row, key)) };
      const projectedBytes = wireBytes(projected);
      const last = end + 1 === matches.length;
      // Account for array commas without reserializing all previous rows.
      const metadataBytes = wireBytes({ ...result, rows: [], complete: last, nextCursor: last ? null : '0'.repeat(36) });
      if (metadataBytes + rowsBytes + projectedBytes + result.rows.length > maxBytes) {
        requireCondition(end > offset, 'budget_too_small', 'A complete row does not fit; reduce projection or increase maxBytes');
        break;
      }
      result.rows.push(projected);
      rowsBytes += projectedBytes;
      end += 1;
    }
    result.complete = end === matches.length;
    result.nextCursor = result.complete ? null : this.#cursor(binding, end);
    requireCondition(wireBytes(result) <= maxBytes, 'budget_too_small', 'Response metadata does not fit');
    return result;
  }

  readText({ ref, field, version, maxBytes = 2048, cursor }) {
    budget(maxBytes);
    const index = this.#index(ref, version);
    const value = this.#records[index][field];
    requireCondition(Object.hasOwn(this.#records[index], field) && typeof value === 'string', 'invalid_field', 'Expected a text field on the referenced row');
    const binding = JSON.stringify(['text', ref, field]);
    const offset = this.#offset(cursor, binding);
    const points = [...value];
    const page = (end) => ({ version: this.version, ref, field, offset, totalCodePoints: points.length,
      text: points.slice(offset, end).join(''), complete: end === points.length,
      nextCursor: end === points.length ? null : '0'.repeat(36) });
    // The final page loses its cursor, so check it before monotone prefix search.
    const terminal = page(points.length);
    if (wireBytes(terminal) <= maxBytes) return terminal;
    let low = offset;
    let high = points.length - 1;
    let end = offset;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (wireBytes(page(middle)) <= maxBytes) {
        end = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    requireCondition(end > offset, 'budget_too_small', 'A complete character and metadata do not fit');
    const result = page(end);
    result.nextCursor = this.#cursor(binding, end);
    requireCondition(wireBytes(result) <= maxBytes, 'budget_too_small', 'Response metadata does not fit');
    return result;
  }

  /** Single-writer fixture operation; not an atomic multi-writer CAS. */
  setEnabled({ ref, value, version }) {
    requireCondition(this.#writable, 'read_only', 'This observation does not permit writes');
    const index = this.#index(ref, version);
    requireCondition(typeof value === 'boolean' && typeof this.#records[index].enabled === 'boolean', 'invalid_update', 'Only an existing boolean enabled field can be changed');
    requireCondition(digest(readRegularFile(this.#file).data) === this.version, 'stale_observation', 'File changed since observation; inspect a new snapshot before acting');
    const updated = clone(this.#records);
    updated[index].enabled = value;
    const bytes = Buffer.from(`${JSON.stringify(updated)}\n`);
    const temporary = path.join(path.dirname(this.#file), `.${path.basename(this.#file)}.${randomUUID()}.tmp`);
    let created = false;
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: this.#mode });
      created = true;
      requireCondition(digest(readRegularFile(this.#file).data) === this.version, 'stale_observation', 'File changed while preparing the update');
      fs.renameSync(temporary, this.#file);
      created = false;
    } finally {
      if (created) fs.unlinkSync(temporary);
    }
    return { status: 'succeeded', ref, field: 'enabled', value, previousVersion: this.version, version: digest(bytes) };
  }
}
