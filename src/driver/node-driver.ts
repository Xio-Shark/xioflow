import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  PlatformDriver,
  PlatformCapabilities,
  StructuredCommand,
  ManagedProcessHandle,
  ProcessIdentity,
  StopProcessResult,
} from './types.js';
import { IdentityVerificationResult } from '../types.js';
import { readBootId, readStartTime, getGroupMembers } from './process-facts.js';
import { ProcessSampler } from './sampler.js';

function resolveExecutable(bin: string, envPath?: string): string | null {
  if (bin.includes(path.sep)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const dirs = (envPath || process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

export class NodePlatformDriver implements PlatformDriver {
  public readonly name = 'node-default';
  private cachedBootId: Promise<string | null> = readBootId();
  private sampler: ProcessSampler = ProcessSampler.getInstance();

  public async readBootId(): Promise<string | null> {
    return this.cachedBootId;
  }

  public async getGroupEvidence(pgid: number): Promise<{ pid: number; startTimeMs: number | null }[]> {
    return getGroupMembers(pgid);
  }

  public readonly capabilities: PlatformCapabilities = {
    // Windows 无进程组语义：process.kill(-pid) 会失败并退化为只杀直接子进程，
    // 所以必须如实声明不支持，让准入期拒绝 hard 请求而不是静默降级。
    processGroupKill: process.platform !== 'win32',
    accurateStartTime: true,
    startTimeSource: process.platform === 'linux' ? 'procfs' : process.platform === 'darwin' ? 'ps_lstart' : 'none',
    memoryHardLimit: false, // macOS/Node.js 默认不支持进程树 cgroup 内存硬限
    pidsLimit: false,
    cpuLimit: false,
    // 后代枚举依赖 ps(1)：Windows 上无法枚举，不能谎报 full。
    descendantEnumeration: process.platform === 'win32' ? 'none' : 'full',
    // 门管道受控启动：POSIX 平台下通过 /bin/sh 与 stdio[3] 实现
    gatedSpawn: process.platform !== 'win32',
  };

  // 内存中追踪当前驱动启动的所有活跃进程
  private activeHandles: Map<number, { handle: ManagedProcessHandle; child: ChildProcess; startTime: number }> =
    new Map();
  // 持续累积后代 PID 集合：leaderPid -> Set<descendantPid>
  private cumulativeDescendantsMap: Map<number, Set<number>> = new Map();
  private pollerTimer: NodeJS.Timeout | null = null;

  public async spawn(command: StructuredCommand): Promise<ManagedProcessHandle> {
    const stdinPayload =
      command.stdin === undefined
        ? undefined
        : typeof command.stdin === 'string'
          ? Buffer.from(command.stdin, 'utf8')
          : Buffer.from(command.stdin);

    const childEnv: NodeJS.ProcessEnv = command.envWhiteList
      ? { ...command.envWhiteList }
      : command.inheritEnv === false
        ? {}
        : process.env;

    const useGatedSpawn = Boolean(this.capabilities.gatedSpawn);

    // 门管道模式下，先验证二进制是否存在与可执行（P0-3 / 契约 #1 保证）
    if (useGatedSpawn) {
      const resolved = resolveExecutable(command.execPath, childEnv.PATH);
      if (!resolved) {
        const err = new Error(`spawn ${command.execPath} ENOENT`);
        (err as any).code = 'ENOENT';
        (err as any).syscall = `spawn ${command.execPath}`;
        (err as any).path = command.execPath;
        return Promise.reject(err);
      }
    }

    return new Promise<ManagedProcessHandle>((resolve, reject) => {
      let child: ChildProcess;
      let gatePipe: any = null;
      let gateReleased = false;

      const isStreamStdin = command.stdinMode === 'stream';
      const stdinOption = (isStreamStdin || stdinPayload !== undefined) ? 'pipe' : 'ignore';

      try {
        if (useGatedSpawn) {
          const springboard = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec "$0" "$@";';
          child = spawn('/bin/sh', ['-c', springboard, command.execPath, ...command.args], {
            cwd: command.cwd,
            env: childEnv,
            detached: true,
            stdio: [stdinOption, 'pipe', 'pipe', 'pipe'],
          });
          gatePipe = child.stdio[3];
        } else {
          child = spawn(command.execPath, command.args, {
            cwd: command.cwd,
            env: childEnv,
            detached: true,
            stdio: [stdinOption, 'pipe', 'pipe'],
          });
        }
      } catch (err) {
        return reject(err);
      }

      let hasSpawned = false;

      child.on('error', (err) => {
        if (!hasSpawned) {
          reject(err);
        }
      });

      child.on('spawn', async () => {
        hasSpawned = true;
        const pid = child.pid!;
        const startTimeMonotonic = Number(process.hrtime.bigint() / 1000n);
        const bootId = await this.cachedBootId;
        const identity: ProcessIdentity = {
          pid,
          pgid: pid,
          startTimeMonotonic,
          spawnTime: new Date().toISOString(),
          commandFingerprint: `${command.execPath}:${command.args.join(' ')}`,
          bootId: bootId ?? undefined,
        };

        const cumSet = new Set<number>();
        this.cumulativeDescendantsMap.set(pid, cumSet);
        this.ensureSharedPoller();

        const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (exitResolve) => {
            const cleanup = () => {
              this.activeHandles.delete(pid);
              if (this.activeHandles.size === 0) {
                this.stopSharedPoller();
              }
            };
            child.on('close', (exitCode, signal) => {
              cleanup();
              exitResolve({ exitCode, signal });
            });
            child.on('error', () => {
              cleanup();
              exitResolve({ exitCode: 1, signal: null });
            });
          }
        );

        // 根进程真实退出事实：后代仍持有管道时 close 会推迟，这里的 exit 不会。
        const rootExitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (rootResolve) => {
            let settled = false;
            const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
              if (settled) return;
              settled = true;
              rootResolve({ exitCode, signal });
            };
            child.on('exit', (exitCode, signal) => settle(exitCode, signal));
            child.on('error', () => settle(1, null));
            child.on('close', (exitCode, signal) => settle(exitCode, signal));
          }
        );

        const releaseGate = () => {
          if (!gateReleased && gatePipe && !gatePipe.destroyed) {
            gateReleased = true;
            try {
              gatePipe.write('GO\n');
              gatePipe.end();
            } catch {}
          }
        };

        const destroyGate = () => {
          if (!gateReleased && gatePipe && !gatePipe.destroyed) {
            gateReleased = true;
            try {
              gatePipe.destroy();
            } catch {}
          }
        };

        const handle: ManagedProcessHandle = {
          identity,
          stdin: isStreamStdin ? (child.stdin ?? undefined) : undefined,
          stdout: child.stdout!,
          stderr: child.stderr!,
          onRootExit: rootExitPromise,
          onExit: exitPromise,
          rawProcess: child,
          releaseGate: useGatedSpawn ? releaseGate : undefined,
          destroyGate: useGatedSpawn ? destroyGate : undefined,
        };

        this.activeHandles.set(pid, { handle, child, startTime: startTimeMonotonic });

        if (isStreamStdin) {
          if (child.stdin) {
            child.stdin.on('error', () => {});
            if (stdinPayload !== undefined) {
              child.stdin.write(stdinPayload);
            }
          }
        } else if (stdinPayload !== undefined && child.stdin) {
          // 一次性 stdin：写入后关闭。子进程不读就退出的 EPIPE 不是启动失败，由退出码体现。
          child.stdin.on('error', () => {});
          child.stdin.end(stdinPayload);
        }

        resolve(handle);
      });
    });
  }

  private ensureSharedPoller(): void {
    if (this.pollerTimer) return;
    this.pollerTimer = setInterval(async () => {
      if (this.cumulativeDescendantsMap.size === 0) {
        this.stopSharedPoller();
        return;
      }
      try {
        const snapshot = await this.sampler.getSnapshot(30);
        for (const [leaderPid, cumSet] of this.cumulativeDescendantsMap.entries()) {
          const tree = await this.sampler.getProcessTree(leaderPid, snapshot, Array.from(cumSet));
          for (const d of tree.allDescendants) {
            cumSet.add(d);
          }
        }
      } catch {}
    }, 35);
    if (this.pollerTimer.unref) this.pollerTimer.unref();
  }

  private stopSharedPoller(): void {
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer);
      this.pollerTimer = null;
    }
  }

  public async verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult> {
    // 1. 检查操作系统中该 PID 是否存活或为僵尸
    if (!this.isPidAlive(identity.pid) || (await this.sampler.isZombie(identity.pid))) {
      return 'not_original_process';
    }

    // 2. bootId 核对：宿主若已重启，绝不盲目信任 PID (P0-1)
    const currentBootId = await this.readBootId();
    if (identity.bootId && currentBootId && identity.bootId !== currentBootId) {
      return 'cannot_determine';
    }

    // 3. 核对内存中本驱动登记的启动记录
    const tracked = this.activeHandles.get(identity.pid);
    if (tracked) {
      if (
        identity.startTimeMonotonic &&
        Math.abs(tracked.startTime - identity.startTimeMonotonic) < 10000 // 10ms 误差内
      ) {
        return 'is_original_process';
      }
      return 'cannot_determine';
    }

    // 4. 跨崩溃/重启进程恢复：查 OS 进程创建时间与命令行指纹 (P0-1)
    const snapshot = await this.sampler.getSnapshot(100);
    const proc = snapshot.get(identity.pid);

    // 进程在进程表中已不存在，或处于僵尸态（<defunct> / Z），直接判定为死亡
    if (!proc || proc.state === 'Z' || proc.command.includes('<defunct>')) {
      return 'not_original_process';
    }

    // 若命令行指纹不匹配，直接否定为 not_original_process
    if (identity.commandFingerprint) {
      const baseExec = identity.commandFingerprint.split(':')[0];
      if (!proc.command.includes(baseExec)) {
        return 'not_original_process';
      }
    }

    // 若登记了 spawnTime，核对 OS 实际启动时间
    const actualStartTimeMs = await readStartTime(identity.pid);
    if (identity.spawnTime && actualStartTimeMs !== null) {
      const expectedTimeMs = new Date(identity.spawnTime).getTime();
      if (!isNaN(expectedTimeMs)) {
        // macOS ps lstart 为 1 秒精度，允许 3 秒宽限
        if (Math.abs(actualStartTimeMs - expectedTimeMs) > 3000) {
          return 'not_original_process';
        }
        if (proc && identity.commandFingerprint && proc.command.includes(identity.commandFingerprint.split(':')[0])) {
          return 'is_original_process';
        }
      }
    }

    return 'cannot_determine';
  }

  public async terminate(
    identity: ProcessIdentity,
    graceMs: number = 2000
  ): Promise<StopProcessResult> {
    const pid = identity.pid;
    const cumSet = this.cumulativeDescendantsMap.get(pid);

    // 1. 终止前先枚举后代进程树，捕获所有组内进程与逃逸进程
    this.sampler.clearCache();
    const initialTree = await this.sampler.getProcessTree(pid, undefined, cumSet ? Array.from(cumSet) : undefined);
    if (cumSet) {
      for (const d of initialTree.allDescendants) {
        cumSet.add(d);
      }
    }
    const allTrackedPids = new Set<number>([pid, ...initialTree.allDescendants]);
    if (cumSet) {
      for (const cp of cumSet) {
        allTrackedPids.add(cp);
      }
    }

    // 若原主进程已死且无任何进程组或后代存活，直接收尾
    const isGroupAlive = await this.sampler.isGroupAlive(pid);
    const aliveBeforeSignals = Array.from(allTrackedPids).filter((p) => p !== pid && this.isPidAlive(p));
    if (!this.isPidAlive(pid) && !isGroupAlive && aliveBeforeSignals.length === 0) {
      this.cumulativeDescendantsMap.delete(pid);
      return { stopped: 'confirmed_stopped', scope: 'direct_child' };
    }

    // 第一阶段：SIGINT 中断信号至整组
    this.sendSignalToGroup(pid, 'SIGINT');
    let exited = await this.waitForGroupAndPids(pid, initialTree.inGroupDescendants, graceMs);

    if (!exited) {
      // 第二阶段：SIGTERM 终止信号至整组
      this.sendSignalToGroup(pid, 'SIGTERM');
      exited = await this.waitForGroupAndPids(pid, initialTree.inGroupDescendants, 1000);
    }

    if (!exited) {
      // 第三阶段：SIGKILL 强制终止至整组
      this.sendSignalToGroup(pid, 'SIGKILL');
      exited = await this.waitForGroupAndPids(pid, initialTree.inGroupDescendants, 1000);
    }

    // 组空后再次扫描后代，核查是否有任何残留进程或 setsid 逃逸孤儿
    this.sampler.clearCache();
    const postTree = await this.sampler.getProcessTree(pid, undefined, cumSet ? Array.from(cumSet) : undefined);
    for (const p of postTree.allDescendants) {
      allTrackedPids.add(p);
    }
    if (cumSet) {
      for (const cp of cumSet) {
        allTrackedPids.add(cp);
      }
    }

    // 探活所有曾属于该进程树的后代
    const aliveResiduals = Array.from(allTrackedPids).filter((p) => this.isPidAlive(p));

    if (aliveResiduals.length > 0) {
      // 存在逃逸或残留孤儿，如实标记 cannot_determine 与 residualPids
      return {
        stopped: 'cannot_determine',
        scope: 'unknown',
        residualPids: aliveResiduals,
        errorDetails: `Residual or escaped processes still alive after termination: ${aliveResiduals.join(', ')}`,
      };
    }

    this.cumulativeDescendantsMap.delete(pid);
    return { stopped: 'confirmed_stopped', scope: 'process_group' };
  }

  public async terminateGroup(pgid: number, graceMs: number = 2000): Promise<StopProcessResult> {
    if (!this.capabilities.processGroupKill) {
      return {
        stopped: 'not_stopped',
        scope: 'unknown',
        errorDetails: 'process groups are not supported on this platform',
      };
    }
    if (!(await this.sampler.isGroupAlive(pgid))) {
      return { stopped: 'confirmed_stopped', scope: 'process_group' };
    }

    this.sendSignalToGroup(pgid, 'SIGKILL');
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      this.sampler.clearCache();
      if (!(await this.sampler.isGroupAlive(pgid))) {
        this.cumulativeDescendantsMap.delete(pgid);
        return { stopped: 'confirmed_stopped', scope: 'process_group' };
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const snapshot = await this.sampler.getSnapshot(10);
    const survivors: number[] = [];
    for (const entry of snapshot.values()) {
      if (entry.state === 'Z') continue;
      if (entry.pgid === pgid) survivors.push(entry.pid);
    }
    return {
      stopped: survivors.length === 0 ? 'confirmed_stopped' : 'cannot_determine',
      scope: 'process_group',
      residualPids: survivors.length > 0 ? survivors : undefined,
    };
  }

  public async sampleMetrics(
    identity: ProcessIdentity
  ): Promise<{ rssBytes: number; pidsCount: number; cpuTimeMs: number }> {
    try {
      const tree = await this.sampler.getProcessTree(identity.pid);
      const targetPids = [identity.pid, ...tree.allDescendants].filter((p) => this.isPidAlive(p));
      if (targetPids.length === 0) {
        return { rssBytes: 0, pidsCount: 0, cpuTimeMs: 0 };
      }
      return this.sampler.sampleMetrics(targetPids);
    } catch {
      return { rssBytes: 0, pidsCount: 0, cpuTimeMs: 0 };
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err.code === 'EPERM';
    }
  }

  private sendSignalToGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (err: any) {
      if (err && err.code === 'ESRCH') {
        // ESRCH 表示该进程组已不存在或已完全清空，如实返回
        return;
      }
      // 其他错误（如 EPERM）如实上抛，禁止退回向单 PID 发信号（N5 / 契约 #42）
      throw err;
    }
  }

  private async waitForGroupAndPids(
    pid: number,
    inGroupPids: number[],
    timeoutMs: number
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.sampler.clearCache();
      const grpAlive = await this.sampler.isGroupAlive(pid);
      const procAlive = this.isPidAlive(pid);
      const inGrpAlive = inGroupPids.some((p) => this.isPidAlive(p));

      if (!grpAlive && !procAlive && !inGrpAlive) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    this.sampler.clearCache();
    const stillGrp = await this.sampler.isGroupAlive(pid);
    const stillProc = this.isPidAlive(pid);
    const stillInGrp = inGroupPids.some((p) => this.isPidAlive(p));
    return !stillGrp && !stillProc && !stillInGrp;
  }
}
