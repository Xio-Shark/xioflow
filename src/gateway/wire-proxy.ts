import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';

export type WireProtocolName = 'chat-completions' | 'responses' | 'gemini' | 'anthropic';

export interface ToolSpec {
  name: string;
  properties: Record<string, any>;
}

export interface ShellToolInfo {
  name: string;
  commandParam: string;
  timeoutParam?: string;
  params: string[];
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ParsedToolResult {
  callId: string;
  text: string;
  isError?: boolean;
}

export interface ParsedWireRequest {
  wire: WireProtocolName;
  main: boolean;
  model: string;
  tools: ToolSpec[];
  shellTool?: ShellToolInfo;
  conversation: unknown[];
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
  stream: boolean;
}

export interface ParsedWireResponse {
  text: string;
  toolCalls: ParsedToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface WireStreamWriter {
  text(chunk: string): void;
  toolCall(call: { id: string; name: string; args: Record<string, unknown> }): void;
  end(): void;
}

export interface ShellExecRequest {
  command: string;
  shell: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface ShellExecResponse {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  residualProcessesReaped?: boolean;
  readSet?: string[];
  writeSet?: string[];
  deleteSet?: string[];
  deniedSet?: string[];
  opId?: string;
}

export interface RecordedToolExecution {
  opId: string;
  callId?: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  readSet: string[];
  writeSet?: string[];
  deleteSet?: string[];
  deniedSet?: string[];
}

export interface RecordedGatewayTurn {
  turnIndex: number;
  wire: WireProtocolName;
  model: string;
  requestPath: string;
  requestBody: any;
  parsedRequest: ParsedWireRequest;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  rawResponseBody: string;
  parsedResponse: ParsedWireResponse;
  cacheStatus: 'HIT-304' | 'MISS';
  etag?: string;
  cutoffUsed?: boolean;
  journalSeq?: number;
  snapshotId?: string;
  snapshotJournalSeq?: number;
  treeFingerprint?: string;
  opIds: string[];
  readFiles: string[];
  writeFiles?: string[];
  deletedFiles?: string[];
  deniedFiles?: string[];
  toolExecutions?: RecordedToolExecution[];
  timestamp: string;
}

export interface Http304LookupResult {
  hit: boolean;
  etag: string;
  cutoffUsed?: boolean;
  cachedTurn?: RecordedGatewayTurn;
  deltaNotice?: string;
  staleNotice?: string;
}

export interface Http304CacheAdapter {
  lookup(params: {
    turnIndex: number;
    parsed: ParsedWireRequest;
    body: any;
    workspaceRoot: string;
  }): Promise<Http304LookupResult>;
  recordTurn(turn: RecordedGatewayTurn, workspaceRoot: string): Promise<{ etag: string }>;
  recordToolExecution?(params: {
    turnIndex: number;
    callId?: string;
    command: string;
    readFiles: string[];
    writeFiles: string[];
    output: string;
  }): void;
}

export interface InterruptedToolRecord {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  wire: WireProtocolName;
  turnIndex: number;
  startedAt: string;
  reapedByWatchdog?: boolean;
}

export interface WireProxyOptions {
  domain?: ExecutionDomain;
  domainPath?: string;
  domainId?: string;
  runId?: string;
  workspaceRoot?: string;
  upstreamUrl?: string | Partial<Record<WireProtocolName | 'default', string>>;
  tape?: {
    schema_version?: string;
    name: string;
    turns: Array<{ steps: any[] }>;
  };
  transcriptPath?: string;
  http304Cache?: Http304CacheAdapter;
  captureTurnSnapshot?: (turnIndex: number) => Promise<
    | {
        snapshotId: string;
        treeFingerprint: string;
        journalSeq?: number;
      }
    | undefined
  >;
  onTurnCompleted?: (turn: RecordedGatewayTurn) => Promise<void> | void;
  onBeforeMainRequest?: () => Promise<void> | void;
  onShellExec?: (req: ShellExecRequest, activeToolCall?: ParsedToolCall) => Promise<ShellExecResponse>;
  getKernelStatus?: () => Record<string, unknown>;
}

export interface WireProxyHandle {
  port: number;
  baseUrl: string;
  events: EventEmitter;
  state: {
    requests: number;
    mainRequests: number;
    upstreamRequests: number;
    cacheHits304: number;
    cursor: number;
    tapeExhausted: boolean;
    adapterNeeded: boolean;
    shellTool?: ShellToolInfo;
    turns: RecordedGatewayTurn[];
  };
  getActiveToolCall(): ParsedToolCall | undefined;
  clearActiveToolCall(callId?: string): void;
  release(barrierId: string): void;
  close(): Promise<void>;
}

const SHELL_NAME = /bash|shell|exec|command|terminal/i;
const COMMAND_PARAMS = ['command', 'cmd'];
const TIMEOUT_PARAMS = [
  { name: 'timeout', unit: 'ms' },
  { name: 'timeout_ms', unit: 'ms' },
  { name: 'yield_time_ms', unit: 'ms' },
];

export const USAGE = { input: 100, output: 20 };

export function discoverShellTool(tools: ToolSpec[]): ShellToolInfo | undefined {
  for (const tool of tools) {
    if (!SHELL_NAME.test(tool.name)) continue;
    const commandParam = COMMAND_PARAMS.find((p) => tool.properties?.[p]?.type?.toLowerCase() === 'string');
    if (!commandParam) continue;
    const timeout = TIMEOUT_PARAMS.find((p) => tool.properties?.[p.name]);
    return {
      name: tool.name,
      commandParam,
      timeoutParam: timeout?.name,
      params: Object.keys(tool.properties ?? {}),
    };
  }
  return undefined;
}

export function resolveToolCall(
  step: any,
  shellTool?: ShellToolInfo
): { name: string; args: Record<string, unknown>; timeoutMs?: number } | undefined {
  if (step.action !== 'shell' && step.tool !== 'shell') {
    return { name: step.name, args: step.arguments ?? step.args ?? {}, timeoutMs: step.timeoutMs };
  }
  if (!shellTool) return undefined;
  const args: Record<string, unknown> = { [shellTool.commandParam]: step.command };
  if (step.timeoutMs !== undefined && shellTool.timeoutParam) {
    args[shellTool.timeoutParam] = step.timeoutMs;
  }
  if (shellTool.params.includes('description')) {
    args.description = 'audit step';
  }
  return {
    name: shellTool.name,
    args: { ...args, ...(step.extraArgs ?? {}) },
    timeoutMs: step.timeoutMs,
  };
}

function halves(text: string): string[] {
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)].filter(Boolean);
}

export function openSse(res: http.ServerResponse, extraHeaders: Record<string, string> = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...extraHeaders,
  });
  return {
    send(data: unknown, event?: string) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function textOfContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  return content == null ? '' : JSON.stringify(content);
}

function geminiResponseText(response: any): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const value = response.output ?? response.error ?? response.content ?? response;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return '';
}

