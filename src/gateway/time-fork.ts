import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { resolveDriver, wrapAgent, WrapAgentOptions, WrapAgentResult } from './shell-shim.js';
import {
  Http304CacheAdapter,
  ParsedToolCall,
  RecordedGatewayTurn,
  RecordedToolExecution,
  WireProtocolName,
} from './wire-proxy.js';

export interface GatewayTraceStep {
  /** 1-indexed step number (Step 1 = turnIndex 0). */
  step: number;
  /** 0-indexed turn number. */
  turnIndex: number;
  llmTurnId: string;
  wire: WireProtocolName;
  model: string;
  promptSummary: string;
  responseText: string;
  toolCalls: ParsedToolCall[];
  toolExecutions: RecordedToolExecution[];
  opIds: string[];
  readFiles: string[];
  writeFiles?: string[];
  deletedFiles?: string[];
  deniedFiles?: string[];
  snapshotId?: string;
  snapshotJournalSeq?: number;
  treeFingerprint?: string;
  journalSeq?: number;
  cacheStatus: 'HIT-304' | 'MISS';
  etag?: string;
  cutoffUsed?: boolean;
  timestamp: string;
}

export interface GatewayRunTrace {
  runId: string;
  domainId: string;
  domainPath: string;
  workspaceRoot: string;
  steps: GatewayTraceStep[];
  rawTurns: RecordedGatewayTurn[];
}

export interface TraceGatewayRunOptions {
  runId: string;
  workspaceRoot?: string;
  domain?: ExecutionDomain;
  domainPath?: string;
  domainId?: string;
}

export interface ForkGatewayRunOptions {
  runId: string;
  /** 1-indexed step number N to fork at (first N-1 steps fast-forward via HIT-304, step N diverges). */
  atStep: number;
  workspaceRoot?: string;
  domain?: ExecutionDomain;
  domainPath?: string;
  domainId?: string;
  /** Destination directory for the materialized Git shadow worktree. Defaults to a new temp dir. */
  forkPath?: string;
  /** Optional new agent command to execute starting from step N inside the forked worktree. */
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  upstreamUrl?: WrapAgentOptions['upstreamUrl'];
  tape?: WrapAgentOptions['tape'];
  forkRunId?: string;
  inheritStdio?: boolean;
}

export interface ForkGatewayRunResult {
  sourceRunId: string;
  forkRunId: string;
  atStep: number;
  snapshotId: string;
  expectedTreeFingerprint: string;
  forkTreeFingerprintAtStep: string;
  finalTreeFingerprint: string;
  forkWorktreePath: string;
  fastForwardedSteps: number;
  agentResult?: WrapAgentResult;
}

function summarizePrompt(turn: Partial<RecordedGatewayTurn>): string {
  const conv = turn.parsedRequest?.conversation;
  if (Array.isArray(conv) && conv.length > 0) {
    for (let i = conv.length - 1; i >= 0; i--) {
      const item = conv[i] as any;
      if (!item) continue;
      if (typeof item.content === 'string' && item.content.trim()) {
        return item.content.trim().replace(/\s+/g, ' ').slice(0, 120);
      }
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (typeof block?.text === 'string' && block.text.trim()) {
            return block.text.trim().replace(/\s+/g, ' ').slice(0, 120);
          }
          if (typeof block?.content === 'string' && block.content.trim()) {
            return block.content.trim().replace(/\s+/g, ' ').slice(0, 120);
          }
        }
      }
      if (Array.isArray(item.parts)) {
        for (const part of item.parts) {
          if (typeof part?.text === 'string' && part.text.trim()) {
            return part.text.trim().replace(/\s+/g, ' ').slice(0, 120);
          }
        }
      }
    }
  }
  return `turn-${turn.turnIndex ?? 0}`;
}

/**
 * Inspect the Flight Recorder Trace (`xio trace <runId>`) of a wrapped agent run,
 * correlating each LLM turn with its Git shadow `SnapshotRef` (`snapshotId`, `treeFingerprint`, `snapshotJournalSeq`),
 * `journalSeq`, `ProcessSupervisor` `opIds[]`, and `HIT-304` / `MISS` cache status.
 */
