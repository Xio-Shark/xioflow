import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { readStartTime } from '../../src/driver/process-facts.js';
import type { ManagedProcessHandle } from '../../src/driver/types.js';

/**
 * 身份核验证据链（ARCHITECTURE §4.1.1）：
 * - commandFingerprint 必须是 sha256，不是可读拼接串；
 * - 「命令行包含 execPath」不能作为肯定证据；
 * - 宿主记录的 spawnTime 只供展示，跨重启身份只看 spawn 时登记的 OS 创建时间 osStartTime；
 * - 驱动不得编造退出事实（post-spawn 'error' 不等于进程已退出）。
 */
describe.skipIf(process.platform === 'win32')('身份核验证据链 §4.1.1', () => {
  const LONG_RUNNING = 'setInterval(() => {}, 1000)';
  const rawChildren: ChildProcess[] = [];
  const handles: ManagedProcessHandle[] = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-identity-'));

  afterEach(async () => {
    for (const child of rawChildren.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    for (const handle of handles.splice(0)) {
      handle.destroyGate?.();
      try {
        process.kill(-handle.identity.pid, 'SIGKILL');
      } catch {}
      await handle.onExit;
    }
  });

  /** 启动一个与内核无关、却与受管命令同名（node）的进程，模拟 PID 复用后的“同名陌生进程”。 */
  async function spawnUnrelatedNode(): Promise<number> {
    const child = spawn(process.execPath, ['-e', LONG_RUNNING], { stdio: 'ignore' });
    rawChildren.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    return child.pid!;
  }

  async function spawnManaged(driver: NodePlatformDriver, args: string[]): Promise<ManagedProcessHandle> {
    const handle = await driver.spawn({ execPath: process.execPath, args, cwd: tempDir });
    handles.push(handle);
    return handle;
  }

  it('[问题 1] commandFingerprint 是 execPath + args 的 sha256', async () => {
    const driver = new NodePlatformDriver();
    const args = ['-e', LONG_RUNNING, 'arg with space', 'a:b'];
    const handle = await spawnManaged(driver, args);

    const expected = createHash('sha256')
      .update(JSON.stringify([process.execPath, ...args]))
      .digest('hex');
    expect(handle.identity.commandFingerprint).toBe(expected);
  });

  it('[问题 2] 同名陌生进程 + 吻合的宿主时钟：命令行包含 execPath 不能证明是原进程', async () => {
    const pid = await spawnUnrelatedNode();
    const driver = new NodePlatformDriver(); // 全新驱动，模拟宿主重启后的跨进程核验

    const verification = await driver.verifyIdentity({
      pid,
      pgid: pid,
      spawnTime: new Date().toISOString(),
      commandFingerprint: `${process.execPath}:-e`,
      bootId: (await driver.readBootId()) ?? undefined,
    });

    // 没有登记 OS 创建时间，就没有可信的肯定证据
    expect(verification).toBe('cannot_determine');
  });

  it('[问题 3a] 登记的 OS 创建时间与实际不符：即使宿主 spawnTime 吻合也必须判为非原进程', async () => {
    const pid = await spawnUnrelatedNode();
    const actual = await readStartTime(pid);
    expect(actual).not.toBeNull();
    const driver = new NodePlatformDriver();

    const verification = await driver.verifyIdentity({
      pid,
      pgid: pid,
      spawnTime: new Date().toISOString(),
      osStartTime: new Date(actual! + 5_000).toISOString(),
      bootId: (await driver.readBootId()) ?? undefined,
    });

    expect(verification).toBe('not_original_process');
  });

  it('[问题 3c] 进程在核验途中退出（存活检查通过、读创建时间时已被回收）：判非原进程，而不是无法判定', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid!;
    const recordedStart = await readStartTime(pid);
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const driver = new NodePlatformDriver();
    // 竞争窗口：第一次存活检查时进程还在，之后才退出
    const realIsPidAlive = (driver as any).isPidAlive.bind(driver);
    let firstCall = true;
    (driver as any).isPidAlive = (target: number) => {
      if (firstCall && target === pid) {
        firstCall = false;
        return true;
      }
      return realIsPidAlive(target);
    };

    const verification = await driver.verifyIdentity({
      pid,
      pgid: pid,
      spawnTime: new Date().toISOString(),
      osStartTime: new Date(recordedStart ?? Date.now()).toISOString(),
      bootId: (await driver.readBootId()) ?? undefined,
    });
    expect(verification).toBe('not_original_process');
  });

  it('[问题 3b] spawn 时登记 osStartTime；跨驱动核验只看 OS 创建时间，宿主 spawnTime 不参与判定', async () => {
    const driverA = new NodePlatformDriver();
    const handle = await spawnManaged(driverA, ['-e', LONG_RUNNING]);
    handle.releaseGate?.();

    expect(handle.identity.osStartTime).toBeDefined();
    expect(Date.parse(handle.identity.osStartTime!)).toBe(await readStartTime(handle.identity.pid));

    const driverB = new NodePlatformDriver();
    const verification = await driverB.verifyIdentity({
      ...handle.identity,
      // 宿主时钟被回拨或记录失真：不影响以 OS 事实为准的判定
      spawnTime: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    });
    expect(verification).toBe('is_original_process');
  });

  it("[问题 4] post-spawn 'error' 不等于进程退出：退出事实只来自真实的 exit/close，且不编造 exitCode", async () => {
    const driver = new NodePlatformDriver();
    const handle = await spawnManaged(driver, ['-e', LONG_RUNNING]);
    handle.releaseGate?.();

    handle.rawProcess.emit('error', new Error('simulated post-spawn error'));

    const early = await Promise.race([
      handle.onRootExit!.then((res) => ({ settled: true as const, res })),
      new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), 300)),
    ]);
    expect(early.settled).toBe(false);

    process.kill(-handle.identity.pid, 'SIGKILL');
    const exit = await handle.onRootExit!;
    expect(exit).toEqual({ exitCode: null, signal: 'SIGKILL' });
    expect(await handle.onExit).toEqual({ exitCode: null, signal: 'SIGKILL' });
  });
});
