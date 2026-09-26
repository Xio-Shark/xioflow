import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain, quickRun } from '../../src/index.js';

describe('内核 0.3.0: quickRun 便捷入口与自动生命周期 [Step 4]', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let counterFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-quickrun-test-'));
    counterFile = path.join(tempDir, 'counter.log');
    domain = ExecutionDomain.acquire(tempDir, 'test-quickrun-domain');
  });

  afterEach(() => {
    if (!domain.isClosed()) {
      domain.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('4.1a 无 opId 时每次调用都执行全新操作', async () => {
    const script = `require('fs').appendFileSync(process.argv[1], 'hit\\n'); console.log('quick-run-out');`;
    const command = {
      execPath: process.execPath,
      args: ['-e', script, counterFile],
      cwd: tempDir,
    };

    // 第一次调用：未提供 opId
    const res1 = await quickRun(command, { domain });
    expect(res1.status).toBe('succeeded');
    expect(res1.replayed).toBeUndefined();
    expect(res1.stdout).toContain('quick-run-out');

    let lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);

    // 第二次调用：未提供 opId，应再次执行
    const res2 = await quickRun(command, { domain });
    expect(res2.status).toBe('succeeded');
    expect(res2.replayed).toBeUndefined();

    lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('4.1b 提供 opId 时享受幂等保护，重复调用返回已记录事实且副作用仅发生一次', async () => {
    const opId = 'my-idempotent-op';
    const script = `require('fs').appendFileSync(process.argv[1], 'idem-hit\\n'); console.log('idem-out');`;
    const command = {
      execPath: process.execPath,
      args: ['-e', script, counterFile],
      cwd: tempDir,
    };

    // 第一次调用
    const res1 = await quickRun(command, { domain, opId });
    expect(res1.status).toBe('succeeded');
    expect(res1.replayed).toBeUndefined();

    let lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(lines).toEqual(['idem-hit']);

    // 第二次调用：相同 opId、相同输入
    const res2 = await quickRun(command, { domain, opId });
    expect(res2.status).toBe('succeeded');
    expect(res2.replayed).toBe(true);
    expect(res2.stdout).toContain('idem-out');

    // 副作用依然仅发生 1 次
    lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
    expect(lines).toEqual(['idem-hit']);
  });

  it('4.1c 自动建的 Task 与 Run 可在 domain.status 中直接查到', async () => {
    const command = {
      execPath: process.execPath,
      args: ['-e', 'console.log("hello-status")'],
      cwd: tempDir,
    };

    const res = await quickRun(command, { domain });
    expect(res.status).toBe('succeeded');

    // 通过 domain.status 查验自动创建的 Task 与 Run
    const status = domain.status;
    expect(status.domainId).toBe('test-quickrun-domain');
    expect(status.tasks.length).toBeGreaterThanOrEqual(1);
    expect(status.tasks.some((t) => t.id === 'quick-task')).toBe(true);

    expect(status.runs.length).toBeGreaterThanOrEqual(1);
    const autoRun = status.runs.find((r) => r.id.startsWith('quick-run-'));
    expect(autoRun).toBeDefined();
    expect(autoRun?.taskId).toBe('quick-task');
    expect(autoRun?.status).toBe('succeeded');

    // 验证 operation 记录
    expect(status.operations.length).toBeGreaterThanOrEqual(1);
  });

  it('4.1d 自主生命周期：不显式传 domain 时自动创建并安全回收域锁', async () => {
    const customDomainDir = path.join(tempDir, 'isolated-kernel');
    const command = {
      execPath: process.execPath,
      args: ['-e', 'console.log("standalone")'],
      cwd: tempDir,
    };

    const res = await quickRun(command, { domainPath: customDomainDir });
    expect(res.status).toBe('succeeded');
    expect(res.stdout).toContain('standalone');

    // 验证锁文件已安全释放（可以立即被重新 acquire，不报 DomainLockedError）
    const reacquired = ExecutionDomain.acquire(customDomainDir, 'default');
    expect(reacquired.isClosed()).toBe(false);
    reacquired.close();
  });
});