export async function traceGatewayRun(options: TraceGatewayRunOptions): Promise<GatewayRunTrace> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const ownsDomain = !options.domain;
  const domainPath = path.resolve(
    options.domain?.domainPath ?? options.domainPath ?? path.join(workspaceRoot, '.xioflow-kernel')
  );
  const domainId = options.domain?.domainId ?? options.domainId ?? 'default';
  const domain = options.domain ?? ExecutionDomain.acquire(domainPath, domainId);

  try {
    const store = domain.getStore();
    const traceFile = path.join(domainPath, 'gateway-traces', `${options.runId}.json`);
    let rawTurns: RecordedGatewayTurn[] = [];
    let resolvedWorkspaceRoot = workspaceRoot;

    if (fs.existsSync(traceFile)) {
      const parsed = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
      if (Array.isArray(parsed.turns)) {
        rawTurns = parsed.turns;
      }
      if (typeof parsed.workspaceRoot === 'string') {
        resolvedWorkspaceRoot = parsed.workspaceRoot;
      }
    }

    // Enrich or reconstruct from SQLite journal events if needed
    const events = store
      .getJournalEvents(domain.domainId)
      .filter((e) => e.runId === options.runId && e.type.startsWith('GATEWAY_'));

    if (rawTurns.length === 0 && events.length > 0) {
      const byTurn = new Map<number, Partial<RecordedGatewayTurn>>();
      for (const e of events) {
        const tIdx = typeof e.payload.turnIndex === 'number' ? e.payload.turnIndex : undefined;
        if (tIdx === undefined) continue;
        const entry = byTurn.get(tIdx) ?? {
          turnIndex: tIdx,
          opIds: [],
          readFiles: [],
          toolExecutions: [],
          parsedResponse: { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } },
        };
        if (e.type === 'GATEWAY_TURN_STARTED') {
          entry.wire = (e.payload.wire as WireProtocolName) ?? 'chat-completions';
          entry.model = String(e.payload.model ?? '');
          entry.snapshotId = e.payload.snapshotId as string | undefined;
          entry.snapshotJournalSeq = e.payload.snapshotJournalSeq as number | undefined;
          entry.treeFingerprint = e.payload.treeFingerprint as string | undefined;
        } else if (e.type === 'GATEWAY_TURN_COMPLETED') {
          entry.wire = (e.payload.wire as WireProtocolName) ?? entry.wire ?? 'chat-completions';
          entry.model = String(e.payload.model ?? entry.model ?? '');
          entry.cacheStatus = (e.payload.cacheStatus as 'HIT-304' | 'MISS') ?? 'MISS';
          entry.etag = e.payload.etag as string | undefined;
          entry.cutoffUsed = e.payload.cutoffUsed as boolean | undefined;
          entry.snapshotId = (e.payload.snapshotId as string | undefined) ?? entry.snapshotId;
          entry.snapshotJournalSeq = (e.payload.snapshotJournalSeq as number | undefined) ?? entry.snapshotJournalSeq;
          entry.treeFingerprint = (e.payload.treeFingerprint as string | undefined) ?? entry.treeFingerprint;
          entry.journalSeq = e.seq;
          entry.timestamp = e.timestamp;
          if (Array.isArray(e.payload.toolCalls)) {
            entry.parsedResponse = {
              text: '',
              toolCalls: e.payload.toolCalls as ParsedToolCall[],
              usage: (e.payload.usage as { inputTokens: number; outputTokens: number }) ?? {
                inputTokens: 0,
                outputTokens: 0,
              },
            };
          }
        } else if (e.type === 'GATEWAY_TURN_TOOL_EXECUTED') {
          const opId = String(e.payload.opId ?? '');
          if (opId && !entry.opIds!.includes(opId)) entry.opIds!.push(opId);
        }
        byTurn.set(tIdx, entry);
      }
      rawTurns = [...byTurn.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v as RecordedGatewayTurn);
    }

    const steps: GatewayTraceStep[] = rawTurns.map((t, idx) => {
      const turnIndex = t.turnIndex ?? idx;
      const snap = t.snapshotId ? store.getSnapshot(t.snapshotId) : undefined;
      return {
        step: turnIndex + 1,
        turnIndex,
        llmTurnId: `${options.runId}:turn:${turnIndex}`,
        wire: t.wire,
        model: t.model,
        promptSummary: summarizePrompt(t),
        responseText: t.parsedResponse?.text ?? '',
        toolCalls: t.parsedResponse?.toolCalls ?? [],
        toolExecutions: t.toolExecutions ?? [],
        opIds: t.opIds ?? [],
        readFiles: t.readFiles ?? [],
        writeFiles: t.writeFiles ?? [],
        deletedFiles: t.deletedFiles ?? [],
        deniedFiles: t.deniedFiles ?? [],
        snapshotId: t.snapshotId,
        snapshotJournalSeq: t.snapshotJournalSeq ?? snap?.journalSeq,
        treeFingerprint: t.treeFingerprint ?? snap?.treeFingerprint,
        journalSeq: t.journalSeq,
        cacheStatus: t.cacheStatus,
        etag: t.etag,
        cutoffUsed: t.cutoffUsed,
        timestamp: t.timestamp,
      };
    });

    return {
      runId: options.runId,
      domainId: domain.domainId,
      domainPath,
      workspaceRoot: resolvedWorkspaceRoot,
      steps,
      rawTurns,
    };
  } finally {
    if (ownsDomain) {
      domain.close();
    }
  }
}

