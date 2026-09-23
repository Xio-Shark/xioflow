import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import {
  PlatformDriver,
  PlatformCapabilities,
  StructuredCommand,
  ManagedProcessHandle,
  ProcessIdentity,
  StopProcessResult,
} from './types.js';
import { IdentityVerificationResult } from '../types.js';

export class NodePlatformDriver implements PlatformDriver {
  public readonly name = 'node-default';
  public readonly capabilities: PlatformCapabilities = {
    // Windows 无进程组语义：process.kill(-pid) 会失败并退化为只杀直接子进程，
    // 所以必须如实声明不支持，让准入期拒绝 hard 请求而不是静默降级。
    processGroupKill: process.platform !== 'win32',
    accurateStartTime: true,
    memoryHardLimit: false, // macOS/Node.js 默认不支持进程树 cgroup 内存硬限
    pidsLimit: false,
    cpuLimit: false,
    // 后代枚举依赖 ps(1)：Windows 上无法枚举，不能谎报 full。
    descendantEnumeration: process.platform === 'win32' ? 'none' : 'full',
  };

  // 内存中追踪当前驱动启动的所有活跃进程
  private activeHandles: Map<number, { handle: ManagedProcessHandle; child: ChildProcess; startTime: number }> =
    new Map();
  // 持续累积后代 PID 集合：leaderPid -> Set<descendantPid>
  private cumulativeDescendantsMap: Map<number, Set<number>> = new Map();
  // 活跃进程树监控定时器：leaderPid -> Timeout
  private descendantPollers: Map<number, NodeJS.Timeout> = new Map();