function safeJsonParse(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractTimeoutMs(args: Record<string, unknown> | undefined): number | undefined {
  if (!args) return undefined;
  for (const { name } of TIMEOUT_PARAMS) {
    const v = args[name];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

export function detectWireProtocol(method: string | undefined, pathname: string): WireProtocolName | undefined {
  if (method !== 'POST') return undefined;
  if (pathname.endsWith('/chat/completions')) return 'chat-completions';
  if (pathname.endsWith('/responses')) return 'responses';
  if (pathname.endsWith('/v1/messages') || pathname.endsWith('/messages')) return 'anthropic';
  if (/:(stream)?[gG]enerateContent$/.test(pathname)) return 'gemini';
  return undefined;
}

export function parseWireRequest(
  method: string | undefined,
  pathname: string,
  rawOrBody: any,
  url: URL = new URL(pathname, 'http://127.0.0.1')
): ParsedWireRequest | undefined {
  const wire = detectWireProtocol(method, pathname.split('?')[0]!);
  const body = typeof rawOrBody === 'string' ? safeJsonParse(rawOrBody) : rawOrBody;
  if (!wire || !body || typeof body !== 'object') return undefined;

  if (wire === 'chat-completions') {
    const tools: ToolSpec[] = (body.tools ?? []).map((t: any) => ({
      name: t.function?.name ?? '',
      properties: t.function?.parameters?.properties ?? {},
    }));
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const toolCalls: ParsedToolCall[] = messages
      .flatMap((m) => m.tool_calls ?? [])
      .map((c: any) => {
        const args = safeJsonParse(c.function?.arguments);
        return {
          id: c.id ?? '',
          name: c.function?.name ?? '',
          args,
          timeoutMs: extractTimeoutMs(args),
        };
      });
    const toolResults: ParsedToolResult[] = messages
      .filter((m) => m.role === 'tool')
      .map((m) => ({
        callId: m.tool_call_id ?? '',
        text: textOfContent(m.content),
      }));
    const shellTool = discoverShellTool(tools);
    return {
      wire,
      main: tools.length > 0,
      model: body.model ?? '',
      tools,
      shellTool,
      conversation: messages,
      toolCalls,
      toolResults,
      stream: Boolean(body.stream),
    };
  }

  if (wire === 'responses') {
    const tools: ToolSpec[] = (body.tools ?? [])
      .filter((t: any) => t.type === 'function')
      .map((t: any) => ({
        name: t.name ?? '',
        properties: t.parameters?.properties ?? {},
      }));
    const input: any[] = Array.isArray(body.input) ? body.input : [];
    const toolCalls: ParsedToolCall[] = input
      .filter((i) => i.type === 'function_call')
      .map((i) => {
        const args = safeJsonParse(i.arguments);
        return {
          id: i.call_id ?? i.id ?? '',
          name: i.name ?? '',
          args,
          timeoutMs: extractTimeoutMs(args),
        };
      });
    const toolResults: ParsedToolResult[] = input
      .filter((i) => i.type === 'function_call_output')
      .map((i) => ({
        callId: i.call_id ?? '',
        text: textOfContent(i.output),
      }));
    const shellTool = discoverShellTool(tools);
    return {
      wire,
      main: tools.length > 0,
      model: body.model ?? '',
      tools,
      shellTool,
      conversation: input,
      toolCalls,
      toolResults,
      stream: body.stream !== false,
    };
  }

  if (wire === 'anthropic') {
    const tools: ToolSpec[] = (body.tools ?? []).map((t: any) => ({
      name: t.name ?? '',
      properties: t.input_schema?.properties ?? {},
    }));
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const toolCalls: ParsedToolCall[] = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => {
        const args = safeJsonParse(block.input);
        return {
          id: block.id ?? '',
          name: block.name ?? '',
          args,
          timeoutMs: extractTimeoutMs(args),
        };
      });
    const toolResults: ParsedToolResult[] = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block: any) => block.type === 'tool_result')
      .map((block: any) => ({
        callId: block.tool_use_id ?? '',
        text: textOfContent(block.content),
        isError: block.is_error === true,
      }));
    const shellTool = discoverShellTool(tools);
    return {
      wire,
      main: tools.length > 0,
      model: body.model ?? '',
      tools,
      shellTool,
      conversation: messages,
      toolCalls,
      toolResults,
      stream: Boolean(body.stream),
    };
  }

  // gemini
  const tools: ToolSpec[] = (body.tools ?? [])
    .flatMap((t: any) => t.functionDeclarations ?? [])
    .map((f: any) => ({
      name: f.name ?? '',
      properties: (f.parametersJsonSchema ?? f.parameters)?.properties ?? {},
    }));
  const contents: any[] = Array.isArray(body.contents) ? body.contents : [];
  const toolCalls: ParsedToolCall[] = contents
    .flatMap((c) => c.parts ?? [])
    .filter((part: any) => part.functionCall)
    .map((part: any) => {
      const args = safeJsonParse(part.functionCall.args);
      return {
        id: part.functionCall.id ?? part.functionCall.name ?? '',
        name: part.functionCall.name ?? '',
        args,
        timeoutMs: extractTimeoutMs(args),
      };
    });
  const toolResults: ParsedToolResult[] = contents
    .flatMap((c) => c.parts ?? [])
    .filter((part: any) => part.functionResponse)
    .map((part: any) => ({
      callId: part.functionResponse.id ?? part.functionResponse.name ?? '',
      text: geminiResponseText(part.functionResponse.response),
    }));
  const shellTool = discoverShellTool(tools);
  return {
    wire,
    main: tools.length > 0,
    model: decodeURIComponent(url.pathname.split('/models/')[1]?.split(':')[0] ?? ''),
    tools,
    shellTool,
    conversation: contents,
    toolCalls,
    toolResults,
    stream: pathname.endsWith(':streamGenerateContent'),
  };
}

