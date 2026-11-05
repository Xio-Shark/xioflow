import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash, sleep } from './process-fixture.mjs';

export const WAIT_ARMS = ['agent-poll', 'server-poll', 'event-view'];
const FIELDS = ['instanceId', 'name', 'environment', 'pid', 'startedAt', 'alive', 'available', 'ready',
  'loadedRevision', 'configRevision', 'setting', 'configSetting', 'configCurrent', 'exitCode', 'probeError'];
export class ProcessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const whereSchema = { type: 'object', description: '字段到标量的精确相等条件；可用 name/environment/instanceId/ready/configCurrent/alive/available 等。' };
export function processTools(arm) {
  const tools = [
    { name: 'inspect', description: '采样真实进程与探针，返回 evidenceId、stateVersion、capturedAt 和 rows。configCurrent 表示实际加载版本和值与文件一致。可按 where 过滤；delayMs 在采样前等待。',
      parameters: objectSchema({ where: whereSchema, delayMs: { type: 'integer', minimum: 0, maximum: 10000 } }) },
    { name: 'read_logs', description: '读取指定实例日志末尾。日志可能过时或提前宣称就绪；此操作不产生可提交的状态证据。',
      parameters: objectSchema({ instanceId: { type: 'string' } }, ['instanceId']) },
  ];
  if (arm !== 'agent-poll') tools.push({ name: 'watch',
    description: '系统等待关注状态变化或 until 所有字段条件满足。where 选择对象，until 如 {ready:true,configCurrent:true} 表达条件。after 是上次 evidenceId；未指定时返回首次采样。返回 changed/condition_met/timeout；timeout 仅说明本次等待结束，仍需判断任务。进程退出也会返回。',
    parameters: objectSchema({ where: whereSchema, until: whereSchema, after: { type: 'string' }, maxWaitMs: { type: 'integer', minimum: 1, maximum: 10000 } }) });
  tools.push({ name: 'submit', description: '提交一次最终判断；必须使用实际观察返回的 evidenceId 与目标当前 instanceId。独立检查器会核对当前真实状态。',
    parameters: objectSchema({ outcome: { type: 'string', enum: ['ready', 'exited', 'timeout', 'unavailable'] },
      instanceId: { type: 'string' }, evidenceId: { type: 'string' } }, ['outcome', 'instanceId', 'evidenceId']) });
  return tools.map((tool) => ({ type: 'function', function: tool }));
}
export function validatePredicate(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.entries(value).some(([key, v]) =>
    !FIELDS.includes(key) || !['string', 'number', 'boolean'].includes(typeof v) && v !== null)) {
    throw new ProcessError('invalid_predicate', 'Use documented fields and scalar equality values');
  }
  return value;
}
export const matches = (row, predicate) => Object.entries(predicate).every(([key, value]) => row[key] === value);

