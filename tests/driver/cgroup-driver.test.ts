import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CgroupPlatformDriver,
  CgroupUnavailableError,
  ExecutionDomain,
  NodePlatformDriver,
  PlatformDriver,
  ProcessSupervisor,
  RecoveryEngine,
} from '@xioflow/kernel';
import { parseOwnCgroup } from '../../src/driver/cgroup-fs.js';
import { buildDist, repoRoot } from '../support/build-dist.js';
import { cgroupSuiteName, cgroupUnavailable } from '../support/cgroup.js';

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

/** 根进程派生一个脱离会话、关闭 stdio 的后代，可选地自己继续运行。 */
function daemonizeScript(pidFile: string, keepRoot: boolean): string {
  return `
    const { spawn } = require('node:child_process');
    const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));
    d.unref();
    ${keepRoot ? 'setInterval(() => {}, 1000);' : ''}
  `;
}

describe('CgroupPlatformDriver preconditions', () => {
  it('normalizes the cgroup path, including the namespace root of a container', () => {
    expect(parseOwnCgroup('0::/\n')).toBe('/sys/fs/cgroup');
    expect(parseOwnCgroup('0::/user.slice/user-1000.slice/run-x.scope\n')).toBe('/sys/fs/cgroup/user.slice/user-1000.slice/run-x.scope');
    // cgroup v1 混合挂载下没有 `0::` 行：不是纯 v2
    expect(parseOwnCgroup('12:memory:/user.slice\n')).toBeNull();
  });

  it('refuses a root that does not contain the host, never falling back to another driver', () => {
    expect(() => new CgroupPlatformDriver({ root: '/sys/fs/cgroup/xioflow-not-the-host' })).toThrow(CgroupUnavailableError);
    expect(CgroupPlatformDriver.unavailableReason({ root: '/sys/fs/cgroup/xioflow-not-the-host' })).toMatch(
      process.platform === 'linux' ? /must run inside|not mounted|not in a cgroup v2/ : /Linux only/
    );
  });
});

