import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createTaskCase } from './task-cases.mjs';
import { TaskHost, toolDefinitions, isDataOperation } from './task-host.mjs';
import { gradeSubmission } from './task-grader.mjs';
import { ObservationError, digest, wireBytes } from './observation.mjs';

/** Evaluation controller; task secrets never enter TaskHost. */
export class TaskEpisode {
  #task;
  #host;
  #observed = new Set();
  #events = [];
  #finished = false;
  #closed = false;
  #verdict = null;
  #ready;
  #arm;
  #calls = 0;
  #errors = 0;
  #bytes = 0;
  #finalVersion;

  constructor(id, arm) {
    this.#task = createTaskCase(id);
    this.#arm = arm;
    try {
      this.#host = new TaskHost(this.#task.file, { arm, recordsKey: this.#task.recordsKey });
      this.#ready = { type: 'ready', protocol: 'RFC-SI-003/task-v1', task: this.#task.spec.publicTask,
        tools: [...toolDefinitions(arm),
          { op: 'help', description: '再次获取本轮目标及全部接口说明。', args: { type: 'object', properties: {}, additionalProperties: false } },
          { op: 'submit', description: '一次性终局提交。评分后本轮结束，无中间答案提示。',
            args: { type: 'object', required: ['version', 'answer'], properties: { version: { type: 'string' }, answer: { type: 'object' } }, additionalProperties: false } }],
        budgets: { defaultResultBytes: 2048, maximumResultBytes: 65536, measuredTransport: 'complete-json-envelope-utf8-bytes' } };
      this.#bytes = wireBytes(this.#ready);
      this.#events.push({ type: 'ready', response: this.#ready });
    } catch (error) {
      this.#task.cleanup();
      throw error;
    }
  }

  get ready() { return structuredClone(this.#ready); }
  get finished() { return this.#finished; }
  get verdict() { return structuredClone(this.#verdict); }

  #record(request, response, started, rawRequestBytes) {
    this.#calls += 1;
    if (response.status === 'error') this.#errors += 1;
    const requestBytes = rawRequestBytes ?? wireBytes(request);
    const responseBytes = wireBytes(response);
    this.#bytes += requestBytes + responseBytes;
    this.#events.push({ type: 'exchange', request: structuredClone(request), response: structuredClone(response),
      requestBytes, responseBytes, elapsedMs: Number((performance.now() - started).toFixed(3)) });
    return response;
  }

  handle(request) {
    if (this.#finished || this.#closed) throw new ObservationError('episode_finished', 'This episode no longer accepts requests');
    const started = performance.now();
    let response;
    try {
      if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.op !== 'string' ||
          Object.keys(request).some((key) => !['id', 'op', 'args'].includes(key))) {
        throw new ObservationError('invalid_request', 'Expected an object with op, optional id and args');
      }
      if (request.id !== undefined && request.id !== null && !['string', 'number'].includes(typeof request.id)) {
        throw new ObservationError('invalid_request', 'id must be a string, number or null');
      }
      let result;
      if (request.op === 'submit') {
        this.#verdict = gradeSubmission(this.#task, request.args, this.#observed);
        this.#finished = true;
        result = this.#verdict;
      } else if (request.op === 'help') {
        if (request.args !== undefined && (request.args === null || typeof request.args !== 'object' || Object.keys(request.args).length > 0 || Array.isArray(request.args))) {
          throw new ObservationError('invalid_args', 'help takes an empty args object');
        }
        result = this.ready;
      } else result = this.#host.call(request.op, request.args);
      response = { id: request.id ?? null, status: 'ok', result };
    } catch (error) {
      if (!(error instanceof ObservationError)) throw error;
      response = { id: request?.id ?? null, status: 'error', error: { code: error.code, message: error.message } };
    }
    this.#record(request, response, started);
    if (response.status === 'ok' && isDataOperation(request.op)) {
      this.#observed.add(response.result.version);
      const changed = this.#task.afterDataRead();
      if (changed) this.#events.push({ ...changed, afterCall: this.#calls });
    }
    return response;
  }

  handleLine(line) {
    if (this.#finished || this.#closed) throw new ObservationError('episode_finished', 'This episode no longer accepts requests');
    let request;
    try { request = JSON.parse(line); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const response = { id: null, status: 'error', error: { code: 'invalid_json', message: error.message } };
      // Preserve malformed input explicitly; no synthetic successful request.
      return this.#record({ rawInput: line }, response, performance.now(), Buffer.byteLength(line, 'utf8'));
    }
    return this.handle(request);
  }

  close() {
    if (this.#closed) return;
    try {
      this.#finalVersion = digest(fs.readFileSync(this.#task.file));
      if (!this.#finished) {
        this.#verdict = { passed: false, reason: 'no_submission' };
        this.#events.push({ type: 'aborted', reason: 'no_submission' });
      }
    } finally {
      this.#task.cleanup();
      this.#closed = true;
    }
  }

  get trace() {
    return structuredClone({ protocol: 'RFC-SI-003/task-v1', taskId: this.#task.spec.id, split: this.#task.spec.split,
      arm: this.#arm, provenance: this.#task.provenance, finalVersion: this.#finalVersion,
      verdict: this.#verdict, submitted: this.#finished, cleaned: this.#closed,
      metrics: { calls: this.#calls, errors: this.#errors, transportBytes: this.#bytes }, events: this.#events });
  }
}
