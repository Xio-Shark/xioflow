import crypto from 'node:crypto';
import { ExecutionDomain } from '../domain.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { ProcessOperationResult } from '../types.js';

/**
 * MCP 工具：把内核原语暴露给任意 MCP 客户端（agent 框架、IDE、CLI agent）。
 * 刻意不暴露 adjudicate：indeterminate 的出口是人工裁决，不交给模型。
 */

export interface ToolContext {
  domain: ExecutionDomain;
  supervisor: ProcessSupervisor;
  driverName: string;
  sessionTaskId: string;
  maxOutputChars: number;
  /** 当前请求的流式输出回调（客户端带 progressToken 时才有）。 */
  onChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  /** 把 opId 绑定到当前请求，使 notifications/cancelled 能取消它。 */
  bindOperation(opId: string): void;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  call(ctx: ToolContext, args: Record<string, any>): Promise<Record<string, unknown>>;
}

const str = (description: string) => ({ type: 'string', description });
const strArray = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

/** 每次工具调用一个 Run（Run = turn）：一次 indeterminate 不会让整个会话无法继续。 */
function newRun(ctx: ToolContext, label: string): string {
  const store = ctx.domain.getStore();
  if (!store.getTask(ctx.sessionTaskId)) {
    store.saveTask({
      id: ctx.sessionTaskId,
      domainId: ctx.domain.domainId,
      name: 'MCP session',
      createdAt: new Date().toISOString(),
    });
  }
  const runId = `${label}-${crypto.randomUUID()}`;
  store.saveRun({
    id: runId,
    taskId: ctx.sessionTaskId,
    domainId: ctx.domain.domainId,
    owner: 'mcp',
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  return runId;
}

function tail(text: string, max: number): { text: string; omittedChars: number } {
  return text.length <= max ? { text, omittedChars: 0 } : { text: text.slice(-max), omittedChars: text.length - max };
}

function summarizeProcess(ctx: ToolContext, opId: string, runId: string, res: ProcessOperationResult) {
  const r = res as ProcessOperationResult & Record<string, any>;
  const stdout = tail(r.stdout ?? '', ctx.maxOutputChars);
  const stderr = tail(r.stderr ?? '', ctx.maxOutputChars);
  return {
    opId,
    runId,
    driver: ctx.driverName,
    status: r.status,
    exitCode: r.exitCode ?? null,
    signal: r.signal ?? null,
    replayed: r.replayed === true,
    terminationReason: r.terminationReason,
    reason: r.reason,
    recoveryGuidance: r.recoveryGuidance,
    residualProcessesReaped: r.residualProcessesReaped,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutOmittedChars: stdout.omittedChars || undefined,
    stderrOmittedChars: stderr.omittedChars || undefined,
    stdoutRef: r.stdoutRef,
    stderrRef: r.stderrRef,
    durationMs: r.durationMs,
  };
}

/**
 * 在一个新 Run 中执行；正常返回时 Run 收尾为 succeeded（有 indeterminate 操作时内核判为 indeterminate），
 * 抛错（准入拒绝、指纹冲突等）时收尾为 failed，不留下永远 running 的 Run。
 */
async function withRun<T>(ctx: ToolContext, label: string, fn: (runId: string) => Promise<T>): Promise<T> {
  const runId = newRun(ctx, label);
  const store = ctx.domain.getStore();
  let result: T;
  try {
    result = await fn(runId);
  } catch (err) {
    store.reportRunFailed(runId);
    throw err;
  }
  store.reportRunSucceeded(runId);
  return result;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    title: 'Run a supervised command',
    description:
      'Run a command under the xioflow kernel: the intent is persisted before it starts, the whole process tree is stopped on timeout or cancel, and the result says "indeterminate" instead of guessing when the kernel cannot confirm what happened. Passing the same opId again returns the recorded result instead of running twice.',
    inputSchema: {
      type: 'object',
      properties: {
        command: str('Executable to run (resolved on PATH).'),
        args: strArray('Arguments, passed without a shell.'),
        cwd: str('Working directory (absolute path).'),
        opId: str('Idempotency key. Reuse it to retry safely: a recorded operation is replayed, never re-run.'),
        timeoutMs: { type: 'integer', minimum: 1, description: 'Stop the process tree after this many milliseconds.' },
        resources: strArray('Exclusive resources to hold while running, e.g. "workspace:write:/repo" or "port:3000".'),
        stdin: str('Text written to stdin, which is then closed.'),
      },
      required: ['command', 'cwd'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    async call(ctx, args) {
      const opId = typeof args.opId === 'string' && args.opId ? args.opId : `mcp-${crypto.randomUUID()}`;
      ctx.bindOperation(opId);
      return withRun(ctx, 'mcp-run', async (runId) => {
        const res = await ctx.supervisor.executeProcess({
          runId,
          opId,
          name: String(args.command),
          command: {
            execPath: String(args.command),
            args: Array.isArray(args.args) ? args.args.map(String) : [],
            cwd: String(args.cwd),
            stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
          },
          requiredResources: Array.isArray(args.resources) ? args.resources.map(String) : [],
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          onStreamChunk: ctx.onChunk,
        });
        return summarizeProcess(ctx, opId, res.runId ?? runId, res);
      });
    },
  },
  {
    name: 'operation_status',
    title: 'Look up an operation',
    description: 'Return the recorded status and result of an operation by opId, including indeterminate operations that wait for a human decision.',
    inputSchema: {
      type: 'object',
      properties: { opId: str('Operation id returned by run_command.') },
      required: ['opId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async call(ctx, args) {
      const op = ctx.domain.getStore().getOperation(String(args.opId));
      if (!op) return { opId: args.opId, found: false };
      const result = op.result as Record<string, any> | undefined;
      return {
        opId: op.id,
        found: true,
        kind: op.kind,
        status: op.status,
        resultStatus: result?.status,
        exitCode: result?.exitCode,
        reason: result?.reason,
        recoveryGuidance: result?.recoveryGuidance,
        leasesHeld: ctx.domain
          .getStore()
          .getPersistedResourceLeases(ctx.domain.domainId)
          .filter((l) => l.operationId === op.id)
          .map((l) => l.resourceId),
      };
    },
  },
  {
    name: 'cancel_operation',
    title: 'Stop a running operation',
    description: 'Stop a running operation and its whole process tree. The answer is "confirmed_stopped" only when the kernel verified nothing is left running.',
    inputSchema: {
      type: 'object',
      properties: {
        opId: str('Operation id to stop.'),
        graceMs: { type: 'integer', minimum: 0, description: 'Time between SIGINT and escalation (default 2000).' },
      },
      required: ['opId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx, args) {
      const res = await ctx.supervisor.cancelOperation(String(args.opId), typeof args.graceMs === 'number' ? args.graceMs : 2000);
      return { opId: args.opId, ...res };
    },
  },
  {
    name: 'snapshot_workspace',
    title: 'Snapshot a workspace',
    description: 'Capture a restorable snapshot of a git working tree (tracked and untracked, ignored files excluded) without touching the index, HEAD or branches.',
    inputSchema: {
      type: 'object',
      properties: { root: str('Directory inside a git working tree.') },
      required: ['root'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async call(ctx, args) {
      const res = await withRun(ctx, 'mcp-snapshot', (runId) =>
        ctx.supervisor.captureSnapshot({ runId, opId: `snap-${crypto.randomUUID()}`, roots: [String(args.root)] })
      );
      return { status: res.status, snapshotId: res.snapshot?.id, roots: res.snapshot?.roots, error: res.errorMessage };
    },
  },
  {
    name: 'rollback_workspace',
    title: 'Roll a workspace back to a snapshot',
    description: 'Restore the snapshot roots and verify the result. "coverage" says how much of the change the rollback can vouch for; it is "complete" only when every operation since the snapshot ran confined and ignored files were in the snapshot. Snapshots taken through this server exclude ignored files, so the best result here is "non_ignored"; "coverageBasis" lists the reasons.',
    inputSchema: {
      type: 'object',
      properties: { snapshotId: str('Snapshot id from snapshot_workspace.') },
      required: ['snapshotId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx, args) {
      const res = await withRun(ctx, 'mcp-rollback', (runId) =>
        ctx.supervisor.rollback({ runId, opId: `rollback-${crypto.randomUUID()}`, snapshotId: String(args.snapshotId) })
      );
      return { ...res };
    },
  },
  {
    name: 'begin_transaction',
    title: 'Start a workspace transaction',
    description: 'Fork a git working tree for one agent. Work inside the returned forkRoot, then commit: the change lands only if no other transaction changed what this one read or wrote.',
    inputSchema: {
      type: 'object',
      properties: {
        txId: str('Transaction id (letters, digits, ".", "_", "-").'),
        root: str('Workspace directory inside a git working tree.'),
        forkPath: str('Where to create the fork (must not exist).'),
      },
      required: ['txId', 'root', 'forkPath'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
    async call(ctx, args) {
      const tx = await withRun(ctx, 'mcp-tx', (runId) =>
        ctx.supervisor.beginWorkspaceTransaction({
          txId: String(args.txId),
          runId,
          root: String(args.root),
          forkPath: String(args.forkPath),
        })
      );
      return { ...tx };
    },
  },
  {
    name: 'commit_transaction',
    title: 'Commit a workspace transaction',
    description: 'Validate the transaction against changes committed since it began and apply it to the workspace. On conflict nothing is applied and the conflicting paths are listed. Validation here is file-level (read and write sets); replaying a transaction\'s observations needs a host-side replay function and is only available to embedded hosts.',
    inputSchema: {
      type: 'object',
      properties: { txId: str('Transaction id.') },
      required: ['txId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    async call(ctx, args) {
      return { ...(await ctx.supervisor.commitWorkspaceTransaction(String(args.txId))) };
    },
  },
  {
    name: 'abort_transaction',
    title: 'Abort a workspace transaction',
    description: 'Discard the transaction and remove its fork. The workspace is not changed.',
    inputSchema: {
      type: 'object',
      properties: { txId: str('Transaction id.'), reason: str('Why it was aborted (journaled).') },
      required: ['txId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async call(ctx, args) {
      await ctx.supervisor.abortWorkspaceTransaction(String(args.txId), typeof args.reason === 'string' ? args.reason : undefined);
      return { txId: args.txId, aborted: true };
    },
  },
];