describe.skipIf(cgroupUnavailable !== null)(cgroupSuiteName('CgroupPlatformDriver'), () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: CgroupPlatformDriver;
  let supervisor: ProcessSupervisor;
  const strays: number[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-cgroup-'));
    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'cgroup');
    driver = new CgroupPlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);
    const store = domain.getStore();
    store.saveTask({ id: 't', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'r', taskId: 't', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('declares cgroup containment and the hard limits its delegated controllers allow', () => {
    expect(driver.capabilities.descendantEnumeration).toBe('cgroup');
    expect(driver.capabilities.gatedSpawn).toBe(true);
    expect(driver.capabilities.cpuLimit).toBe(false);
    // 硬限制能力只在控制器真的启用后声明；否则原因必须说出来
    if (driver.limitsUnavailableReason === undefined) {
      expect(driver.capabilities.memoryHardLimit).toBe(true);
      expect(driver.capabilities.pidsLimit).toBe(true);
    } else {
      expect(driver.capabilities.memoryHardLimit && driver.capabilities.pidsLimit).toBe(false);
    }
    if (process.env.XIOFLOW_EXPECT_CGROUP) expect(driver.limitsUnavailableReason).toBeUndefined();
  });

  it('places the process in its own cgroup before it runs, records the path, and removes it once empty', async () => {
    const result = await supervisor.executeProcess({
      runId: 'r',
      opId: 'whereami',
      name: 'whereami',
      command: { execPath: '/bin/cat', args: ['/proc/self/cgroup'], cwd: tempDir },
    });
    const cgroupPath = domain.getStore().getOperation('whereami')?.processIdentity?.cgroupPath;
    expect(cgroupPath).toBeDefined();
    expect(cgroupPath!.startsWith(driver.opsDir)).toBe(true);
    expect(result.stdout.trim()).toBe(`0::${cgroupPath!.slice('/sys/fs/cgroup'.length)}`);
    expect(result.treeSettlement).toBe('empty');
    expect(fs.existsSync(cgroupPath!)).toBe(false);
  });

  it('cancel stops escapees too and confirms it with the containment_cgroup scope', async () => {
    const pidFile = path.join(tempDir, 'escapee.pid');
    const pending = supervisor.executeProcess({
      runId: 'r',
      opId: 'escape',
      name: 'escape',
      command: { execPath: process.execPath, args: ['-e', daemonizeScript(pidFile, true)], cwd: tempDir },
      requiredResources: ['res:escape'],
    });
    const escapee = await readPid(pidFile);
    strays.push(escapee);
    const stop = await supervisor.cancelOperation('escape', 500);
    expect(stop).toMatchObject({ stopped: 'confirmed_stopped', scope: 'containment_cgroup' });
    expect(await waitFor(() => !isAlive(escapee), 2000)).toBe(true);
    expect((await pending).status).toBe('cancelled');
    expect(domain.isResourceLocked('res:escape')).toBe(false);
  });

  it('a failed placement fails the spawn explicitly and leaves nothing running', async () => {
    const broken = new CgroupPlatformDriver();
    // ops 目录的父目录不存在：mkdir 失败（root 用户不受目录权限限制，所以不用只读目录来制造失败）
    Object.defineProperty(broken, 'opsDir', { value: path.join(driver.opsDir, 'missing-parent', 'ops') });
    const result = await new ProcessSupervisor(domain, broken).executeProcess({
      runId: 'r',
      opId: 'unplaced',
      name: 'unplaced',
      command: { execPath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: tempDir },
      requiredResources: ['res:unplaced'],
    });
    expect(result.status).toBe('failed');
    expect(result.spawnFailure).toMatch(/could not place process/);
    expect(domain.isResourceLocked('res:unplaced')).toBe(false);
  });

  describe('crash recovery', () => {
    const worker = path.join(import.meta.dirname, 'cgroup-crash-worker.mjs');
    const distIndex = pathToFileURL(path.join(repoRoot, 'dist/index.js')).href;
    buildDist();

    async function crashWithEscapee(kind: 'cgroup' | 'node') {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-cgroup-crash-'));
      const workDir = path.join(ws, 'work');
      fs.mkdirSync(workDir);
      const run = spawnSync(process.execPath, [worker, distIndex, path.join(ws, 'domain'), workDir, kind], {
        env: { ...process.env, XIOFLOW_TEST_CRASHPOINT: 'supervisor:process-running#1' },
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(run.signal).toBe('SIGKILL');
      const escapee = await readPid(path.join(workDir, 'escapee.pid'));
      strays.push(escapee);
      const recovered = ExecutionDomain.acquire(path.join(ws, 'domain'), 'cgroup-crash');
      // 等根进程自己退出：恢复要面对的是「根已不在、脱离的后代还在」
      const rootPid = recovered.getStore().getOperation('op')!.processIdentity!.pid;
      expect(await waitFor(() => !isAlive(rootPid), 5000)).toBe(true);
      return { ws, escapee, recovered };
    }

    async function recover(domainAfterCrash: ExecutionDomain, recoveryDriver: PlatformDriver) {
      const report = await new RecoveryEngine(domainAfterCrash, recoveryDriver).recover();
      return {
        action: report.recoveredOperations.find((r) => r.opId === 'op')?.action,
        result: domainAfterCrash.getStore().getOperation('op')?.result as any,
        locked: domainAfterCrash.isResourceLocked('res:workspace'),
      };
    }

    it('reaps a daemonized escapee from the recorded cgroup before releasing leases', async () => {
      const { ws, escapee, recovered } = await crashWithEscapee('cgroup');
      try {
        // 根进程已退出，只剩脱离会话的后代：进程组视图里看不到它
        const cgroupPath = recovered.getStore().getOperation('op')?.processIdentity?.cgroupPath;
        expect(cgroupPath).toBeDefined();
        const outcome = await recover(recovered, new CgroupPlatformDriver());
        expect(outcome.action).toBe('marked_dead');
        expect(outcome.result).toMatchObject({ terminationReason: 'exit_unobserved', residualProcessesReaped: true });
        expect(outcome.locked).toBe(false);
        expect(await waitFor(() => !isAlive(escapee), 2000)).toBe(true);
        expect(fs.existsSync(cgroupPath!)).toBe(false);
      } finally {
        recovered.close();
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('baseline: the node driver cannot see the escapee and releases the leases while it runs', async () => {
      const { ws, escapee, recovered } = await crashWithEscapee('node');
      try {
        const outcome = await recover(recovered, new NodePlatformDriver());
        expect(outcome.action).toBe('marked_dead');
        expect(outcome.locked).toBe(false);
        expect(isAlive(escapee)).toBe(true);
      } finally {
        recovered.close();
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
