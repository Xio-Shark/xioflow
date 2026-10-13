import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import type { ProcessIdentity, StructuredCommand, StopProcessResult } from '../../src/driver/types.js';
import { ProcessSupervisor, normalizeResourceName } from '../../src/supervisor/supervisor.js';
import { quickRun } from '../../src/quick-run.js';
import { OperationIdConflictError } from '../../src/types.js';

/** 运行真实进程，仅延迟 spawn 返回；Node 驱动自身的启动门保持命令尚未执行。 */
class ControlledNodeDriver extends NodePlatformDriver {
  spawnCalls = 0;
  terminateCalls = 0;
  private signalSpawn!: () => void;
  readonly spawnStarted = new Promise<void>((resolve) => { this.signalSpawn = resolve; });
  private release!: () => void;
  private readonly spawnGate = new Promise<void>((resolve) => { this.release = resolve; });

  constructor(holdSpawn = false) {
    super();
    if (!holdSpawn) this.releaseSpawn();
  }

  releaseSpawn(): void { this.release(); }

  override async spawn(command: StructuredCommand) {
    this.spawnCalls += 1;
    const handle = await super.spawn(command);
    this.signalSpawn();
    await this.spawnGate;
    return handle;
  }

  override async terminate(identity: ProcessIdentity, graceMs: number) {
    this.terminateCalls += 1;
    return super.terminate(identity, graceMs);
  }
}

