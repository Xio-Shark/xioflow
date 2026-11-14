import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { isPathContained } from '../capability/path-utils.js';
import { LandlockConfinementDriver } from '../confinement/landlock.js';
import { ExecutionDomain } from '../domain.js';
import { NodePlatformDriver } from '../driver/node-driver.js';
import { ReaperPlatformDriver } from '../driver/reaper-driver.js';
import type { ManagedProcessHandle, PlatformDriver, StructuredCommand } from '../driver/types.js';
import { RecoveryEngine } from '../recovery/engine.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { finalizeOperation } from '../supervisor/finalize.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { ConfinementDriver, Operation, ProcessOperationResult } from '../types.js';
import { computeBytesRev, readDiskSnapshot, SessionView } from './session-view.js';
import type {
  AdjudicateSyscallRequest,
  AdjudicateSyscallResult,
  AwaitCondition,
  AwaitSyscallRequest,
  AwaitSyscallResult,
  BlobDescriptor,
  BlobGrepMatch,
  BlobSyscallRequest,
  BlobSyscallResult,
  ExecSyscallRequest,
  ExecSyscallResult,
  LeafAwaitCondition,
  ManagedProcessSummary,
  ObserveSyscallRequest,
  ObserveSyscallResult,
  OsMedium,
  VfsMutation,
  VfsTxSyscallRequest,
  VfsTxSyscallResult,
} from './syscalls.js';

const execFileAsync = promisify(execFile);

const DEFAULT_INLINE_MAX_BYTES = 16 * 1024;
const SUPERVISOR_CAPTURE_BYTES = 64 * 1024;
const PREVIEW_HEAD_LINES = 30;
const PREVIEW_TAIL_LINES = 30;
const PREVIEW_SIDE_MAX_BYTES = 4096;
const GREP_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', '.xiotask']);

interface StoredBlobEntry {
  blobRef: string;
  filePath: string;
  sha256: string;
  totalBytes: number;
  totalLines: number;
}

interface BackgroundManagedProcess {
  opId: string;
  sessionId: string;
  commandLabel: string;
  handle: ManagedProcessHandle;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutStream: fs.WriteStream;
  stderrStream: fs.WriteStream;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutBlobRef?: string;
  stderrBlobRef?: string;
  events: EventEmitter;
}

export interface KernelMediumOptions {
  workspaceRoot: string;
  domainPath?: string;
  domainId?: string;
  domain?: ExecutionDomain;
  driver?: PlatformDriver;
  supervisor?: ProcessSupervisor;
  ownsDomain?: boolean;
}

export function defaultDomainPathForWorkspace(workspaceRoot: string): string {
  const realRoot = fs.realpathSync(workspaceRoot);
  const hash = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  const home = process.env.XIOFLOW_RUNTIME_HOME || path.join(process.env.HOME || '/tmp', '.xioflow');
  return path.join(home, 'domains', hash);
}

function countLinesInBuffer(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) newlines++;
  }
  return buf[buf.length - 1] === 0x0a ? newlines : newlines + 1;
}

function buildHeadTailPreview(text: string, blob: BlobDescriptor): string {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES + 4 && Buffer.byteLength(text, 'utf8') <= PREVIEW_SIDE_MAX_BYTES * 2) {
    return `${text}\n[full output stored at ${blob.blobRef} (${blob.totalBytes} bytes, ${blob.totalLines} lines)]`;
  }
  const head = lines.slice(0, PREVIEW_HEAD_LINES).join('\n').slice(0, PREVIEW_SIDE_MAX_BYTES);
  const tail = lines.slice(-PREVIEW_TAIL_LINES).join('\n').slice(-PREVIEW_SIDE_MAX_BYTES);
  const omittedLines = Math.max(0, blob.totalLines - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES);
  return [
    head,
    `... [spilled to ${blob.blobRef}: ${blob.totalBytes} bytes, ${blob.totalLines} total lines, ~${omittedLines} lines omitted; use inspect/blob slice or grep] ...`,
    tail,
  ].join('\n');
}