  public async spawn(command: StructuredCommand): Promise<ManagedProcessHandle> {
    const stdinPayload =
      command.stdin === undefined
        ? undefined
        : typeof command.stdin === 'string'
          ? Buffer.from(command.stdin, 'utf8')
          : Buffer.from(command.stdin);

    return new Promise<ManagedProcessHandle>((resolve, reject) => {
      let child: ChildProcess;
      try {
        // envWhiteList 是精确语义：给了什么就是什么，不静默补 PATH。
        const childEnv: NodeJS.ProcessEnv = command.envWhiteList
          ? { ...command.envWhiteList }
          : command.inheritEnv === false
            ? {}
            : process.env;

        child = spawn(command.execPath, command.args, {
          cwd: command.cwd,
          env: childEnv,
          detached: true,
          stdio: [stdinPayload === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }

      let hasSpawned = false;

      child.on('error', (err) => {
        if (!hasSpawned) {
          reject(err);
        }
      });

      child.on('spawn', () => {
        hasSpawned = true;
        const pid = child.pid!;
        const startTimeMonotonic = Number(process.hrtime.bigint() / 1000n);
        const identity: ProcessIdentity = {
          pid,
          pgid: pid,
          startTimeMonotonic,
          spawnTime: new Date().toISOString(),
          commandFingerprint: `${command.execPath}:${command.args.join(' ')}`,
        };

        const cumSet = new Set<number>();
        this.cumulativeDescendantsMap.set(pid, cumSet);

        const scanDescendants = () => {
          const currentCum = this.cumulativeDescendantsMap.get(pid);
          if (!currentCum) return;
          const tree = this.getProcessTree(pid);
          for (const d of tree.allDescendants) {
            currentCum.add(d);
          }
        };

        scanDescendants();
        const poller = setInterval(scanDescendants, 30);
        if (poller.unref) poller.unref();
        this.descendantPollers.set(pid, poller);

        const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (exitResolve) => {
            const cleanup = () => {
              const p = this.descendantPollers.get(pid);
              if (p) {
                clearInterval(p);
                this.descendantPollers.delete(pid);
              }
              this.activeHandles.delete(pid);
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

        const handle: ManagedProcessHandle = {
          identity,
          stdout: child.stdout!,
          stderr: child.stderr!,
          onRootExit: rootExitPromise,
          onExit: exitPromise,
          rawProcess: child,
        };

        this.activeHandles.set(pid, { handle, child, startTime: startTimeMonotonic });

        // 一次性 stdin：写入后关闭。子进程不读就退出的 EPIPE 不是启动失败，由退出码体现。
        if (stdinPayload !== undefined && child.stdin) {
          child.stdin.on('error', () => {});
          child.stdin.end(stdinPayload);
        }

        resolve(handle);
      });
    });
  }

  public async verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult> {
    // 1. 检查操作系统中该 PID 是否存活。僵尸进程（已退出、等待父进程收尸）不能再算
    //    存活：它既不会继续工作，ps 里的命令也已经变成 `<defunct>`，若按存活处理就会
    //    走到下面的指纹校验并得出 cannot_determine，把一个已经确定的崩溃错判成不可知。
    if (!this.isPidAlive(identity.pid) || this.isZombie(identity.pid)) {
      return 'not_original_process';
    }

    // 2. 核对内存中本驱动登记的启动记录
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

    // 3. 跨崩溃/重启进程恢复：查 OS 进程命令行指纹验证真实身份
    if (identity.commandFingerprint) {
      try {
        const cmdLine = execFileSync('ps', ['-p', String(identity.pid), '-o', 'command='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const baseExec = identity.commandFingerprint.split(':')[0];
        if (cmdLine && cmdLine.includes(baseExec)) {
          return 'is_original_process';
        }
      } catch {
        return 'cannot_determine';
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
    const initialTree = this.getProcessTree(pid);
    const allTrackedPids = new Set<number>([pid, ...initialTree.allDescendants]);
    if (cumSet) {
      for (const cp of cumSet) {
        allTrackedPids.add(cp);
      }
    }

    // 若原主进程已死且无任何后代存活，直接收尾
    const aliveBeforeSignals = Array.from(allTrackedPids).filter((p) => p !== pid && this.isPidAlive(p));
    if (!this.isPidAlive(pid) && aliveBeforeSignals.length === 0) {
      this.cumulativeDescendantsMap.delete(pid);
      return { stopped: true, scope: 'direct_child' };
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
    const postTree = this.getProcessTree(pid);
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
      // 存在逃逸或残留孤儿，如实标记 stopped: false 与 residualPids
      return {
        stopped: false,
        scope: 'unknown',
        residualPids: aliveResiduals,
        errorDetails: `Residual or escaped processes still alive after termination: ${aliveResiduals.join(', ')}`,
      };
    }

    this.cumulativeDescendantsMap.delete(pid);
    return { stopped: true, scope: 'process_group' };
  }

  /**
   * 崩溃恢复专用：leader 已经死了（通常是 SIGKILL 后的僵尸），但组里可能还有后代
   * 进程活着。这些进程没有任何 owner，唯一诚实的处置是按 pgid 定向清场，并在返回前
   * 确认组已经空了——否则残留进程会被继续留在这个域里。
   */
  public async terminateGroup(pgid: number, graceMs: number = 2000): Promise<StopProcessResult> {
    if (!this.capabilities.processGroupKill) {
      return {
        stopped: false,
        scope: 'unknown',
        errorDetails: 'process groups are not supported on this platform',
      };
    }
    if (!this.isGroupAlive(pgid)) {
      return { stopped: true, scope: 'process_group' };
    }

    this.sendSignalToGroup(pgid, 'SIGKILL');
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      if (!this.isGroupAlive(pgid)) {
        this.cumulativeDescendantsMap.delete(pgid);
        return { stopped: true, scope: 'process_group' };
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const survivors: number[] = [];
    for (const entry of this.processTable().values()) {
      if (entry.state === 'Z') continue;
      if (entry.pgid === pgid) survivors.push(entry.pid);
    }
    return {
      stopped: survivors.length === 0,
      scope: 'process_group',
      residualPids: survivors.length > 0 ? survivors : undefined,
    };
  }

  public async sampleMetrics(
    identity: ProcessIdentity
  ): Promise<{ rssBytes: number; pidsCount: number; cpuTimeMs: number }> {
    try {
      const tree = this.getProcessTree(identity.pid);
      const targetPids = [identity.pid, ...tree.allDescendants].filter((p) => this.isPidAlive(p));

      if (targetPids.length === 0) {
        return { rssBytes: 0, pidsCount: 0, cpuTimeMs: 0 };
      }

      const out = execFileSync('ps', ['-p', targetPids.join(','), '-o', 'pid=,rss=,time='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let totalRssKb = 0;
      let totalCpuMs = 0;
      let count = 0;

      const lines = out.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          const rssKb = parseInt(parts[1], 10) || 0;
          const timeStr = parts[2];
          totalRssKb += rssKb;
          totalCpuMs += this.parseCpuTimeToMs(timeStr);
          count++;
        }
      }

      return {
        rssBytes: totalRssKb * 1024,
        pidsCount: count || targetPids.length,
        cpuTimeMs: totalCpuMs,
      };
    } catch {
      return { rssBytes: 0, pidsCount: 0, cpuTimeMs: 0 };
    }
  }

  public getProcessTree(leaderPid: number): {
    allDescendants: number[];
    inGroupDescendants: number[];
    escapedDescendants: number[];
  } {
    const allProcs = this.getAllProcesses();
    const procsByPid = new Map<number, { pid: number; ppid: number; pgid: number; command: string }>();
    const childrenMap = new Map<number, { pid: number; ppid: number; pgid: number; command: string }[]>();

    for (const p of allProcs) {
      procsByPid.set(p.pid, p);
      const list = childrenMap.get(p.ppid);
      if (list) {
        list.push(p);
      } else {
        childrenMap.set(p.ppid, [p]);
      }
    }

    const allDescendants: number[] = [];
    const inGroupDescendants: number[] = [];
    const escapedDescendants: number[] = [];

    const cumSet = this.cumulativeDescendantsMap.get(leaderPid);
    const historicalDescendants = cumSet ? Array.from(cumSet) : [];

    // 初始队列包括 leaderPid 以及所有已知历史后代（防止中间父进程提前退出导致孙进程 PPID 变为 1 发生断链漏报）
    const queue: number[] = [leaderPid];
    const visited = new Set<number>([leaderPid]);

    for (const hPid of historicalDescendants) {
      if (!visited.has(hPid)) {
        visited.add(hPid);
        queue.push(hPid);
        const pInfo = procsByPid.get(hPid);
        if (pInfo) {
          allDescendants.push(hPid);
          if (pInfo.pgid === leaderPid) {
            inGroupDescendants.push(hPid);
          } else {
            escapedDescendants.push(hPid);
          }
        }
      }
    }

    while (queue.length > 0) {
      const currentPid = queue.shift()!;
      const children = childrenMap.get(currentPid) || [];
      for (const child of children) {
        if (!visited.has(child.pid)) {
          visited.add(child.pid);
          allDescendants.push(child.pid);
          if (child.pgid === leaderPid) {
            inGroupDescendants.push(child.pid);
          } else {
            escapedDescendants.push(child.pid);
          }
          queue.push(child.pid);
        }
      }
    }

    // 扫描可能已由于中间父进程退出导致 PPID 变为 1、但仍同属于 leader 进程组的残留进程
    for (const p of allProcs) {
      if (p.pgid === leaderPid && !visited.has(p.pid)) {
        visited.add(p.pid);
        allDescendants.push(p.pid);
        inGroupDescendants.push(p.pid);
      }
    }

    if (cumSet) {
      for (const d of allDescendants) {
        cumSet.add(d);
      }
    }

    return { allDescendants, inGroupDescendants, escapedDescendants };
  }

  private getAllProcesses(): { pid: number; ppid: number; pgid: number; command: string }[] {
    try {
      const output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lines = output.split('\n');
      const procs: { pid: number; ppid: number; pgid: number; command: string }[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        if (match) {
          procs.push({
            pid: parseInt(match[1], 10),
            ppid: parseInt(match[2], 10),
            pgid: parseInt(match[3], 10),
            command: match[4],
          });
        }
      }
      return procs;
    } catch {
      return [];
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

  /**
   * 崩溃恢复的判定依据：进程组里是否还有**真正能工作**的进程。
   *
   * SIGKILL 掉的 leader 会以僵尸形态留在组里，`kill(-pgid, 0)` 因此永远为真。
   * 只按 PID 存在与否判断会让恢复永远无法确认"组已清空"，孤儿进程也就永远得不到
   * 处置。这里按 ps 的进程状态把僵尸排除掉。
   */
  private isGroupAlive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0);
    } catch (err: any) {
      return err.code === 'EPERM';
    }
    // The group exists; zombies do not count as work in progress.
    for (const entry of this.processTable().values()) {
      if (entry.state === 'Z') continue;
      if (entry.pgid === pgid) return true;
    }
    return false;
  }

  /** pid → { pid, pgid, state } snapshot from `ps -A`; state is one letter (R/S/T/Z/…). */
  private processTable(): Map<number, { pid: number; pgid: number; state: string }> {
    const table = new Map<number, { pid: number; pgid: number; state: string }>();
    try {
      const output = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,state='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        table.set(pid, { pid, pgid: parseInt(match[2], 10), state: match[3][0] });
      }
    } catch {
      // no snapshot available; callers treat the process as alive
    }
    return table;
  }

  private isZombie(pid: number): boolean {
    return this.processTable().get(pid)?.state === 'Z';
  }

  private sendSignalToGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }

  private async waitForGroupAndPids(
    pid: number,
    inGroupPids: number[],
    timeoutMs: number
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const grpAlive = this.isGroupAlive(pid);
      const procAlive = this.isPidAlive(pid);
      const inGrpAlive = inGroupPids.some((p) => this.isPidAlive(p));

      if (!grpAlive && !procAlive && !inGrpAlive) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const stillGrp = this.isGroupAlive(pid);
    const stillProc = this.isPidAlive(pid);
    const stillInGrp = inGroupPids.some((p) => this.isPidAlive(p));
    return !stillGrp && !stillProc && !stillInGrp;
  }

  private parseCpuTimeToMs(timeStr: string): number {
    try {
      let days = 0;
      let rest = timeStr;
      if (rest.includes('-')) {
        const daySplit = rest.split('-');
        days = parseInt(daySplit[0], 10) || 0;
        rest = daySplit[1];
      }
      const parts = rest.split(':');
      let hours = 0;
      let minutes = 0;
      let seconds = 0;

      if (parts.length === 3) {
        hours = parseInt(parts[0], 10) || 0;
        minutes = parseInt(parts[1], 10) || 0;
        seconds = parseFloat(parts[2]) || 0;
      } else if (parts.length === 2) {
        minutes = parseInt(parts[0], 10) || 0;
        seconds = parseFloat(parts[1]) || 0;
      } else if (parts.length === 1) {
        seconds = parseFloat(parts[0]) || 0;
      }

      return Math.round(
        days * 86400000 + hours * 3600000 + minutes * 60000 + seconds * 1000
      );
    } catch {
      return 0;
    }
  }
}
