import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PlatformDriver,
  PlatformCapabilities,
  StructuredCommand,
  ManagedProcessHandle,
  ProcessIdentity,
  StopProcessResult,
} from './types.js';
import { IdentityVerificationResult } from '../types.js';
import { NodePlatformDriver } from './node-driver.js';
import { readStartTime } from './process-facts.js';
import { computeCommandFingerprint, resolveExecutable } from './spawn-support.js';

type ExitFacts = { exitCode: number | null; signal: NodeJS.Signals | null };

const HELPER_NAME = 'xioflow-reaper';

/**
 * 解析当前平台的 reaper helper：`XIOFLOW_REAPER_PATH` 优先，否则取包内
 * `dist/native/<platform>-<arch>/xioflow-reaper`。找不到或不可执行时返回 null。
 */
export function locateReaperHelper(): string | null {
  const candidates = [
    process.env.XIOFLOW_REAPER_PATH,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native', `${process.platform}-${process.arch}`, HELPER_NAME),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export interface ReaperDriverOptions {
  /** helper 可执行文件路径；缺省按 locateReaperHelper() 解析。 */
  helperPath?: string;
  /** stop 应答的额外等待上限（在 grace + 3s 信号阶梯之外），超过即判 cannot_determine。 */
  stopReplyMarginMs?: number;
}

interface ReaperSession {
  helper: ChildProcess;
  /** fd 3：Node 为额外的 'pipe' 创建 socketpair，双向可读写。 */
  ctl: Socket;
  rootPid: number;
  /** root 的退出事实（helper 回收 root 时报告）。 */
  rootExit?: ExitFacts;
  rootExitListeners: Array<(facts: ExitFacts) => void>;
  /** helper 报告整棵树已空（root 退出后后代也全部结束，或 stop 已确认）。 */
  treeEmpty: boolean;
  /** 控制通道关闭时树未被确认清空：helper 已不再持有它，此后只能退回操作系统事实。 */
  helperLost: boolean;
  /** 在途 stop 请求的应答回调（stopped / residual；通道关闭时为 null）。 */
  onStopReply?: (line: string | null) => void;
  stopPromise?: Promise<StopProcessResult>;
  lastError?: string;
}

/**
 * 以原生 helper 持有进程树的平台驱动（Linux / macOS）。
 *
 * - Linux：helper 是子收割者，孤儿（setsid、双 fork）必然回到它名下；停止经 pidfd 发信号，
 *   以 waitpid ECHILD 证明整棵树已空（scope `subreaper_tree`）。
 * - macOS：没有子收割者，helper 用 kqueue NOTE_FORK + 会话成员跟踪后代（scope `tracked_tree`）；
 *   已脱离会话又失去父链的逃逸者仍可能漏掉，输出管道持有检测继续兜底。
 * - 监督进程消失（控制通道 EOF）时 helper 停掉整棵树，不留无人监督的进程。
 *
 * 崩溃恢复所需的身份核验、进程组清场与指标采样沿用操作系统事实（与 NodePlatformDriver 同源），
 * 因此两种驱动写下的身份可以互相裁决。
 */
export class ReaperPlatformDriver implements PlatformDriver {
  public readonly name = 'reaper';
  public readonly capabilities: PlatformCapabilities;
  private readonly helperPath: string;
  private readonly stopReplyMarginMs: number;
  private readonly facts = new NodePlatformDriver();
  private readonly sessions = new Map<number, ReaperSession>();

  public static isAvailable(): boolean {
    return (process.platform === 'linux' || process.platform === 'darwin') && locateReaperHelper() !== null;
  }

  constructor(options: ReaperDriverOptions = {}) {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error(`ReaperPlatformDriver supports Linux and macOS only (got ${process.platform})`);
    }
    const helperPath = options.helperPath ?? locateReaperHelper();
    if (!helperPath) {
      throw new Error(
        `${HELPER_NAME} is not available for ${process.platform}-${process.arch}; ` +
          'build it with `node scripts/build-native.mjs` or set XIOFLOW_REAPER_PATH'
      );
    }
    this.helperPath = helperPath;
    this.stopReplyMarginMs = options.stopReplyMarginMs ?? 2000;
    this.capabilities = {
      ...this.facts.capabilities,
      processGroupKill: true,
      gatedSpawn: true,
      descendantEnumeration: process.platform === 'linux' ? 'subreaper' : 'full',
    };
  }

  public async readBootId(): Promise<string | null> {
    return this.facts.readBootId();
  }

  public async getGroupEvidence(pgid: number): Promise<{ pid: number; startTimeMs: number | null }[]> {
    return this.facts.getGroupEvidence(pgid);
  }

  public async terminateGroup(pgid: number, graceMs: number = 2000): Promise<StopProcessResult> {
    return this.facts.terminateGroup(pgid, graceMs);
  }

  public async sampleMetrics(identity: ProcessIdentity) {
    return this.facts.sampleMetrics(identity);
  }

  public async spawn(command: StructuredCommand): Promise<ManagedProcessHandle> {
    const childEnv: NodeJS.ProcessEnv = command.envWhiteList
      ? { ...command.envWhiteList }
      : command.inheritEnv === false
        ? {}
        : process.env;
    // 与 NodePlatformDriver 相同：启动前确认可执行文件存在，缺失即显式失败（契约 #1）
    if (!resolveExecutable(command.execPath, childEnv.PATH)) {
      const err = new Error(`spawn ${command.execPath} ENOENT`);
      Object.assign(err, { code: 'ENOENT', syscall: `spawn ${command.execPath}`, path: command.execPath });
      throw err;
    }

    const stdinPayload =
      command.stdin === undefined
        ? undefined
        : typeof command.stdin === 'string'
          ? Buffer.from(command.stdin, 'utf8')
          : Buffer.from(command.stdin);
    const isStreamStdin = command.stdinMode === 'stream';
    const helper = spawn(this.helperPath, [command.execPath, ...command.args], {
      cwd: command.cwd,
      env: childEnv,
      detached: true,
      stdio: [isStreamStdin || stdinPayload !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    const rootPid = await this.awaitSpawned(helper);
    const session = this.openSession(helper, rootPid);

    const bootId = await this.facts.readBootId();
    // root 此刻阻塞在门上，exec 不改变创建时间：读到的就是目标程序的 OS 创建时间
    const osStartTimeMs = await readStartTime(rootPid);
    const identity: ProcessIdentity = {
      pid: rootPid,
      pgid: rootPid,
      startTimeMonotonic: Number(process.hrtime.bigint() / 1000n),
      spawnTime: new Date().toISOString(),
      osStartTime: osStartTimeMs !== null ? new Date(osStartTimeMs).toISOString() : undefined,
      commandFingerprint: computeCommandFingerprint(command.execPath, command.args),
      bootId: bootId ?? undefined,
    };

    this.writeStdin(helper, isStreamStdin, stdinPayload);
    let gateSettled = false;
    const sendGate = (line: string) => {
      if (gateSettled) return;
      gateSettled = true;
      this.send(session, line);
    };

    return {
      identity,
      stdin: isStreamStdin ? (helper.stdin ?? undefined) : undefined,
      stdout: helper.stdout!,
      stderr: helper.stderr!,
      onRootExit: this.rootExitPromise(session),
      onExit: new Promise<ExitFacts>((resolve) => {
        // close：helper 退出且目标继承的输出管道全部关闭（与 NodePlatformDriver 的 close 语义一致）
        helper.on('close', () => resolve(session.rootExit ?? { exitCode: null, signal: null }));
      }),
      rawProcess: {
        pid: rootPid,
        helperPid: helper.pid,
        // root 未被 helper 回收前 pid 不会被复用，由 helper 代发信号
        kill: (signal: NodeJS.Signals | number = 'SIGTERM') => {
          const signo = typeof signal === 'number' ? signal : os.constants.signals[signal];
          this.send(session, `signal ${signo}`);
          return true;
        },
      },
      releaseGate: () => sendGate('go'),
      destroyGate: () => sendGate('abort'),
    };
  }

  public async verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult> {
    const session = this.sessions.get(identity.pid);
    if (session && !session.helperLost) {
      // helper 是 root 的父进程：未回收之前 pid 不可能被复用，内存事实即可判定
      return session.rootExit ? 'not_original_process' : 'is_original_process';
    }
    return this.facts.verifyIdentity(identity);
  }

  public async terminate(identity: ProcessIdentity, graceMs: number = 2000): Promise<StopProcessResult> {
    const session = this.sessions.get(identity.pid);
    if (!session || session.helperLost) {
      // 不是本驱动持有的树（例如恢复期接手旧进程）或 helper 已丢失：只能退回操作系统事实
      return this.facts.terminate(identity, graceMs);
    }
    if (session.treeEmpty) {
      return { stopped: 'confirmed_stopped', scope: this.treeScope() };
    }
    session.stopPromise ??= this.requestStop(session, graceMs);
    return session.stopPromise;
  }

  private treeScope(): StopProcessResult['scope'] {
    return process.platform === 'linux' ? 'subreaper_tree' : 'tracked_tree';
  }

  private async requestStop(session: ReaperSession, graceMs: number): Promise<StopProcessResult> {
    const reply = this.awaitStopReply(session, graceMs + 3000 + this.stopReplyMarginMs);
    this.send(session, `stop ${Math.max(0, Math.floor(graceMs))}`);
    const line = await reply;
    session.stopPromise = undefined;
    if (line === 'stopped') {
      session.treeEmpty = true;
      return { stopped: 'confirmed_stopped', scope: this.treeScope() };
    }
    if (line?.startsWith('residual ')) {
      const residualPids = line
        .slice('residual '.length)
        .split(',')
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      return {
        stopped: 'cannot_determine',
        scope: 'unknown',
        residualPids,
        errorDetails: `${HELPER_NAME} could not empty the process tree; still alive: ${residualPids.join(', ')}`,
      };
    }
    return {
      stopped: 'cannot_determine',
      scope: 'unknown',
      errorDetails: session.helperLost
        ? `${HELPER_NAME} exited before confirming the stop${session.lastError ? `: ${session.lastError}` : ''}`
        : `${HELPER_NAME} did not answer the stop request in time`,
    };
  }

  /** 等待第一条 `spawned <pid>`；helper 启动失败或先报错都显式拒绝。 */
  private awaitSpawned(helper: ChildProcess): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const ctl = helper.stdio[3] as NodeJS.ReadableStream;
      let buffered = '';
      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const nl = buffered.indexOf('\n');
        if (nl < 0) return;
        const line = buffered.slice(0, nl);
        cleanup();
        const match = /^spawned (\d+)$/.exec(line);
        if (!match) {
          helper.kill('SIGKILL');
          reject(new Error(`${HELPER_NAME} failed to start the process: ${line}`));
          return;
        }
        // 首行之后的内容交给会话解析
        if (buffered.length > nl + 1) ctl.unshift(Buffer.from(buffered.slice(nl + 1)));
        resolve(Number(match[1]));
      };
      const onError = (err: Error) => fail(err);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        fail(new Error(`${HELPER_NAME} exited before spawning (code=${code}, signal=${signal})`));
      const cleanup = () => {
        ctl.off('data', onData);
        helper.off('error', onError);
        helper.off('exit', onExit);
      };
      ctl.on('data', onData);
      helper.once('error', onError);
      helper.once('exit', onExit);
    });
  }

  private openSession(helper: ChildProcess, rootPid: number): ReaperSession {
    const session: ReaperSession = {
      helper,
      ctl: helper.stdio[3] as unknown as Socket,
      rootPid,
      rootExitListeners: [],
      treeEmpty: false,
      helperLost: false,
    };
    this.sessions.set(rootPid, session);

    let buffered = '';
    session.ctl.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        this.onLine(session, line);
      }
    });
    session.ctl.on('error', () => {});
    // 以通道关闭为准而不是 helper 的 exit 事件：close 之前通道里的应答已全部读完
    session.ctl.on('close', () => {
      if (!session.treeEmpty) session.helperLost = true;
      session.onStopReply?.(null);
      if (session.treeEmpty) this.sessions.delete(rootPid);
      if (!session.rootExit) this.watchOrphanedRoot(session);
    });
    return session;
  }

  private onLine(session: ReaperSession, line: string): void {
    const exit = /^exit (-|\d+) (-|\d+)$/.exec(line);
    if (exit) {
      const facts: ExitFacts = {
        exitCode: exit[1] === '-' ? null : Number(exit[1]),
        signal: exit[2] === '-' ? null : signalName(Number(exit[2])),
      };
      session.rootExit = facts;
      for (const listener of session.rootExitListeners.splice(0)) listener(facts);
      // root 已结束：剩余后代由 helper 继续持有，不再阻止宿主进程退出（宿主退出即 EOF，helper 清场）
      session.helper.unref();
      session.ctl.unref();
    } else if (line === 'empty') {
      session.treeEmpty = true;
    } else if (line === 'stopped' || line.startsWith('residual ')) {
      session.onStopReply?.(line);
    } else if (line.startsWith('error ')) {
      session.lastError = line.slice('error '.length);
    }
  }

  private rootExitPromise(session: ReaperSession): Promise<ExitFacts> {
    return new Promise<ExitFacts>((resolve) => {
      if (session.rootExit) resolve(session.rootExit);
      else session.rootExitListeners.push(resolve);
    });
  }

  /** helper 丢失而 root 退出事实未知：不编造退出码，只观察 root 何时不再存活。 */
  private watchOrphanedRoot(session: ReaperSession): void {
    const timer = setInterval(() => {
      if (isPidAlive(session.rootPid)) return;
      clearInterval(timer);
      const facts: ExitFacts = { exitCode: null, signal: null };
      for (const listener of session.rootExitListeners.splice(0)) listener(facts);
    }, 100);
    timer.unref();
  }

  private awaitStopReply(session: ReaperSession, timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (session.helperLost) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => settle(null), timeoutMs);
      const settle = (line: string | null) => {
        clearTimeout(timer);
        session.onStopReply = undefined;
        resolve(line);
      };
      session.onStopReply = settle;
    });
  }

  private send(session: ReaperSession, line: string): void {
    if (session.ctl.destroyed) return;
    try {
      session.ctl.write(`${line}\n`);
    } catch {}
  }

  private writeStdin(helper: ChildProcess, isStream: boolean, payload: Buffer | undefined): void {
    if (!helper.stdin) return;
    helper.stdin.on('error', () => {});
    if (isStream) {
      if (payload !== undefined) helper.stdin.write(payload);
    } else if (payload !== undefined) {
      // 一次性 stdin：写入后关闭。子进程不读就退出的 EPIPE 不是启动失败，由退出码体现。
      helper.stdin.end(payload);
    }
  }
}

function signalName(signo: number): NodeJS.Signals | null {
  const signals = os.constants.signals as Record<string, number>;
  return (Object.keys(signals).find((name) => signals[name] === signo) as NodeJS.Signals | undefined) ?? null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}
