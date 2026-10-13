import crypto from 'node:crypto';
import { ExecutionDomain } from '../domain.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { ProcessExecutionResult, TerminationReason } from '../types.js';
import { ToolInputSchema } from './input-schema.js';

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
  inputSchema: ToolInputSchema;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  call(ctx: ToolContext, args: Record<string, any>): Promise<Record<string, unknown>>;
}

const str = (description: string, minLength = 1) => ({ type: 'string' as const, minLength, description });
const osStr = (description: string, minLength = 1) => ({ ...str(description, minLength), pattern: '^[^\\u0000]*$' });
const strArray = (description: string, minLength = 0, items = str('Array item.', minLength)) => ({ type: 'array' as const, items, description });
const txIdSchema = () => ({ ...str('Transaction id (letters, digits, ".", "_", "-").'), pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' });
const MAX_TIMER_MS = 2_147_483_647;

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
  return text.length <= max ? { text, omittedChars: 0 } : { text: max === 0 ? '' : text.slice(-max), omittedChars: text.length - max };
}

function summarizeProcess(ctx: ToolContext, opId: string, runId: string, res: ProcessExecutionResult) {
  const facts = {
    ...res,
    opId,
    runId,
    driver: ctx.driverName,
    replayed: res.replayed === true,
    processIdentity: ctx.domain.getStore().getOperation(opId)?.processIdentity,
  };
  // An indeterminate result has no observed exit or output. Do not invent empty output or a null exit.
  if (res.kind !== 'process') return facts;
  const stdout = tail(res.stdout, ctx.maxOutputChars);
  const stderr = tail(res.stderr, ctx.maxOutputChars);
  return {
    ...facts,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutOmittedChars: stdout.omittedChars || undefined,
    stderrOmittedChars: stderr.omittedChars || undefined,
    // Kernel byte-limit truncation stays in isTruncated/stdoutTruncated/stderrTruncated.
    mcpOutput: {
      maxOutputChars: ctx.maxOutputChars,
      stdoutOmittedChars: stdout.omittedChars,
      stderrOmittedChars: stderr.omittedChars,
    },
  };
}

/**
 * 在一个新 Run 中执行；正常返回时 Run 收尾为 succeeded（有 indeterminate 操作时内核判为 indeterminate），
 * 抛错（准入拒绝、指纹冲突等）时收尾为 failed，不留下永远 running 的 Run。
 */
async function withRun<T extends { status: string; terminationReason?: TerminationReason }>(ctx: ToolContext, label: string, fn: (runId: string) => Promise<T>): Promise<T> {
  const runId = newRun(ctx, label);
  const store = ctx.domain.getStore();
  let result: T;
  try {
    result = await fn(runId);
  } catch (err) {
    try {
      if (store.getRun(runId)?.status !== 'indeterminate') store.reportRunFailed(runId);
    } catch (finalizeError) {
      const originalMessage = err instanceof Error ? err.message : String(err);
      const finalizeMessage = finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
      throw new AggregateError([err, finalizeError], `MCP tool failed: ${originalMessage}; run finalization failed: ${finalizeMessage}`, { cause: err });
    }
    throw err;
  }
  if (result.status === 'indeterminate') {
    // The original execution may already have finalized this run; a replay belongs to a new request run.
    if (store.getRun(runId)?.status !== 'indeterminate') store.updateRunStatus(runId, 'indeterminate', result.terminationReason);
  } else if (store.getRun(runId)?.status !== 'indeterminate') {
    store.reportRunSucceeded(runId);
  }
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
        command: osStr('Executable to run (resolved on PATH).'),
        args: strArray('Arguments, passed without a shell.', 0, osStr('Argument.', 0)),
        cwd: osStr('Working directory (absolute path).'),
        opId: str('Idempotency key. Reuse it to retry safely: a recorded operation is replayed, never re-run.'),
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMER_MS, description: 'Stop the process tree after this many milliseconds.' },
        resources: strArray('Exclusive resources to hold while running, e.g. "workspace:write:/repo" or "port:3000".', 1),
        stdin: str('Text written to stdin, which is then closed.', 0),
      },
      required: ['command', 'cwd'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    async call(ctx, args) {
      const opId = args.opId ?? `mcp-${crypto.randomUUID()}`;
      ctx.bindOperation(opId);
      return withRun(ctx, 'mcp-run', async (runId) => {
        const res = await ctx.supervisor.executeProcess({
          runId,
          opId,
          name: args.command,
          command: {
            execPath: args.command,
            args: args.args ?? [],
            cwd: args.cwd,
            stdin: args.stdin,
          },
          requiredResources: args.resources ?? [],
          timeoutMs: args.timeoutMs,
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
      const op = ctx.domain.getStore().getOperation(args.opId);
      if (!op) return { opId: args.opId, found: false };
      const result = op.result;
      return {
        opId: op.id,
        found: true,
        kind: op.kind,
        runId: op.runId,
        status: op.status,
        processIdentity: op.processIdentity,
        resultStatus: result?.status,
        exitCode: result?.kind === 'process' ? result.exitCode : undefined,
        reason: result?.kind === 'indeterminate' ? result.reason : undefined,
        recoveryGuidance: result?.kind === 'indeterminate' ? result.recoveryGuidance : undefined,
        result: op.result && (op.result.kind === 'process' || op.result.kind === 'indeterminate')
          ? summarizeProcess(ctx, op.id, op.result.runId ?? op.runId, op.result)
          : op.result,
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
        graceMs: { type: 'integer', minimum: 0, maximum: MAX_TIMER_MS, description: 'Time between SIGINT and escalation (default 2000).' },
      },
      required: ['opId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx, args) {
      const res = await ctx.supervisor.cancelOperation(args.opId, args.graceMs ?? 2000);
      return { opId: args.opId, ...res };
    },
  },
  {
    name: 'snapshot_workspace',
    title: 'Snapshot a workspace',
    description: 'Capture a restorable snapshot of a git working tree (tracked and untracked, ignored files excluded) without touching the index, HEAD or branches.',
    inputSchema: {
      type: 'object',
      properties: { root: osStr('Directory inside a git working tree.') },
      required: ['root'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async call(ctx, args) {
      const res = await withRun(ctx, 'mcp-snapshot', (runId) =>
        ctx.supervisor.captureSnapshot({ runId, opId: `snap-${crypto.randomUUID()}`, roots: [args.root] })
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
        ctx.supervisor.rollback({ runId, opId: `rollback-${crypto.randomUUID()}`, snapshotId: args.snapshotId })
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
        txId: txIdSchema(),
        root: osStr('Workspace directory inside a git working tree.'),
        forkPath: osStr('Where to create the fork (must not exist).'),
      },
      required: ['txId', 'root', 'forkPath'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
    async call(ctx, args) {
      const tx = await withRun(ctx, 'mcp-tx', (runId) =>
        ctx.supervisor.beginWorkspaceTransaction({
          txId: args.txId,
          runId,
          root: args.root,
          forkPath: args.forkPath,
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
      properties: { txId: txIdSchema() },
      required: ['txId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    async call(ctx, args) {
      return { ...(await ctx.supervisor.commitWorkspaceTransaction(args.txId)) };
    },
  },
  {
    name: 'abort_transaction',
    title: 'Abort a workspace transaction',
    description: 'Discard the transaction and remove its fork. The workspace is not changed.',
    inputSchema: {
      type: 'object',
      properties: { txId: txIdSchema(), reason: str('Why it was aborted (journaled).', 0) },
      required: ['txId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async call(ctx, args) {
      await ctx.supervisor.abortWorkspaceTransaction(args.txId, args.reason);
      return { txId: args.txId, aborted: true };
    },
  },
];
