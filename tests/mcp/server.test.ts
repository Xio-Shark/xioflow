import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildDist, repoRoot } from '../support/build-dist.js';

buildDist();
const cli = path.join(repoRoot, 'dist/cli.js');

type Structured = Record<string, any>;

describe('xioflow mcp (interoperability with the official MCP SDK client)', () => {
  let tempDir: string;
  let client: Client;
  let stderr: string;

  async function connect(extraArgs: string[] = []): Promise<void> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--domain', path.join(tempDir, 'domain'), '--driver', 'node', ...extraArgs],
      stderr: 'pipe',
    });
    stderr = '';
    transport.stderr?.on('data', (d) => (stderr += d));
    client = new Client({ name: 'xioflow-test', version: '0.0.0' });
    await client.connect(transport);
  }

  async function call(name: string, args: Record<string, unknown>, options?: Parameters<Client['callTool']>[2]) {
    const res = await client.callTool({ name, arguments: args }, undefined, options);
    return { isError: res.isError === true, data: res.structuredContent as Structured, text: (res.content as any)[0].text };
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-mcp-')));
  });

  afterEach(async () => {
    await client?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('negotiates the latest protocol and lists the kernel tools', async () => {
    await connect();
    expect(client.getServerVersion()?.name).toBe('xioflow-kernel');
    expect(client.getInstructions()).toMatch(/node-default driver/);
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'abort_transaction',
      'begin_transaction',
      'cancel_operation',
      'commit_transaction',
      'operation_status',
      'rollback_workspace',
      'run_command',
      'snapshot_workspace',
    ]);
    expect(stderr).toMatch(/recovered 0 operation/);
  });

  it('runs a command and replays it by opId instead of running it again', async () => {
    await connect();
    const counter = path.join(tempDir, 'count.txt');
    const args = {
      command: process.execPath,
      args: ['-e', `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); console.log('hello')`],
      cwd: tempDir,
      opId: 'build-1',
    };
    const first = await call('run_command', args);
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: 'hello\n', replayed: false, driver: 'node-default' });

    const again = await call('run_command', args);
    expect(again.data).toMatchObject({ status: 'succeeded', replayed: true });
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');

    const status = await call('operation_status', { opId: 'build-1' });
    expect(status.data).toMatchObject({ found: true, status: 'done', resultStatus: 'succeeded', leasesHeld: [] });

    const conflict = await call('run_command', { ...args, args: ['-e', '1'] });
    expect(conflict.isError).toBe(true);
    expect(conflict.data.error).toBe('OperationIdConflictError');
  });

  it('streams output as progress notifications and stops the process tree when the client cancels', async () => {
    await connect();
    const progress: string[] = [];
    const controller = new AbortController();
    const pending = call(
      'run_command',
      {
        command: process.execPath,
        args: ['-e', "console.log('tick'); setInterval(() => console.log('tick'), 50)"],
        cwd: tempDir,
        opId: 'watch-1',
      },
      {
        signal: controller.signal,
        onprogress: (p) => {
          progress.push(String(p.message));
          if (progress.length === 2) controller.abort('user pressed stop');
        },
      }
    );
    await expect(pending).rejects.toThrow();
    expect(progress[0]).toMatch(/^\[stdout\] tick/);

    // The kernel ran its stop pipeline for the cancelled request
    for (let i = 0; i < 100; i++) {
      const status = await call('operation_status', { opId: 'watch-1' });
      if (status.data.status === 'done') {
        expect(status.data.resultStatus).toBe('cancelled');
        expect(status.data.leasesHeld).toEqual([]);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('cancelled operation never settled');
  });

  it('reports a timeout and a missing binary as results, not as protocol errors', async () => {
    await connect();
    const slow = await call('run_command', { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: tempDir, timeoutMs: 300 });
    expect(slow.data).toMatchObject({ status: 'failed', terminationReason: 'timed_out' });

    const missing = await call('run_command', { command: 'definitely-not-a-binary-xioflow', cwd: tempDir });
    expect(missing.data).toMatchObject({ status: 'failed', exitCode: 127 });

    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await expect(client.callTool({ name: 'run_command', arguments: { cwd: tempDir } })).rejects.toThrow(/missing required/);
  });

  it('drives a workspace transaction end to end', async () => {
    const repo = path.join(tempDir, 'repo');
    fs.mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    await connect();

    const tx = await call('begin_transaction', { txId: 'tx-1', root: repo, forkPath: path.join(tempDir, 'fork') });
    expect(tx.isError, tx.text).toBe(false);
    await call('run_command', {
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('a.txt', 'changed\\n')"],
      cwd: tx.data.forkRoot,
    });
    const commit = await call('commit_transaction', { txId: 'tx-1' });
    expect(commit.data).toMatchObject({ status: 'committed', writeSet: [{ status: 'M', path: 'a.txt' }] });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('changed\n');
  });

  it('exports the journal to an OTLP/HTTP endpoint while serving', async () => {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        bodies.push({ url: req.url, contentType: req.headers['content-type'], auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      await connect(['--otlp-endpoint', endpoint, '--otlp-header', 'authorization=Bearer t0ken', '--otlp-interval-ms', '100']);
      await call('run_command', { command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: tempDir, opId: 'exit-3' });
      for (let i = 0; i < 60 && bodies.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(bodies.length).toBeGreaterThan(0);

      const { url, contentType, auth, body } = bodies[0];
      expect(url).toBe('/v1/traces');
      expect(contentType).toBe('application/json');
      expect(auth).toBe('Bearer t0ken');
      const scope = body.resourceSpans[0].scopeSpans[0];
      expect(scope.scope.name).toBe('@xioflow/kernel');
      const span = scope.spans.find((s: any) => s.attributes.some((a: any) => a.key === 'xioflow.op.id' && a.value.stringValue === 'exit-3'));
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
      expect(span.status).toEqual({ code: 2, message: 'failed' });
      expect(span.attributes).toContainEqual({ key: 'process.exit_code', value: { intValue: '3' } });
      expect(span.events.map((e: any) => e.name)).toContain('status.active');
    } finally {
      await client?.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