export class ProcessHost {
  constructor(fixture, arm, { intervalMs = 50, dropHints = false, onObservation = () => {} } = {}) {
    if (!WAIT_ARMS.includes(arm)) throw new Error('Unknown wait arm');
    this.fixture = fixture;
    this.arm = arm;
    this.intervalMs = intervalMs;
    this.dropHints = dropHints;
    this.onObservation = onObservation;
    this.evidence = new Map();
    this.abort = new AbortController();
    this.metrics = { scans: 0, probes: 0, notifications: 0, hints: 0, activeWatchers: 0, activeTimers: 0 };
    this.samples = [];
  }
  async capture(where = {}) {
    validatePredicate(where);
    this.abort.signal.throwIfAborted();
    this.fixture.assertHealthy();
    this.metrics.scans += 1;
    const rows = [];
    for (const item of [...this.fixture.current]) {
      const config = JSON.parse(fs.readFileSync(item.configFile));
      const row = { instanceId: item.instanceId, name: item.name, environment: item.environment, pid: item.pid,
        startedAt: item.startedAt, alive: item.alive, available: false, ready: false,
        loadedRevision: null, configRevision: config.revision, setting: null, configSetting: config.setting,
        configCurrent: false, exitCode: item.alive ? null : item.exitCode, probeError: null };
      if (item.alive) {
        this.metrics.probes += 1;
        try {
          const response = await fetch(`${item.url}/state`, { redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(300)]) });
          const state = await response.json();
          if (!response.ok) row.probeError = `HTTP_${response.status}`;
          else {
            if (state.instanceId !== item.instanceId || state.pid !== item.pid) throw new Error('Probe identity mismatch');
            Object.assign(row, { available: true, ready: state.ready, loadedRevision: state.loadedRevision, setting: state.setting,
              configCurrent: state.loadedRevision === config.revision && state.setting === config.setting });
          }
        } catch (error) {
          this.abort.signal.throwIfAborted();
          if (error.name !== 'TypeError' && error.name !== 'TimeoutError') throw error;
          row.probeError = error.name;
        }
      }
      if (matches(row, where)) rows.push(row);
    }
    const sample = { evidenceId: randomUUID(), stateVersion: hash(rows), capturedAt: Date.now(), rows };
    this.samples.push(sample);
    this.onObservation(sample);
    return sample;
  }
  async call(op, args = {}) {
    const definition = processTools(this.arm).find((tool) => tool.function.name === op)?.function;
    if (!definition || op === 'submit') throw new ProcessError('unsupported_operation', op);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !Object.hasOwn(definition.parameters.properties, key))) {
      throw new ProcessError('invalid_args', 'Unexpected argument');
    }
    if (op === 'read_logs') {
      const item = this.fixture.instances.find((candidate) => candidate.instanceId === args.instanceId);
      if (!item) throw new ProcessError('unknown_instance', 'Instance is not owned by this fixture');
      return { instanceId: item.instanceId, text: fs.readFileSync(item.logFile, 'utf8').slice(-2000), stateEvidence: false };
    }
    if (op === 'inspect') {
      const delay = args.delayMs ?? 0;
      if (!Number.isInteger(delay) || delay < 0 || delay > 10000) throw new ProcessError('invalid_delay', 'delayMs must be 0..10000');
      if (delay) { this.metrics.activeTimers += 1; try { await sleep(delay, this.abort.signal); } finally { this.metrics.activeTimers -= 1; } }
      const result = await this.capture(args.where);
      this.evidence.set(result.evidenceId, result);
      this.metrics.notifications += 1;
      return result;
    }
    return this.watch(args);
  }
  async watch({ where = {}, until = {}, after, maxWaitMs = 1000 }) {
    validatePredicate(where); validatePredicate(until);
    if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 10000) throw new ProcessError('invalid_wait', 'maxWaitMs must be 1..10000');
    const previous = after === undefined ? null : this.evidence.get(after);
    if (after !== undefined && !previous) throw new ProcessError('unknown_evidence', 'after must reference a returned observation');
    const previousVersion = previous ? hash(previous.rows.filter((row) => matches(row, where))) : null;
    let wake;
    let watcher;
    if (this.arm === 'event-view') {
      watcher = fs.watch(this.fixture.directory, () => {
        this.metrics.hints += 1;
        if (!this.dropHints) wake?.();
      });
      watcher.on('error', (error) => { this.fixture.errors.push(`watch: ${error.message}`); wake?.(); });
      this.metrics.activeWatchers += 1;
    }
    const deadline = Date.now() + maxWaitMs;
    try {
      while (true) {
        const current = await this.capture(where);
        const conditionMet = current.rows.length > 0 && current.rows.every((row) => matches(row, until));
        const exited = current.rows.length > 0 && current.rows.every((row) => !row.alive);
        const reason = conditionMet ? 'condition_met' : exited ? 'exited' : !previous ? 'initial' :
          current.stateVersion !== previousVersion ? 'changed' : Date.now() >= deadline ? 'timeout' : null;
        if (reason) {
          this.metrics.notifications += 1;
          this.evidence.set(current.evidenceId, current);
          return { ...current, reason };
        }
        this.metrics.activeTimers += 1;
        try {
          await new Promise((resolve, reject) => {
            const done = (error) => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', cancel); wake = null; error ? reject(error) : resolve(); };
            const cancel = () => done(this.abort.signal.reason);
            const timer = setTimeout(() => done(), Math.min(this.intervalMs, Math.max(1, deadline - Date.now())));
            wake = () => done();
            this.abort.signal.addEventListener('abort', cancel, { once: true });
            if (this.abort.signal.aborted) cancel();
          });
        } finally { this.metrics.activeTimers -= 1; }
      }
    } finally { if (watcher) { watcher.close(); this.metrics.activeWatchers -= 1; } }
  }
  close() { this.abort.abort(new Error('host_closed')); }
}
