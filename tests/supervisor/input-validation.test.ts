import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } from '../../src/index.js';
import { validateExecuteProcessOptions } from '../../src/supervisor/input-validation.js';
import type { ExecuteProcessOptions } from '../../src/supervisor/types.js';

describe('executeProcess input admission', () => {
  let root: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-input-admission-'));
    domain = ExecutionDomain.acquire(root, 'input-admission');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function valid(): ExecuteProcessOptions {
    return {
      runId: 'run', opId: 'input', name: 'input admission', requiredResources: ['resource'],
      command: { execPath: process.execPath, cwd: root, args: ['-e', 'process.stdout.write("output")'] },
    };
  }

  function change(options: ExecuteProcessOptions, field: string, value: unknown): void {
    const segments = field.split('.');
    let owner = options as unknown as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) {
      owner[segment] ??= {};
      owner = owner[segment] as Record<string, unknown>;
    }
    owner[segments.at(-1)!] = value;
  }

  const badInputs: Array<[string, unknown, typeof TypeError | typeof RangeError]> = [
    ['runId', null, TypeError], ['opId', 123, TypeError], ['opId', '', RangeError], ['name', '', RangeError],
    ['command', null, TypeError], ['command.execPath', '', RangeError], ['command.execPath', 'node\0bad', TypeError],
    ['command.cwd', 1, TypeError], ['command.cwd', '', RangeError], ['command.args', 'argument', TypeError],
    ['command.args', [1], TypeError], ['command.args', new Array(1), TypeError], ['command.args', ['\0'], TypeError],
    ['command.inheritEnv', 'false', TypeError], ['command.stdinMode', 'invalid', TypeError],
    ['command.stdin', {}, TypeError], ['command.stdin', null, TypeError], ['command.stdin', new Uint16Array(1), TypeError],
    ['command.envWhiteList', [], TypeError], ['command.envWhiteList', null, TypeError],
    ['command.envWhiteList', { VALUE: 1 }, TypeError], ['command.envWhiteList', { 'A=B': 'value' }, TypeError],
    ['command.envWhiteList', { '': 'value' }, TypeError], ['command.envWhiteList', { VALUE: '\0' }, TypeError],
    ['command.hardLimits.memoryMaxBytes', -1, RangeError], ['command.hardLimits.pidsMax', 1.5, RangeError],
    ['requiredResources', 'resource', TypeError], ['requiredResources', [null], TypeError],
    ['mutationRoots', [1], TypeError], ['capabilityId', false, TypeError], ['confinement', 1, TypeError],
    ['artifactsDir', 'bad\0path', TypeError], ['inputFingerprint', {}, TypeError],
    ['timeoutMs', '1000', TypeError], ['timeoutMs', NaN, RangeError], ['timeoutMs', Infinity, RangeError],
    ['timeoutMs', -1, RangeError], ['timeoutMs', 2 ** 31, RangeError],
    ['waitTimeoutMs', NaN, RangeError], ['waitTimeoutMs', -1, RangeError], ['waitTimeoutMs', 2 ** 31, RangeError],
    ['drainTimeoutMs', Infinity, RangeError], ['drainTimeoutMs', -1, RangeError], ['drainTimeoutMs', 2 ** 31, RangeError],
    ['maxOutputBytes', -1, RangeError], ['maxOutputBytes', 1.5, RangeError], ['maxOutputBytes', Infinity, RangeError],
    ['maxOutputBytes', Number.MAX_SAFE_INTEGER + 1, RangeError], ['resourceBudget', null, TypeError],
    ['resourceBudget.enforcement', 'invalid', TypeError], ['resourceBudget.enforcement', undefined, TypeError],
    ['resourceBudget.maxMemoryBytes', -1, RangeError], ['resourceBudget.maxMemoryBytes', 1.5, RangeError],
    ['resourceBudget.maxPids', 1.5, RangeError], ['resourceBudget.maxPids', '10', TypeError],
    ['resourceBudget.maxCpuTimeMs', Infinity, RangeError], ['resourceBudget.maxOutputBytes', -1, RangeError],
    ['trackReads.roots', 'root', TypeError], ['trackReads.statCaches', 'possible', TypeError],
    ['onStreamChunk', true, TypeError], ['abortSignal', {}, TypeError], ['confinementDriver', {}, TypeError],
  ];

  it.each(badInputs)('rejects %s before registering intents, leasing resources or spawning', async (field, value, ErrorType) => {
    const options = valid();
    if (field.startsWith('resourceBudget.')) options.resourceBudget = { enforcement: 'observe' };
    if (field.startsWith('trackReads.')) options.trackReads = { roots: [root] };
    change(options, field, value);
    const store = domain.getStore();
    const runBefore = store.getRun('run');
    const eventsBefore = store.getJournalEvents(domain.domainId);
    const spawn = vi.spyOn(driver, 'spawn');
    const execution = supervisor.executeProcess(options);
    await expect(execution).rejects.toBeInstanceOf(ErrorType);
    await expect(execution).rejects.toThrow(field.split('.')[0]);
    expect(spawn).not.toHaveBeenCalled();
    expect(store.getAllOperations(domain.domainId)).toEqual([]);
    expect(store.getPersistedResourceLeases(domain.domainId)).toEqual([]);
    expect(domain.isResourceLocked('resource')).toBe(false);
    expect(store.getRun('run')).toEqual(runBefore);
    expect(store.getJournalEvents(domain.domainId)).toEqual(eventsBefore);
    expect(fs.existsSync(path.join(root, 'artifacts'))).toBe(false);
  });

  it('rejects malformed options and arguments before capability or Run admission', async () => {
    await expect(supervisor.executeProcess(null as unknown as ExecuteProcessOptions)).rejects.toThrow(TypeError);
    const options = valid();
    options.runId = 'not-registered';
    options.capabilityId = 'not-registered';
    options.command.args = [123] as unknown as string[];
    const admission = vi.spyOn(domain, 'checkCapabilityAdmission');
    await expect(supervisor.executeProcess(options)).rejects.toThrow('command.args[0]');
    expect(admission).not.toHaveBeenCalled();
    expect(domain.getStore().getAllOperations(domain.domainId)).toEqual([]);
  });

  it('preserves zero-limit semantics and opaque operation IDs in a real execution', async () => {
    const options = valid();
    options.opId = '../操作 with spaces\0/opaque';
    options.timeoutMs = 0;
    options.waitTimeoutMs = 0;
    options.drainTimeoutMs = 0;
    options.maxOutputBytes = 0;
    options.resourceBudget = { enforcement: 'hard', maxMemoryBytes: 0, maxPids: 0, maxCpuTimeMs: 0, maxOutputBytes: 0 };
    options.command.envWhiteList = { EMPTY: '' };
    options.command.inheritEnv = false;
    options.command.stdin = new Uint8Array([0, 1, 2]);
    options.command.stdinMode = 'once';
    const result = await supervisor.executeProcess(options);
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected a successful execution');
    expect(result.stdout).toContain('truncated 6 bytes');
    expect(result.stdout).not.toContain('output');
    expect(result.stdoutBytes).toBe(6);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutRef).toBeDefined();
    expect(fs.readFileSync(result.stdoutRef!, 'utf8')).toBe('output');
    expect(domain.getStore().getOperation(options.opId)?.result?.status).toBe('succeeded');
    expect(domain.getStore().getPersistedResourceLeases(domain.domainId)).toEqual([]);
  });

  it('accepts timer boundaries, fractional durations, byte limits and both stdin forms without coercion', () => {
    const options = valid();
    options.timeoutMs = 2 ** 31 - 1;
    options.waitTimeoutMs = 0.5;
    options.drainTimeoutMs = 0;
    options.maxOutputBytes = Number.MAX_SAFE_INTEGER;
    options.resourceBudget = { enforcement: 'observe', maxMemoryBytes: Number.MAX_SAFE_INTEGER, maxPids: 0, maxCpuTimeMs: 0.5 };
    options.command.args = [''];
    options.command.stdin = 'text\0with null bytes';
    options.command.envWhiteList = Object.assign(Object.create(null), { EMPTY: '' });
    options.abortSignal = new AbortController().signal;
    options.requiredResources = ['opaque/resource with spaces'];
    options.trackReads = { roots: [], statCaches: 'ruled_out' };
    expect(() => validateExecuteProcessOptions(options)).not.toThrow();
    options.command.stdin = Buffer.from([0, 1, 2]);
    expect(() => validateExecuteProcessOptions(options)).not.toThrow();
  });
});
