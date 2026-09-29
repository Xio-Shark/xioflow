import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ExecutionDomain } from '../domain.js';
import { NodePlatformDriver } from '../driver/node-driver.js';
import { ReaperPlatformDriver } from '../driver/reaper-driver.js';
import { PlatformDriver } from '../driver/types.js';
import { RecoveryEngine } from '../recovery/engine.js';
import { exportJournalToOtlp } from '../otel/otlp.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { TOOLS, ToolContext } from './tools.js';

/**
 * MCP server（stdio，JSON-RPC 2.0，每行一条消息），零依赖。
 *
 * 启动顺序遵循「先恢复、再执行」（ARCHITECTURE §3.2）：获取域、运行恢复引擎，然后才响应请求。
 * stdout 只写协议消息；日志写 stderr。支持 progress 通知（请求带 progressToken 时转发输出块）
 * 与 notifications/cancelled（取消对应的 run_command 操作，走标准停止流水线）。
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface KernelMcpServerOptions {
  domainPath: string;
  domainId?: string;
  /** 'auto'：helper 可用时用 ReaperPlatformDriver，否则 NodePlatformDriver；实际选择写进 instructions 与每个结果。 */
  driver?: 'auto' | 'node' | 'reaper';
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
  /** 工具结果中保留的 stdout / stderr 尾部字符数（完整输出见 stdoutRef / stderrRef）。 */
  maxOutputChars?: number;
  /** 周期性把 journal 导出为 OTLP traces；失败写日志且游标不前进，下个周期重试。 */
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
    message: string
  ) {
    super(message);
  }
}

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
  private instructions = '';
  private readonly sessionTaskId = `mcp-session-${crypto.randomUUID()}`;
  /** requestId → 该请求启动的操作，用于 notifications/cancelled */
  private readonly inFlight = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: KernelMcpServerOptions) {
    this.log = options.log ?? ((m) => process.stderr.write(`[xioflow-mcp] ${m}\n`));
    this.output = options.output ?? process.stdout;
  }

  /** 获取域并完成恢复后开始服务；输入流结束时等待在途请求、关闭域后返回。 */
  public async serve(): Promise<void> {
    this.driver = selectDriver(this.options.driver);
    this.domain = ExecutionDomain.acquire(this.options.domainPath, this.options.domainId ?? 'default');
    try {
      const report = await new RecoveryEngine(this.domain, this.driver).recover();
      const isolated = report.recoveredOperations.filter((r) => r.action === 'isolated_indeterminate').length;
      this.log(`domain ${this.options.domainPath} recovered ${report.recoveredOperations.length} operation(s), ${isolated} isolated as indeterminate`);
      this.supervisor = new ProcessSupervisor(this.domain, this.driver);
      this.instructions =
        `xioflow kernel ${packageVersion()} with the ${this.driver.name} driver. ` +
        'Use run_command instead of a plain shell when you need to know for sure what happened: reuse an opId to retry without running twice, ' +
        'and treat "indeterminate" as "stop and ask a human", never as success or failure. ' +
        'Use begin_transaction / commit_transaction when several agents edit the same repository.';

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
      this.domain.close();
    }
  }

  /** 启动周期导出，返回「停止并最后导出一次」的函数；未配置时为空操作。 */
  private startOtlpExport(): () => Promise<void> {
    const otlp = this.options.otlp;
    if (!otlp) return async () => {};
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
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code, message: err?.message ?? String(err) } });
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
      case 'tools/list':
        return {
          tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations,
          })),
        };
      case 'tools/call':
        return this.callTool(params, id);
      case 'notifications/cancelled': {
        const opId = this.inFlight.get(String(params.requestId));
        if (opId) {
          this.log(`request ${params.requestId} cancelled by client (${params.reason ?? 'no reason'}), stopping ${opId}`);
          await this.supervisor!.cancelOperation(opId).catch((err) => this.log(`cancel ${opId}: ${err.message}`));
        }
        return undefined;
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async callTool(params: any, id: JsonRpcId | undefined): Promise<unknown> {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
    const args = params.arguments ?? {};
    const missing = ((tool.inputSchema.required as string[]) ?? []).filter((k) => args[k] === undefined);
    if (missing.length > 0) throw new RpcError(-32602, `${tool.name}: missing required argument(s) ${missing.join(', ')}`);

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
      // 工具执行失败是结果的一部分（MCP 约定），让模型看到原因而不是协议错误
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
