import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';

describe('内核长驻 service op: Step 1 stdinMode stream 驱动层测试', () => {
  let tempDir: string;
  let driver: NodePlatformDriver;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-service-test-'));
    driver = new NodePlatformDriver();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1.1a stdinMode: stream 保留 stdin 管道并支持多次写入与逐次回显', async () => {
    // 持续回显测试脚本
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on('line', (line) => {
        console.log('ECHO:' + line);
      });
      rl.on('close', () => {
        process.exit(0);
      });
    `;

    const handle = await driver.spawn({
      execPath: process.execPath,
      args: ['-e', script],
      cwd: tempDir,
      stdinMode: 'stream',
    });

    if (handle.releaseGate) {
      handle.releaseGate();
    }

    expect(handle.stdin).toBeDefined();

    const outputChunks: string[] = [];
    handle.stdout.on('data', (chunk) => {
      outputChunks.push(chunk.toString());
    });

    const waitFor = async (pattern: string, timeoutMs = 2000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (outputChunks.join('').includes(pattern)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(outputChunks.join('')).toContain(pattern);
    };

    // 写入第 1 行
    (handle.stdin as any).write('msg1\n');
    await waitFor('ECHO:msg1');

    // 写入第 2 行
    (handle.stdin as any).write('msg2\n');
    await waitFor('ECHO:msg2');

    // 写入第 3 行并关闭 stdin 管道
    (handle.stdin as any).end('msg3\n');
    const exitResult = await handle.onExit;
    expect(exitResult.exitCode).toBe(0);
    expect(outputChunks.join('')).toContain('ECHO:msg3');
  });

  it('1.1b 默认或 stdinMode: once 保持单次写入并自动关闭 stdin 管道', async () => {
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on('line', (line) => {
        console.log('ONCE:' + line);
      });
    `;

    const handle = await driver.spawn({
      execPath: process.execPath,
      args: ['-e', script],
      cwd: tempDir,
      stdin: 'hello-once\n',
      stdinMode: 'once',
    });

    if (handle.releaseGate) {
      handle.releaseGate();
    }

    const outputChunks: string[] = [];
    handle.stdout.on('data', (chunk) => {
      outputChunks.push(chunk.toString());
    });

    const exitResult = await handle.onExit;
    expect(exitResult.exitCode).toBe(0);
    expect(outputChunks.join('')).toContain('ONCE:hello-once');
  });
});

