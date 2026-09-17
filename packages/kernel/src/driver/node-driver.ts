import { spawn, ChildProcess } from 'node:child_process';
import {
  PlatformDriver,
  StructuredCommand,
  ManagedProcessHandle,
  ProcessIdentity,
  StopProcessResult,
} from './types.js';
import { IdentityVerificationResult } from '../types.js';

export class NodePlatformDriver implements PlatformDriver {
  public readonly name = 'node-default';
  public readonly capabilities = {
    processGroupKill: true,
    accurateStartTime: true,
  };

  // 内存中追踪当前驱动启动的所有活跃进程
  private activeHandles: Map<number, { handle: ManagedProcessHandle; child: ChildProcess; startTime: number }> =
    new Map();

  public async spawn(command: StructuredCommand): Promise<ManagedProcessHandle> {
    return new Promise<ManagedProcessHandle>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command.execPath, command.args, {
          cwd: command.cwd,
          env: command.envWhiteList ? { ...command.envWhiteList, PATH: process.env.PATH || '' } : process.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
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
          startTimeMonotonic,
          spawnTime: new Date().toISOString(),
        };

        const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (exitResolve) => {
            child.on('close', (exitCode, signal) => {
              this.activeHandles.delete(pid);
              exitResolve({ exitCode, signal });
            });
            child.on('error', () => {
              this.activeHandles.delete(pid);
              exitResolve({ exitCode: 1, signal: null });
            });
          }
        );

        const handle: ManagedProcessHandle = {
          identity,
          stdout: child.stdout!,
          stderr: child.stderr!,
          onExit: exitPromise,
          rawProcess: child,
        };

        this.activeHandles.set(pid, { handle, child, startTime: startTimeMonotonic });
        resolve(handle);
      });
    });
  }

  public async verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult> {
    // 1. 检查操作系统中该 PID 是否存活
    let isAlive = false;
    try {
      process.kill(identity.pid, 0);
      isAlive = true;
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        return 'not_original_process';
      }
      return 'cannot_determine';
    }

    if (!isAlive) {
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

    // 进程存活但不在当前活跃实例列表中（例如由已崩溃的前代内核启动）
    // 无法微秒比对前代进程启动时间时，返回 cannot_determine
    return 'cannot_determine';
  }

  public async terminate(
    identity: ProcessIdentity,
    graceMs: number = 2000
  ): Promise<StopProcessResult> {
    const pid = identity.pid;

    // 先检查是否已经退出
    const initialStatus = await this.verifyIdentity(identity);
    if (initialStatus === 'not_original_process') {
      return { stopped: true, scope: 'direct_child' };
    }

    // 第一阶段：SIGINT 中断信号
    this.sendSignalToGroup(pid, 'SIGINT');

    const exitedAfterInt = await this.waitForExit(pid, graceMs);
    if (exitedAfterInt) {
      return { stopped: true, scope: 'process_group' };
    }

    // 第二阶段：SIGTERM 终止信号
    this.sendSignalToGroup(pid, 'SIGTERM');
    const exitedAfterTerm = await this.waitForExit(pid, 1000);
    if (exitedAfterTerm) {
      return { stopped: true, scope: 'process_group' };
    }

    // 第三阶段：SIGKILL 强制终止
    this.sendSignalToGroup(pid, 'SIGKILL');
    const exitedAfterKill = await this.waitForExit(pid, 1000);
    if (exitedAfterKill) {
      return { stopped: true, scope: 'process_group' };
    }

    // 依然存活，判定未完全停止
    return {
      stopped: false,
      scope: 'unknown',
      residualPids: [pid],
      errorDetails: `Process ${pid} did not terminate after SIGINT, SIGTERM, and SIGKILL`,
    };
  }

  private sendSignalToGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      // 尝试向负 PID 进程组发送信号
      process.kill(-pid, signal);
    } catch {
      try {
        // 退化为向单个进程发送
        process.kill(pid, signal);
      } catch {}
    }
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          return true;
        }
      }
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (err: any) {
      return err.code === 'ESRCH';
    }
  }
}
