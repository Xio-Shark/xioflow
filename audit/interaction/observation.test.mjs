import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileObservation, wireBytes } from './observation.mjs';
import { makeRecords, withFixture } from './fixtures.mjs';

const errorCode = (code) => (error) => error.code === code;

test('bounded query recovers exactly the oracle selection across page sizes', () => {
  const records = makeRecords(81, 1);
  withFixture(records, ({ file }) => {
    for (const maxBytes of [400, 700, 2048, 65536]) {
      const observation = new FileObservation(file);
      const rows = [];
      let cursor;
      do {
        const reply = observation.query({ where: { group: 'alpha' }, select: ['id', 'enabled'], maxBytes, cursor });
        assert.ok(wireBytes(reply) <= maxBytes);
        assert.equal(reply.offset, rows.length);
        assert.equal(reply.matchedCount, 41);
        assert.equal(reply.complete, reply.nextCursor === null);
        rows.push(...reply.rows);
        cursor = reply.nextCursor;
      } while (cursor);
      assert.deepEqual(rows.map((row) => row.values.id), records.filter((row) => row.group === 'alpha').map((row) => row.id));
      assert.equal(new Set(rows.map((row) => row.ref)).size, rows.length);
    }
  });
});

test('no match is distinguishable from clipping and invalid fields', () => {
  withFixture(makeRecords(2), ({ file }) => {
    const observation = new FileObservation(file);
    const reply = observation.query({ where: { id: 'absent' }, select: ['id'] });
    assert.deepEqual(reply.rows, []);
    assert.equal(reply.matchedCount, 0);
    assert.equal(reply.complete, true);
    assert.throws(() => observation.query({ where: { invented: 1 }, select: ['id'] }), errorCode('invalid_query'));
    assert.throws(() => observation.query({ select: ['notes'], maxBytes: 256 }), errorCode('budget_too_small'));
  });
});

test('pages explicitly distinguish a missing property from JSON null', () => {
  withFixture([{ id: 'a', maybe: null }, { id: 'b' }], ({ file }) => {
    const reply = new FileObservation(file).query({ select: ['id', 'maybe'] });
    assert.deepEqual(reply.rows[0].values, { id: 'a', maybe: null });
    assert.deepEqual(reply.rows[0].missing, []);
    assert.deepEqual(reply.rows[1].values, { id: 'b' });
    assert.deepEqual(reply.rows[1].missing, ['maybe']);
  });
});

test('a cursor cannot change predicate, projection, operation or observation', () => {
  withFixture(makeRecords(20), ({ file }) => {
    const observation = new FileObservation(file);
    const first = observation.query({ select: ['id'], maxBytes: 400 });
    assert.ok(first.nextCursor);
    assert.throws(() => observation.query({ select: ['enabled'], cursor: first.nextCursor }), errorCode('invalid_cursor'));
    assert.throws(() => observation.query({ where: { group: 'alpha' }, select: ['id'], cursor: first.nextCursor }), errorCode('invalid_cursor'));
    assert.throws(() => observation.readText({ version: observation.version, ref: 'r0', field: 'notes', cursor: first.nextCursor }), errorCode('invalid_cursor'));
    assert.throws(() => new FileObservation(file).query({ select: ['id'], cursor: first.nextCursor }), errorCode('invalid_cursor'));
    assert.throws(() => observation.query({ select: ['id'], cursor: 'forged' }), errorCode('invalid_cursor'));
  });
});

test('query order and page budget can change without losing cursor position', () => {
  withFixture(makeRecords(20), ({ file }) => {
    const observation = new FileObservation(file);
    const first = observation.query({ select: ['id', 'enabled'], maxBytes: 400 });
    const next = observation.query({ select: ['enabled', 'id'], maxBytes: 1000, cursor: first.nextCursor });
    assert.equal(next.offset, first.rows.length);
    assert.notEqual(next.rows[0].ref, first.rows[0].ref);
  });
});

test('Unicode text can be reconstructed without losing code points or escapes', () => {
  const notes = ('中文🧪e\u0301\n"\\\t').repeat(100);
  withFixture([{ id: 'unicode', enabled: false, notes }], ({ file }) => {
    const observation = new FileObservation(file);
    let cursor;
    let combined = '';
    do {
      const reply = observation.readText({ version: observation.version, ref: 'r0', field: 'notes', cursor, maxBytes: 400 });
      assert.ok(wireBytes(reply) <= 400);
      assert.equal(reply.offset, [...combined].length);
      assert.equal(reply.totalCodePoints, [...notes].length);
      combined += reply.text;
      cursor = reply.nextCursor;
    } while (cursor);
    assert.equal(combined, notes);
    assert.throws(() => observation.readText({ version: observation.version, ref: 'r0', field: 'enabled' }), errorCode('invalid_field'));
  });
});

test('text expansion stops explicitly at a boundary and supports empty text', () => {
  withFixture([{ id: 'a', notes: '' }], ({ file }) => {
    const observation = new FileObservation(file);
    const reply = observation.readText({ version: observation.version, ref: 'r0', field: 'notes' });
    assert.equal(reply.text, '');
    assert.equal(reply.complete, true);
    assert.equal(reply.nextCursor, null);
  });
});

test('callers cannot mutate the captured snapshot through responses', () => {
  withFixture([{ id: 'a', enabled: false, nested: { value: 1 } }], ({ file }) => {
    const observation = new FileObservation(file);
    observation.full().records[0].nested.value = 9;
    observation.query({ select: ['nested'] }).rows[0].values.nested.value = 8;
    assert.equal(observation.full().records[0].nested.value, 1);
    assert.throws(() => { observation.version = 'invented'; }, TypeError);
  });
});