export function formatGatewayRunTrace(trace: GatewayRunTrace): string {
  const lines: string[] = [
    `Flight Recorder Trace: ${trace.runId} (domain=${trace.domainId}, steps=${trace.steps.length})`,
    `Workspace: ${trace.workspaceRoot}`,
    '--------------------------------------------------------------------------------',
  ];
  for (const s of trace.steps) {
    const tools = s.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args ?? {})})`).join(', ') || 'none';
    const treeSha = s.treeFingerprint ? s.treeFingerprint.slice(0, 12) : 'n/a';
    const badge = s.cacheStatus === 'HIT-304' ? (s.cutoffUsed ? 'HIT-304 (Early-Cutoff)' : 'HIT-304') : 'MISS';
    lines.push(
      `[Step ${s.step}] wire=${s.wire} model=${s.model} cache=${badge} tree=${treeSha} snap=${s.snapshotId ?? 'n/a'} seq=${s.journalSeq ?? 'n/a'}`,
      `  Prompt : ${s.promptSummary}`,
      `  Tools  : ${tools}`,
      `  OpIds  : ${s.opIds.join(', ') || 'none'}`,
      `  VFS    : read=[${s.readFiles.join(', ')}] write=[${(s.writeFiles ?? []).join(', ')}]${
        s.deniedFiles && s.deniedFiles.length > 0 ? ` denied=[${s.deniedFiles.join(', ')}]` : ''
      }`
    );
  }
  return lines.join('\n');
}

/**
 * Time-Travel Workspace & Conversation Fork (`xio fork <runId> --at-step <N> [-- <new-agent-cmd>]`):
 * 1. Materializes the exact Git shadow snapshot from Step `N` into a new isolated worktree.
 * 2. Verifies that the materialized worktree's `treeFingerprint` matches Step `N`'s snapshot 100%.
 * 3. When a new agent command is supplied, fast-forwards Steps `1 .. N-1` (`turnIndex < N - 1`)
 *    via `HIT-304` (0 upstream LLM requests, with automatic cross-protocol SSE transcoding and
 *    recorded tool-output replay) and hands over execution to the new agent starting at Step `N`.
 */
export async function forkGatewayRunAtStep(options: ForkGatewayRunOptions): Promise<ForkGatewayRunResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const ownsDomain = !options.domain;
  const domainPath = path.resolve(
    options.domain?.domainPath ?? options.domainPath ?? path.join(workspaceRoot, '.xioflow-kernel')
  );
  const domainId = options.domain?.domainId ?? options.domainId ?? 'default';
  const domain = options.domain ?? ExecutionDomain.acquire(domainPath, domainId);

  try {
    const trace = await traceGatewayRun({
      runId: options.runId,
      workspaceRoot,
      domain,
      domainPath,
      domainId,
    });

    if (options.atStep < 1 || options.atStep > trace.steps.length) {
      throw new Error(
        `Invalid --at-step ${options.atStep}: run "${options.runId}" has ${trace.steps.length} recorded step(s) (valid range: 1..${trace.steps.length})`
      );
    }

    const targetStep = trace.steps[options.atStep - 1];
    if (!targetStep.snapshotId) {
      throw new Error(`Step ${options.atStep} of run "${options.runId}" does not have an associated git-shadow snapshot`);
    }

    const store = domain.getStore();
    const snapRef = store.getSnapshot(targetStep.snapshotId);
    if (!snapRef) {
      throw new Error(`Snapshot "${targetStep.snapshotId}" not found in domain store`);
    }

    const driver = resolveDriver('auto');
    const snapshotDriver = new GitShadowSnapshotDriver();
    const supervisor = new ProcessSupervisor(domain, driver, snapshotDriver);

    const forkRunId = options.forkRunId ?? `${options.runId}-fork-s${options.atStep}-${crypto.randomUUID().slice(0, 6)}`;
    const forkWorktreePath = options.forkPath
      ? path.resolve(options.forkPath)
      : path.join(fs.mkdtempSync(path.join(os.tmpdir(), `xio-fork-s${options.atStep}-`)), 'worktree');

    await supervisor.materialize(snapRef.id, forkWorktreePath);
    // Release the materialization write lease on forkWorktreePath so the forked agent can freely use it
    for (const resKey of new Set([
      `workspace:write:${path.resolve(forkWorktreePath)}`,
      `workspace:write:${fs.realpathSync(forkWorktreePath)}`,
    ])) {
      const owner = domain.getResourceOwner(resKey);
      if (owner) {
        domain.internalReleaseResources(owner, [resKey]);
      }
    }

    const realForkPath = fs.realpathSync(forkWorktreePath);
    const forkTreeFingerprintAtStep = await snapshotDriver.fingerprint([realForkPath], { against: snapRef });
    if (forkTreeFingerprintAtStep !== snapRef.treeFingerprint) {
      throw new Error(
        `Forked worktree fingerprint mismatch at step ${options.atStep}: expected ${snapRef.treeFingerprint}, got ${forkTreeFingerprintAtStep}`
      );
    }

    let agentResult: WrapAgentResult | undefined;
    let fastForwardedSteps = 0;

    if (options.command) {
      const prefixTurnLimit = options.atStep - 1; // turns 0 .. atStep - 2 fast-forward via HIT-304
      const toolCursorByTurn = new Map<number, number>();

      const forkCacheAdapter: Http304CacheAdapter = {
        async lookup({ turnIndex }) {
          if (turnIndex < prefixTurnLimit) {
            const origTurn = trace.rawTurns[turnIndex];
            if (origTurn) {
              fastForwardedSteps++;
              return {
                hit: true,
                etag: origTurn.etag ?? `W/"fork-${options.runId}-t${turnIndex}"`,
                cutoffUsed: false,
                cachedTurn: origTurn,
              };
            }
          }
          return {
            hit: false,
            etag: `W/"fork-miss-t${turnIndex}"`,
          };
        },
        async recordTurn(turn) {
          return {
            etag: `W/"fork-${forkRunId}-t${turn.turnIndex}"`,
          };
        },
      };

      agentResult = await wrapAgent({
        command: options.command,
        args: options.args,
        env: options.env,
        cwd: realForkPath,
        domain,
        domainPath,
        domainId,
        runId: forkRunId,
        upstreamUrl: options.upstreamUrl,
        tape: options.tape,
        http304Cache: forkCacheAdapter,
        inheritStdio: options.inheritStdio,
        async onShellExecOverride({ turnIndex, defaultExec }) {
          if (turnIndex < prefixTurnLimit) {
            const origStep = trace.steps[turnIndex];
            const idx = toolCursorByTurn.get(turnIndex) ?? 0;
            toolCursorByTurn.set(turnIndex, idx + 1);
            const recordedTool = origStep?.toolExecutions?.[idx];
            if (recordedTool) {
              return {
                exitCode: recordedTool.exitCode,
                signal: recordedTool.signal,
                stdout: recordedTool.stdout,
                stderr: recordedTool.stderr,
                residualProcessesReaped: false,
                readSet: recordedTool.readSet,
                opId: `${forkRunId}-replayed-tool-${turnIndex}-${idx + 1}`,
              };
            }
            return {
              exitCode: 0,
              signal: null,
              stdout: '',
              stderr: '',
              residualProcessesReaped: false,
              readSet: [],
              opId: `${forkRunId}-replayed-tool-${turnIndex}-${idx + 1}`,
            };
          }
          return await defaultExec();
        },
      });
    }

    const finalTreeFingerprint = await snapshotDriver.fingerprint([realForkPath], { against: snapRef });

    return {
      sourceRunId: options.runId,
      forkRunId,
      atStep: options.atStep,
      snapshotId: snapRef.id,
      expectedTreeFingerprint: snapRef.treeFingerprint,
      forkTreeFingerprintAtStep,
      finalTreeFingerprint,
      forkWorktreePath: realForkPath,
      fastForwardedSteps,
      agentResult,
    };
  } finally {
    if (ownsDomain) {
      domain.close();
    }
  }
}
