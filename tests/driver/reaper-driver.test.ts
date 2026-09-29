import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '@xioflow/kernel';
import { buildReaperHelper } from '../support/reaper-helper.js';

const helperPath = buildReaperHelper();
const expectedScope = process.platform === 'linux' ? 'subreaper_tree' : 'tracked_tree';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

async function readPid(file: string): Promise<number> {
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '', 5000);
  return parseInt(fs.readFileSync(file, 'utf8'), 10);
}

describe('ReaperPlatformDriver', () => {
  let tempDir: string;
  const strays: number[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-reaper-'));
  });

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('declares its tree scope and refuses to construct without a helper', () => {
    const driver = new ReaperPlatformDriver({ helperPath });
    expect(driver.capabilities.gatedSpawn).toBe(true);
    expect(driver.capabilities.descendantEnumeration).toBe(process.platform === 'linux' ? 'subreaper' : 'full');

    const saved = process.env.XIOFLOW_REAPER_PATH;
    process.env.XIOFLOW_REAPER_PATH = path.join(tempDir, 'missing-helper');
    try {
      expect(() => new ReaperPlatformDriver()).toThrow(/xioflow-reaper is not available/);
    } finally {
      if (saved === undefined) delete process.env.XIOFLOW_REAPER_PATH;
      else process.env.XIOFLOW_REAPER_PATH = saved;
    }
  });

  it('reaps a setsid escapee that keeps the output pipes open and reports the real exit', async () => {
    const domain = ExecutionDomain.acquire(tempDir, 'reaper-escape');
    try {
      const store = domain.getStore();
      store.saveTask({ id: 't', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
      store.saveRun({
        id: 'r',
        taskId: 't',
        domainId: domain.domainId,
        owner: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      const supervisor = new ProcessSupervisor(domain, new ReaperPlatformDriver({ helperPath }));
      const pidFile = path.join(tempDir, 'escapee.pid');
      const script = `
        const { spawn } = require('node:child_process');
        const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(sub.pid));
        sub.unref(); // 否则 root 会一直等这个子进程，永远不会自行退出
        process.stdout.write('root-done');
      `;

      const result = await supervisor.executeProcess({
        runId: 'r',
        opId: 'op-escape',
        name: 'escape',
        command: { execPath: process.execPath, args: ['-e', script], cwd: tempDir },
        requiredResources: ['res:escape'],
        drainTimeoutMs: 300,
      });
      const escapee = await readPid(pidFile);
      strays.push(escapee);

      // 默认驱动在这里只能判 indeterminate；持有整棵树的驱动能确认回收并保留真实退出事实
      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('root-done');
      expect(result.residualProcessesReaped).toBe(true);
      expect(await waitFor(() => !isAlive(escapee), 2000)).toBe(true);
      expect(domain.isResourceLocked('res:escape')).toBe(false);
    } finally {
      domain.close();
    }
  });

  it('stops a double-forked orphan whose parent exited immediately', async () => {
    const driver = new ReaperPlatformDriver({ helperPath });
    const pidFile = path.join(tempDir, 'orphan.pid');
    const handle = await driver.spawn({
      execPath: '/bin/sh',
      args: ['-c', `(sh -c 'sleep 30 & echo $! > "${pidFile}"' &); sleep 30`],
      cwd: tempDir,
    });
    handle.releaseGate?.();
    const orphan = await readPid(pidFile);
    strays.push(orphan);
    expect(isAlive(orphan)).toBe(true);

    const res = await driver.terminate(handle.identity, 200);
    expect(res).toEqual({ stopped: 'confirmed_stopped', scope: expectedScope });
    expect(await waitFor(() => !isAlive(orphan), 2000)).toBe(true);
    await handle.onRootExit;
  });

  it('falls back to OS facts when the helper is lost, without inventing an exit code', async () => {
    const driver = new ReaperPlatformDriver({ helperPath });
    const handle = await driver.spawn({ execPath: '/bin/sh', args: ['-c', 'sleep 30'], cwd: tempDir });
    handle.releaseGate?.();
    strays.push(handle.identity.pid);
    expect(await driver.verifyIdentity(handle.identity)).toBe('is_original_process');

    process.kill(handle.rawProcess.helperPid, 'SIGKILL');
    await new Promise((resolve) => handle.stdout.on('close', resolve));
    await waitFor(() => false, 200); // 等控制通道关闭被观察到

    const res = await driver.terminate(handle.identity, 200);
    expect(res.stopped).toBe('confirmed_stopped');
    expect(res.scope).not.toBe(expectedScope);
    await expect(handle.onRootExit).resolves.toEqual({ exitCode: null, signal: null });
  });

  it('stops the whole tree when the supervising host dies', async () => {
    const pidFile = path.join(tempDir, 'tree.pid');
    // 宿主只讲 helper 协议，然后在树运行时被 SIGKILL：helper 看到控制通道 EOF 必须清场
    const hostScript = `
      const { spawn } = require('node:child_process');
      const helper = spawn(${JSON.stringify(helperPath)}, ['/bin/sh', '-c', 'sleep 30 & echo $! > ${pidFile}; sleep 30'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      helper.stdio[3].once('data', () => helper.stdio[3].write('go\\n'));
      setInterval(() => {}, 1000);
    `;
    const host = spawn(process.execPath, ['-e', hostScript], { stdio: 'ignore' });
    const grandchild = await readPid(pidFile);
    strays.push(grandchild);
    expect(isAlive(grandchild)).toBe(true);

    host.kill('SIGKILL');
    expect(await waitFor(() => !isAlive(grandchild), 5000)).toBe(true);
  });
});