export function openWireStream(
  wire: WireProtocolName,
  res: http.ServerResponse,
  body: any,
  extraHeaders: Record<string, string> = {}
): WireStreamWriter {
  const sse = openSse(res, extraHeaders);

  if (wire === 'chat-completions') {
    const base = {
      id: `chatcmpl-xf-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? 'mock-1',
    };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      sse.send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
    let toolCalls = 0;
    chunk({ role: 'assistant', content: '' });
    return {
      text: (text) => chunk({ content: text }),
      toolCall({ id, name: toolName, args }) {
        const index = toolCalls++;
        chunk({ tool_calls: [{ index, id, type: 'function', function: { name: toolName, arguments: '' } }] });
        for (const piece of halves(JSON.stringify(args))) {
          chunk({ tool_calls: [{ index, function: { arguments: piece } }] });
        }
      },
      end() {
        chunk({}, toolCalls > 0 ? 'tool_calls' : 'stop');
        if (body?.stream_options?.include_usage) {
          sse.send({
            ...base,
            choices: [],
            usage: {
              prompt_tokens: USAGE.input,
              completion_tokens: USAGE.output,
              total_tokens: USAGE.input + USAGE.output,
            },
          });
        }
        sse.send('[DONE]');
        sse.end();
      },
    };
  }

  if (wire === 'responses') {
    const responseId = `resp_xf_${Date.now()}`;
    const response = (status: string, extra: Record<string, unknown> = {}) => ({
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: body?.model ?? 'mock-1',
      output: [],
      ...extra,
    });
    let sequence = 0;
    const send = (type: string, payload: Record<string, unknown>) =>
      sse.send({ type, sequence_number: sequence++, ...payload }, type);
    const output: any[] = [];
    send('response.created', { response: response('in_progress') });
    send('response.in_progress', { response: response('in_progress') });

    let message: { index: number; id: string; text: string } | undefined;
    const closeMessage = () => {
      if (!message) return;
      const { index, id, text } = message;
      message = undefined;
      const part = { type: 'output_text', text, annotations: [] };
      send('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text });
      send('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part });
      const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [part] };
      output[index] = item;
      send('response.output_item.done', { output_index: index, item });
    };

    return {
      text(text) {
        if (!message) {
          message = { index: output.length, id: `msg_xf_${output.length}`, text: '' };
          output.push(null);
          send('response.output_item.added', {
            output_index: message.index,
            item: { type: 'message', id: message.id, role: 'assistant', status: 'in_progress', content: [] },
          });
          send('response.content_part.added', {
            item_id: message.id,
            output_index: message.index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
        }
        message.text += text;
        send('response.output_text.delta', {
          item_id: message.id,
          output_index: message.index,
          content_index: 0,
          delta: text,
        });
      },
      toolCall({ id, name: toolName, args }) {
        closeMessage();
        const index = output.length;
        const itemId = `fc_xf_${index}`;
        const argumentsJson = JSON.stringify(args);
        send('response.output_item.added', {
          output_index: index,
          item: { type: 'function_call', id: itemId, call_id: id, name: toolName, arguments: '', status: 'in_progress' },
        });
        for (const piece of halves(argumentsJson)) {
          send('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: piece });
        }
        send('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: argumentsJson });
        const item = {
          type: 'function_call',
          id: itemId,
          call_id: id,
          name: toolName,
          arguments: argumentsJson,
          status: 'completed',
        };
        output.push(item);
        send('response.output_item.done', { output_index: index, item });
      },
      end() {
        closeMessage();
        send('response.completed', {
          response: response('completed', {
            output,
            usage: {
              input_tokens: USAGE.input,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: USAGE.output,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: USAGE.input + USAGE.output,
            },
          }),
        });
        sse.end();
      },
    };
  }

  if (wire === 'anthropic') {
    const send = (type: string, payload: Record<string, unknown>) => sse.send({ type, ...payload }, type);
    let index = 0;
    let textOpen = false;
    let toolCalls = 0;
    send('message_start', {
      message: {
        id: `msg_xf_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: body?.model ?? 'claude-mock',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: USAGE.input, output_tokens: 1 },
      },
    });
    const closeText = () => {
      if (!textOpen) return;
      send('content_block_stop', { index: index++ });
      textOpen = false;
    };
    return {
      text(text) {
        if (!textOpen) {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          textOpen = true;
        }
        send('content_block_delta', { index, delta: { type: 'text_delta', text } });
      },
      toolCall({ id, name: toolName, args }) {
        closeText();
        toolCalls++;
        send('content_block_start', { index, content_block: { type: 'tool_use', id, name: toolName, input: {} } });
        for (const piece of halves(JSON.stringify(args))) {
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
        }
        send('content_block_stop', { index: index++ });
      },
      end() {
        closeText();
        send('message_delta', {
          delta: { stop_reason: toolCalls > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: USAGE.output },
        });
        send('message_stop', {});
        sse.end();
      },
    };
  }

  // gemini
  const usageMetadata = {
    promptTokenCount: USAGE.input,
    candidatesTokenCount: USAGE.output,
    totalTokenCount: USAGE.input + USAGE.output,
  };
  const candidate = (parts: any[], finishReason?: string) => ({
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }],
  });
  return {
    text: (text) => sse.send(candidate([{ text }])),
    toolCall: ({ id, name: toolName, args }) => sse.send(candidate([{ functionCall: { id, name: toolName, args } }])),
    end() {
      sse.send({ ...candidate([{ text: '' }], 'STOP'), usageMetadata });
      sse.end();
    },
  };
}

function fillGeminiSchema(schema: any): unknown {
  const type = String(schema?.type ?? '').toUpperCase();
  if (schema?.enum?.length) return schema.enum[0];
  if (type === 'OBJECT') {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, sub]) => [key, fillGeminiSchema(sub)])
    );
  }
  if (type === 'ARRAY') return [];
  if (type === 'INTEGER' || type === 'NUMBER') return 1;
  if (type === 'BOOLEAN') return false;
  return 'xf-audit';
}

