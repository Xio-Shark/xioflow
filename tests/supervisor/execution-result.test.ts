import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  ExecutionDomain,
  ProcessSupervisor,
  computeInputFingerprint,
  quickRun,
} from '../../src/index.js';
import type {
  AgentCommandResult,
  IndeterminateResult,
  ProcessExecutionResult,
  ProcessOperationResult,
} from '../../src/index.js';
import type { ManagedProcessHandle, PlatformDriver, StructuredCommand } from '../../src/driver/types.js';
import { finalizeOperation } from '../../src/supervisor/finalize.js';

/** Controlled driver facts exercise uncertainty without signalling any host process. */
class UnconfirmedDriver implements PlatformDriver {
  readonly name = 'controlled-unconfirmed';
  readonly capabilities = {
    processGroupKill: false, accurateStartTime: false, memoryHardLimit: false,
    pidsLimit: false, cpuLimit: false, descendantEnumeration: 'none' as const, gatedSpawn: true,
  };
  spawnCalls = 0;
  private released!: () => void;
  readonly active = new Promise<void>((resolve) => { this.released = resolve; });

  async spawn(_command: StructuredCommand): Promise<ManagedProcessHandle> {
    this.spawnCalls += 1;
    return {
      identity: { pid: 2_147_483_000, spawnTime: new Date().toISOString() },
      stdout: new PassThrough(), stderr: new PassThrough(),
      onExit: new Promise(() => {}), releaseGate: () => this.released(),
    };
  }
  async verifyIdentity() { return 'cannot_determine' as const; }
  async terminate() {
    return { stopped: 'cannot_determine' as const, scope: 'unknown' as const, errorDetails: 'driver lost observation' };
  }
}

describe('public process execution result contract', () => {
  let root: string;
  let domain: ExecutionDomain;
  let driver: UnconfirmedDriver;
  let supervisor: ProcessSupervisor;
  function registerRun(id: string) {
    domain.getStore().saveRun({ id, taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-execution-result-'));
    domain = ExecutionDomain.acquire(root, 'execution-result');
    driver = new UnconfirmedDriver();
    supervisor = new ProcessSupervisor(domain, driver);
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    registerRun('run');
  });
  afterEach(() => { domain.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('exports the same complete union from every execution facade while preserving exact finalization types', () => {
    expectTypeOf<ReturnType<ProcessSupervisor['executeProcess']>>().toEqualTypeOf<Promise<ProcessExecutionResult>>();
    expectTypeOf<ReturnType<typeof quickRun>>().toEqualTypeOf<Promise<ProcessExecutionResult>>();
    expectTypeOf<AgentCommandResult>().toEqualTypeOf<ProcessExecutionResult>();
    expectTypeOf(finalizeOperation<ProcessOperationResult>).returns.toEqualTypeOf<ProcessOperationResult>();
    expectTypeOf(finalizeOperation<IndeterminateResult>).returns.toEqualTypeOf<IndeterminateResult>();

    const describeResult = (result: ProcessExecutionResult): string => {
      if (result.status === 'indeterminate') {
        expectTypeOf(result).toEqualTypeOf<IndeterminateResult>();
        return result.reason;
      }
      expectTypeOf(result).toEqualTypeOf<ProcessOperationResult>();
      return result.stdout;
    };
    const exhaustiveStatus = (status: ProcessExecutionResult['status']): string => {
      switch (status) {
        case 'succeeded': case 'failed': case 'cancelled': case 'indeterminate': return status;
        default: { const unreachable: never = status; return unreachable; }
      }
    };
    const indeterminate: IndeterminateResult = {
      kind: 'indeterminate', status: 'indeterminate', reason: 'unconfirmed', recoveryGuidance: 'inspect',
      completedAt: new Date().toISOString(), durationMs: 1,
    };
    expect(describeResult(indeterminate)).toBe('unconfirmed');
    expect(exhaustiveStatus(indeterminate.status)).toBe('indeterminate');
  });

  it('preserves an unconfirmed stop through in-flight joins, quickRun, and durable replay without releasing its lease', async () => {
    const command = { execPath: process.execPath, args: ['-e', '0'], cwd: root };
    const options = { opId: 'uncertain', runId: 'run', name: 'uncertain', command, requiredResources: ['exclusive'] };
    const original = supervisor.executeProcess(options);
    const joined = new ProcessSupervisor(domain).executeProcess(options);
    const quickJoined = quickRun(command, { ...options, domain });
    await driver.active;
    expect((await supervisor.cancelOperation(options.opId, 0)).stopped).toBe('cannot_determine');
    const results = await Promise.all([original, joined, quickJoined]);
    for (const result of results) {
      assert(result.status === 'indeterminate');
      expect(result.kind).toBe('indeterminate');
      expect(result.reason).toContain('driver lost observation');
      expect(result.recoveryGuidance).toBeTruthy();
      expect(result.terminationReason).toBe('user_cancelled');
      expect(result).not.toHaveProperty('stdout');
      expect(result).not.toHaveProperty('exitCode');
    }
    expect(results.map((result) => result.replayed)).toEqual([undefined, true, true]);
    expect(driver.spawnCalls).toBe(1);
    expect(domain.isResourceLocked('exclusive')).toBe(true);
    expect(domain.getStore().getRun('run')?.status).toBe('indeterminate');

    const autoReplay = await quickRun(command, {
      domain, opId: options.opId, name: options.name, requiredResources: options.requiredResources,
    });
    expect(autoReplay.status).toBe('indeterminate');
    expect(autoReplay.runId).toBe('run');
    const requestRun = domain.status.runs.find((run) => run.id.startsWith('quick-run-'));
    expect(requestRun).toMatchObject({ status: 'indeterminate', terminationReason: 'user_cancelled' });
    expect(requestRun?.endedAt).toBeTruthy();
    expect(domain.getStore().getOperationsByRun(requestRun!.id)).toEqual([]);

    domain.close();
    domain = ExecutionDomain.acquire(root, 'execution-result');
    supervisor = new ProcessSupervisor(domain, driver);
    registerRun('replay-run');
    const replayOptions = { ...options, runId: 'replay-run' };
    const replayed = await supervisor.executeProcess(replayOptions);
    const quickReplayed = await quickRun(command, { ...replayOptions, domain });
    expect(replayed).toEqual({ ...results[0], replayed: true });
    expect(quickReplayed).toEqual(replayed);
    expect(replayed.runId).toBe('run');
    expect(driver.spawnCalls).toBe(1);
    expect(domain.getStore().getRun('replay-run')?.status).toBe('running');
    expect(domain.getStore().getPersistedResourceLeases(domain.domainId)).toContainEqual(expect.objectContaining({ operationId: options.opId, resourceId: 'exclusive' }));
  });

  it('rejects an incompatible durable result rather than casting it into a process result or executing again', async () => {
    const options = { opId: 'corrupt', runId: 'run', name: 'corrupt', command: { execPath: process.execPath, args: [], cwd: root } };
    domain.getStore().registerOperationIntent({
      id: options.opId, runId: options.runId, name: options.name, kind: 'process',
      inputFingerprint: computeInputFingerprint(options), status: 'pending', requiredResources: [],
    }, domain.domainId);
    domain.getStore().recordOperationResult(options.opId, { kind: 'generic', status: 'succeeded', durationMs: 0, completedAt: new Date().toISOString() });
    await expect(supervisor.executeProcess(options)).rejects.toThrow('stored process result is missing or has an incompatible kind');
    expect(driver.spawnCalls).toBe(0);
  });
});
