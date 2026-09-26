import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import util from 'node:util';

const execFileAsync = util.promisify(execFile);

/**
 * 进程事实采集模块 (process-facts.ts)
 * 职责：异步采集操作系统底层进程与宿主启动事实，严禁同步调用子进程，读不到诚实返回 null。
 */

/**
 * 读取宿主启动标识 (bootId)
 * Linux: /proc/sys/kernel/random/boot_id
 * macOS: sysctl -n kern.boottime -> { sec = 1711411200, usec = ... }
 */
export async function readBootId(): Promise<string | null> {
  const platform = process.platform;
  if (platform === 'linux') {
    try {
      const content = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
      const trimmed = content.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.boottime']);
      // 典型输出: { sec = 1711411200, usec = 123456 } ...
      const match = stdout.match(/sec\s*=\s*(\d+)/);
      if (match && match[1]) {
        return `darwin-boot-${match[1]}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 读取单个进程的创建时间戳（毫秒）
 * Linux: /proc/<pid>/stat 第 22 字段 (starttime)
 * macOS: ps -o lstart= -p <pid>
 */
export async function readStartTime(pid: number): Promise<number | null> {
  const platform = process.platform;
  if (platform === 'linux') {
    try {
      const statContent = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      // comm 字段可能包含空格与括号，例如 (my node app)
      // 必须从最后一个 ')' 之后进行切分
      const lastParenIndex = statContent.lastIndexOf(')');
      if (lastParenIndex === -1) return null;
      const rest = statContent.slice(lastParenIndex + 1).trim();
      const fields = rest.split(/\s+/);
      // rest 的第 0 项是 state (字段 3)
      // 原始字段 22 (starttime) 对应 fields[22 - 3] = fields[19]
      const startTicks = parseInt(fields[19], 10);
      if (isNaN(startTicks)) return null;

      // 读取系统 btime (以转为绝对 epoch 毫秒)
      try {
        const statFile = await fs.readFile('/proc/stat', 'utf8');
        const btimeMatch = statFile.match(/^btime\s+(\d+)/m);
        const btimeSec = btimeMatch ? parseInt(btimeMatch[1], 10) : 0;
        // 假设标准 USER_HZ = 100
        const startSec = btimeSec + startTicks / 100;
        return Math.floor(startSec * 1000);
      } catch {
        return startTicks;
      }
    } catch {
      return null;
    }
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const parsed = Date.parse(trimmed);
      return isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }

  return null;
}

export interface GroupMemberFact {
  pid: number;
  startTimeMs: number | null;
}

/**
 * 读取指定进程组的所有成员进程及其启动时间事实
 */
export async function getGroupMembers(pgid: number): Promise<GroupMemberFact[]> {
  const platform = process.platform;
  const members: GroupMemberFact[] = [];

  if (platform === 'linux') {
    try {
      const entries = await fs.readdir('/proc');
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = parseInt(entry, 10);
        try {
          const statContent = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
          const lastParenIndex = statContent.lastIndexOf(')');
          if (lastParenIndex === -1) continue;
          const rest = statContent.slice(lastParenIndex + 1).trim();
          const fields = rest.split(/\s+/);
          // 原始字段 5 (pgrp) 对应 fields[5 - 3] = fields[2]
          const pgrp = parseInt(fields[2], 10);
          if (pgrp === pgid) {
            const startTimeMs = await readStartTime(pid);
            members.push({ pid, startTimeMs });
          }
        } catch {
          // 进程可能在读取中途已退出
        }
      }
    } catch {
      return [];
    }
    return members;
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,pgid=,lstart=']);
      const lines = stdout.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 格式: pid pgid Day Mon Date HH:MM:SS Year
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 7) {
          const procPid = parseInt(parts[0], 10);
          const procPgid = parseInt(parts[1], 10);
          if (procPgid === pgid) {
            const dateStr = parts.slice(2).join(' ');
            const parsedTime = Date.parse(dateStr);
            members.push({
              pid: procPid,
              startTimeMs: isNaN(parsedTime) ? null : parsedTime,
            });
          }
        }
      }
    } catch {
      return [];
    }
    return members;
  }

  return members;
}