describe('同一 ExecutionDomain 的监督器入口协调', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  const domains: ExecutionDomain[] = [];

  function open(name: string): ExecutionDomain {
    const domain = ExecutionDomain.acquire(path.join(tempDir, name), name);
    domains.push(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: name, name: 'Task', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: name, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    return domain;
  }

  function options(opId = 'op', script = "require('fs').appendFileSync('effects.log', 'hit\\n'); console.log('done')") {
    return {
      runId: 'run', opId, name: 'coordinated-process', requiredResources: ['workspace:write:shared'],
      command: { execPath: process.execPath, args: ['-e', script], cwd: tempDir },
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-domain-coordination-'));
    domain = open('domain');
  });

  afterEach(() => {
    for (const domain of domains.splice(0)) domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('跨入口同 tick 同 ID 只执行一次，加入等待不会释放原租约', async () => {
    const driver = new ControlledNodeDriver(true);
    const first = new ProcessSupervisor(domain, driver);
    const second = new ProcessSupervisor(domain);
    const request = options();
    const settled = Promise.allSettled([first.executeProcess(request), second.executeProcess(request)]);
    let owner: string | undefined;
    let persistedOwner: string | undefined;
    try {
      await driver.spawnStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      owner = domain.getResourceOwner(request.requiredResources[0]);
      persistedOwner = domain.getStore().getPersistedResourceLeases(domain.domainId)
        .find((lease) => lease.resourceId === request.requiredResources[0])?.operationId;
    } finally {
      driver.releaseSpawn();
    }
    const results = await settled;
    expect(owner).toBe(request.opId);
    expect(persistedOwner).toBe(request.opId);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Expected both callers to complete');
    expect(results[0].value.status).toBe('succeeded');
    expect(results[1].value).toMatchObject({ status: 'succeeded', replayed: true });
    expect(driver.spawnCalls).toBe(1);
    expect(fs.readFileSync(path.join(tempDir, 'effects.log'), 'utf8')).toBe('hit\n');
  });

  it('跨入口同 ID 不同指纹明确冲突，并保持原操作的租约和执行', async () => {
    const driver = new ControlledNodeDriver(true);
    const first = new ProcessSupervisor(domain, driver);
    const second = new ProcessSupervisor(domain);
    const request = options();
    const settled = Promise.allSettled([
      first.executeProcess(request),
      second.executeProcess({ ...request, command: { ...request.command, args: ['-e', 'console.log("conflict")'] } }),
    ]);
    let owner: string | undefined;
    let persistedOwner: string | undefined;
    try {
      await driver.spawnStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      owner = domain.getResourceOwner(request.requiredResources[0]);
      persistedOwner = domain.getStore().getPersistedResourceLeases(domain.domainId)
        .find((lease) => lease.resourceId === request.requiredResources[0])?.operationId;
    } finally {
      driver.releaseSpawn();
    }
    const [original, conflicting] = await settled;
    expect(owner).toBe(request.opId);
    expect(persistedOwner).toBe(request.opId);
    expect(original.status).toBe('fulfilled');
    expect(conflicting.status).toBe('rejected');
    if (conflicting.status !== 'rejected') throw new Error('Expected conflicting request to reject');
    expect(conflicting.reason).toBeInstanceOf(OperationIdConflictError);
    expect(driver.spawnCalls).toBe(1);
    expect(fs.readFileSync(path.join(tempDir, 'effects.log'), 'utf8')).toBe('hit\n');
  });

  it.each(['cancel', 'stop'] as const)('另一个显式驱动入口通过 %s 停止时仍使用启动驱动', async (mode) => {
    const ownerDriver = new ControlledNodeDriver();
    const otherDriver = new ControlledNodeDriver();
    const first = new ProcessSupervisor(domain, ownerDriver);
    const second = new ProcessSupervisor(domain, otherDriver);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const running = first.executeProcess({
      ...options('cancel', "console.log('ready'); setTimeout(() => {}, 5000)"),
      onStreamChunk: () => ready(),
    });
    await started;
    const stopped = await (mode === 'cancel'
      ? second.cancelOperation('cancel', 10)
      : second.handleStopPipeline('cancel', 'user_cancelled', 10)).catch((error: unknown) => error);
    if (stopped instanceof Error) await first.cancelOperation('cancel', 10);
    const result = await running;
    expect(stopped).not.toBeInstanceOf(Error);
    const confirmed = (stopped as StopProcessResult).stopped === 'confirmed_stopped';
    expect(result.status).toBe(confirmed ? 'cancelled' : 'indeterminate');
    expect(domain.isResourceLocked(normalizeResourceName(options().requiredResources[0]))).toBe(!confirmed);
    expect(ownerDriver.terminateCalls).toBe(1);
    expect(otherDriver.terminateCalls).toBe(0);

    domain.getStore().saveRun({ id: 'independent', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    const other = await second.executeProcess({
      ...options('other-driver', 'console.log("other")'), runId: 'independent', requiredResources: ['independent'],
    });
    expect(other.status).toBe('succeeded');
    expect(otherDriver.spawnCalls).toBe(1);
  });

  it('不同域允许相同 ID 独立执行，且入口复用域的默认快照驱动', async () => {
    const otherDomain = open('other-domain');
    const firstDriver = new ControlledNodeDriver();
    const secondDriver = new ControlledNodeDriver();
    const first = new ProcessSupervisor(domain, firstDriver);
    const sameDomain = new ProcessSupervisor(domain);
    const second = new ProcessSupervisor(otherDomain, secondDriver);
    const results = await Promise.all([first.executeProcess(options()), second.executeProcess(options())]);
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    expect(firstDriver.spawnCalls).toBe(1);
    expect(secondDriver.spawnCalls).toBe(1);
    expect(sameDomain.getSnapshotDriver()).toBe(first.getSnapshotDriver());
    expect(fs.readFileSync(path.join(tempDir, 'effects.log'), 'utf8')).toBe('hit\nhit\n');
  });

  it('quickRun 使用域已有驱动，并与已有监督器加入同一在飞操作', async () => {
    const driver = new ControlledNodeDriver(true);
    const supervisor = new ProcessSupervisor(domain, driver);
    const request = options();
    const settled = Promise.allSettled([
      supervisor.executeProcess(request),
      quickRun(request.command, { ...request, domain }),
    ]);
    await driver.spawnStarted;
    driver.releaseSpawn();
    const results = await settled;
    expect(domain.getDriver()).toBe(driver);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    if (results[1].status !== 'fulfilled') throw new Error('Expected quickRun to join');
    expect(results[1].value).toMatchObject({ status: 'succeeded', replayed: true });
    expect(driver.spawnCalls).toBe(1);
  });

  it('跨入口的重叠读证据观测标记 roots_busy，不重置先来者的访问时间', async () => {
    const root = path.join(tempDir, 'workspace');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'input.txt'), 'input');
    const driver = new ControlledNodeDriver(true);
    const first = new ProcessSupervisor(domain, driver);
    const second = new ProcessSupervisor(domain, driver);
    const request = {
      ...options('read-first', "require('fs').readFileSync('input.txt'); console.log('read')"),
      requiredResources: [],
      command: { ...options().command, args: ['-e', "require('fs').readFileSync('input.txt')"], cwd: root },
      trackReads: { roots: [root] },
    };
    const pending = Promise.all([first.executeProcess(request), second.executeProcess({ ...request, opId: 'read-second' })]);
    await driver.spawnStarted;
    driver.releaseSpawn();
    const results = await pending;
    assert(results[1].kind === 'process');
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    expect(results[1].readEvidence).toMatchObject({ tracking: 'unobserved', reason: 'roots_busy' });
  });
});
