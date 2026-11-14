import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectWorkspace } from '../arbiter/index.js';
import { ExecutionDomain } from '../domain.js';
import { NodePlatformDriver } from '../driver/node-driver.js';
import { ReaperPlatformDriver } from '../driver/reaper-driver.js';
import { PlatformDriver } from '../driver/types.js';
import { defaultDomainPathForWorkspace, KernelMedium } from '../kernel/medium.js';
import type { OsMedium } from '../kernel/syscalls.js';
import { RecoveryEngine } from '../recovery/engine.js';
import { exportJournalToOtlp } from '../otel/otlp.js';
import {
  createSurfaceDispatcher,
  SurfaceValidationError,
  toMcpTools,
  type SurfaceToolDispatcher,
} from '../surface/index.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { compileToolInputSchema } from './input-schema.js';
import { ISA_EXECUTE_TOOL, TOOLS, ToolContext } from './tools.js';
import { executeIsaProgram, type IsaAdapterOptions } from '../adapters/isa.js';

/**
 * MCP server (stdio, JSON-RPC 2.0, newline-delimited), zero runtime dependencies.
 *
 * Default `surface: 'v2'` exposes ONLY the 4 Golden Surface Primitives (`run`, `edit`, `inspect`, `branch`)
 * backed by the workspace-scoped UDS Micro-Arbiter (`connectWorkspace`) so multiple IDE/CLI/sub-agent
 * MCP clients share one causal process-tree & OCC ledger without `DomainLockedError`.
 *
 * Explicit `surface: 'legacy'` preserves the v1 operational toolset; `isaOnly: true` serves only ISA `execute`.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface KernelMcpServerOptions {
  domainPath?: string;
  workspaceRoot?: string;
  domainId?: string;
  /** 'auto': ReaperPlatformDriver when native helper is available, otherwise NodePlatformDriver. */
  driver?: 'auto' | 'node' | 'reaper';
  /** Tool surface: 'v2' (default, 4 golden primitives: run/edit/inspect/branch) or 'legacy'. */
  surface?: 'v2' | 'legacy';
  /** In v2 surface mode, attach to shared UDS Micro-Arbiter (default true when driver is auto and otlp is unset). */
  arbiter?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
  /** Maximum inline characters retained in legacy tool stdout/stderr. */
  maxOutputChars?: number;
  /** Host-owned ISA configuration; binding callbacks are never read from client arguments. */
  isa?: IsaAdapterOptions;
  /** Serve only the preview execute tool without acquiring a domain or creating a database. */
  isaOnly?: boolean;
  /** Periodically export domain journal events as OTLP traces. */
  otlp?: { endpoint: string; headers?: Record<string, string>; intervalMs?: number; serviceName?: string };
}

type JsonRpcId = string | number;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: any;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>
  ) {
    super(message);
  }
}

const inputValidators = new Map(TOOLS.map((tool) => [tool.name, compileToolInputSchema(tool.inputSchema)]));

function packageVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function selectDriver(choice: KernelMcpServerOptions['driver']): PlatformDriver {
  if (choice === 'node') return new NodePlatformDriver();
  if (choice === 'reaper') return new ReaperPlatformDriver();
  return ReaperPlatformDriver.isAvailable() ? new ReaperPlatformDriver() : new NodePlatformDriver();
}

