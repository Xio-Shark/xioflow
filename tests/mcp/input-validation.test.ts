import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileToolInputSchema } from '../../src/mcp/input-schema.js';
import { KernelMcpServer } from '../../src/mcp/server.js';
import { TOOLS } from '../../src/mcp/tools.js';

interface RpcResponse {
  id: number;
  result?: { structuredContent: Record<string, unknown>; isError: boolean };
  error?: { code: number; message: string; data: { tool: string; path: string; keyword: string } };
}

describe('MCP argument admission', () => {
  let root: string;
  let input: PassThrough;
  let serving: Promise<void>;
  let nextId: number;
  let responses: Map<number, (response: RpcResponse) => void>;

  function call(name: string, args: unknown): Promise<RpcResponse> {
    const id = ++nextId;
    const response = new Promise<RpcResponse>((resolve) => responses.set(id, resolve));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    return response;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-mcp-admission-')));
    input = new PassThrough();
    const output = new PassThrough();
    nextId = 0;
    responses = new Map();
    let buffer = '';
    output.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let newline; (newline = buffer.indexOf('\n')) !== -1;) {
        const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
        buffer = buffer.slice(newline + 1);
        responses.get(response.id)?.(response);
        responses.delete(response.id);
      }
    });
    serving = new KernelMcpServer({ domainPath: path.join(root, 'domain'), driver: 'node', input, output, log: () => {} }).serve();
  });

  afterEach(async () => {
    input.end();
    await serving;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed requests before creating runs, operations, leases or command side effects', async () => {
    const marker = path.join(root, 'unexpected-command');
    const valid = {
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      cwd: root,
      opId: 'rejected-operation',
      resources: ['workspace'],
    };
    const invalid: Array<{ args: unknown; path: string; keyword: string }> = [
      { args: null, path: 'arguments', keyword: 'type' },
      { args: [], path: 'arguments', keyword: 'type' },
      { args: 'command', path: 'arguments', keyword: 'type' },
      { args: 1, path: 'arguments', keyword: 'type' },
      { args: { cwd: root }, path: 'arguments.command', keyword: 'required' },
      ...[null, 1, true, []].map((command) => ({ args: { ...valid, command }, path: 'arguments.command', keyword: 'type' })),
      { args: { ...valid, command: '' }, path: 'arguments.command', keyword: 'minLength' },
      { args: { ...valid, command: 'node\u0000extra' }, path: 'arguments.command', keyword: 'pattern' },
      { args: { ...valid, cwd: null }, path: 'arguments.cwd', keyword: 'type' },
      { args: { ...valid, cwd: '' }, path: 'arguments.cwd', keyword: 'minLength' },
      { args: { ...valid, args: 'flattened' }, path: 'arguments.args', keyword: 'type' },
      { args: { ...valid, args: ['-e', 3] }, path: 'arguments.args[1]', keyword: 'type' },
      { args: { ...valid, args: ['-e', 'nul\u0000argument'] }, path: 'arguments.args[1]', keyword: 'pattern' },
      { args: { ...valid, resources: 'workspace' }, path: 'arguments.resources', keyword: 'type' },
      { args: { ...valid, resources: ['workspace', {}] }, path: 'arguments.resources[1]', keyword: 'type' },
      { args: { ...valid, resources: [''] }, path: 'arguments.resources[0]', keyword: 'minLength' },
      ...[null, 3, false].map((opId) => ({ args: { ...valid, opId }, path: 'arguments.opId', keyword: 'type' })),
      { args: { ...valid, opId: '' }, path: 'arguments.opId', keyword: 'minLength' },
      ...[null, '10', 0.5, 1e100].map((timeoutMs) => ({ args: { ...valid, timeoutMs }, path: 'arguments.timeoutMs', keyword: 'type' })),
      ...[0, -1].map((timeoutMs) => ({ args: { ...valid, timeoutMs }, path: 'arguments.timeoutMs', keyword: 'minimum' })),
      { args: { ...valid, timeoutMs: 2_147_483_648 }, path: 'arguments.timeoutMs', keyword: 'maximum' },
      { args: { ...valid, stdin: 7 }, path: 'arguments.stdin', keyword: 'type' },
      { args: { ...valid, unrecognized: true }, path: 'arguments.unrecognized', keyword: 'additionalProperties' },
      { args: { ...valid, ['__proto__']: {} }, path: 'arguments.__proto__', keyword: 'additionalProperties' },
    ];
    for (const invalidRequest of invalid) {
      const response = await call('run_command', invalidRequest.args);
      expect(response.error, JSON.stringify(invalidRequest)).toMatchObject({
        code: -32602,
        data: { tool: 'run_command', path: invalidRequest.path, keyword: invalidRequest.keyword },
      });
      expect(response.result).toBeUndefined();
    }

    const db = new DatabaseSync(path.join(root, 'domain', 'domain.db'), { readOnly: true });
    try {
      for (const table of ['tasks', 'runs', 'operations', 'resource_leases']) {
        expect(db.prepare(`SELECT count(*) AS total FROM ${table}`).get()?.total, table).toBe(0);
      }
    } finally {
      db.close();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('applies each tool schema to optional fields and transaction identities', async () => {
    const invalid = [
      { name: 'operation_status', args: { opId: 1 }, path: 'arguments.opId' },
      { name: 'cancel_operation', args: { opId: 'running', graceMs: -1 }, path: 'arguments.graceMs' },
      { name: 'cancel_operation', args: { opId: 'running', graceMs: 0.5 }, path: 'arguments.graceMs' },
      { name: 'cancel_operation', args: { opId: 'running', graceMs: 2_147_483_648 }, path: 'arguments.graceMs' },
      { name: 'snapshot_workspace', args: { root: [] }, path: 'arguments.root' },
      { name: 'rollback_workspace', args: { snapshotId: null }, path: 'arguments.snapshotId' },
      { name: 'begin_transaction', args: { txId: '../escape', root, forkPath: path.join(root, 'fork') }, path: 'arguments.txId' },
      { name: 'begin_transaction', args: { txId: 'tx', root, forkPath: 7 }, path: 'arguments.forkPath' },
      { name: 'commit_transaction', args: { txId: 'tx', ignoreConflicts: true }, path: 'arguments.ignoreConflicts' },
      { name: 'abort_transaction', args: { txId: 'tx', reason: {} }, path: 'arguments.reason' },
    ];
    for (const request of invalid) {
      expect((await call(request.name, request.args)).error).toMatchObject({ code: -32602, data: { tool: request.name, path: request.path } });
    }
    expect(fs.existsSync(path.join(root, 'fork'))).toBe(false);
  });

  it('preserves declared defaults and allows meaningful empty strings', async () => {
    const response = await call('run_command', {
      command: process.execPath,
      cwd: root,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ''],
      stdin: '',
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ isError: false, structuredContent: { status: 'succeeded', stdout: '[""]' } });
  });

  it('keeps opaque operation identities intact through JSON-RPC and replay', async () => {
    const opId = '恢复 ../path with spaces\u0000✅';
    const counter = path.join(root, 'counter');
    const request = {
      command: process.execPath,
      cwd: root,
      opId,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x')`],
    };
    const first = await call('run_command', request);
    const replay = await call('run_command', request);
    expect(first.result).toMatchObject({ isError: false, structuredContent: { opId, status: 'succeeded', replayed: false } });
    expect(replay.result).toMatchObject({ isError: false, structuredContent: { opId, status: 'succeeded', replayed: true } });
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');
  });

  it('fails registration for unsupported schema features rather than ignoring them', () => {
    const schema = TOOLS[0].inputSchema;
    expect(() => compileToolInputSchema({ ...schema, anyOf: [] })).toThrow(/unsupported input schema keyword/);
    expect(() => compileToolInputSchema({ ...schema, required: ['command'], properties: { command: { type: 'string', maxLength: 3 } } })).toThrow(/unsupported input schema keyword/);
    expect(() => compileToolInputSchema({ ...schema, required: ['command'], properties: { command: { type: 'boolean' } } })).toThrow(/unsupported input schema type/);
  });
});
