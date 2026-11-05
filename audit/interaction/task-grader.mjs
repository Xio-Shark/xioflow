import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

function expectedAnswer(spec, document) {
  const records = spec.kind === 'registry' ? document.opcodes : document;
  if (spec.kind === 'registry') {
    if (spec.registryMode === 'pure') {
      const ops = records.filter((row) => row.atomicity === 'pure').map((row) => row.op);
      return { ops, count: ops.length };
    }
    const row = records.find((entry) => entry.op === 'proc.inspect');
    return { op: row.op, drivers: row.drivers, observation: row.observation };
  }
  if (spec.kind === 'set') {
    const ids = records.filter((row) => row.environment === spec.environment && row.enabled === false).map((row) => row.id);
    return { ids, count: ids.length };
  }
  if (spec.kind === 'missing') {
    const result = { missing: [], null: [], empty: [] };
    for (const row of records) {
      if (row.environment !== spec.environment) continue;
      if (!Object.hasOwn(row, 'owner')) result.missing.push(row.id);
      else if (row.owner === null) result.null.push(row.id);
      else if (row.owner === '') result.empty.push(row.id);
    }
    return result;
  }
  const targets = records.filter((row) => row.name === spec.name && row.environment === spec.environment);
  if (targets.length !== 1) throw new Error('Invalid task data: expected a unique target');
  const target = targets[0];
  if (spec.kind === 'locate') return { id: target.id, port: target.port, owner: target.owner };
  if (spec.kind === 'refresh') return { id: target.id, enabled: target.enabled, port: target.port };
  if (spec.kind === 'log') {
    let failure;
    for (const line of target.notes.split('\n')) {
      if (!line.startsWith('ERROR ')) continue;
      const match = /^ERROR code=(\S+) message=(.*)$/.exec(line);
      if (!match) throw new Error('Invalid task data: malformed ERROR line');
      failure = { id: target.id, code: match[1], message: match[2] };
    }
    if (!failure) throw new Error('Invalid task data: no ERROR line');
    return failure;
  }
  throw new Error(`Unknown task kind: ${spec.kind}`);
}

function canonical(value) {
  // All arrays in this answer contract are sets of strings. Sorting preserves
  // duplicates, so duplicated evidence cannot pass as a complete unique set.
  if (Array.isArray(value)) return value.every((item) => typeof item === 'string') ? [...value].sort() : value;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** No query adapter, jq process or reference-client functions are used here. */
export function gradeSubmission(task, submission, observedVersions) {
  const bytes = fs.readFileSync(task.file);
  const currentVersion = createHash('sha256').update(bytes).digest('hex');
  const expected = expectedAnswer(task.spec, JSON.parse(bytes));
  const shape = submission !== null && typeof submission === 'object' && !Array.isArray(submission) &&
    Object.keys(submission).sort().join(',') === 'answer,version' && typeof submission.version === 'string';
  const checks = {
    submissionShape: shape,
    currentSourceVersion: shape && submission.version === currentVersion,
    versionWasObserved: shape && observedVersions.has(submission.version),
    answerMatches: shape && isDeepStrictEqual(canonical(submission.answer), canonical(expected)),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