test('refresh cannot reinterpret an old row reference after row order changes', () => {
  const records = makeRecords(2);
  withFixture(records, ({ file }) => {
    const old = new FileObservation(file);
    const oldRow = old.query({ where: { id: 'service-0000' }, select: ['id'] }).rows[0];
    fs.writeFileSync(file, JSON.stringify([...records].reverse()));
    const fresh = new FileObservation(file, { writable: true });
    assert.throws(() => fresh.readText({ version: old.version, ref: oldRow.ref, field: 'notes' }), errorCode('invalid_version'));
    assert.throws(() => fresh.setEnabled({ version: old.version, ref: oldRow.ref, value: true }), errorCode('invalid_version'));
    assert.throws(() => fresh.readText({ ref: oldRow.ref, field: 'notes' }), errorCode('invalid_version'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [...records].reverse());
  });
});

test('version-bound operation changes only the selected field', () => {
  const records = makeRecords(12);
  withFixture(records, ({ file, root }) => {
    const observation = new FileObservation(file, { writable: true });
    const row = observation.query({ where: { id: 'service-0011' }, select: ['id'] }).rows[0];
    const receipt = observation.setEnabled({ version: observation.version, ref: row.ref, value: true });
    const expected = structuredClone(records);
    expected[11].enabled = true;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
    assert.equal(receipt.status, 'succeeded');
    assert.notEqual(receipt.version, observation.version);
    assert.deepEqual(fs.readdirSync(root), ['records.json']);
    assert.throws(() => observation.setEnabled({ version: observation.version, ref: row.ref, value: true }), errorCode('stale_observation'));
  });
});

test('external edits remain intact when an old observation is used to act', () => {
  const records = makeRecords(3);
  withFixture(records, ({ file }) => {
    const observation = new FileObservation(file, { writable: true });
    records[2].notes = 'external edit';
    fs.writeFileSync(file, JSON.stringify(records));
    assert.equal(observation.query({ where: { id: 'service-0002' }, select: ['notes'] }).rows[0].values.notes.includes('external edit'), false);
    assert.throws(() => observation.setEnabled({ version: observation.version, ref: 'r0', value: true }), errorCode('stale_observation'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), records);
  });
});

test('readonly host, invalid references and invalid budgets refuse explicitly', () => {
  withFixture(makeRecords(1), ({ file }) => {
    const observation = new FileObservation(file);
    assert.throws(() => observation.setEnabled({ version: observation.version, ref: 'r0', value: true }), errorCode('read_only'));
    for (const ref of ['r-1', 'r01', 'r1', '../file']) {
      assert.throws(() => observation.readText({ version: observation.version, ref, field: 'notes' }), errorCode('invalid_ref'));
    }
    for (const maxBytes of [0, -1, Infinity, NaN, 1.5, 65537]) {
      assert.throws(() => observation.query({ select: ['id'], maxBytes }), errorCode('invalid_budget'));
    }
  });
});

test('invalid JSON, invalid UTF-8 and symlink sources are not silently accepted', () => {
  withFixture([], ({ file, root }) => {
    fs.writeFileSync(file, '{bad');
    assert.throws(() => new FileObservation(file), errorCode('invalid_source'));
    fs.writeFileSync(file, Buffer.from([0xff]));
    assert.throws(() => new FileObservation(file), errorCode('invalid_source'));
    fs.writeFileSync(file, '[]');
    const link = path.join(root, 'link.json');
    fs.symlinkSync(file, link);
    assert.throws(() => new FileObservation(link), errorCode('ELOOP'));
  });
});

test('nested real-document collections preserve whole-file version and remain readonly', () => {
  withFixture([], ({ file }) => {
    const document = { metadata: { untouched: true }, opcodes: [{ op: 'fs.read', enabled: false }] };
    fs.writeFileSync(file, JSON.stringify(document));
    const observation = new FileObservation(file, { recordsKey: 'opcodes' });
    assert.equal(observation.describe().recordsKey, 'opcodes');
    assert.equal(observation.query({ select: ['op'] }).rows[0].values.op, 'fs.read');
    assert.throws(() => new FileObservation(file, { recordsKey: 'absent' }), errorCode('invalid_collection'));
    assert.throws(() => new FileObservation(file, { recordsKey: 'opcodes', writable: true }), errorCode('unsupported_mode'));
    document.metadata.untouched = false;
    fs.writeFileSync(file, JSON.stringify(document));
    assert.notEqual(new FileObservation(file, { recordsKey: 'opcodes' }).version, observation.version);
  });
});

test('JSONL host reports malformed requests and denies writes without hiding subsequent results', () => {
  withFixture(makeRecords(2), ({ file }) => {
    const before = fs.readFileSync(file);
    const input = [
      '{bad',
      JSON.stringify({ id: 1, op: 'describe' }),
      JSON.stringify({ id: 2, op: 'query', args: { where: { id: 'service-0001' }, select: ['id'] } }),
      JSON.stringify({ id: 3, op: 'setEnabled', args: { ref: 'r0', value: true } }),
      JSON.stringify({ id: 4, op: 'query', args: null }),
      JSON.stringify({ id: 5, op: 'readText' }),
      JSON.stringify({ id: 6, op: 'describe' }),
    ].join('\n') + '\n';
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./session.mjs', import.meta.url)), file], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(replies[0].error.code, 'invalid_json');
    assert.equal(replies[1].result.records, 2);
    assert.equal(replies[2].result.rows[0].values.id, 'service-0001');
    assert.equal(replies[3].error.code, 'unsupported_operation');
    assert.equal(replies[4].error.code, 'invalid_args');
    assert.equal(replies[5].error.code, 'invalid_args');
    assert.equal(replies[6].status, 'ok');
    assert.deepEqual(fs.readFileSync(file), before);
  });
});