export class KernelMcpServer {
  private readonly log: (message: string) => void;
  private readonly output: NodeJS.WritableStream;
  private domain?: ExecutionDomain;
  private supervisor?: ProcessSupervisor;
  private driver?: PlatformDriver;
  private medium?: OsMedium;
  private surfaceDispatcher?: SurfaceToolDispatcher;
  private instructions = '';
  private readonly sessionTaskId = `mcp-session-${crypto.randomUUID()}`;
  /** Request cancellation only; the kernel remains the execution-state authority. */
  private readonly inFlight = new Map<string, string | AbortController>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: KernelMcpServerOptions) {
    if (options.maxOutputChars !== undefined && (!Number.isSafeInteger(options.maxOutputChars) || options.maxOutputChars < 0)) {
      throw new RangeError('maxOutputChars must be a nonnegative safe integer');
    }
    this.log = options.log ?? ((m) => process.stderr.write(`[xioflow-mcp] ${m}\n`));
    this.output = options.output ?? process.stdout;
    if (options.isaOnly && options.otlp) throw new Error('isaOnly does not own a domain for OTLP export');
  }

  private get effectiveSurface(): 'v2' | 'legacy' {
    return this.options.surface ?? 'v2';
  }

  /** Acquire/attach medium and serve until stdin EOF; drains in-flight calls and closes cleanly. */
  public async serve(): Promise<void> {
    try {
      if (this.options.isaOnly) {
        this.instructions =
          `xioflow kernel ${packageVersion()} ISA preview. Use execute with a structured xio/1 Program. ` +
          'Plan mode validates without creating execution state. Pipeline mode requires an explicit host kernel binding; unsupported results are not success.';
      } else if (this.effectiveSurface === 'v2') {
        const workspaceRoot = fs.realpathSync(this.options.workspaceRoot ?? process.cwd());
        const domainPath = this.options.domainPath
          ? path.resolve(this.options.domainPath)
          : defaultDomainPathForWorkspace(workspaceRoot);
        const useArbiter =
          this.options.arbiter ??
          (!this.options.otlp && (this.options.driver === undefined || this.options.driver === 'auto'));

        if (useArbiter) {
          this.medium = await connectWorkspace(workspaceRoot, {
            domainPath,
            domainId: this.options.domainId,
            sessionId: this.sessionTaskId,
            mode: 'auto',
          });
          this.surfaceDispatcher = createSurfaceDispatcher(this.medium);
          this.log(`attached to workspace arbiter for ${workspaceRoot} (domain ${domainPath})`);
          this.instructions =
            `xioflow OS medium ${packageVersion()} (shared workspace Micro-Arbiter). ` +
            'Tools: run, edit, inspect, branch. Oversized outputs spill to paged blobRef; stale file edits are guarded by SessionView causal revisions.';
        } else {
          this.driver = selectDriver(this.options.driver);
          const kernelMedium = await KernelMedium.open(workspaceRoot, {
            domainPath,
            domainId: this.options.domainId,
            driver: this.driver,
          });
          this.domain = kernelMedium.domain;
          this.supervisor = kernelMedium.supervisor;
          this.medium = kernelMedium;
          this.surfaceDispatcher = createSurfaceDispatcher(this.medium);
          this.log(`opened in-process OS medium for ${workspaceRoot} (${this.driver.name} driver)`);
          this.instructions =
            `xioflow OS medium ${packageVersion()} with the ${this.driver.name} driver. ` +
            'Tools: run, edit, inspect, branch. Oversized outputs spill to paged blobRef; stale file edits are guarded by SessionView causal revisions.';
        }
      } else {
        const domainPath = path.resolve(this.options.domainPath ?? '.xioflow-kernel');
        this.driver = selectDriver(this.options.driver);
        this.domain = ExecutionDomain.acquire(domainPath, this.options.domainId ?? 'default');
        const report = await new RecoveryEngine(this.domain, this.driver).recover();
        const isolated = report.recoveredOperations.filter((r) => r.action === 'isolated_indeterminate').length;
        this.log(`domain ${domainPath} recovered ${report.recoveredOperations.length} operation(s), ${isolated} isolated as indeterminate`);
        this.supervisor = new ProcessSupervisor(this.domain, this.driver);
        this.instructions =
          `xioflow kernel ${packageVersion()} with the ${this.driver.name} driver. ` +
          'Use run_command instead of a plain shell when you need to know for sure what happened: reuse an opId to retry without running twice, ' +
          'and treat "indeterminate" as "stop and ask a human", never as success or failure. ' +
          'Use begin_transaction / commit_transaction when several agents edit the same repository.';
      }

      const stopExport = this.startOtlpExport();
      const lines = readline.createInterface({ input: this.options.input ?? process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const work = this.handleLine(line).catch((err) => this.log(`unhandled: ${err?.stack ?? err}`));
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
      }
      await Promise.allSettled([...this.pending]);
      await stopExport();
    } finally {
      await this.medium?.close().catch(() => {});
      this.domain?.close();
    }
  }

  /** Start periodic OTLP trace export when configured and domain is in-process. */
  private startOtlpExport(): () => Promise<void> {
    const otlp = this.options.otlp;
    if (!otlp || !this.domain) return async () => {};
    let fromSeq = 0;
    let running: Promise<void> = Promise.resolve();
    const exportOnce = () =>
      (running = running.then(async () => {
        try {
          const res = await exportJournalToOtlp(this.domain!, { ...otlp, fromSeq });
          fromSeq = res.nextSeq;
          if (res.spanCount > 0) this.log(`exported ${res.spanCount} span(s) to ${otlp.endpoint}`);
        } catch (err: any) {
          this.log(`OTLP export failed (will retry): ${err?.message ?? err}`);
        }
      }));
    const timer = setInterval(exportOnce, otlp.intervalMs ?? 5000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await exportOnce();
    };
  }

  private async handleLine(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (typeof msg.method !== 'string') {
      if (msg.id !== undefined) this.log(`ignoring response to request ${String(msg.id)}`);
      return;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {}, msg.id ?? undefined);
      if (!isNotification) this.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err: any) {
      if (isNotification) {
        this.log(`notification ${msg.method} failed: ${err?.message ?? err}`);
        return;
      }
      const code = err instanceof RpcError ? err.code : -32603;
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code,
          message: err?.message ?? String(err),
          ...(err instanceof RpcError && err.data ? { data: err.data } : {}),
        },
      });
    }
  }

  private async dispatch(method: string, params: any, id: JsonRpcId | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'xioflow-kernel', title: 'xioflow supervised execution kernel', version: packageVersion() },
          instructions: this.instructions,
        };
      }
      case 'notifications/initialized':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list': {
        if (this.options.isaOnly) {
          const { name, title, description, inputSchema, annotations } = ISA_EXECUTE_TOOL;
          return { tools: [{ name, title, description, inputSchema, annotations }] };
        }
        if (this.effectiveSurface === 'v2') {
          return { tools: toMcpTools() };
        }
        return {
          tools: [ISA_EXECUTE_TOOL, ...TOOLS].map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations,
          })),
        };
      }
      case 'tools/call':
        return this.callTool(params, id);
      case 'notifications/cancelled': {
        const target = this.inFlight.get(String(params.requestId));
        if (target instanceof AbortController) {
          this.log(`request ${params.requestId} cancelled by client; stopping pending ISA dispatch`);
          target.abort(new DOMException('MCP ISA request cancelled', 'AbortError'));
        } else if (target) {
          const opId = target;
          this.log(`request ${params.requestId} cancelled by client (${params.reason ?? 'no reason'}), stopping ${opId}`);
          if (this.medium) {
            await this.medium.exec({ stopOpId: opId, sessionId: this.sessionTaskId }).catch((err) => this.log(`cancel ${opId}: ${err.message}`));
          } else if (this.supervisor) {
            await this.supervisor.cancelOperation(opId).catch((err) => this.log(`cancel ${opId}: ${err.message}`));
          }
        }
        return undefined;
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async callTool(params: any, id: JsonRpcId | undefined): Promise<unknown> {
    if ((this.options.isaOnly || this.effectiveSurface === 'legacy') && params?.name === ISA_EXECUTE_TOOL.name) {
      const args = params.arguments;
      if (
        args === null ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => key !== 'program') ||
        args.program === null ||
        typeof args.program !== 'object' ||
        Array.isArray(args.program)
      ) {
        throw new RpcError(-32602, 'execute requires exactly one object argument: program');
      }
      const controller = new AbortController();
      if (id !== undefined) this.inFlight.set(String(id), controller);
      try {
        const result = await executeIsaProgram(args.program, { ...this.options.isa, signal: controller.signal });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: result.status !== 'admitted' && result.status !== 'succeeded',
        };
      } finally {
        if (id !== undefined && this.inFlight.get(String(id)) === controller) this.inFlight.delete(String(id));
      }
    }

    if (this.options.isaOnly) {
      throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
    }

    if (this.effectiveSurface === 'v2') {
      const rawName = typeof params?.name === 'string' ? params.name : '';
      const rawArgs = params?.arguments === undefined ? {} : params.arguments;
      try {
        const result = await this.surfaceDispatcher!.call(rawName, rawArgs, {
          sessionId: this.sessionTaskId,
          onOpId: (opId) => {
            if (id !== undefined) this.inFlight.set(String(id), opId);
          },
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        };
      } catch (err: any) {
        if (err instanceof SurfaceValidationError) {
          throw new RpcError(-32602, err.message, { tool: err.tool, path: err.fieldPath });
        }
        const error = { error: err?.name ?? 'Error', message: err?.message ?? String(err) };
        return {
          content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
          structuredContent: error,
          isError: true,
        };
      } finally {
        if (id !== undefined) this.inFlight.delete(String(id));
      }
    }

    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
    const args = params.arguments === undefined ? {} : params.arguments;
    const issue = inputValidators.get(tool.name)!(args);
    if (issue) throw new RpcError(-32602, `${tool.name}: ${issue.path} ${issue.message}`, { tool: tool.name, ...issue });

    const progressToken = params._meta?.progressToken;
    let progress = 0;
    const ctx: ToolContext = {
      domain: this.domain!,
      supervisor: this.supervisor!,
      driverName: this.driver!.name,
      sessionTaskId: this.sessionTaskId,
      maxOutputChars: this.options.maxOutputChars ?? 16_000,
      bindOperation: (opId) => {
        if (id !== undefined) this.inFlight.set(String(id), opId);
      },
      onChunk:
        progressToken === undefined
          ? undefined
          : (stream, chunk) => {
              progress += chunk.length;
              this.send({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken, progress, message: `[${stream}] ${chunk.toString('utf8').slice(0, 2000)}` },
              });
            },
    };
    try {
      const result = await tool.call(ctx, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
    } catch (err: any) {
      const error = { error: err?.name ?? 'Error', message: err?.message ?? String(err) };
      return { content: [{ type: 'text', text: JSON.stringify(error, null, 2) }], structuredContent: error, isError: true };
    } finally {
      if (id !== undefined) this.inFlight.delete(String(id));
    }
  }

  private send(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