describe('内核长驻 service op: Step 2-4 startService, readiness 与 restart', () => {
  let tempDir: string;
  let domain: any;
  let supervisor: any;
  let runId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-service-sup-test-'));
    domain = ExecutionDomain.acquire(tempDir, 'test-service-domain');
    supervisor = new ProcessSupervisor(domain);

    const store = domain.getStore();
    store.saveTask({ id: 'task-srv', domainId: domain.domainId, name: 'srv-task', createdAt: new Date().toISOString() });
    runId = 'run-srv-1';
    store.saveRun({ id: runId, taskId: 'task-srv', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    if (domain && !domain.isClosed()) {
      domain.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('2.1 startService 返回 handle，实例为 <serviceId>#1，登记 SERVICE_STARTED 事件', async () => {
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on('line', (line) => console.log('REPLY:' + line));
    `;

    const handle = await supervisor.startService({
      serviceId: 'mcp-server-1',
      runId,
      command: {
        execPath: process.execPath,
        args: ['-e', script],
        cwd: tempDir,
      },
      readiness: 'spawned',
    });

    expect(handle.serviceId).toBe('mcp-server-1');
    expect(handle.currentInstanceOpId).toBe('mcp-server-1#1');

    const readyFact = await handle.ready;
    expect(readyFact.serviceId).toBe('mcp-server-1');
    expect(readyFact.instanceIndex).toBe(1);

    // 检查 journal 事件
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const startedEvt = events.find((e: any) => e.type === 'SERVICE_STARTED' && e.payload?.serviceId === 'mcp-server-1');
    expect(startedEvt).toBeDefined();
    expect(startedEvt.payload.instanceIndex).toBe(1);

    const readyEvt = events.find((e: any) => e.type === 'SERVICE_READY' && e.payload?.serviceId === 'mcp-server-1');
    expect(readyEvt).toBeDefined();

    // 停止 service
    await handle.stop(1000);

    const stoppedEvents = domain.getStore().getJournalEvents(domain.domainId);
    const stoppedEvt = stoppedEvents.find((e: any) => e.type === 'SERVICE_STOPPED' && e.payload?.serviceId === 'mcp-server-1');
    expect(stoppedEvt).toBeDefined();
  });

  it('2.2 stdout 直通消费：调用方实时接收多行输出且内核不在内存保留无界输出', async () => {
    const script = `
      for (let i = 0; i < 50; i++) {
        console.log('LINE_' + i);
      }
      setInterval(() => {}, 1000);
    `;

    const handle = await supervisor.startService({
      serviceId: 'dev-server-stdout',
      runId,
      command: {
        execPath: process.execPath,
        args: ['-e', script],
        cwd: tempDir,
      },
      readiness: 'spawned',
    });

    await handle.ready;

    const receivedLines: string[] = [];
    handle.stdout.on('data', (chunk: Buffer) => {
      const parts = chunk.toString().split('\n');
      for (const p of parts) {
        if (p.trim()) receivedLines.push(p.trim());
      }
    });

    // 等待接收完成
    const start = Date.now();
    while (receivedLines.length < 50 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedLines.length).toBeGreaterThanOrEqual(50);
    expect(receivedLines[0]).toBe('LINE_0');
    expect(receivedLines[49]).toBe('LINE_49');

    await handle.stop(500);
  });

  it('2.3 stderr 超过上限时按 B3 规则截断与转储', async () => {
    const artifactsDir = path.join(tempDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });

    const stderrChunk = 'E'.repeat(2000);
    const script = `
      process.stderr.write(${JSON.stringify(stderrChunk)});
      console.log('READY');
      setInterval(() => {}, 1000);
    `;

    const handle = await supervisor.startService({
      serviceId: 'service-stderr-b3',
      runId,
      command: {
        execPath: process.execPath,
        args: ['-e', script],
        cwd: tempDir,
      },
      readiness: { stdoutLine: /^READY$/ },
      maxStderrBytes: 200,
      artifactsDir,
    });

    await handle.ready;
    await handle.stop(500);

    const op = domain.getStore().getOperation('service-stderr-b3#1');
    expect(op).toBeDefined();
    expect(op?.result).toBeDefined();
    const result = op?.result as any;
    expect(result.isTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr).toMatch(/\[\.\.\. truncated \d+ bytes \.\.\.\]/);
    expect(result.stderrRef).toBeDefined();
    expect(fs.existsSync(result.stderrRef)).toBe(true);
    const dumpedContent = fs.readFileSync(result.stderrRef, 'utf8');
    expect(dumpedContent.length).toBe(2000);
  });

  it('3.1 readiness: stdoutLine 模式匹配特征行后就绪，超时则自动停止并记录失败', async () => {
    // 1) 成功匹配模式
    const successScript = `
      setTimeout(() => {
        console.log('Server initialized and listening on 127.0.0.1:3000');
      }, 100);
      setInterval(() => {}, 1000);
    `;

    const handle = await supervisor.startService({
      serviceId: 'web-srv-ready',
      runId,
      command: {
        execPath: process.execPath,
        args: ['-e', successScript],
        cwd: tempDir,
      },
      readiness: { stdoutLine: /listening on (.*)/, timeoutMs: 2000 },
    });

    const readyFact = await handle.ready;
    expect(readyFact.serviceId).toBe('web-srv-ready');
    expect(readyFact.matchedLine).toContain('listening on 127.0.0.1:3000');

    await handle.stop(500);

    // 2) 超时未匹配模式
    const slowScript = `
      setTimeout(() => console.log('late output'), 2000);
      setInterval(() => {}, 1000);
    `;

    const timeoutHandle = await supervisor.startService({
      serviceId: 'slow-srv',
      runId,
      command: {
        execPath: process.execPath,
        args: ['-e', slowScript],
        cwd: tempDir,
      },
      readiness: { stdoutLine: /NEVER_PRINTED/, timeoutMs: 300 },
    });

    await expect(timeoutHandle.ready).rejects.toThrow(/timed out|timeout/i);
  });

  it('4.1 restart on-failure 自动重启至 maxRestarts 上限并写 SERVICE_RESTARTED / SERVICE_FAILED', async () => {
    // 脚本读 1 行后以非零码 42 退出
    const crashScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.once('line', () => {
        process.exit(42);
      });
    `;

    const handle = await supervisor.startService({
      serviceId: 'crash-service',
      runId,
      command: {
        execPath: process.execPath,
        args: ['-e', crashScript],
        cwd: tempDir,
      },
      readiness: 'spawned',
      restart: { policy: 'on-failure', maxRestarts: 2, backoffMs: 50 },
    });

    await handle.ready;
    expect(handle.currentInstanceOpId).toBe('crash-service#1');

    // 触发 instance #1 退出
    handle.stdin.write('die-1\n');
    const start1 = Date.now();
    while (handle.currentInstanceOpId !== 'crash-service#2' && Date.now() - start1 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // 应该已重启至 instance #2
    expect(handle.currentInstanceOpId).toBe('crash-service#2');

    // 触发 instance #2 退出
    handle.stdin.write('die-2\n');
    const start2 = Date.now();
    while (handle.currentInstanceOpId !== 'crash-service#3' && Date.now() - start2 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // 应该已重启至 instance #3
    expect(handle.currentInstanceOpId).toBe('crash-service#3');

    // 触发 instance #3 退出，已达到上限 (maxRestarts=2，总计3次实例)
    handle.stdin.write('die-3\n');
    const start3 = Date.now();
    let events = domain.getStore().getJournalEvents(domain.domainId);
    while (!events.some((e: any) => e.type === 'SERVICE_FAILED' && e.payload?.serviceId === 'crash-service') && Date.now() - start3 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
      events = domain.getStore().getJournalEvents(domain.domainId);
    }

    events = domain.getStore().getJournalEvents(domain.domainId);
    const restarts = events.filter((e: any) => e.type === 'SERVICE_RESTARTED' && e.payload?.serviceId === 'crash-service');
    expect(restarts.length).toBe(2);

    const failed = events.find((e: any) => e.type === 'SERVICE_FAILED' && e.payload?.serviceId === 'crash-service');
    expect(failed).toBeDefined();
    expect(failed.payload.maxRestartsExceeded).toBe(true);
  });

  it('4.2 显式 stop() 不触发重启；重复 startService 命中运行中 handle 或拒绝已终态', async () => {
    const script = `setInterval(() => {}, 1000);`;
    const handle = await supervisor.startService({
      serviceId: 'no-restart-on-stop',
      runId,
      command: { execPath: process.execPath, args: ['-e', script], cwd: tempDir },
      restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 50 },
    });

    await handle.ready;

    // 运行中重复调用 startService 返回同一 handle
    const handle2 = await supervisor.startService({
      serviceId: 'no-restart-on-stop',
      runId,
      command: { execPath: process.execPath, args: ['-e', script], cwd: tempDir },
    });
    expect(handle2).toBe(handle);

    // 显式停止
    await handle.stop(500);

    // 停止后不再重启
    await new Promise((r) => setTimeout(r, 150));
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const restarts = events.filter((e: any) => e.type === 'SERVICE_RESTARTED' && e.payload?.serviceId === 'no-restart-on-stop');
    expect(restarts.length).toBe(0);

    // 已终态后再次调用应拒绝
    await expect(
      supervisor.startService({
        serviceId: 'no-restart-on-stop',
        runId,
        command: { execPath: process.execPath, args: ['-e', script], cwd: tempDir },
      })
    ).rejects.toThrow(/already/i);
  });

  it('4.3 重启间隙保持 service 级资源租约，阻止并发 op 抢占', async () => {
    const resource = 'exclusive-port-8080';
    const crashScript = `
      setTimeout(() => process.exit(1), 50);
    `;

    const handle = await supervisor.startService({
      serviceId: 'resource-srv',
      runId,
      command: { execPath: process.execPath, args: ['-e', crashScript], cwd: tempDir },
      requiredResources: [resource],
      restart: { policy: 'on-failure', maxRestarts: 1, backoffMs: 200 },
    });

    await handle.ready;

    // 等待 instance #1 退出进入重启 backoff (200ms)
    await new Promise((r) => setTimeout(r, 100));

    // 在 backoff 间隙，另一个 op 尝试申请同一资源，应被拒绝
    await expect(
      supervisor.executeProcess({
        opId: 'competing-op',
        runId,
        command: { execPath: process.execPath, args: ['-e', ''], cwd: tempDir },
        requiredResources: [resource],
      })
    ).rejects.toThrow(/Resource conflict|is held/i);

    await handle.stop(500);
  });
});

describe('内核长驻 service op: Step 5 崩溃恢复与 service 治理', () => {
  let tempDir: string;
  let driver: NodePlatformDriver;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  const runId = 'run-recovery-service';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-service-recovery-'));
    driver = new NodePlatformDriver();
    domain = ExecutionDomain.acquire(tempDir, 'recovery-test-domain');
    domain.getStore().saveTask({
      id: 'task-service-recovery',
      domainId: domain.domainId,
      name: 'recovery-task',
      createdAt: new Date().toISOString(),
    });
    domain.getStore().saveRun({
      id: runId,
      taskId: 'task-service-recovery',
      domainId: domain.domainId,
      owner: 'test-agent',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    supervisor = new ProcessSupervisor(domain, driver);
  });

  afterEach(() => {
    try {
      domain.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('5.1 运行中 service 的宿主崩溃后重新 acquire + recover(): 实例被停止、租约释放、报告聚合 serviceId、无新实例', async () => {
    const resource = 'exclusive-mcp-port';
    const script = `
      console.log('READY');
      setInterval(() => {}, 1000);
    `;

    const handle = await supervisor.startService({
      serviceId: 'mcp-crash-srv',
      runId,
      command: { execPath: process.execPath, args: ['-e', script], cwd: tempDir },
      requiredResources: [resource],
      readiness: { stdoutLine: /^READY$/ },
      restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 50 },
    });

    await handle.ready;
    expect(domain.isResourceLocked(resource)).toBe(true);

    const op = domain.getStore().getOperation('mcp-crash-srv#1');
    expect(op?.processIdentity?.pid).toBeDefined();
    const childPid = op!.processIdentity!.pid;

    // 验证子进程处于存活状态
    expect(() => process.kill(childPid, 0)).not.toThrow();

    // 模拟宿主进程异常崩溃（关闭原 domain 模拟宿主失联退出，但不调用 handle.stop()）
    domain.close();

    // 子进程依然存活
    expect(() => process.kill(childPid, 0)).not.toThrow();

    // 新宿主启动并 acquire 该 domain
    const restartedDomain = ExecutionDomain.acquire(tempDir, 'recovery-test-domain');
    expect(restartedDomain.isResourceLocked(resource)).toBe(true);

    // 运行恢复引擎
    const recoveryEngine = new RecoveryEngine(restartedDomain, driver);
    const report = await recoveryEngine.recover();

    // 1. 验证报告中包含 recoveredServices 聚合维度
    expect(report.recoveredServices).toBeDefined();
    const srvReport = report.recoveredServices!.find((s) => s.serviceId === 'mcp-crash-srv');
    expect(srvReport).toBeDefined();
    expect(srvReport?.resourcesReleased).toBe(true);
    expect(srvReport?.instanceOpIds).toContain('mcp-crash-srv#1');

    // 2. 验证受管子进程已被确认为停止 (killed)
    await new Promise((r) => setTimeout(r, 100));
    let isAlive = true;
    try {
      process.kill(childPid, 0);
    } catch (err: any) {
      if (err.code === 'ESRCH') isAlive = false;
    }
    expect(isAlive).toBe(false);

    // 3. 验证 service 租约已释放
    expect(restartedDomain.isResourceLocked(resource)).toBe(false);

    // 4. 验证 journal 记录了 SERVICE_STOPPED
    const events = restartedDomain.getStore().getJournalEvents(restartedDomain.domainId);
    const serviceStopped = events.find(
      (e: any) => e.type === 'SERVICE_STOPPED' && e.payload?.serviceId === 'mcp-crash-srv'
    );
    expect(serviceStopped).toBeDefined();
    expect(serviceStopped?.payload.reason).toBe('recovered_after_crash');

    // 5. 验证没有自动重启产生新实例 (无 mcp-crash-srv#2)
    await new Promise((r) => setTimeout(r, 200));
    const allOps = restartedDomain.getStore().getOperationsByRun(runId);
    const nextInstance = allOps.find((o) => o.id === 'mcp-crash-srv#2');
    expect(nextInstance).toBeUndefined();

    restartedDomain.close();
  });
});