function buildHeadTailFromFile(filePath: string, blob: BlobDescriptor): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= PREVIEW_SIDE_MAX_BYTES * 2) {
    return buildHeadTailPreview(fs.readFileSync(filePath, 'utf8'), blob);
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const headBuf = Buffer.alloc(PREVIEW_SIDE_MAX_BYTES);
    const tailBuf = Buffer.alloc(PREVIEW_SIDE_MAX_BYTES);
    const headRead = fs.readSync(fd, headBuf, 0, PREVIEW_SIDE_MAX_BYTES, 0);
    const tailRead = fs.readSync(fd, tailBuf, 0, PREVIEW_SIDE_MAX_BYTES, Math.max(0, stat.size - PREVIEW_SIDE_MAX_BYTES));
    const headText = headBuf.subarray(0, headRead).toString('utf8');
    const tailText = tailBuf.subarray(0, tailRead).toString('utf8');
    return [
      headText,
      `... [spilled to ${blob.blobRef}: ${blob.totalBytes} bytes, ${blob.totalLines} total lines; use inspect/blob slice or grep] ...`,
      tailText,
    ].join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

export class KernelMedium implements OsMedium {
  public readonly workspaceRoot: string;
  public readonly domain: ExecutionDomain;
  public readonly driver: PlatformDriver;
  public readonly supervisor: ProcessSupervisor;
  private readonly ownsDomain: boolean;
  private readonly blobsDir: string;
  private readonly forksDir: string;
  private readonly blobIndex = new Map<string, StoredBlobEntry>();
  private readonly sessions = new Map<string, SessionView>();
  private readonly backgroundProcs = new Map<string, BackgroundManagedProcess>();
  private readonly systemRunId: string;
  private workspaceLockChain: Promise<void> = Promise.resolve();
  private opSeq = 0;
  private closed = false;

  public static async open(
    workspaceRoot: string,
    options?: Omit<KernelMediumOptions, 'workspaceRoot'>,
  ): Promise<KernelMedium> {
    const realWorkspace = fs.realpathSync(workspaceRoot);
    const driver =
      options?.driver ??
      (ReaperPlatformDriver.isAvailable() ? new ReaperPlatformDriver() : new NodePlatformDriver());
    if (process.platform === 'linux') {
      await LandlockConfinementDriver.probe();
    }
    const ownsDomain = options?.domain === undefined && options?.ownsDomain !== false;
    const domainPath = options?.domainPath ?? defaultDomainPathForWorkspace(realWorkspace);
    const domainId =
      options?.domainId ??
      `ws-${crypto.createHash('sha256').update(realWorkspace).digest('hex').slice(0, 12)}`;
    const domain = options?.domain ?? ExecutionDomain.acquire(domainPath, domainId);
    if (ownsDomain) {
      const recovery = new RecoveryEngine(domain, driver);
      await recovery.recover();
    }
    const supervisor = options?.supervisor ?? new ProcessSupervisor(domain, driver, new GitShadowSnapshotDriver());
    return new KernelMedium({
      workspaceRoot: realWorkspace,
      domain,
      driver,
      supervisor,
      ownsDomain,
    });
  }

  constructor(options: Required<Pick<KernelMediumOptions, 'workspaceRoot' | 'domain' | 'driver' | 'supervisor'>> & { ownsDomain?: boolean }) {
    this.workspaceRoot = fs.realpathSync(options.workspaceRoot);
    this.domain = options.domain;
    this.driver = options.driver;
    this.supervisor = options.supervisor;
    this.ownsDomain = options.ownsDomain ?? false;
    this.blobsDir = path.join(this.domain.domainPath, 'blobs');
    this.forksDir = path.join(this.domain.domainPath, 'forks');
    fs.mkdirSync(this.blobsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.forksDir, { recursive: true, mode: 0o700 });

    const store = this.domain.getStore();
    const epoch = store.getCurrentEpoch();
    const taskId = `medium-task-${this.domain.domainId}`;
    this.systemRunId = `medium-run-e${epoch}`;
    if (!store.getTask(taskId)) {
      store.saveTask({
        id: taskId,
        domainId: this.domain.domainId,
        name: 'os-medium',
        createdAt: new Date().toISOString(),
      });
    }
    if (!store.getRun(this.systemRunId)) {
      store.saveRun({
        id: this.systemRunId,
        taskId,
        domainId: this.domain.domainId,
        owner: 'kernel-medium',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }
  }

  public getSession(sessionId: string = 'default'): SessionView {
    let view = this.sessions.get(sessionId);
    if (!view) {
      view = new SessionView(this.workspaceRoot, sessionId);
      this.sessions.set(sessionId, view);
    }
    return view;
  }

  public dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public hasActiveWork(): boolean {
    for (const bg of this.backgroundProcs.values()) {
      if (bg.status === 'running') return true;
    }
    return false;
  }

  private nextId(prefix: string): string {
    this.opSeq += 1;
    return `${prefix}-${this.domain.getStore().getCurrentEpoch()}-${Date.now().toString(36)}-${this.opSeq}`;
  }

  private async withWorkspaceLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.workspaceLockChain;
    this.workspaceLockChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private resolveExecCwd(cwd?: string): string {
    if (!cwd) return this.workspaceRoot;
    const resolved = path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(this.workspaceRoot, cwd);
    if (!isPathContained(this.workspaceRoot, resolved) && !isPathContained(this.forksDir, resolved)) {
      throw new Error(`Execution cwd "${cwd}" escapes workspace "${this.workspaceRoot}"`);
    }
    return resolved;
  }

  private buildStructuredCommand(req: ExecSyscallRequest, resolvedCwd: string): { command: StructuredCommand; label: string } {
    const inheritEnv = req.inheritEnv ?? true;
    if (req.execPath) {
      return {
        command: {
          execPath: req.execPath,
          args: req.args ?? [],
          cwd: resolvedCwd,
          stdin: req.stdin,
          inheritEnv,
          ...(req.env ? { envWhiteList: inheritEnv ? { ...(process.env as Record<string, string>), ...req.env } : req.env } : {}),
        },
        label: [req.execPath, ...(req.args ?? [])].join(' '),
      };
    }
    if (!req.cmd) {
      throw new Error('exec requires either `cmd` or `execPath` (or `stopOpId` to stop a background process)');
    }
    const shell = req.shell || '/bin/sh';
    return {
      command: {
        execPath: shell,
        args: ['-c', req.cmd],
        cwd: resolvedCwd,
        stdin: req.stdin,
        inheritEnv,
        ...(req.env ? { envWhiteList: inheritEnv ? { ...(process.env as Record<string, string>), ...req.env } : req.env } : {}),
      },
      label: req.cmd,
    };
  }

  private registerBlobFromBuffer(buf: Buffer): StoredBlobEntry {
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const blobRef = `blob:${sha256.slice(0, 24)}`;
    const existing = this.blobIndex.get(blobRef);
    if (existing && fs.existsSync(existing.filePath)) return existing;
    const filePath = path.join(this.blobsDir, `${sha256.slice(0, 24)}.blob`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, buf, { mode: 0o600 });
    }
    const entry: StoredBlobEntry = {
      blobRef,
      filePath,
      sha256,
      totalBytes: buf.length,
      totalLines: countLinesInBuffer(buf),
    };
    this.blobIndex.set(blobRef, entry);
    return entry;
  }

  private registerBlobFromFile(filePath: string, knownSha256?: string): StoredBlobEntry {
    const buf = fs.readFileSync(filePath);
    const sha256 = knownSha256 || crypto.createHash('sha256').update(buf).digest('hex');
    const blobRef = `blob:${sha256.slice(0, 24)}`;
    const entry: StoredBlobEntry = {
      blobRef,
      filePath,
      sha256,
      totalBytes: buf.length,
      totalLines: countLinesInBuffer(buf),
    };
    this.blobIndex.set(blobRef, entry);
    return entry;
  }

  private formatStreamOutput(
    inlineText: string,
    spillRef: string | undefined,
    spillHash: string | undefined,
    inlineMaxBytes: number,
  ): { text: string; truncated: boolean; blob?: BlobDescriptor } {
    if (spillRef && fs.existsSync(spillRef)) {
      const entry = this.registerBlobFromFile(spillRef, spillHash);
      const descriptor: BlobDescriptor = {
        blobRef: entry.blobRef,
        sha256: entry.sha256,
        totalBytes: entry.totalBytes,
        totalLines: entry.totalLines,
      };
      return {
        text: buildHeadTailFromFile(entry.filePath, descriptor),
        truncated: true,
        blob: descriptor,
      };
    }
    const byteLen = Buffer.byteLength(inlineText, 'utf8');
    if (byteLen > inlineMaxBytes) {
      const entry = this.registerBlobFromBuffer(Buffer.from(inlineText, 'utf8'));
      const descriptor: BlobDescriptor = {
        blobRef: entry.blobRef,
        sha256: entry.sha256,
        totalBytes: entry.totalBytes,
        totalLines: entry.totalLines,
      };
      return {
        text: buildHeadTailPreview(inlineText, descriptor),
        truncated: true,
        blob: descriptor,
      };
    }
    return { text: inlineText, truncated: false };
  }

  // =========================================================================
  // Syscall 1: exec
  // =========================================================================
  public async exec(req: ExecSyscallRequest): Promise<ExecSyscallResult> {
    const session = this.getSession(req.sessionId);
    const startMs = Date.now();

    if (req.stopOpId) {
      const bg = this.backgroundProcs.get(req.stopOpId);
      if (!bg) {
        const stopRes = await this.supervisor.cancelOperation(req.stopOpId, req.graceMs ?? 1500);
        return {
          opId: req.stopOpId,
          status: stopRes.stopped === 'confirmed_stopped' ? 'stopped' : 'indeterminate',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - startMs,
          stopResult: stopRes,
          staleReads: session.checkStaleReads(),
        };
      }
      if (req.signal && req.signal !== 'SIGTERM' && req.signal !== 'SIGKILL' && req.signal !== 'SIGINT') {
        bg.handle.rawProcess?.kill?.(req.signal);
        return {
          opId: bg.opId,
          status: bg.status === 'running' ? 'running' : 'stopped',
          exitCode: bg.exitCode,
          signal: bg.signal,
          pid: bg.handle.identity.pid,
          pgid: bg.handle.identity.pgid,
          stdout: bg.stdoutTail,
          stderr: bg.stderrTail,
          durationMs: Date.now() - startMs,
          staleReads: session.checkStaleReads(),
        };
      }
      const stopRes = await this.driver.terminate(bg.handle.identity, req.graceMs ?? 1500);
      await Promise.race([
        bg.handle.onExit.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
      return {
        opId: bg.opId,
        status: stopRes.stopped === 'confirmed_stopped' ? 'stopped' : 'indeterminate',
        exitCode: bg.exitCode,
        signal: bg.signal,
        pid: bg.handle.identity.pid,
        pgid: bg.handle.identity.pgid,
        stdout: bg.stdoutTail,
        stderr: bg.stderrTail,
        durationMs: Date.now() - startMs,
        stopResult: stopRes,
        staleReads: session.checkStaleReads(),
      };
    }

    const opId = req.opId ?? this.nextId('exec');
    const resolvedCwd = this.resolveExecCwd(req.cwd);
    const { command, label } = this.buildStructuredCommand(req, resolvedCwd);
    const inlineMaxBytes = req.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;

    let confinementDriver: ConfinementDriver | undefined;
    let mutationRoots: string[] | undefined;
    if (req.confinement) {
      if (process.platform === 'linux') {
        await LandlockConfinementDriver.probe();
        if (LandlockConfinementDriver.isAvailable()) {
          confinementDriver = new LandlockConfinementDriver();
          mutationRoots =
            typeof req.confinement === 'object' && req.confinement.writableRoots
              ? req.confinement.writableRoots
              : [this.workspaceRoot, '/tmp'];
        }
      }
    }

    if (req.background) {
      const wrappedCmd = confinementDriver ? confinementDriver.wrap(command, mutationRoots ?? [this.workspaceRoot]) : command;
      const store = this.domain.getStore();
      const op: Operation = {
        id: opId,
        runId: this.systemRunId,
        kind: 'process',
        name: `bg:${label.slice(0, 64)}`,
        inputFingerprint: crypto.createHash('sha256').update(JSON.stringify({ opId, label, resolvedCwd })).digest('hex'),
        requiredResources: [],
        spawnGated: this.driver.capabilities.gatedSpawn === true,
        status: 'pending',
      };
      store.registerOperationIntent(op, this.domain.domainId);
      let handle: ManagedProcessHandle;
      try {
        handle = await this.driver.spawn(wrappedCmd, { vfsTrace: false });
        store.updateOperationStatus(opId, 'active', handle.identity);
        handle.releaseGate?.();
      } catch (err: any) {
        const failRes: ProcessOperationResult = {
          kind: 'process',
          status: 'failed',
          exitCode: 127,
          signal: null,
          stdout: '',
          stderr: err?.message || String(err),
          spawnFailure: err?.message || String(err),
          isTruncated: false,
          identityVerification: 'not_original_process',
          durationMs: Date.now() - startMs,
          completedAt: new Date().toISOString(),
        };
        finalizeOperation(this.domain, opId, failRes);
        throw err;
      }

      const stdoutPath = path.join(this.blobsDir, `${opId}.stdout.log`);
      const stderrPath = path.join(this.blobsDir, `${opId}.stderr.log`);
      const stdoutStream = fs.createWriteStream(stdoutPath, { mode: 0o600 });
      const stderrStream = fs.createWriteStream(stderrPath, { mode: 0o600 });
      const events = new EventEmitter();
      events.setMaxListeners(64);

      const bg: BackgroundManagedProcess = {
        opId,
        sessionId: session.sessionId,
        commandLabel: label,
        handle,
        startedAt: new Date().toISOString(),
        status: 'running',
        exitCode: null,
        signal: null,
        stdoutPath,
        stderrPath,
        stdoutStream,
        stderrStream,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTail: '',
        stderrTail: '',
        events,
      };
      this.backgroundProcs.set(opId, bg);

      handle.stdout.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        bg.stdoutBytes += buf.length;
        stdoutStream.write(buf);
        const text = buf.toString('utf8');
        bg.stdoutTail = (bg.stdoutTail + text).slice(-inlineMaxBytes);
        events.emit('output', { stream: 'stdout', text });
      });
      handle.stderr.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        bg.stderrBytes += buf.length;
        stderrStream.write(buf);
        const text = buf.toString('utf8');
        bg.stderrTail = (bg.stderrTail + text).slice(-inlineMaxBytes);
        events.emit('output', { stream: 'stderr', text });
      });

      void (handle.onRootExit ?? handle.onExit).then((exitFacts) => {
        bg.status = 'exited';
        bg.exitCode = exitFacts.exitCode;
        bg.signal = exitFacts.signal;
        bg.completedAt = new Date().toISOString();
        stdoutStream.end();
        stderrStream.end();
        try {
          if (bg.stdoutBytes > 0 && fs.existsSync(stdoutPath)) {
            bg.stdoutBlobRef = this.registerBlobFromFile(stdoutPath).blobRef;
          }
          if (bg.stderrBytes > 0 && fs.existsSync(stderrPath)) {
            bg.stderrBlobRef = this.registerBlobFromFile(stderrPath).blobRef;
          }
        } catch {}
        if (!this.closed) {
          try {
            const doneRes: ProcessOperationResult = {
              kind: 'process',
              status: exitFacts.exitCode === 0 && !exitFacts.signal ? 'succeeded' : 'failed',
              exitCode: exitFacts.exitCode,
              signal: exitFacts.signal,
              stdout: bg.stdoutTail.slice(0, 4096),
              stderr: bg.stderrTail.slice(0, 4096),
              isTruncated: bg.stdoutBytes > 4096 || bg.stderrBytes > 4096,
              identityVerification: 'not_original_process',
              durationMs: Date.now() - Date.parse(bg.startedAt),
              completedAt: bg.completedAt,
            };
            finalizeOperation(this.domain, opId, doneRes);
          } catch {}
        }
        events.emit('exit', exitFacts);
      });

      let waitOutcome: AwaitSyscallResult | undefined;
      if (req.waitUntil) {
        const boundCondition = this.bindAwaitOpId(req.waitUntil, opId);
        waitOutcome = await this.await({
          sessionId: session.sessionId,
          condition: boundCondition,
          timeoutMs: req.timeoutMs ?? 15_000,
        });
      }

      const currentStatus: ExecSyscallResult['status'] =
        bg.status === 'exited'
          ? bg.exitCode === 0 && !bg.signal
            ? 'succeeded'
            : 'failed'
          : 'running';

      return {
        opId,
        status: currentStatus,
        exitCode: bg.exitCode,
        signal: bg.signal,
        pid: handle.identity.pid,
        pgid: handle.identity.pgid,
        stdout: bg.stdoutTail,
        stderr: bg.stderrTail,
        durationMs: Date.now() - startMs,
        waitOutcome,
        staleReads: session.checkStaleReads(),
      };
    }

    // Foreground supervised execution
    const res = await this.supervisor.executeProcess({
      runId: this.systemRunId,
      opId,
      name: `exec:${label.slice(0, 64)}`,
      command,
      timeoutMs: req.timeoutMs ?? 60_000,
      maxOutputBytes: Math.max(SUPERVISOR_CAPTURE_BYTES, inlineMaxBytes),
      ...(confinementDriver ? { confinement: true, confinementDriver, mutationRoots } : {}),
      ...(req.trackReads
        ? {
            trackReads: {
              roots: [this.workspaceRoot],
              statCaches: 'ruled_out',
              mode: 'auto',
            },
          }
        : {}),
    });

    if (res.kind === 'indeterminate') {
      return {
        opId,
        status: 'indeterminate',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: res.reason,
        durationMs: res.durationMs,
        replayed: res.replayed,
        staleReads: session.checkStaleReads(),
      };
    }

    const outFormatted = this.formatStreamOutput(res.stdout, res.stdoutRef, res.stdoutHash, inlineMaxBytes);
    const errFormatted = this.formatStreamOutput(res.stderr, res.stderrRef, res.stderrHash, inlineMaxBytes);

    return {
      opId,
      status: res.status,
      exitCode: res.exitCode,
      signal: res.signal,
      stdout: outFormatted.text,
      stderr: errFormatted.text,
      ...(outFormatted.truncated ? { stdoutTruncated: true, stdoutBlob: outFormatted.blob } : {}),
      ...(errFormatted.truncated ? { stderrTruncated: true, stderrBlob: errFormatted.blob } : {}),
      durationMs: res.durationMs,
      ...(res.replayed ? { replayed: true } : {}),
      ...(res.treeSettlement ? { treeSettlement: res.treeSettlement } : {}),
      ...(res.readEvidence ? { readEvidence: res.readEvidence } : {}),
      staleReads: session.checkStaleReads(),
    };
  }

  private bindAwaitOpId(cond: AwaitCondition, opId: string): AwaitCondition {
    if (cond.kind === 'any') {
      return {
        kind: 'any',
        conditions: cond.conditions.map((c) => this.bindAwaitOpId(c, opId)),
      };
    }
    if (cond.kind === 'all') {
      return {
        kind: 'all',
        conditions: cond.conditions.map((c) => this.bindAwaitOpId(c, opId)),
      };
    }
    if (cond.kind === 'process_exit') return { ...cond, opId: cond.opId || opId };
    return { ...cond, opId: cond.opId || opId };
  }

  // =========================================================================
  // Syscall 2: await
  // =========================================================================
  public async await(req: AwaitSyscallRequest): Promise<AwaitSyscallResult> {
    const session = this.getSession(req.sessionId);
    const timeoutMs = req.timeoutMs ?? 15_000;
    const pollIntervalMs = Math.max(15, Math.min(500, req.pollIntervalMs ?? 40));
    const startMs = Date.now();
    const deadline = startMs + timeoutMs;

    const evalResult = await this.evaluateConditionUntil(req.condition, deadline, pollIntervalMs, startMs);
    return {
      ...evalResult,
      staleReads: session.checkStaleReads(),
    };
  }

  private async evaluateConditionUntil(
    cond: AwaitCondition,
    deadline: number,
    pollIntervalMs: number,
    startMs: number,
  ): Promise<Omit<AwaitSyscallResult, 'staleReads'>> {
    if (cond.kind === 'any') {
      while (Date.now() <= deadline) {
      for (const sub of cond.conditions) {
        if (sub.kind === 'any' || sub.kind === 'all') {
          const nested = await this.evaluateConditionUntil(sub, deadline, pollIntervalMs, startMs);
          if (nested.status === 'satisfied' || nested.status === 'process_exited_early') return nested;
          continue;
        }
        const snap = await this.probeSingleCondition(sub);
          if (snap.state === 'satisfied') {
            return {
              status: 'satisfied',
              satisfiedCondition: sub.kind,
              durationMs: Date.now() - startMs,
              detail: snap.detail,
              httpStatus: snap.httpStatus,
              matchedLine: snap.matchedLine,
              fileRev: snap.fileRev,
              processExit: snap.processExit,
            };
          }
          if (snap.state === 'process_exited_early') {
            return {
              status: 'process_exited_early',
              durationMs: Date.now() - startMs,
              detail: snap.detail,
              processExit: snap.processExit,
            };
          }
        }
        const rem = deadline - Date.now();
        if (rem <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, rem)));
      }
      return { status: 'timeout', durationMs: Date.now() - startMs };
    }

    if (cond.kind === 'all') {
      for (const sub of cond.conditions) {
        const res = await this.evaluateConditionUntil(sub, deadline, pollIntervalMs, startMs);
        if (res.status !== 'satisfied') return res;
      }
      return { status: 'satisfied', satisfiedCondition: 'all', durationMs: Date.now() - startMs };
    }

    if (cond.kind === 'process_exit') {
      const bg = this.backgroundProcs.get(cond.opId);
      if (!bg) {
        const recorded = this.domain.getStore().getOperation(cond.opId);
        if (recorded?.status === 'done' && recorded.result?.kind === 'process') {
          return {
            status: 'satisfied',
            satisfiedCondition: 'process_exit',
            durationMs: Date.now() - startMs,
            processExit: {
              opId: cond.opId,
              exitCode: recorded.result.exitCode,
              signal: recorded.result.signal,
              stdoutPreview: recorded.result.stdout.slice(-2048),
              stderrPreview: recorded.result.stderr.slice(-2048),
            },
          };
        }
        throw new Error(`await process_exit: unknown operation "${cond.opId}"`);
      }
      if (bg.status === 'exited') {
        return {
          status: 'satisfied',
          satisfiedCondition: 'process_exit',
          durationMs: Date.now() - startMs,
          processExit: this.bgExitSummary(bg),
        };
      }
      const rem = Math.max(0, deadline - Date.now());
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          bg.events.off('exit', onExit);
          resolve(false);
        }, rem);
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        bg.events.once('exit', onExit);
      });
      if (exited || (bg.status as BackgroundManagedProcess['status']) === 'exited') {
        return {
          status: 'satisfied',
          satisfiedCondition: 'process_exit',
          durationMs: Date.now() - startMs,
          processExit: this.bgExitSummary(bg),
        };
      }
      return { status: 'timeout', durationMs: Date.now() - startMs };
    }

    const leafCond: Exclude<LeafAwaitCondition, { kind: 'process_exit' }> = cond;
    // Event-assisted polling loop with instant process-death short-circuiting!
    let baselineRev: string | undefined;
    if (leafCond.kind === 'file_change') {
      const { absPath } = this.getSession().resolveWorkspacePath(leafCond.path);
      baselineRev = leafCond.sinceRev ?? readDiskSnapshot(absPath).rev;
    }

    while (Date.now() <= deadline) {
      const snap = await this.probeSingleCondition(leafCond, baselineRev);
      if (snap.state === 'satisfied') {
        return {
          status: 'satisfied',
          satisfiedCondition: leafCond.kind,
          durationMs: Date.now() - startMs,
          detail: snap.detail,
          httpStatus: snap.httpStatus,
          matchedLine: snap.matchedLine,
          fileRev: snap.fileRev,
        };
      }
      if (snap.state === 'process_exited_early') {
        return {
          status: 'process_exited_early',
          durationMs: Date.now() - startMs,
          detail: snap.detail,
          processExit: snap.processExit,
        };
      }

      const rem = deadline - Date.now();
      if (rem <= 0) break;
      const boundBg = leafCond.opId ? this.backgroundProcs.get(leafCond.opId) : undefined;
      if (boundBg && boundBg.status === 'running') {
        await new Promise<void>((resolve) => {
          const waitMs = Math.min(pollIntervalMs, rem);
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, waitMs);
          const onWake = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
            clearTimeout(timer);
            boundBg.events.off('exit', onWake);
            if (leafCond.kind === 'output_match') {
              boundBg.events.off('output', onWake);
            }
          };
          boundBg.events.once('exit', onWake);
          if (leafCond.kind === 'output_match') {
            boundBg.events.once('output', onWake);
          }
        });
      } else {
        await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, rem)));
      }
    }

    return { status: 'timeout', durationMs: Date.now() - startMs };
  }

  private bgExitSummary(bg: BackgroundManagedProcess): NonNullable<AwaitSyscallResult['processExit']> {
    return {
      opId: bg.opId,
      exitCode: bg.exitCode,
      signal: bg.signal,
      stdoutPreview: bg.stdoutTail.slice(-2048),
      stderrPreview: bg.stderrTail.slice(-2048),
    };
  }

  private async probeSingleCondition(
    cond: LeafAwaitCondition,
    baselineFileRev?: string,
  ): Promise<{
    state: 'satisfied' | 'pending' | 'process_exited_early';
    detail?: string;
    httpStatus?: number;
    matchedLine?: string;
    fileRev?: string;
    processExit?: AwaitSyscallResult['processExit'];
  }> {
    if (cond.kind === 'process_exit') {
      const bg = this.backgroundProcs.get(cond.opId);
      if (bg && bg.status === 'exited') {
        return { state: 'satisfied', processExit: this.bgExitSummary(bg) };
      }
      return { state: 'pending' };
    }

    if (cond.kind === 'output_match') {
      const bg = this.backgroundProcs.get(cond.opId);
      if (!bg) throw new Error(`await output_match: unknown background operation "${cond.opId}"`);
      const regex = new RegExp(cond.pattern, 'm');
      const stream = cond.stream ?? 'any';
      const haystack =
        stream === 'stdout'
          ? bg.stdoutTail
          : stream === 'stderr'
            ? bg.stderrTail
            : `${bg.stdoutTail}\n${bg.stderrTail}`;
      const match = regex.exec(haystack);
      if (match) {
        return { state: 'satisfied', matchedLine: match[0], detail: `Matched /${cond.pattern}/` };
      }
      if (bg.status === 'exited') {
        return {
          state: 'process_exited_early',
          detail: `Process "${cond.opId}" exited before output matched /${cond.pattern}/`,
          processExit: this.bgExitSummary(bg),
        };
      }
      return { state: 'pending' };
    }

    if (cond.kind === 'port_open') {
      const host = cond.host ?? '127.0.0.1';
      const open = await probeTcpPort(host, cond.port, 250);
      if (open) {
        return { state: 'satisfied', detail: `${host}:${cond.port} accepting connections` };
      }
      const bg = cond.opId ? this.backgroundProcs.get(cond.opId) : undefined;
      if (bg && bg.status === 'exited') {
        return {
          state: 'process_exited_early',
          detail: `Process "${cond.opId}" exited before port ${cond.port} opened`,
          processExit: this.bgExitSummary(bg),
        };
      }
      return { state: 'pending' };
    }

    if (cond.kind === 'http_ready') {
      const probe = await probeHttpUrl(cond.url, 500);
      if (probe.ok) {
        const allowed =
          cond.expectedStatus === undefined
            ? probe.status >= 200 && probe.status < 400
            : Array.isArray(cond.expectedStatus)
              ? cond.expectedStatus.includes(probe.status)
              : probe.status === cond.expectedStatus;
        const bodyOk = cond.bodyPattern ? new RegExp(cond.bodyPattern).test(probe.body) : true;
        if (allowed && bodyOk) {
          return {
            state: 'satisfied',
            httpStatus: probe.status,
            detail: `HTTP ${probe.status} from ${cond.url}`,
          };
        }
      }
      const bg = cond.opId ? this.backgroundProcs.get(cond.opId) : undefined;
      if (bg && bg.status === 'exited') {
        return {
          state: 'process_exited_early',
          detail: `Process "${cond.opId}" exited before ${cond.url} became ready`,
          processExit: this.bgExitSummary(bg),
        };
      }
      return { state: 'pending' };
    }

    if (cond.kind === 'file_change') {
      const { absPath } = this.getSession().resolveWorkspacePath(cond.path);
      const snap = readDiskSnapshot(absPath);
      const refRev = baselineFileRev ?? cond.sinceRev ?? 'missing';
      if (snap.rev !== refRev) {
        return { state: 'satisfied', fileRev: snap.rev, detail: `${cond.path} changed to ${snap.rev}` };
      }
      const bg = cond.opId ? this.backgroundProcs.get(cond.opId) : undefined;
      if (bg && bg.status === 'exited') {
        return {
          state: 'process_exited_early',
          detail: `Process "${cond.opId}" exited before ${cond.path} changed`,
          processExit: this.bgExitSummary(bg),
        };
      }
      return { state: 'pending' };
    }

    return { state: 'pending' };
  }

  // =========================================================================
  // Syscall 3: vfs_tx
  // =========================================================================
  public async vfs_tx(req: VfsTxSyscallRequest): Promise<VfsTxSyscallResult> {
    const session = this.getSession(req.sessionId);
    const txId = req.txId ?? this.nextId('tx');
    const startMs = Date.now();
    const mutations = req.mutations ?? [];
    const useIsolated = req.isolated === true || Boolean(req.branchCmd) || req.commit === false;

    if (useIsolated) {
      return this.runIsolatedShadowTx(txId, session, req, startMs);
    }

    return this.withWorkspaceLock(() => this.runDirectCasTx(txId, session, req, mutations, startMs));
  }

  private async runDirectCasTx(
    txId: string,
    session: SessionView,
    req: VfsTxSyscallRequest,
    mutations: VfsMutation[],
    startMs: number,
  ): Promise<VfsTxSyscallResult> {
    // Direct CAS + atomic gate rollback mode
    const conflicts: NonNullable<VfsTxSyscallResult['conflicts']> = [];
    for (const mut of mutations) {
      const failure = session.validateMutationTarget(mut.path, mut.expectedRev);
      if (failure) conflicts.push(failure);
    }
    if (conflicts.length > 0) {
      return {
        txId,
        status: 'conflict',
        changedFiles: [],
        revisions: {},
        conflicts,
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    }

    // Plan all mutations in memory before touching disk so partial errors never dirty the workspace
    const planned = new Map<
      string,
      {
        relPath: string;
        absPath: string;
        existedBefore: boolean;
        beforeBytes?: Buffer;
        beforeMode?: number;
        action: 'write' | 'delete';
        afterBytes?: Buffer;
      }
    >();

    try {
      for (const mut of mutations) {
        const { absPath, relPath } = session.resolveWorkspacePath(mut.path);
        const prevPlan = planned.get(relPath);
        const existedOnDisk = fs.existsSync(absPath) && fs.lstatSync(absPath).isFile();
        const currentBytes =
          prevPlan !== undefined
            ? prevPlan.action === 'write'
              ? prevPlan.afterBytes
              : undefined
            : existedOnDisk
              ? fs.readFileSync(absPath)
              : undefined;
        const beforeRecord = prevPlan
          ? {
              existedBefore: prevPlan.existedBefore,
              beforeBytes: prevPlan.beforeBytes,
              beforeMode: prevPlan.beforeMode,
            }
          : {
              existedBefore: existedOnDisk,
              beforeBytes: existedOnDisk ? currentBytes : undefined,
              beforeMode: existedOnDisk ? fs.lstatSync(absPath).mode : undefined,
            };

        if (mut.kind === 'delete') {
          planned.set(relPath, {
            relPath,
            absPath,
            ...beforeRecord,
            action: 'delete',
          });
        } else if (mut.kind === 'write') {
          planned.set(relPath, {
            relPath,
            absPath,
            ...beforeRecord,
            action: 'write',
            afterBytes: Buffer.from(mut.content, 'utf8'),
          });
        } else if (mut.kind === 'patch') {
          if (currentBytes === undefined) {
            throw new Error(`Cannot patch missing file "${relPath}"`);
          }
          const patched = applyTextEdits(relPath, currentBytes.toString('utf8'), mut);
          planned.set(relPath, {
            relPath,
            absPath,
            ...beforeRecord,
            action: 'write',
            afterBytes: Buffer.from(patched, 'utf8'),
          });
        }
      }
    } catch (planErr: any) {
      return {
        txId,
        status: 'rolled_back',
        changedFiles: [],
        revisions: {},
        errorMessage: planErr?.message || String(planErr),
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    }

    // Optional git-shadow snapshot before applying mutations when gateCmd is present (also catches side-effect files created by gateCmd!)
    let gateSnapshotId: string | undefined;
    if (req.gateCmd && (await this.isGitWorkspace())) {
      const snapOpId = `${txId}:pre-gate-snap`;
      const snapRes = await this.supervisor.captureSnapshot({
        runId: this.systemRunId,
        opId: snapOpId,
        roots: [this.workspaceRoot],
      });
      if (snapRes.status === 'succeeded' && snapRes.snapshot) {
        gateSnapshotId = snapRes.snapshot.id;
      }
    }

    const restoreUndo = async () => {
      if (gateSnapshotId) {
        try {
          await this.supervisor.rollback({
            runId: this.systemRunId,
            opId: `${txId}:gate-rollback`,
            snapshotId: gateSnapshotId,
          });
          await this.supervisor.pruneSnapshots([gateSnapshotId], { runId: this.systemRunId });
          gateSnapshotId = undefined;
          return;
        } catch {
          // Fallback to exact per-file undo below
        }
      }
      for (const item of planned.values()) {
        if (!item.existedBefore) {
          fs.rmSync(item.absPath, { force: true });
        } else if (item.beforeBytes !== undefined) {
          fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
          fs.writeFileSync(item.absPath, item.beforeBytes, {
            ...(item.beforeMode !== undefined ? { mode: item.beforeMode } : {}),
          });
        }
      }
    };

    try {
      for (const item of planned.values()) {
        if (item.action === 'delete') {
          fs.rmSync(item.absPath, { force: true });
        } else if (item.afterBytes !== undefined) {
          fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
          const tmpPath = `${item.absPath}.xio-tmp-${process.pid}-${Date.now()}`;
          fs.writeFileSync(tmpPath, item.afterBytes, {
            ...(item.beforeMode !== undefined ? { mode: item.beforeMode } : {}),
          });
          fs.renameSync(tmpPath, item.absPath);
        }
      }

      let gateSummary: VfsTxSyscallResult['gateResult'];
      if (req.gateCmd) {
        const gateExec = await this.exec({
          sessionId: session.sessionId,
          opId: `${txId}:gate`,
          cmd: req.gateCmd,
          timeoutMs: req.gateTimeoutMs ?? 60_000,
        });
        gateSummary = {
          exitCode: gateExec.exitCode,
          stdout: gateExec.stdout,
          stderr: gateExec.stderr,
          ...(gateExec.stdoutBlob ? { stdoutBlob: gateExec.stdoutBlob } : {}),
          ...(gateExec.stderrBlob ? { stderrBlob: gateExec.stderrBlob } : {}),
        };
        if (gateExec.status !== 'succeeded' || gateExec.exitCode !== 0) {
          await restoreUndo();
          return {
            txId,
            status: 'rolled_back',
            changedFiles: [],
            revisions: {},
            gateResult: gateSummary,
            errorMessage: `Gate command failed with exitCode=${gateExec.exitCode}`,
            durationMs: Date.now() - startMs,
            staleReads: session.checkStaleReads(),
          };
        }
      }

      if (gateSnapshotId) {
        await this.supervisor.pruneSnapshots([gateSnapshotId], { runId: this.systemRunId }).catch(() => {});
      }

      const changedFiles: string[] = [];
      const revisions: Record<string, string> = {};
      for (const item of planned.values()) {
        changedFiles.push(item.relPath);
        const rec = session.recordWrite(item.relPath);
        revisions[item.relPath] = rec.rev;
      }

      return {
        txId,
        status: 'committed',
        changedFiles: changedFiles.sort(),
        revisions,
        ...(gateSummary ? { gateResult: gateSummary } : {}),
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    } catch (err: any) {
      await restoreUndo();
      return {
        txId,
        status: 'rolled_back',
        changedFiles: [],
        revisions: {},
        errorMessage: err?.message || String(err),
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    }
  }

  private async runIsolatedShadowTx(
    txId: string,
    session: SessionView,
    req: VfsTxSyscallRequest,
    startMs: number,
  ): Promise<VfsTxSyscallResult> {
    if (!(await this.isGitWorkspace())) {
      return {
        txId,
        status: 'rolled_back',
        changedFiles: [],
        revisions: {},
        errorMessage: 'Isolated shadow transactions require a Git repository workspace',
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    }

    // Validate causal preconditions on explicit mutations first
    const conflicts: NonNullable<VfsTxSyscallResult['conflicts']> = [];
    for (const mut of req.mutations ?? []) {
      const failure = session.validateMutationTarget(mut.path, mut.expectedRev);
      if (failure) conflicts.push(failure);
    }
    if (conflicts.length > 0) {
      return {
        txId,
        status: 'conflict',
        changedFiles: [],
        revisions: {},
        conflicts,
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    }

    const forkPath = path.join(this.forksDir, txId);
    const tx = await this.withWorkspaceLock(() =>
      this.supervisor.beginWorkspaceTransaction({
        txId,
        runId: this.systemRunId,
        root: this.workspaceRoot,
        forkPath,
      }),
    );

    let branchSummary: VfsTxSyscallResult['branchResult'];
    let gateSummary: VfsTxSyscallResult['gateResult'];

    try {
      // Apply structured mutations inside forkRoot
      for (const mut of req.mutations ?? []) {
        const targetAbs = path.resolve(tx.forkRoot, mut.path);
        if (!isPathContained(tx.forkRoot, targetAbs)) {
          throw new Error(`Mutation path "${mut.path}" escapes isolated fork root`);
        }
        if (mut.kind === 'delete') {
          fs.rmSync(targetAbs, { force: true });
        } else if (mut.kind === 'write') {
          fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
          fs.writeFileSync(targetAbs, mut.content, 'utf8');
        } else if (mut.kind === 'patch') {
          if (!fs.existsSync(targetAbs)) {
            throw new Error(`Cannot patch missing file "${mut.path}" in isolated branch`);
          }
          const patched = applyTextEdits(mut.path, fs.readFileSync(targetAbs, 'utf8'), mut);
          fs.writeFileSync(targetAbs, patched, 'utf8');
        }
      }

      if (req.branchCmd) {
        const branchExec = await this.exec({
          sessionId: session.sessionId,
          opId: `${txId}:branch-cmd`,
          cmd: req.branchCmd,
          cwd: tx.forkRoot,
          timeoutMs: req.gateTimeoutMs ?? 60_000,
        });
        branchSummary = {
          exitCode: branchExec.exitCode,
          stdout: branchExec.stdout,
          stderr: branchExec.stderr,
          ...(branchExec.stdoutBlob ? { stdoutBlob: branchExec.stdoutBlob } : {}),
          ...(branchExec.stderrBlob ? { stderrBlob: branchExec.stderrBlob } : {}),
        };
        if (branchExec.status !== 'succeeded' || branchExec.exitCode !== 0) {
          await this.supervisor.abortWorkspaceTransaction(txId, 'branch_cmd_failed');
          return {
            txId,
            status: 'rolled_back',
            changedFiles: [],
            revisions: {},
            branchResult: branchSummary,
            errorMessage: `Branch command failed with exitCode=${branchExec.exitCode}`,
            durationMs: Date.now() - startMs,
            staleReads: session.checkStaleReads(),
          };
        }
      }

      if (req.gateCmd) {
        const gateExec = await this.exec({
          sessionId: session.sessionId,
          opId: `${txId}:branch-gate`,
          cmd: req.gateCmd,
          cwd: tx.forkRoot,
          timeoutMs: req.gateTimeoutMs ?? 60_000,
        });
        gateSummary = {
          exitCode: gateExec.exitCode,
          stdout: gateExec.stdout,
          stderr: gateExec.stderr,
          ...(gateExec.stdoutBlob ? { stdoutBlob: gateExec.stdoutBlob } : {}),
          ...(gateExec.stderrBlob ? { stderrBlob: gateExec.stderrBlob } : {}),
        };
        if (gateExec.status !== 'succeeded' || gateExec.exitCode !== 0) {
          await this.supervisor.abortWorkspaceTransaction(txId, 'gate_cmd_failed');
          return {
            txId,
            status: 'rolled_back',
            changedFiles: [],
            revisions: {},
            ...(branchSummary ? { branchResult: branchSummary } : {}),
            gateResult: gateSummary,
            errorMessage: `Gate command failed in isolated branch with exitCode=${gateExec.exitCode}`,
            durationMs: Date.now() - startMs,
            staleReads: session.checkStaleReads(),
          };
        }
      }

      const effects = await this.supervisor.inspectWorkspaceTransaction(txId);
      const changedFiles = effects.writeSet.map((w) => w.path).sort();

      if (req.commit === false) {
        await this.withWorkspaceLock(() => this.supervisor.abortWorkspaceTransaction(txId, 'dry_run'));
        return {
          txId,
          status: 'dry_run',
          changedFiles,
          revisions: {},
          ...(branchSummary ? { branchResult: branchSummary } : {}),
          ...(gateSummary ? { gateResult: gateSummary } : {}),
          durationMs: Date.now() - startMs,
          staleReads: session.checkStaleReads(),
        };
      }

      const commitRes = await this.withWorkspaceLock(() => this.supervisor.commitWorkspaceTransaction(txId));
      if (commitRes.status === 'conflict') {
        return {
          txId,
          status: 'conflict',
          changedFiles: [],
          revisions: {},
          conflicts: commitRes.conflicts,
          ...(branchSummary ? { branchResult: branchSummary } : {}),
          ...(gateSummary ? { gateResult: gateSummary } : {}),
          durationMs: Date.now() - startMs,
          staleReads: session.checkStaleReads(),
        };
      }

      const revisions: Record<string, string> = {};
      for (const w of commitRes.writeSet) {
        const rec = session.recordWrite(w.path);
        revisions[w.path] = rec.rev;
      }

      return {
        txId,
        status: 'committed',
        changedFiles: commitRes.writeSet.map((w) => w.path).sort(),
        revisions,
        ...(branchSummary ? { branchResult: branchSummary } : {}),
        ...(gateSummary ? { gateResult: gateSummary } : {}),
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    } catch (err: any) {
      await this.supervisor.abortWorkspaceTransaction(txId, 'exception').catch(() => {});
      return {
        txId,
        status: 'rolled_back',
        changedFiles: [],
        revisions: {},
        ...(branchSummary ? { branchResult: branchSummary } : {}),
        ...(gateSummary ? { gateResult: gateSummary } : {}),
        errorMessage: err?.message || String(err),
        durationMs: Date.now() - startMs,
        staleReads: session.checkStaleReads(),
      };
    }
  }

  // =========================================================================
  // Syscall 4: blob
  // =========================================================================
  public async blob(req: BlobSyscallRequest): Promise<BlobSyscallResult> {
    const session = this.getSession(req.sessionId);

    if (req.op === 'put') {
      const entry = this.registerBlobFromBuffer(Buffer.from(req.content, 'utf8'));
      return {
        op: 'put',
        target: entry.blobRef,
        blobRef: entry.blobRef,
        sha256: entry.sha256,
        totalBytes: entry.totalBytes,
        totalLines: entry.totalLines,
      };
    }

    if (req.op === 'stat') {
      const resolved = this.resolveBlobOrFileTarget(session, req.target);
      return {
        op: 'stat',
        target: resolved.label,
        ...(resolved.blobRef ? { blobRef: resolved.blobRef } : {}),
        ...(resolved.rev ? { rev: resolved.rev } : {}),
        sha256: resolved.sha256,
        totalBytes: resolved.totalBytes,
        totalLines: resolved.totalLines,
      };
    }

    if (req.op === 'slice') {
      const resolved = this.resolveBlobOrFileTarget(session, req.target, {
        recordSessionRead: true,
        symbols: req.symbols,
        startLine: req.startLine,
        endLine: req.endLine,
      });
      const lines = resolved.text.split('\n');
      const totalLines = resolved.totalLines;
      const startLine = Math.max(1, req.startLine ?? 1);
      const endLine = Math.min(Math.max(startLine, req.endLine ?? startLine + 199), Math.max(1, totalLines));
      const sliceLines = totalLines === 0 ? [] : lines.slice(startLine - 1, endLine);
      const numbered = sliceLines.map((line, idx) => `${startLine + idx}|${line}`).join('\n');
      return {
        op: 'slice',
        target: resolved.label,
        ...(resolved.blobRef ? { blobRef: resolved.blobRef } : {}),
        ...(resolved.rev ? { rev: resolved.rev } : {}),
        sha256: resolved.sha256,
        totalBytes: resolved.totalBytes,
        totalLines,
        startLine,
        endLine: totalLines === 0 ? 0 : endLine,
        hasMore: endLine < totalLines,
        content: numbered,
      };
    }

    // op === 'grep'
    const maxMatches = Math.max(1, Math.min(500, req.maxMatches ?? 50));
    const contextLines = Math.max(0, Math.min(10, req.contextLines ?? 0));
    const flags = req.caseSensitive === false ? 'i' : '';
    const matcher = req.isRegex
      ? new RegExp(req.pattern, flags)
      : new RegExp(req.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

    const targetSpec = req.target ?? '.';
    const matches: BlobGrepMatch[] = [];
    let truncatedMatches = false;
    let totalBytes = 0;
    let totalLines = 0;

    const grepText = (label: string, text: string) => {
      const lines = text.split('\n');
      totalBytes += Buffer.byteLength(text, 'utf8');
      totalLines += lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          if (matches.length >= maxMatches) {
            truncatedMatches = true;
            return false;
          }
          matches.push({
            target: label,
            line: i + 1,
            text: lines[i].slice(0, 500),
            ...(contextLines > 0
              ? {
                  contextBefore: lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 300)),
                  contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)).map((l) => l.slice(0, 300)),
                }
              : {}),
          });
        }
      }
      return true;
    };

    if (targetSpec.startsWith('blob:')) {
      const resolved = this.resolveBlobOrFileTarget(session, targetSpec);
      grepText(resolved.label, resolved.text);
    } else {
      const { absPath, relPath } = session.resolveWorkspacePath(targetSpec);
      const st = fs.lstatSync(absPath, { throwIfNoEntry: false });
      if (!st) {
        throw new Error(`grep target "${targetSpec}" does not exist`);
      }
      if (st.isFile()) {
        const snap = readDiskSnapshot(absPath);
        if (snap.text !== undefined) grepText(relPath || path.basename(absPath), snap.text);
      } else if (st.isDirectory()) {
        const walkDir = (dirAbs: string): boolean => {
          const entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (GREP_SKIP_DIRS.has(entry.name)) continue;
              if (!walkDir(path.join(dirAbs, entry.name))) return false;
            } else if (entry.isFile()) {
              const fileAbs = path.join(dirAbs, entry.name);
              const fileStat = fs.lstatSync(fileAbs, { throwIfNoEntry: false });
              if (!fileStat || fileStat.size > 2 * 1024 * 1024) continue;
              const snap = readDiskSnapshot(fileAbs);
              if (snap.text === undefined) continue;
              const fileRel = path.relative(this.workspaceRoot, fileAbs).split(path.sep).join('/');
              if (!grepText(fileRel, snap.text)) return false;
            }
          }
          return true;
        };
        walkDir(absPath);
      }
    }

    return {
      op: 'grep',
      target: targetSpec,
      totalBytes,
      totalLines,
      matches,
      truncatedMatches,
    };
  }

  private resolveBlobOrFileTarget(
    session: SessionView,
    target: string,
    opts?: { recordSessionRead?: boolean; symbols?: string[]; startLine?: number; endLine?: number },
  ): {
    label: string;
    blobRef?: string;
    rev?: string;
    sha256: string;
    totalBytes: number;
    totalLines: number;
    text: string;
  } {
    if (target.startsWith('blob:')) {
      let entry = this.blobIndex.get(target);
      if (!entry) {
        const candidate = path.join(this.blobsDir, `${target.slice('blob:'.length)}.blob`);
        if (fs.existsSync(candidate)) {
          entry = this.registerBlobFromFile(candidate);
        }
      }
      if (!entry || !fs.existsSync(entry.filePath)) {
        throw new Error(`Unknown blob reference "${target}"`);
      }
      const buf = fs.readFileSync(entry.filePath);
      return {
        label: entry.blobRef,
        blobRef: entry.blobRef,
        sha256: entry.sha256,
        totalBytes: entry.totalBytes,
        totalLines: entry.totalLines,
        text: buf.toString('utf8'),
      };
    }

    if (path.isAbsolute(target) && isPathContained(this.domain.domainPath, path.resolve(target))) {
      const entry = this.registerBlobFromFile(path.resolve(target));
      const buf = fs.readFileSync(entry.filePath);
      return {
        label: entry.blobRef,
        blobRef: entry.blobRef,
        sha256: entry.sha256,
        totalBytes: entry.totalBytes,
        totalLines: entry.totalLines,
        text: buf.toString('utf8'),
      };
    }

    const { absPath, relPath } = session.resolveWorkspacePath(target);
    if (!fs.existsSync(absPath) || !fs.lstatSync(absPath).isFile()) {
      throw new Error(`Workspace file "${relPath}" does not exist`);
    }
    const buf = fs.readFileSync(absPath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const rev = computeBytesRev(buf);
    if (opts?.recordSessionRead) {
      session.recordRead(relPath, {
        symbols: opts.symbols,
        startLine: opts.startLine,
        endLine: opts.endLine,
      });
    }
    return {
      label: relPath,
      rev,
      sha256,
      totalBytes: buf.length,
      totalLines: countLinesInBuffer(buf),
      text: buf.toString('utf8'),
    };
  }

  // =========================================================================
  // Syscall 5: observe
  // =========================================================================
  public async observe(req?: ObserveSyscallRequest): Promise<ObserveSyscallResult> {
    const session = this.getSession(req?.sessionId);
    const git = await this.inspectGitStatus();
    const activeProcesses: ManagedProcessSummary[] = [];
    const recentBackgroundProcesses: ManagedProcessSummary[] = [];

    for (const bg of this.backgroundProcs.values()) {
      const summary: ManagedProcessSummary = {
        opId: bg.opId,
        pid: bg.handle.identity.pid,
        pgid: bg.handle.identity.pgid,
        command: bg.commandLabel,
        status: bg.status,
        exitCode: bg.exitCode,
        signal: bg.signal,
        startedAt: bg.startedAt,
        ...(bg.completedAt ? { completedAt: bg.completedAt } : {}),
        stdoutBytes: bg.stdoutBytes,
        stderrBytes: bg.stderrBytes,
        ...(bg.stdoutBlobRef ? { stdoutBlobRef: bg.stdoutBlobRef } : {}),
        ...(bg.stderrBlobRef ? { stderrBlobRef: bg.stderrBlobRef } : {}),
      };
      if (bg.status === 'running') activeProcesses.push(summary);
      else recentBackgroundProcesses.push(summary);
    }

    const indeterminateOperations: ObserveSyscallResult['indeterminateOperations'] = [];
    for (const op of this.domain.getStore().getAllOperations(this.domain.domainId)) {
      if (op.result?.status === 'indeterminate' && !op.result.adjudication) {
        indeterminateOperations.push({
          opId: op.id,
          reason: op.result.reason,
          recoveryGuidance: op.result.recoveryGuidance,
        });
      }
    }

    const staleReads = session.checkStaleReads({ includeAlreadyNotified: req?.includeAllStale ?? true });
    const stats = session.getStats();
    return {
      workspaceRoot: this.workspaceRoot,
      domainId: this.domain.domainId,
      epoch: this.domain.getStore().getCurrentEpoch() ?? 0,
      git,
      activeProcesses,
      recentBackgroundProcesses: recentBackgroundProcesses.slice(-20),
      indeterminateOperations,
      sessionStats: {
        sessionId: session.sessionId,
        trackedFiles: stats.trackedFiles,
        earlyCutoffHits: stats.earlyCutoffHits,
      },
      staleReads,
    };
  }

  // =========================================================================
  // Syscall 6: adjudicate
  // =========================================================================
  public async adjudicate(req: AdjudicateSyscallRequest): Promise<AdjudicateSyscallResult> {
    const adjudication = await this.domain.adjudicate(req.opId, req.verdict, req.actor, req.note, {
      evidence: req.evidence,
    });
    return { adjudication };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stopPromises: Promise<unknown>[] = [];
    for (const bg of this.backgroundProcs.values()) {
      if (bg.status === 'running') {
        stopPromises.push(
          this.driver.terminate(bg.handle.identity, 500).catch(() => {}),
        );
      }
      bg.stdoutStream.end();
      bg.stderrStream.end();
    }
    await Promise.all(stopPromises);
    if (this.ownsDomain) {
      this.domain.close();
    }
  }

  private async isGitWorkspace(): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.workspaceRoot,
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async inspectGitStatus(): Promise<ObserveSyscallResult['git']> {
    try {
      const { stdout: statusOut } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '-b'],
        { cwd: this.workspaceRoot, encoding: 'utf8', timeout: 4000 },
      );
      const lines = statusOut.trimEnd().split('\n').filter(Boolean);
      let branch: string | undefined;
      const dirtyFiles: string[] = [];
      for (const line of lines) {
        if (line.startsWith('## ')) {
          branch = line.slice(3).split('...')[0]?.trim();
        } else if (line.length > 3) {
          dirtyFiles.push(line.slice(3).trim());
        }
      }
      let head: string | undefined;
      try {
        const { stdout: headOut } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: this.workspaceRoot,
          encoding: 'utf8',
          timeout: 2000,
        });
        head = headOut.trim();
      } catch {}
      return { isRepo: true, branch, head, dirtyFiles };
    } catch {
      return { isRepo: false, dirtyFiles: [] };
    }
  }
}

