import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FileObservation, ObservationError, wireBytes } from './observation.mjs';

export const ARMS = ['full', 'jq', 'structured'];
const DATA_OPS = new Set(['full', 'jq', 'query', 'readText']);
export const isDataOperation = (op) => DATA_OPS.has(op);
const maxBytesSchema = { type: 'integer', minimum: 256, maximum: 65536, default: 2048 };
const emptyArgs = { type: 'object', properties: {}, additionalProperties: false };

export function toolDefinitions(arm) {
  if (!ARMS.includes(arm)) throw new Error(`Unknown arm: ${arm}`);
  const tools = [
    { op: 'describe', description: '返回当前快照的版本、字段和记录数；不自动刷新。', args: emptyArgs },
    { op: 'refresh', description: '重新读取当前源文件。旧引用和游标不能在新快照使用。', args: emptyArgs },
  ];
  if (arm === 'full') tools.push({ op: 'full', description: '返回整个快照的记录数组。超预算时报错，可增大 maxBytes 后重试。',
    args: { type: 'object', properties: { maxBytes: maxBytesSchema }, additionalProperties: false } });
  if (arm === 'jq') tools.push({ op: 'jq', description: '用 jq 处理当前快照的记录数组；所有输出值放入 values 数组。例如 .[] | {id}。只有显式 refresh 才更新快照。',
    args: { type: 'object', required: ['program'], properties: { program: { type: 'string' }, maxBytes: maxBytesSchema }, additionalProperties: false } });
  if (arm === 'structured') tools.push(
    { op: 'query', description: 'where 是字段与标量值的精确相等条件；空对象匹配全部。select 指定字段。complete=false 时须使用原查询和 nextCursor 继续；missing 显式列出缺失字段。',
      args: { type: 'object', required: ['select'], properties: { where: { type: 'object' }, select: { type: 'array', items: { type: 'string' } },
        maxBytes: maxBytesSchema, cursor: { type: ['string', 'null'] } }, additionalProperties: false } },
    { op: 'readText', description: '按 ref、version、field 展开文本。complete=false 时用 nextCursor 继续，按顺序拼接 text。',
      args: { type: 'object', required: ['ref', 'version', 'field'], properties: { ref: { type: 'string' }, version: { type: 'string' },
        field: { type: 'string' }, maxBytes: maxBytesSchema, cursor: { type: ['string', 'null'] } }, additionalProperties: false } });
  return tools;
}

/** Task-agnostic readonly host: it has no goal, oracle, or expected query. */
export class TaskHost {
  #observation;
  #file;
  #recordsKey;
  #arm;
  constructor(file, { arm, recordsKey } = {}) {
    if (!ARMS.includes(arm)) throw new Error(`Unknown arm: ${arm}`);
    this.#file = file;
    this.#arm = arm;
    this.#recordsKey = recordsKey;
    this.#observation = new FileObservation(file, { recordsKey });
  }

  call(op, args = {}) {
    const tool = toolDefinitions(this.#arm).find((entry) => entry.op === op);
    if (!tool) throw new ObservationError('unsupported_operation', `Operation ${op} is not available in arm ${this.#arm}`);
    if (args === null || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some((key) => !Object.hasOwn(tool.args.properties, key))) {
      throw new ObservationError('invalid_args', 'Expected an args object containing only documented properties');
    }
    for (const key of tool.args.required ?? []) {
      if (!Object.hasOwn(args, key)) throw new ObservationError('invalid_args', `Missing required argument: ${key}`);
    }
    if (op === 'describe') return this.#observation.describe();
    if (op === 'refresh') {
      this.#observation = new FileObservation(this.#file, { recordsKey: this.#recordsKey });
      return this.#observation.describe();
    }
    const limit = args.maxBytes === undefined ? 2048 : args.maxBytes;
    if (!Number.isSafeInteger(limit) || limit < 256 || limit > 65536) {
      throw new ObservationError('invalid_budget', 'maxBytes must be an integer from 256 through 65536');
    }
    let result;
    if (op === 'full') result = this.#observation.full();
    else if (op === 'query') result = this.#observation.query(args);
    else if (op === 'readText') result = this.#observation.readText(args);
    else {
      if (typeof args.program !== 'string' || args.program.length === 0 || args.program.length > 16384) {
        throw new ObservationError('invalid_args', 'program must be a nonempty jq expression of at most 16384 characters');
      }
      const execution = spawnSync('jq', ['-c', '--', args.program], {
        input: JSON.stringify(this.#observation.full().records), encoding: 'utf8', timeout: 2000,
        maxBuffer: 1024 * 1024, cwd: path.dirname(this.#file), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      });
      if (execution.error) throw new ObservationError(execution.error.code === 'ENOENT' ? 'jq_unavailable' : 'jq_execution_error', execution.error.message);
      if (execution.status !== 0) throw new ObservationError('jq_failed', `jq exited ${execution.status}: ${execution.stderr.trim().slice(0, 1000)}`);
      const output = execution.stdout.trim();
      result = { version: this.#observation.version, values: output ? output.split('\n').map((line) => JSON.parse(line)) : [] };
    }
    const bytes = wireBytes(result);
    if (bytes > limit) throw new ObservationError('budget_too_small', `Complete result needs ${bytes} bytes; maxBytes is ${limit}`);
    return result;
  }
}
