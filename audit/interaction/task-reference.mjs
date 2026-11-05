// Deterministic reachability client, intentionally aware of task semantics.
// This is not an LLM and is never included in the agent-facing tool contract.
function call(episode, op, args) {
  const response = episode.handle({ op, ...(args === undefined ? {} : { args }) });
  if (response.status !== 'ok') throw new Error(`${op}: ${response.error.code}: ${response.error.message}`);
  return response.result;
}

function selection(spec) {
  if (spec.kind === 'registry') return spec.registryMode === 'pure'
    ? { where: { atomicity: 'pure' }, fields: ['op'] }
    : { where: { op: 'proc.inspect' }, fields: ['op', 'drivers', 'observation'] };
  if (spec.kind === 'set') return { where: { environment: spec.environment, enabled: false }, fields: ['id'] };
  if (spec.kind === 'missing') return { where: { environment: spec.environment }, fields: ['id', 'owner'] };
  const fields = { locate: ['id', 'port', 'owner'], refresh: ['id', 'port', 'enabled'], log: ['id', 'notes'] }[spec.kind];
  return { where: { name: spec.name, environment: spec.environment }, fields };
}

function collect(episode, spec, arm) {
  const { where, fields } = selection(spec);
  if (arm === 'full') {
    const result = call(episode, 'full', { maxBytes: 65536 });
    return { version: result.version, rows: result.records.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)) };
  }
  if (arm === 'jq') {
    const predicate = Object.entries(where).map(([key, value]) => `.[${JSON.stringify(key)}] == ${JSON.stringify(value)}`).join(' and ');
    // Keep whole records for missing-field tasks: jq object construction would
    // otherwise turn an absent property into null and change task semantics.
    const projection = spec.kind === 'missing' ? '.' : `{${fields.join(',')}}`;
    const result = call(episode, 'jq', { program: `.[] | select(${predicate}) | ${projection}`, maxBytes: 65536 });
    return { version: result.version, rows: result.values };
  }
  const rows = [];
  let cursor;
  let version;
  do {
    const result = call(episode, 'query', { where, select: spec.kind === 'log' ? ['id'] : fields, maxBytes: 2048, ...(cursor ? { cursor } : {}) });
    version = result.version;
    for (const row of result.rows) {
      const values = { ...row.values };
      if (spec.kind === 'log') {
        let textCursor;
        values.notes = '';
        do {
          const text = call(episode, 'readText', { ref: row.ref, field: 'notes', version, maxBytes: 2048, ...(textCursor ? { cursor: textCursor } : {}) });
          values.notes += text.text;
          textCursor = text.nextCursor;
        } while (textCursor);
      }
      rows.push(values);
    }
    cursor = result.nextCursor;
  } while (cursor);
  return { version, rows };
}

function answerFor(spec, rows) {
  if (spec.kind === 'registry') return spec.registryMode === 'pure'
    ? { ops: rows.map((row) => row.op), count: rows.length }
    : { op: rows[0].op, drivers: rows[0].drivers, observation: rows[0].observation };
  if (spec.kind === 'set') return { ids: rows.map((row) => row.id), count: rows.length };
  if (spec.kind === 'missing') return {
    missing: rows.filter((row) => !Object.hasOwn(row, 'owner')).map((row) => row.id),
    null: rows.filter((row) => Object.hasOwn(row, 'owner') && row.owner === null).map((row) => row.id),
    empty: rows.filter((row) => row.owner === '').map((row) => row.id),
  };
  if (rows.length !== 1) throw new Error('Reference client did not identify exactly one object');
  const row = rows[0];
  if (spec.kind === 'locate') return { id: row.id, port: row.port, owner: row.owner };
  if (spec.kind === 'refresh') return { id: row.id, enabled: row.enabled, port: row.port };
  const last = row.notes.split('\n').filter((line) => line.startsWith('ERROR ')).at(-1);
  const separator = last.indexOf(' message=');
  return { id: row.id, code: last.slice('ERROR code='.length, separator), message: last.slice(separator + ' message='.length) };
}

export function solveReference(episode, spec, arm, { refresh = true } = {}) {
  call(episode, 'describe');
  let observed = collect(episode, spec, arm);
  if (spec.kind === 'refresh' && refresh) {
    call(episode, 'refresh');
    observed = collect(episode, spec, arm);
  }
  return { version: observed.version, answer: answerFor(spec, observed.rows) };
}
