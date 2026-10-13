import type { ExecuteProcessOptions } from './types.js';

// Node turns larger timer delays into 1 ms, which changes both timeout and lease-wait semantics.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function record(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function string(value: unknown, field: string, nonempty = false, osValue = false): void {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  if (nonempty && value.length === 0) throw new RangeError(`${field} must not be empty`);
  if (osValue && value.includes('\0')) throw new TypeError(`${field} must not contain null bytes`);
}

function optionalString(value: unknown, field: string, nonempty = false, osValue = false): void {
  if (value !== undefined) string(value, field, nonempty, osValue);
}

function strings(value: unknown, field: string, nonempty = false, osValue = false): void {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`);
  for (let i = 0; i < value.length; i++) string(value[i], `${field}[${i}]`, nonempty, osValue);
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
}

function nonnegativeNumber(value: unknown, field: string, integer = false, max = Number.MAX_SAFE_INTEGER): void {
  if (value === undefined) return;
  if (typeof value !== 'number') throw new TypeError(`${field} must be a number`);
  if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${field} must be a finite nonnegative ${integer ? 'integer' : 'number'} no greater than ${max}`);
  }
}

/** Validate the public execution boundary before fingerprints, admission or durable effects. */
export function validateExecuteProcessOptions(options: ExecuteProcessOptions): void {
  record(options, 'options');
  // IDs are opaque journal keys; neither whitespace nor filename syntax restricts them.
  string(options.runId, 'runId', true);
  string(options.opId, 'opId', true);
  string(options.name, 'name', true);
  record(options.command, 'command');
  const command = options.command;
  string(command.execPath, 'command.execPath', true, true);
  string(command.cwd, 'command.cwd', true, true);
  strings(command.args, 'command.args', false, true);
  optionalBoolean(command.inheritEnv, 'command.inheritEnv');
  if (command.stdinMode !== undefined && command.stdinMode !== 'once' && command.stdinMode !== 'stream') {
    throw new TypeError('command.stdinMode must be once or stream');
  }
  if (command.stdin !== undefined && typeof command.stdin !== 'string' && !(command.stdin instanceof Uint8Array)) {
    throw new TypeError('command.stdin must be a string or Uint8Array');
  }
  if (command.envWhiteList !== undefined) {
    record(command.envWhiteList, 'command.envWhiteList');
    for (const [key, value] of Object.entries(command.envWhiteList)) {
      if (key.length === 0 || key.includes('=') || key.includes('\0')) {
        throw new TypeError('command.envWhiteList keys must be nonempty and contain neither = nor null bytes');
      }
      // Do not include environment values in errors: they may contain credentials.
      string(value, 'command.envWhiteList value', false, true);
    }
  }
  if (command.hardLimits !== undefined) {
    record(command.hardLimits, 'command.hardLimits');
    nonnegativeNumber(command.hardLimits.memoryMaxBytes, 'command.hardLimits.memoryMaxBytes', true);
    nonnegativeNumber(command.hardLimits.pidsMax, 'command.hardLimits.pidsMax', true);
  }
  if (options.requiredResources !== undefined) strings(options.requiredResources, 'requiredResources', true);
  if (options.mutationRoots !== undefined) strings(options.mutationRoots, 'mutationRoots', true, true);
  optionalString(options.capabilityId, 'capabilityId', true);
  optionalString(options.inputFingerprint, 'inputFingerprint');
  optionalString(options.artifactsDir, 'artifactsDir', true, true);
  if (options.confinement !== undefined && typeof options.confinement !== 'boolean') {
    string(options.confinement, 'confinement', true);
  }
  for (const field of ['timeoutMs', 'waitTimeoutMs', 'drainTimeoutMs'] as const) {
    nonnegativeNumber(options[field], field, false, MAX_TIMER_DELAY_MS);
  }
  // Zero timeout disables it; zero wait does not queue; zero drain waits no time;
  // zero output capture retains no output in memory. Budget zero keeps its existing unset-limit meaning.
  nonnegativeNumber(options.maxOutputBytes, 'maxOutputBytes', true);
  if (options.resourceBudget !== undefined) {
    record(options.resourceBudget, 'resourceBudget');
    const budget = options.resourceBudget;
    if (budget.enforcement !== 'observe' && budget.enforcement !== 'soft' && budget.enforcement !== 'hard') {
      throw new TypeError('resourceBudget.enforcement must be observe, soft or hard');
    }
    for (const field of ['maxMemoryBytes', 'maxPids', 'maxOutputBytes'] as const) {
      nonnegativeNumber(budget[field], `resourceBudget.${field}`, true);
    }
    nonnegativeNumber(budget.maxCpuTimeMs, 'resourceBudget.maxCpuTimeMs');
  }
  if (options.trackReads !== undefined) {
    record(options.trackReads, 'trackReads');
    strings(options.trackReads.roots, 'trackReads.roots', true, true);
    if (options.trackReads.statCaches !== undefined && options.trackReads.statCaches !== 'ruled_out') {
      throw new TypeError('trackReads.statCaches must be ruled_out');
    }
  }
  if (options.onStreamChunk !== undefined && typeof options.onStreamChunk !== 'function') {
    throw new TypeError('onStreamChunk must be a function');
  }
  if (options.abortSignal !== undefined) {
    record(options.abortSignal, 'abortSignal');
    if (typeof options.abortSignal.aborted !== 'boolean'
      || typeof options.abortSignal.addEventListener !== 'function'
      || typeof options.abortSignal.removeEventListener !== 'function') {
      throw new TypeError('abortSignal must implement AbortSignal');
    }
  }
  if (options.confinementDriver !== undefined) {
    record(options.confinementDriver, 'confinementDriver');
    if (typeof options.confinementDriver.wrap !== 'function') {
      throw new TypeError('confinementDriver.wrap must be a function');
    }
  }
}