function applyTextEdits(
  relPath: string,
  original: string,
  mut: Extract<VfsMutation, { kind: 'patch' }>,
): string {
  const edits =
    mut.edits && mut.edits.length > 0
      ? mut.edits
      : mut.oldText !== undefined && mut.newText !== undefined
        ? [{ oldText: mut.oldText, newText: mut.newText, replaceAll: mut.replaceAll }]
        : [];
  if (edits.length === 0) {
    throw new Error(`Patch on "${relPath}" must specify oldText/newText or non-empty edits[]`);
  }
  let current = original;
  for (const edit of edits) {
    if (!edit.oldText) {
      throw new Error(`Patch on "${relPath}" has an empty oldText`);
    }
    const parts = current.split(edit.oldText);
    const occurrences = parts.length - 1;
    if (occurrences === 0) {
      throw new Error(`Patch target oldText not found in "${relPath}"`);
    }
    if (!edit.replaceAll && occurrences > 1) {
      throw new Error(`Patch target oldText matched ${occurrences} locations in "${relPath}"; provide more context or set replaceAll: true`);
    }
    current = edit.replaceAll ? parts.join(edit.newText) : current.replace(edit.oldText, () => edit.newText);
  }
  return current;
}

function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function probeHttpUrl(urlStr: string, timeoutMs: number): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      resolve({ ok: false, status: 0, body: '' });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        if (total < 16_384) {
          chunks.push(chunk);
          total += chunk.length;
        }
      });
      res.on('end', () => {
        resolve({
          ok: true,
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: '' });
    });
    req.on('error', () => {
      resolve({ ok: false, status: 0, body: '' });
    });
  });
}
