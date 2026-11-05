import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const service = fileURLToPath(new URL('./process-service.mjs', import.meta.url));
export const KINDS = ['delayed', 'misleading-log', 'config-change', 'exit', 'replacement', 'lost-hints'];
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
  signal?.addEventListener('abort', cancel, { once: true });
});
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const atomicJson = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`);
  fs.renameSync(`${file}.tmp`, file);
};

export function processTask(id) {
  const match = /^(dev|heldout)-(0[1-6])$/.exec(id);
  if (!match) throw new Error(`Unknown process task: ${id}`);
  const held = match[1] === 'heldout';
  const kind = KINDS[Number(match[2]) - 1];
  const name = held ? 'catalog-api' : 'billing-api';
  const environment = held ? 'staging' : 'prod';
  return { id, split: match[1], kind, name, environment, initialSetting: held ? 23 : 11,
    expected: kind === 'exit' ? 'exited' : 'ready',
    goal: `观察 ${environment} 环境的 ${name} 当前实例。等到真实就绪且加载的配置与当前配置文件一致后报告 ready；如果它在就绪前退出则报告 exited。同名其他环境与旧实例不算目标，日志不是就绪证明。配置和实例可能变化，需重新判断。` };
}

export class ProcessFixture extends EventEmitter {
  constructor(spec, { tickMs = 60, deadlineMs = 3000, failStart = false } = {}) {
    super();
    this.spec = spec;
    this.tickMs = tickMs;
    this.deadlineMs = deadlineMs;
    this.failStart = failStart;
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-process-'));
    this.instances = [];
    this.current = [];
    this.timers = new Set();
    this.jobs = new Set();
    this.changes = [];
    this.errors = [];
    this.started = null;
    this.closed = false;
    this.cleanup = null;
  }
  static async create(spec, options) {
    const fixture = new ProcessFixture(spec, options);
    try { await fixture.initialize(); return fixture; }
    catch (error) { await fixture.close(); error.cleanup = fixture.cleanup; throw error; }
  }
  async initialize() {
    this.target = await this.spawn(this.spec.environment, this.spec.initialSetting);
    if (this.failStart) throw new Error('injected_partial_start_failure');
    this.decoy = await this.spawn(this.spec.environment === 'prod' ? 'staging' : 'prod', 999);
    await this.control(this.decoy, 'ready', { value: true });
    if (this.spec.kind === 'misleading-log') await this.control(this.target, 'log', { message: 'ready (historical message; probe may disagree)' });
  }
  async spawn(environment, setting) {
    if (this.closed) throw new Error('fixture_closed');
    const instanceId = randomUUID();
    const item = { instanceId, name: this.spec.name, environment, current: true,
      configFile: path.join(this.directory, `${instanceId}.config.json`),
      logFile: path.join(this.directory, `${instanceId}.log`), alive: true, pending: new Map() };
    atomicJson(item.configFile, { revision: 1, setting });
    const child = fork(service, [this.directory, instanceId, item.name, environment], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    item.child = child;
    item.stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { item.stderr = (item.stderr + chunk).slice(-2048); });
    item.closedPromise = new Promise((resolve) => child.once('close', (code, signal) => {
      item.alive = false; item.exitCode = code; item.signal = signal; item.closed = true;
      for (const pending of item.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('process_exited')); }
      item.pending.clear();
      this.record('exit', item);
      resolve();
    }));
    this.instances.push(item);
    this.current.push(item);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('process_start_timeout')), 3000);
      const finish = (fn, value) => { clearTimeout(timer); child.off('error', onError); child.off('close', onClose); fn(value); };
      const onError = (error) => finish(reject, error);
      const onClose = () => finish(reject, new Error('process_exited_before_listen'));
      child.once('error', onError);
      child.once('close', onClose);
      child.on('message', (message) => {
        if (message.type === 'listening') {
          item.url = `http://127.0.0.1:${message.port}`;
          item.pid = message.state.pid;
          item.startedAt = message.state.startedAt;
          finish(resolve);
        } else if (item.pending.has(message.id)) {
          const pending = item.pending.get(message.id);
          clearTimeout(pending.timer); item.pending.delete(message.id);
          if (message.ok) pending.resolve(message); else pending.reject(new Error(message.error));
        }
      });
    });
    this.record('spawn', item);
    return item;
  }
  record(type, item, details = {}) {
    const event = { type, instanceId: item.instanceId, at: Date.now(), ...details };
    this.changes.push(event);
    this.emit('hint', event);
  }
  async control(item, op, args = {}) {
    if (!item.alive || !item.child.connected) throw new Error('process_exited');
    const id = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { item.pending.delete(id); reject(new Error('control_timeout')); }, 1500);
      item.pending.set(id, { resolve, reject, timer });
      item.child.send({ id, op, args }, (error) => {
        if (error && item.pending.has(id)) { clearTimeout(timer); item.pending.delete(id); reject(error); }
      });
    });
    this.record(op, item, { at: result.state.changedAt, receivedAt: result.at, state: result.state });
    return result;
  }
  schedule(multiplier, operation) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      const job = operation();
      this.jobs.add(job);
      job.catch((error) => this.errors.push(error.message)).finally(() => this.jobs.delete(job));
    }, multiplier * this.tickMs * (this.spec.split === 'heldout' ? 1.25 : 1));
    this.timers.add(timer);
  }
  start() {
    if (this.started !== null || this.closed) return;
    this.started = Date.now();
    if (this.spec.kind === 'never' || this.spec.kind === 'unavailable') return;
    if (this.spec.kind === 'exit') {
      this.schedule(2, async () => { this.target.child.kill('SIGTERM'); await this.target.closedPromise; });
    } else if (this.spec.kind === 'replacement') {
      this.schedule(1, async () => {
        const old = this.target;
        old.current = false;
        this.current = this.current.filter((item) => item !== old);
        this.record('replacing', old);
        old.child.kill('SIGTERM'); await old.closedPromise;
        const replacement = await this.spawn(old.environment, this.spec.initialSetting);
        this.target = replacement;
        this.record('replacement', replacement);
        await sleep(this.tickMs * 2);
        if (!this.closed) await this.control(replacement, 'ready', { value: true });
      });
    } else if (this.spec.kind === 'config-change') {
      this.schedule(1, async () => {
        atomicJson(this.target.configFile, { revision: 2, setting: this.spec.initialSetting + 7 });
        this.record('config', this.target);
      });
      this.schedule(3, async () => { await this.control(this.target, 'reload'); await this.control(this.target, 'ready', { value: true }); });
    } else {
      if (this.spec.kind === 'lost-hints') for (let i = 1; i <= 5; i += 1) this.schedule(i / 2, () => this.control(this.decoy, 'noise'));
      this.schedule(3, () => this.control(this.target, 'ready', { value: true }));
    }
  }
  assertHealthy() { if (this.errors.length) throw new Error(`Scenario failure: ${this.errors.join('; ')}`); }
  async close() {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.jobs]);
    for (const item of this.instances) if (!item.closed) item.child.kill('SIGTERM');
    const forced = setTimeout(() => { for (const item of this.instances) if (!item.closed) item.child.kill('SIGKILL'); }, 1200);
    try { await Promise.all(this.instances.map((item) => item.closedPromise)); }
    finally { clearTimeout(forced); }
    const probes = await Promise.all(this.instances.filter((item) => item.url).map(async (item) => {
      try { await fetch(`${item.url}/state`, { signal: AbortSignal.timeout(200), redirect: 'error' }); return false; }
      catch (error) { if (error.name === 'TypeError' || error.name === 'TimeoutError') return true; throw error; }
    }));
    const childrenClosed = this.instances.every((item) => item.closed && item.pending.size === 0);
    const listeners = this.listenerCount('hint');
    if (!childrenClosed || probes.some((closed) => !closed) || listeners !== 0) throw new Error('Fixture cleanup verification failed');
    fs.rmSync(this.directory, { recursive: true });
    this.cleanup = { childrenClosed, portsClosed: true, timers: this.timers.size, jobs: this.jobs.size,
      listeners, directoryRemoved: !fs.existsSync(this.directory), instanceCount: this.instances.length };
    return this.cleanup;
  }
}
