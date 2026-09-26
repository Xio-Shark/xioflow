import { execFile } from 'node:child_process';
import util from 'node:util';

const execFileAsync = util.promisify(execFile);

export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  rssKb: number;
  timeStr: string;
  command: string;
}

export type ProcessSnapshotMap = Map<number, ProcessSnapshotEntry>;

/**
 * 全域共享异步进程采样器 (P0-8 / ARCHITECTURE §4.4)
 * 职责：异步按需/周期性采集进程表快照，杜绝热路径上任何同步子进程阻塞事件循环。
 */
export class ProcessSampler {
  private static instance: ProcessSampler | null = null;

  public static getInstance(): ProcessSampler {
    if (!ProcessSampler.instance) {
      ProcessSampler.instance = new ProcessSampler();
    }
    return ProcessSampler.instance;
  }

  private cachedSnapshot: { timestamp: number; map: ProcessSnapshotMap } | null = null;
  private inFlightPromise: Promise<ProcessSnapshotMap> | null = null;

  /**
   * 异步获取进程表快照 (支持请求合并与短缓存)
   */
  public async getSnapshot(maxAgeMs: number = 100): Promise<ProcessSnapshotMap> {
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cachedSnapshot.timestamp < maxAgeMs) {
      return this.cachedSnapshot.map;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,state=,rss=,time=,command=']);
        const map = new Map<number, ProcessSnapshotEntry>();
        const lines = stdout.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // 列格式: pid ppid pgid state rss time command...
          const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
          if (match) {
            const pid = parseInt(match[1], 10);
            map.set(pid, {
              pid,
              ppid: parseInt(match[2], 10),
              pgid: parseInt(match[3], 10),
              state: match[4][0],
              rssKb: parseInt(match[5], 10) || 0,
              timeStr: match[6],
              command: match[7],
            });
          }
        }
        this.cachedSnapshot = { timestamp: Date.now(), map };
        return map;
      } catch {
        return this.cachedSnapshot?.map ?? new Map();
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  /**
   * 异步解析指定 leaderPid 的完整后代树 (区分组内与逃逸后代，支持历史种子后代探活)
   */
  public async getProcessTree(
    leaderPid: number,
    existingSnapshot?: ProcessSnapshotMap,
    seedPids?: number[]
  ): Promise<{ allDescendants: number[]; inGroupDescendants: number[]; escapedDescendants: number[] }> {
    const snapshot = existingSnapshot ?? (await this.getSnapshot(50));
    const allProcs = Array.from(snapshot.values());

    const childrenMap = new Map<number, number[]>();
    for (const p of allProcs) {
      if (!childrenMap.has(p.ppid)) {
        childrenMap.set(p.ppid, []);
      }
      childrenMap.get(p.ppid)!.push(p.pid);
    }

    const allDescendants: number[] = [];
    const inGroupDescendants: number[] = [];
    const escapedDescendants: number[] = [];

    const queue: number[] = [leaderPid];
    const visited = new Set<number>([leaderPid]);

    // 初始队列注入历史已知种子（防止中间父进程提前退出导致孙进程 PPID 变为 1 发生断链漏报）
    if (seedPids) {
      for (const sPid of seedPids) {
        if (!visited.has(sPid)) {
          visited.add(sPid);
          queue.push(sPid);
          const pInfo = snapshot.get(sPid);
          if (pInfo && pInfo.state !== 'Z') {
            allDescendants.push(sPid);
            if (pInfo.pgid === leaderPid) {
              inGroupDescendants.push(sPid);
            } else {
              escapedDescendants.push(sPid);
            }
          }
        }
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childrenMap.get(current) || [];
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child);
          const pInfo = snapshot.get(child);
          if (pInfo && pInfo.state !== 'Z') {
            allDescendants.push(child);
            if (pInfo.pgid === leaderPid) {
              inGroupDescendants.push(child);
            } else {
              escapedDescendants.push(child);
            }
          }
          queue.push(child);
        }
      }
    }

    // 扫描可能已由于中间父进程退出导致 PPID 变为 1、但仍同属于 leader 进程组的残留进程
    for (const p of allProcs) {
      if (p.pgid === leaderPid && !visited.has(p.pid) && p.state !== 'Z') {
        visited.add(p.pid);
        allDescendants.push(p.pid);
        inGroupDescendants.push(p.pid);
      }
    }

    return { allDescendants, inGroupDescendants, escapedDescendants };
  }

  /**
   * 异步核验进程组是否仍有存活且非僵尸的进程
   */
  public async isGroupAlive(pgid: number, existingSnapshot?: ProcessSnapshotMap): Promise<boolean> {
    let osAlive = false;
    try {
      process.kill(-pgid, 0);
      osAlive = true;
    } catch (err: any) {
      if (err.code === 'EPERM') {
        osAlive = true;
      } else {
        return false;
      }
    }

    let snapshot = existingSnapshot ?? (await this.getSnapshot(30));
    let hasLiveMember = false;
    for (const entry of snapshot.values()) {
      if (entry.state === 'Z') continue;
      if (entry.pgid === pgid) {
        hasLiveMember = true;
        break;
      }
    }

    // 若 OS 报告存在但快照未匹配到，可能是新衍生进程未及入库，强制刷新快照重试一次
    if (osAlive && !hasLiveMember && !existingSnapshot) {
      this.clearCache();
      snapshot = await this.getSnapshot(0);
      for (const entry of snapshot.values()) {
        if (entry.state === 'Z') continue;
        if (entry.pgid === pgid) {
          hasLiveMember = true;
          break;
        }
      }
    }

    return hasLiveMember;
  }

  /**
   * 异步判断是否为僵尸进程
   */
  public async isZombie(pid: number, existingSnapshot?: ProcessSnapshotMap): Promise<boolean> {
    const snapshot = existingSnapshot ?? (await this.getSnapshot(50));
    return snapshot.get(pid)?.state === 'Z';
  }

  /**
   * 异步采样一组目标 PID 的聚合资源使用量
   */
  public async sampleMetrics(
    targetPids: number[],
    existingSnapshot?: ProcessSnapshotMap
  ): Promise<{ rssBytes: number; pidsCount: number; cpuTimeMs: number }> {
    const snapshot = existingSnapshot ?? (await this.getSnapshot(100));
    let totalRssKb = 0;
    let totalCpuMs = 0;
    let count = 0;

    for (const pid of targetPids) {
      const entry = snapshot.get(pid);
      if (entry && entry.state !== 'Z') {
        totalRssKb += entry.rssKb;
        totalCpuMs += this.parseCpuTimeToMs(entry.timeStr);
        count++;
      }
    }

    return {
      rssBytes: totalRssKb * 1024,
      pidsCount: count,
      cpuTimeMs: totalCpuMs,
    };
  }

  private parseCpuTimeToMs(timeStr: string): number {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 2) {
      const min = parseInt(parts[0], 10) || 0;
      const sec = parseFloat(parts[1]) || 0;
      return Math.round((min * 60 + sec) * 1000);
    }
    if (parts.length === 3) {
      const hr = parseInt(parts[0], 10) || 0;
      const min = parseInt(parts[1], 10) || 0;
      const sec = parseFloat(parts[2]) || 0;
      return Math.round((hr * 3600 + min * 60 + sec) * 1000);
    }
    return 0;
  }

  public clearCache(): void {
    this.cachedSnapshot = null;
  }
}