export function serveAuxResponse(wire: WireProtocolName, res: http.ServerResponse, body: any, url: URL): void {
  if (wire === 'chat-completions') {
    if (body?.stream) {
      const writer = openWireStream(wire, res, body);
      writer.text('xf-audit');
      writer.end();
      return;
    }
    sendJson(res, 200, {
      id: 'chatcmpl-xf-aux',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? 'mock-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'xf-audit' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return;
  }

  if (wire === 'responses') {
    if (body?.stream) {
      const writer = openWireStream(wire, res, body);
      writer.text('xf-audit');
      writer.end();
      return;
    }
    sendJson(res, 200, {
      id: 'resp_xf_aux',
      object: 'response',
      status: 'completed',
      model: body?.model ?? 'mock-1',
      output: [
        {
          type: 'message',
          id: 'msg_xf_aux',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'xf-audit', annotations: [] }],
        },
      ],
    });
    return;
  }

  if (wire === 'anthropic') {
    if (body?.stream) {
      const writer = openWireStream(wire, res, body);
      writer.text('xf-audit');
      writer.end();
      return;
    }
    sendJson(res, 200, {
      id: `msg_xf_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: body?.model ?? 'claude-mock',
      content: [{ type: 'text', text: 'xf-audit' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
    });
    return;
  }

  // gemini
  const config = body?.generationConfig ?? {};
  const schema = config.responseJsonSchema ?? config.responseSchema;
  const text = schema ? JSON.stringify(fillGeminiSchema(schema)) : 'xf-audit';
  const usageMetadata = {
    promptTokenCount: USAGE.input,
    candidatesTokenCount: USAGE.output,
    totalTokenCount: USAGE.input + USAGE.output,
  };
  const payload = {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, finishReason: 'STOP' }],
    usageMetadata,
  };
  if (url.pathname.endsWith(':streamGenerateContent')) {
    const sse = openSse(res);
    sse.send(payload);
    sse.end();
    return;
  }
  sendJson(res, 200, payload);
}

/**
 * Parse a completed raw response (SSE stream or JSON) from any of the four wire protocols
 * into normalized text, toolCalls, and token usage.
 */
export function parseWireResponse(wire: WireProtocolName, rawResponse: string): ParsedWireResponse {
  let text = '';
  const toolCalls: ParsedToolCall[] = [];
  let inputTokens = USAGE.input;
  let outputTokens = USAGE.output;

  const dataFrames: any[] = [];
  const trimmed = rawResponse.trim();
  if (trimmed.startsWith('{')) {
    try {
      dataFrames.push(JSON.parse(trimmed));
    } catch {}
  } else {
    for (const line of rawResponse.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        dataFrames.push(JSON.parse(payload));
      } catch {}
    }
  }

  if (wire === 'chat-completions') {
    const byIndex = new Map<number, { id: string; name: string; argChunks: string }> ();
    for (const frame of dataFrames) {
      if (frame.usage) {
        inputTokens = frame.usage.prompt_tokens ?? inputTokens;
        outputTokens = frame.usage.completion_tokens ?? outputTokens;
      }
      const choice = frame.choices?.[0];
      if (!choice) continue;
      if (choice.message) {
        if (typeof choice.message.content === 'string') text += choice.message.content;
        for (const tc of choice.message.tool_calls ?? []) {
          const args = safeJsonParse(tc.function?.arguments);
          toolCalls.push({
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            args,
            timeoutMs: extractTimeoutMs(args),
          });
        }
      }
      if (choice.delta) {
        if (typeof choice.delta.content === 'string') text += choice.delta.content;
        for (const tc of choice.delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const existing = byIndex.get(idx) ?? { id: '', name: '', argChunks: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argChunks += tc.function.arguments;
          byIndex.set(idx, existing);
        }
      }
    }
    for (const [, tc] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      const args = safeJsonParse(tc.argChunks);
      toolCalls.push({
        id: tc.id,
        name: tc.name,
        args,
        timeoutMs: extractTimeoutMs(args),
      });
    }
    return { text, toolCalls, usage: { inputTokens, outputTokens } };
  }

  if (wire === 'responses') {
    const seenIds = new Set<string>();
    for (const frame of dataFrames) {
      if (frame.type === 'response.output_text.delta' && typeof frame.delta === 'string') {
        text += frame.delta;
      } else if (frame.type === 'response.output_item.done' && frame.item?.type === 'function_call') {
        const id = frame.item.call_id ?? frame.item.id ?? '';
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          const args = safeJsonParse(frame.item.arguments);
          toolCalls.push({ id, name: frame.item.name ?? '', args, timeoutMs: extractTimeoutMs(args) });
        }
      } else if (frame.type === 'response.completed' && frame.response) {
        if (frame.response.usage) {
          inputTokens = frame.response.usage.input_tokens ?? inputTokens;
          outputTokens = frame.response.usage.output_tokens ?? outputTokens;
        }
        for (const item of frame.response.output ?? []) {
          if (item?.type === 'function_call') {
            const id = item.call_id ?? item.id ?? '';
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              const args = safeJsonParse(item.arguments);
              toolCalls.push({ id, name: item.name ?? '', args, timeoutMs: extractTimeoutMs(args) });
            }
          }
        }
      } else if (frame.object === 'response' && Array.isArray(frame.output)) {
        for (const item of frame.output) {
          if (item?.type === 'function_call') {
            const id = item.call_id ?? item.id ?? '';
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              const args = safeJsonParse(item.arguments);
              toolCalls.push({ id, name: item.name ?? '', args, timeoutMs: extractTimeoutMs(args) });
            }
          }
        }
      }
    }
    return { text, toolCalls, usage: { inputTokens, outputTokens } };
  }

  if (wire === 'anthropic') {
    const blocks = new Map<number, { id: string; name: string; json: string; initialInput?: Record<string, unknown> }>();
    for (const frame of dataFrames) {
      if (frame.type === 'message_start' && frame.message?.usage) {
        inputTokens = frame.message.usage.input_tokens ?? inputTokens;
      } else if (frame.type === 'message_delta' && frame.usage) {
        outputTokens = frame.usage.output_tokens ?? outputTokens;
      } else if (frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use') {
        blocks.set(frame.index ?? 0, {
          id: frame.content_block.id ?? '',
          name: frame.content_block.name ?? '',
          json: '',
          initialInput: frame.content_block.input,
        });
      } else if (frame.type === 'content_block_delta') {
        if (frame.delta?.type === 'text_delta' && typeof frame.delta.text === 'string') {
          text += frame.delta.text;
        } else if (frame.delta?.type === 'input_json_delta' && typeof frame.delta.partial_json === 'string') {
          const b = blocks.get(frame.index ?? 0);
          if (b) b.json += frame.delta.partial_json;
        }
      } else if (frame.type === 'message' && Array.isArray(frame.content)) {
        for (const block of frame.content) {
          if (block.type === 'text') text += block.text ?? '';
          if (block.type === 'tool_use') {
            const args = safeJsonParse(block.input);
            toolCalls.push({ id: block.id ?? '', name: block.name ?? '', args, timeoutMs: extractTimeoutMs(args) });
          }
        }
      }
    }
    for (const [, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      const args = b.json ? safeJsonParse(b.json) : safeJsonParse(b.initialInput);
      toolCalls.push({ id: b.id, name: b.name, args, timeoutMs: extractTimeoutMs(args) });
    }
    return { text, toolCalls, usage: { inputTokens, outputTokens } };
  }

  // gemini
  for (const frame of dataFrames) {
    if (frame.usageMetadata) {
      inputTokens = frame.usageMetadata.promptTokenCount ?? inputTokens;
      outputTokens = frame.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
    for (const cand of frame.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if (typeof part.text === 'string') text += part.text;
        if (part.functionCall) {
          const args = safeJsonParse(part.functionCall.args);
          toolCalls.push({
            id: part.functionCall.id ?? part.functionCall.name ?? '',
            name: part.functionCall.name ?? '',
            args,
            timeoutMs: extractTimeoutMs(args),
          });
        }
      }
    }
  }
  return { text, toolCalls, usage: { inputTokens, outputTokens } };
}

/**
 * Inject or enrich an interrupted tool call record into the outgoing request body
 * when a wrapped harness resumes after a mid-tool SIGKILL crash.
 */
export function injectInterruptedToolAccount(
  wire: WireProtocolName,
  body: any,
  parsed: ParsedWireRequest,
  interrupted: InterruptedToolRecord
): boolean {
  const notice =
    `[xioflow kernel recovery] Tool call "${interrupted.name}" (${interrupted.callId}) was interrupted by crash (SIGKILL): ` +
    `outcome indeterminate; leftover orphan process was reaped by xioflow kernel; inspect workspace before retrying.`;

  const hasCall = parsed.toolCalls.some((c) => c.id === interrupted.callId);
  const existingResult = parsed.toolResults.find((r) => r.callId === interrupted.callId);

  if (wire === 'gemini') {
    body.contents = Array.isArray(body.contents) ? body.contents : [];
    if (!hasCall) {
      // Gemini CLI loses the in-flight functionCall when SIGKILLed mid-tool; inject it before the latest user prompt.
      const insertAt = Math.max(0, body.contents.length - 1);
      body.contents.splice(
        insertAt,
        0,
        {
          role: 'model',
          parts: [{ functionCall: { id: interrupted.callId, name: interrupted.name, args: interrupted.args } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: interrupted.callId,
                name: interrupted.name,
                response: { output: notice },
              },
            },
          ],
        }
      );
      parsed.toolCalls.push({ id: interrupted.callId, name: interrupted.name, args: interrupted.args });
      parsed.toolResults.push({ callId: interrupted.callId, text: notice });
      return true;
    }
    if (!existingResult) {
      const insertAt = Math.max(0, body.contents.length - 1);
      body.contents.splice(insertAt, 0, {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: interrupted.callId,
              name: interrupted.name,
              response: { output: notice },
            },
          },
        ],
      });
      parsed.toolResults.push({ callId: interrupted.callId, text: notice });
      return true;
    }
    // Enrich existing functionResponse
    for (const c of body.contents) {
      for (const p of c.parts ?? []) {
        if (p.functionResponse && (p.functionResponse.id === interrupted.callId || p.functionResponse.name === interrupted.name)) {
          const prev = geminiResponseText(p.functionResponse.response);
          if (!prev.includes('xioflow kernel recovery')) {
            p.functionResponse.response = { output: prev ? `${prev}\n${notice}` : notice };
          }
        }
      }
    }
    if (!existingResult.text.includes('xioflow kernel recovery')) {
      existingResult.text = `${existingResult.text}\n${notice}`;
    }
    return true;
  }

  if (wire === 'anthropic') {
    body.messages = Array.isArray(body.messages) ? body.messages : [];
    if (!hasCall) {
      const insertAt = Math.max(0, body.messages.length - 1);
      body.messages.splice(
        insertAt,
        0,
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: interrupted.callId, name: interrupted.name, input: interrupted.args }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: interrupted.callId, content: notice, is_error: true }],
        }
      );
      parsed.toolCalls.push({ id: interrupted.callId, name: interrupted.name, args: interrupted.args });
      parsed.toolResults.push({ callId: interrupted.callId, text: notice, isError: true });
      return true;
    }
    if (!existingResult) {
      const insertAt = Math.max(0, body.messages.length - 1);
      body.messages.splice(insertAt, 0, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: interrupted.callId, content: notice, is_error: true }],
      });
      parsed.toolResults.push({ callId: interrupted.callId, text: notice, isError: true });
      return true;
    }
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === 'tool_result' && block.tool_use_id === interrupted.callId) {
          const prev = textOfContent(block.content);
          if (!prev.includes('xioflow kernel recovery')) {
            block.content = prev ? `${prev}\n${notice}` : notice;
          }
        }
      }
    }
    if (!existingResult.text.includes('xioflow kernel recovery')) {
      existingResult.text = `${existingResult.text}\n${notice}`;
    }
    return true;
  }

  if (wire === 'responses') {
    body.input = Array.isArray(body.input) ? body.input : [];
    if (!hasCall) {
      const insertAt = Math.max(0, body.input.length - 1);
      body.input.splice(
        insertAt,
        0,
        {
          type: 'function_call',
          id: `fc_${interrupted.callId}`,
          call_id: interrupted.callId,
          name: interrupted.name,
          arguments: JSON.stringify(interrupted.args),
          status: 'completed',
        },
        {
          type: 'function_call_output',
          call_id: interrupted.callId,
          output: notice,
        }
      );
      parsed.toolCalls.push({ id: interrupted.callId, name: interrupted.name, args: interrupted.args });
      parsed.toolResults.push({ callId: interrupted.callId, text: notice });
      return true;
    }
    if (!existingResult) {
      const insertAt = Math.max(0, body.input.length - 1);
      body.input.splice(insertAt, 0, {
        type: 'function_call_output',
        call_id: interrupted.callId,
        output: notice,
      });
      parsed.toolResults.push({ callId: interrupted.callId, text: notice });
      return true;
    }
    for (const item of body.input) {
      if (item.type === 'function_call_output' && item.call_id === interrupted.callId) {
        const prev = textOfContent(item.output);
        if (!prev.includes('xioflow kernel recovery')) {
          item.output = prev ? `${prev}\n${notice}` : notice;
        }
      }
    }
    if (!existingResult.text.includes('xioflow kernel recovery')) {
      existingResult.text = `${existingResult.text}\n${notice}`;
    }
    return true;
  }

  // chat-completions
  body.messages = Array.isArray(body.messages) ? body.messages : [];
  if (!hasCall) {
    const insertAt = Math.max(0, body.messages.length - 1);
    body.messages.splice(
      insertAt,
      0,
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: interrupted.callId,
            type: 'function',
            function: { name: interrupted.name, arguments: JSON.stringify(interrupted.args) },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: interrupted.callId,
        content: notice,
      }
    );
    parsed.toolCalls.push({ id: interrupted.callId, name: interrupted.name, args: interrupted.args });
    parsed.toolResults.push({ callId: interrupted.callId, text: notice });
    return true;
  }
  if (!existingResult) {
    const insertAt = Math.max(0, body.messages.length - 1);
    body.messages.splice(insertAt, 0, {
      role: 'tool',
      tool_call_id: interrupted.callId,
      content: notice,
    });
    parsed.toolResults.push({ callId: interrupted.callId, text: notice });
    return true;
  }
  for (const m of body.messages) {
    if (m.role === 'tool' && m.tool_call_id === interrupted.callId) {
      const prev = textOfContent(m.content);
      if (!prev.includes('xioflow kernel recovery')) {
        m.content = prev ? `${prev}\n${notice}` : notice;
      }
    }
  }
  if (!existingResult.text.includes('xioflow kernel recovery')) {
    existingResult.text = `${existingResult.text}\n${notice}`;
  }
  return true;
}

/**
 * Append a stale-context or delta notice into the latest user message/tool result of the request body.
 */
export function injectContextNotice(wire: WireProtocolName, body: any, notice: string): void {
  if (!notice) return;
  if (wire === 'chat-completions' || wire === 'anthropic') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    if (last && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${notice}`;
    } else if (last && Array.isArray(last.content) && last.content.length > 0) {
      const lastBlock = last.content.at(-1);
      if (typeof lastBlock.text === 'string') lastBlock.text = `${lastBlock.text}\n\n${notice}`;
      else if (typeof lastBlock.content === 'string') lastBlock.content = `${lastBlock.content}\n\n${notice}`;
    }
  } else if (wire === 'responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    const last = input.at(-1);
    if (last && typeof last.output === 'string') {
      last.output = `${last.output}\n\n${notice}`;
    }
  } else if (wire === 'gemini') {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    const last = contents.at(-1);
    const lastPart = last?.parts?.at(-1);
    if (lastPart?.text) {
      lastPart.text = `${lastPart.text}\n\n${notice}`;
    } else if (lastPart?.functionResponse?.response) {
      const prev = geminiResponseText(lastPart.functionResponse.response);
      lastPart.functionResponse.response = { output: `${prev}\n\n${notice}` };
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function resolveUpstreamBase(
  upstreamUrl: WireProxyOptions['upstreamUrl'],
  wire?: WireProtocolName
): string | undefined {
  if (!upstreamUrl) return undefined;
  if (typeof upstreamUrl === 'string') return upstreamUrl.replace(/\/+$/, '');
  if (wire && upstreamUrl[wire]) return upstreamUrl[wire]!.replace(/\/+$/, '');
  return upstreamUrl.default?.replace(/\/+$/, '');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function gatewayStateFilePath(domainPath: string): string {
  return path.join(domainPath, 'gateway-state.json');
}

export function readGatewayInterruptedTool(domainPath: string): InterruptedToolRecord | undefined {
  try {
    const file = gatewayStateFilePath(domainPath);
    if (!fs.existsSync(file)) return undefined;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.interruptedToolCall ?? data.inFlightToolCall ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeGatewayInFlightTool(
  domainPath: string,
  inFlightToolCall: InterruptedToolRecord | null,
  interruptedToolCall: InterruptedToolRecord | null = null
): void {
  try {
    fs.mkdirSync(domainPath, { recursive: true });
    const file = gatewayStateFilePath(domainPath);
    fs.writeFileSync(
      file,
      JSON.stringify({ inFlightToolCall, interruptedToolCall, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch {}
}

export async function startWireProxy(options: WireProxyOptions = {}): Promise<WireProxyHandle> {
  const events = new EventEmitter();
  const state = {
    requests: 0,
    mainRequests: 0,
    upstreamRequests: 0,
    cacheHits304: 0,
    cursor: 0,
    tapeExhausted: false,
    adapterNeeded: false,
    shellTool: undefined as ShellToolInfo | undefined,
    turns: [] as RecordedGatewayTurn[],
  };

  const domainPath = options.domain?.domainPath ?? (options.domainPath ? path.resolve(options.domainPath) : undefined);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const runId = options.runId ?? 'gateway-run';
  const turnByConversation = new Map<string, number>();
  const barriers = new Map<string, { promise: Promise<void>; release: () => void }>();
  let activeToolCall: ParsedToolCall | undefined;
  let pendingInterrupted: InterruptedToolRecord | undefined = domainPath
    ? readGatewayInterruptedTool(domainPath)
    : undefined;

  const recordTranscript = (entry: Record<string, unknown>) => {
    if (!options.transcriptPath) return;
    fs.mkdirSync(path.dirname(options.transcriptPath), { recursive: true });
    fs.appendFileSync(options.transcriptPath, `${JSON.stringify(entry)}\n`);
  };

  const recordJournal = (type: string, payload: Record<string, unknown>): number | undefined => {
    if (!options.domain) return undefined;
    return options.domain.getStore().recordJournalEvent({
      domainId: options.domain.domainId,
      runId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    });
  };

  const barrier = (id: string) => {
    if (!barriers.has(id)) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      barriers.set(id, { promise, release });
    }
    return barriers.get(id)!;
  };

  async function serveTapeTurn(
    wire: WireProtocolName,
    res: http.ServerResponse,
    body: any,
    turnIndex: number,
    parsed: ParsedWireRequest
  ): Promise<{ served: any[]; rawBody: string; status: number }> {
    const served: any[] = [];
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    (res as any).write = (chunk: any, ...rest: any[]) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWrite(chunk, ...rest);
    };
    (res as any).end = (chunk?: any, ...rest: any[]) => {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return origEnd(chunk, ...rest);
    };

    const turn = options.tape?.turns[turnIndex];
    let writer: WireStreamWriter | undefined;
    const out = () => (writer ??= openWireStream(wire, res, body, { 'x-xio-cache': 'MISS' }));
    if (!turn) {
      state.tapeExhausted = true;
      out().text('[xf-audit: tape exhausted]');
      out().end();
      return { served: ['tape_exhausted'], rawBody: Buffer.concat(chunks).toString('utf8'), status: 200 };
    }
    let calls = 0;
    for (const step of turn.steps) {
      if (res.destroyed) {
        served.push('client_gone');
        break;
      }
      if (step.type === 'delta') {
        if (step.channel !== 'thinking') {
          for (const chunk of step.chunks ?? []) out().text(chunk);
        }
        served.push('delta');
      } else if (step.type === 'tool_call') {
        const call = resolveToolCall(step, parsed.shellTool);
        if (!call) {
          state.adapterNeeded = true;
          out().text('[xf-audit: this harness offered no shell tool the endpoint recognises]');
          served.push('adapter_needed');
          break;
        }
        const id = step.id ?? `call_xf_${turnIndex}_${calls++}`;
        out().toolCall({ id, name: call.name, args: call.args });
        served.push({ tool_call: call.name, id, args: call.args });
      } else if (step.type === 'hang') {
        await sleep(step.ms);
        served.push('hang');
      } else if (step.type === 'barrier') {
        events.emit('barrier', { id: step.id, turn: turnIndex });
        await Promise.race([barrier(step.id).promise, new Promise<void>((resolve) => res.once('close', () => resolve()))]);
        served.push({ barrier: step.id });
      } else if (step.type === 'error') {
        served.push({ error: step.class });
        const status = step.status ?? 500;
        if (step.class === 'disconnect' || res.headersSent) res.destroy();
        else sendJson(res, status, { error: { message: step.message ?? 'xf-audit injected error', type: step.class } });
        return { served, rawBody: Buffer.concat(chunks).toString('utf8'), status };
      } else if (step.type === 'done') {
        break;
      }
    }
    if (!res.destroyed) out().end();
    return { served, rawBody: Buffer.concat(chunks).toString('utf8'), status: 200 };
  }

  async function forwardToUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawBody: string,
    wire?: WireProtocolName,
    extraResponseHeaders: Record<string, string> = {}
  ): Promise<{ status: number; headers: Record<string, string>; rawBody: string }> {
    const upstreamBase = resolveUpstreamBase(options.upstreamUrl, wire);
    if (!upstreamBase) {
      throw new Error(`No upstream URL configured for wire protocol "${wire ?? 'unknown'}"`);
    }
    // Avoid duplicating /v1 if upstreamBase already ends with /v1 and req.url starts with /v1/
    let reqPath = req.url ?? '/';
    if (upstreamBase.endsWith('/v1') && reqPath.startsWith('/v1/')) {
      reqPath = reqPath.slice(3);
    }
    const targetUrl = `${upstreamBase}${reqPath}`;
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v || k === 'host' || k === 'content-length' || k === 'connection') continue;
      forwardHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    state.upstreamRequests++;
    const abortController = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.once('close', onClose);
    try {
      const upstreamRes = await fetch(targetUrl, {
        method: req.method ?? 'POST',
        headers: forwardHeaders,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : rawBody,
        signal: abortController.signal,
      });

      const responseHeaders: Record<string, string> = { ...extraResponseHeaders };
      upstreamRes.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === 'content-encoding' || lower === 'transfer-encoding' || lower === 'content-length') return;
        responseHeaders[lower] = value;
      });
      res.writeHead(upstreamRes.status, responseHeaders);

      const chunks: Buffer[] = [];
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const buf = Buffer.from(value);
            chunks.push(buf);
            if (!res.writableEnded && !res.destroyed) res.write(buf);
          }
        }
      }
      if (!res.writableEnded && !res.destroyed) res.end();
      return {
        status: upstreamRes.status,
        headers: responseHeaders,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      };
    } finally {
      res.off('close', onClose);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Virtual kernel introspection endpoint (/proc equivalent for wrapped agents)
    if (req.method === 'GET' && url.pathname === '/__xio_proc') {
      sendJson(res, 200, {
        kernel: '@xioflow/kernel',
        runId: options.runId ?? 'default',
        domainId: options.domain?.domainId ?? options.domainId ?? 'default',
        workspaceRoot,
        gateway: {
          requests: state.requests,
          mainRequests: state.mainRequests,
          upstreamRequests: state.upstreamRequests,
          cacheHits304: state.cacheHits304,
          turns: state.turns.length,
        },
        activeToolCall: activeToolCall ?? null,
        ...(options.getKernelStatus?.() ?? {}),
      });
      return;
    }

    // Internal shell-shim IPC endpoint
    if (req.method === 'POST' && url.pathname === '/__xio_exec') {
      try {
        const raw = await readBody(req);
        const execReq = JSON.parse(raw) as ShellExecRequest;
        if (!options.onShellExec) {
          sendJson(res, 501, { error: 'Shell execution handler not configured' });
          return;
        }
        if (domainPath) {
          writeGatewayInFlightTool(domainPath, {
            callId: activeToolCall?.id ?? `call_exec_${state.requests + 1}`,
            name: activeToolCall?.name ?? 'bash',
            args: activeToolCall?.args ?? { command: execReq.command },
            wire: state.turns.at(-1)?.wire ?? 'chat-completions',
            turnIndex: Math.max(0, state.cursor - 1),
            startedAt: new Date().toISOString(),
          });
        }
        let execDone = false;
        const onExecClientClose = () => {
          if (!execDone) {
            Promise.resolve(options.onBeforeMainRequest?.()).catch(() => {});
          }
        };
        res.once('close', onExecClientClose);
        let execRes: ShellExecResponse;
        try {
          execRes = await options.onShellExec(execReq, activeToolCall);
        } finally {
          execDone = true;
          res.off('close', onExecClientClose);
        }
        if (domainPath) {
          writeGatewayInFlightTool(domainPath, null, null);
        }
        const lastTurn = state.turns.at(-1);
        if (lastTurn && execRes.opId) {
          recordJournal('GATEWAY_TURN_TOOL_EXECUTED', {
            turnIndex: lastTurn.turnIndex,
            opId: execRes.opId,
            callId: activeToolCall?.id,
            command: execReq.command,
            exitCode: execRes.exitCode,
            readFiles: execRes.readSet ?? [],
            writeFiles: execRes.writeSet ?? [],
            deletedFiles: execRes.deleteSet ?? [],
            deniedFiles: execRes.deniedSet ?? [],
          });
        }
        sendJson(res, 200, execRes);
      } catch (err: any) {
        sendJson(res, 500, { error: err?.message ?? String(err) });
      }
      return;
    }

    const seq = ++state.requests;
    const at = Date.now();
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return;
    }

    const base = {
      seq,
      at,
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'] ?? '',
      bodyBytes: raw.length,
    };

    const wire = detectWireProtocol(req.method, url.pathname);
    try {
      if (!wire) {
        recordTranscript({ ...base, kind: 'other' });
        events.emit('request', { ...base, kind: 'other' });
        if (resolveUpstreamBase(options.upstreamUrl)) {
          await forwardToUpstream(req, res, raw);
          return;
        }
        if (req.method === 'HEAD' || req.method === 'GET') {
          res.writeHead(200);
          res.end();
          return;
        }
        if (url.pathname.endsWith('/count_tokens')) {
          sendJson(res, 200, { input_tokens: 100 });
          return;
        }
        sendJson(res, 404, {
          error: { message: `xioflow wire-proxy: no handler for ${req.method} ${url.pathname}`, type: 'not_found' },
        });
        return;
      }

      const body = JSON.parse(raw);
      const parsed = parseWireRequest(req.method, url.pathname, body, url)!;
      if (!parsed.main) {
        recordTranscript({ ...base, wire, kind: 'aux', model: parsed.model, body });
        events.emit('request', { ...base, wire, kind: 'aux' });
        if (resolveUpstreamBase(options.upstreamUrl, wire) && !options.tape) {
          await forwardToUpstream(req, res, raw, wire);
          return;
        }
        serveAuxResponse(wire, res, body, url);
        return;
      }

      await options.onBeforeMainRequest?.();
      state.shellTool ??= parsed.shellTool;
      state.mainRequests++;

      // Clear any previous in-flight tool call if its result has now been reported by the harness
      if (activeToolCall && parsed.toolResults.some((r) => r.callId === activeToolCall?.id)) {
        activeToolCall = undefined;
        if (domainPath) writeGatewayInFlightTool(domainPath, null, null);
      }

      // If a previous launch crashed mid-tool, inject/enrich the interrupted tool call account once
      if (pendingInterrupted) {
        injectInterruptedToolAccount(wire, body, parsed, pendingInterrupted);
        raw = JSON.stringify(body);
        pendingInterrupted = undefined;
        if (domainPath) writeGatewayInFlightTool(domainPath, null, null);
      }

      const conversationKey = crypto.createHash('sha256').update(JSON.stringify(parsed.conversation)).digest('hex');
      const replay = turnByConversation.has(conversationKey);
      const turnIndex = replay ? turnByConversation.get(conversationKey)! : state.cursor++;
      turnByConversation.set(conversationKey, turnIndex);

      const turnSnap = await options.captureTurnSnapshot?.(turnIndex);

      const info = {
        ...base,
        wire,
        kind: 'main',
        turn: turnIndex,
        replay,
        model: parsed.model,
        tools: parsed.tools.map((t) => t.name),
        shellTool: parsed.shellTool,
        toolCalls: parsed.toolCalls,
        toolResults: parsed.toolResults,
      };
      recordTranscript({ ...info, body });
      events.emit('request', info);

      recordJournal('GATEWAY_TURN_STARTED', {
        turnIndex,
        wire,
        model: parsed.model,
        conversationKey,
        toolResultsCount: parsed.toolResults.length,
        snapshotId: turnSnap?.snapshotId,
        snapshotJournalSeq: turnSnap?.journalSeq,
        treeFingerprint: turnSnap?.treeFingerprint,
      });

      // Check P2 HTTP-304 Causal Fast-Forward Cache
      if (options.http304Cache) {
        const lookup = await options.http304Cache.lookup({
          turnIndex,
          parsed,
          body,
          workspaceRoot,
        });
        if (lookup.hit && lookup.cachedTurn) {
          state.cacheHits304++;
          const cached = lookup.cachedTurn;
          const headers: Record<string, string> = {
            ...cached.responseHeaders,
            'x-xio-cache': 'HIT-304',
            etag: lookup.etag,
            ...(lookup.cutoffUsed ? { 'x-xio-early-cutoff': 'true' } : {}),
          };

          const mappedToolCalls: ParsedToolCall[] = cached.parsedResponse.toolCalls.map((tc) => {
            if (
              parsed.shellTool &&
              cached.parsedRequest?.shellTool &&
              tc.name === cached.parsedRequest.shellTool.name
            ) {
              const args = { ...(tc.args ?? {}) };
              const oldKey = cached.parsedRequest.shellTool.commandParam;
              const newKey = parsed.shellTool.commandParam;
              if (oldKey !== newKey && oldKey in args) {
                args[newKey] = args[oldKey];
                delete args[oldKey];
              }
              return { ...tc, name: parsed.shellTool.name, args };
            }
            return tc;
          });

          if (cached.wire === wire) {
            res.writeHead(cached.responseStatus, headers);
            res.end(cached.rawResponseBody);
          } else {
            // Cross-protocol 304 fast-forward: transcode cached turn into target wire protocol SSE stream
            const writer = openWireStream(wire, res, body, {
              'x-xio-cache': 'HIT-304',
              etag: lookup.etag,
              ...(lookup.cutoffUsed ? { 'x-xio-early-cutoff': 'true' } : {}),
            });
            if (cached.parsedResponse.text) {
              writer.text(cached.parsedResponse.text);
            }
            for (const tc of mappedToolCalls) {
              writer.toolCall({ id: tc.id, name: tc.name, args: tc.args ?? {} });
            }
            writer.end();
          }

          const firstCall = mappedToolCalls[0];
          activeToolCall = firstCall;
          if (firstCall && domainPath) {
            writeGatewayInFlightTool(domainPath, {
              callId: firstCall.id,
              name: firstCall.name,
              args: firstCall.args ?? {},
              wire,
              turnIndex,
              startedAt: new Date().toISOString(),
            });
          }

          const snapshotId = turnSnap?.snapshotId ?? cached.snapshotId;
          const snapshotJournalSeq = turnSnap?.journalSeq ?? cached.snapshotJournalSeq;
          const treeFingerprint = turnSnap?.treeFingerprint ?? cached.treeFingerprint;

          const seqAfter = recordJournal('GATEWAY_TURN_COMPLETED', {
            turnIndex,
            wire,
            model: parsed.model,
            cacheStatus: 'HIT-304',
            etag: lookup.etag,
            cutoffUsed: Boolean(lookup.cutoffUsed),
            snapshotId,
            snapshotJournalSeq,
            treeFingerprint,
            toolCalls: mappedToolCalls,
            usage: { inputTokens: 0, outputTokens: 0 },
          });

          const replayedTurn: RecordedGatewayTurn = {
            ...cached,
            turnIndex,
            wire,
            model: parsed.model || cached.model,
            cacheStatus: 'HIT-304',
            etag: lookup.etag,
            cutoffUsed: lookup.cutoffUsed,
            snapshotId,
            snapshotJournalSeq,
            treeFingerprint,
            journalSeq: seqAfter,
            timestamp: new Date().toISOString(),
          };
          state.turns.push(replayedTurn);
          await options.onTurnCompleted?.(replayedTurn);
          recordTranscript({ seq, at: Date.now(), kind: 'response', turn: turnIndex, cacheStatus: 'HIT-304' });
          events.emit('turn', { seq, turn: turnIndex, cacheStatus: 'HIT-304', at: Date.now() });
          return;
        }
        // Cache miss: inject delta or stale context notice if present
        const combinedNotice = [lookup.deltaNotice, lookup.staleNotice].filter(Boolean).join('\n');
        if (combinedNotice) {
          injectContextNotice(wire, body, combinedNotice);
          raw = JSON.stringify(body);
        }
      }

      let rawResponseBody = '';
      let responseStatus = 200;
      let responseHeaders: Record<string, string> = { 'content-type': 'text/event-stream', 'x-xio-cache': 'MISS' };
      let served: any[] = [];

      if (options.tape) {
        const tapeOut = await serveTapeTurn(wire, res, body, turnIndex, parsed);
        rawResponseBody = tapeOut.rawBody;
        responseStatus = tapeOut.status;
        served = tapeOut.served;
      } else {
        const upOut = await forwardToUpstream(req, res, raw, wire, { 'x-xio-cache': 'MISS' });
        rawResponseBody = upOut.rawBody;
        responseStatus = upOut.status;
        responseHeaders = upOut.headers;
      }

      const parsedResponse = parseWireResponse(wire, rawResponseBody);
      for (const tc of parsedResponse.toolCalls) {
        recordJournal('GATEWAY_TOOL_CALL', {
          turnIndex,
          callId: tc.id,
          name: tc.name,
          args: tc.args ?? {},
          timeoutMs: tc.timeoutMs,
        });
      }

      const firstCall = parsedResponse.toolCalls[0];
      activeToolCall = firstCall;
      if (firstCall && domainPath) {
        writeGatewayInFlightTool(domainPath, {
          callId: firstCall.id,
          name: firstCall.name,
          args: firstCall.args ?? {},
          wire,
          turnIndex,
          startedAt: new Date().toISOString(),
        });
      }

      const recordedTurn: RecordedGatewayTurn = {
        turnIndex,
        wire,
        model: parsed.model,
        requestPath: url.pathname + url.search,
        requestBody: body,
        parsedRequest: parsed,
        responseStatus,
        responseHeaders,
        rawResponseBody,
        parsedResponse,
        cacheStatus: 'MISS',
        snapshotId: turnSnap?.snapshotId,
        snapshotJournalSeq: turnSnap?.journalSeq,
        treeFingerprint: turnSnap?.treeFingerprint,
        opIds: [],
        readFiles: [],
        writeFiles: [],
        deletedFiles: [],
        deniedFiles: [],
        toolExecutions: [],
        timestamp: new Date().toISOString(),
      };

      if (options.http304Cache && responseStatus >= 200 && responseStatus < 300) {
        const stored = await options.http304Cache.recordTurn(recordedTurn, workspaceRoot);
        recordedTurn.etag = stored.etag;
      }

      const seqAfter = recordJournal('GATEWAY_TURN_COMPLETED', {
        turnIndex,
        wire,
        model: parsed.model,
        cacheStatus: 'MISS',
        etag: recordedTurn.etag,
        snapshotId: turnSnap?.snapshotId,
        snapshotJournalSeq: turnSnap?.journalSeq,
        treeFingerprint: turnSnap?.treeFingerprint,
        toolCalls: parsedResponse.toolCalls,
        usage: parsedResponse.usage,
      });
      recordedTurn.journalSeq = seqAfter;

      state.turns.push(recordedTurn);
      await options.onTurnCompleted?.(recordedTurn);

      recordTranscript({ seq, at: Date.now(), kind: 'response', turn: turnIndex, served, cacheStatus: 'MISS' });
      events.emit('turn', { seq, turn: turnIndex, served, cacheStatus: 'MISS', at: Date.now() });
    } catch (err: any) {
      recordTranscript({ ...base, kind: 'endpoint_error', error: String(err?.stack ?? err) });
      events.emit('endpoint-error', err);
      if (!res.headersSent) {
        sendJson(res, 400, {
          error: { message: `xioflow wire-proxy error: ${err?.message ?? String(err)}`, type: 'invalid_request_error' },
        });
      } else {
        res.destroy();
      }
    }
  });

  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    events,
    state,
    getActiveToolCall: () => activeToolCall,
    clearActiveToolCall(callId?: string) {
      if (!callId || activeToolCall?.id === callId) {
        activeToolCall = undefined;
        if (domainPath) writeGatewayInFlightTool(domainPath, null, null);
      }
    },
    release: (id: string) => barrier(id).release(),
    async close() {
      for (const { release } of barriers.values()) release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
