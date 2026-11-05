import readline from 'node:readline';
import { FileObservation, ObservationError } from './observation.mjs';

// A read-only JSONL transport for an agent host; never installs or registers tools.
const [file, recordsKey, ...extra] = process.argv.slice(2);
if (!file || extra.length) {
  console.error('Usage: node audit/interaction/session.mjs FILE [TOP_LEVEL_ARRAY_KEY]');
  process.exitCode = 2;
} else {
  let observation = new FileObservation(file, { recordsKey });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      try { request = JSON.parse(line); }
      catch (error) { throw new ObservationError('invalid_json', error.message); }
      if (request === null || typeof request !== 'object' || Array.isArray(request)) {
        throw new ObservationError('invalid_request', 'Expected an object with op and optional args');
      }
      let result;
      if ((request.args !== undefined && (request.args === null || typeof request.args !== 'object' || Array.isArray(request.args))) ||
          (request.op === 'readText' && request.args === undefined)) {
        throw new ObservationError('invalid_args', 'Expected an args object for this operation');
      }
      switch (request.op) {
        case 'describe': result = observation.describe(); break;
        case 'query': result = observation.query(request.args); break;
        case 'readText': result = observation.readText(request.args); break;
        case 'refresh': observation = new FileObservation(file, { recordsKey }); result = observation.describe(); break;
        default: throw new ObservationError('unsupported_operation', 'Supported operations: describe, query, readText, refresh');
      }
      console.log(JSON.stringify({ id: request.id ?? null, status: 'ok', result }));
    } catch (error) {
      if (!(error instanceof ObservationError)) throw error;
      console.log(JSON.stringify({ id: request?.id ?? null, status: 'error', error: { code: error.code, message: error.message } }));
    }
  }
}
