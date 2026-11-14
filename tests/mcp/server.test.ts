import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { connectWorkspace, WorkspaceArbiterClient } from '../../src/arbiter/index.js';
import { buildDist, repoRoot } from '../support/build-dist.js';

buildDist();
const cli = path.join(repoRoot, 'dist/cli.js');

type Structured = Record<string, any>;

describe('xioflow mcp (Golden Surface v2 + shared Micro-Arbiter & legacy compatibility)', () => {
  let tempDir: string;
  let workspaceDir: string;
  let domainDir: string;
  const openClients: Client[] = [];

  async function openMcpClient(extraArgs: string[] = []): Promise<{ client: Client; getStderr: () => string }> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--workspace', workspaceDir, '--domain', domainDir, ...extraArgs],
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d) => (stderr += d));
    const c = new Client({ name: 'xioflow-test', version: '0.0.0' });
    await c.connect(transport);
    openClients.push(c);
    return { client: c, getStderr: () => stderr };
  }

  async function callTool(c: Client, name: string, args: Record<string, unknown>, options?: Parameters<Client['callTool']>[2]) {
    const res = await c.callTool({ name, arguments: args }, undefined, options);
    return { isError: res.isError === true, data: res.structuredContent as Structured, text: (res.content as any)[0].text };
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-mcp-')));
    workspaceDir = path.join(tempDir, 'ws');
    domainDir = path.join(tempDir, 'domain');
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    for (const c of openClients.splice(0)) {
      await c.close().catch(() => {});
    }
    if (fs.existsSync(path.join(domainDir, 'arbiter.json'))) {
      const m = await connectWorkspace(workspaceDir, { domainPath: domainDir }).catch(() => null);
      if (m instanceof WorkspaceArbiterClient) {
        await m.shutdownArbiter().catch(() => {});
      } else {
        await m?.close().catch(() => {});
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes ONLY the 4 golden primitives by default and eliminates dual-track tool clutter', async () => {
    const { client, getStderr } = await openMcpClient();
    expect(client.getServerVersion()?.name).toBe('xioflow-kernel');
    expect(client.getInstructions()).toMatch(/Tools: run, edit, inspect, branch/);
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['branch', 'edit', 'inspect', 'run']);
    expect(getStderr()).toMatch(/attached to workspace arbiter/);

    // Rejected invalid arguments map to JSON-RPC -32602
    await expect(client.callTool({ name: 'execute', arguments: {} })).rejects.toThrow(/unknown surface tool/);
    await expect(client.callTool({ name: 'run', arguments: { unknownField: 1 } })).rejects.toThrow(/unknown argument/);
  });

  it('allows multiple concurrent MCP clients on the same workspace without DomainLockedError and enforces SessionView dirty-read guards', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'config.ts'), 'export const PORT = 3000;\nexport const HOST = "127.0.0.1";\n');

    const [{ client: ideClient }, { client: cliClient }] = await Promise.all([
      openMcpClient(),
      openMcpClient(),
    ]);

    // Both clients inspect config.ts independently
    const sliceA = await callTool(ideClient, 'inspect', { target: 'config.ts' });
    const sliceB = await callTool(cliClient, 'inspect', { target: 'config.ts' });
    expect(sliceA.isError).toBe(false);
    expect(sliceB.isError).toBe(false);
    expect(sliceA.data.rev).toBe(sliceB.data.rev);

    // Client A edits config.ts with a passing gateCmd
    const editA = await callTool(ideClient, 'edit', {
      path: 'config.ts',
      oldText: 'PORT = 3000',
      newText: 'PORT = 8080',
      gateCmd: 'test -f config.ts',
    });
    expect(editA.data).toMatchObject({ status: 'committed' });

    // Client B attempts a stale overwrite without re-inspecting -> rejected with compact diff!
    const staleEditB = await callTool(cliClient, 'edit', {
      path: 'config.ts',
      content: 'export const PORT = 9999;\n',
    });
    expect(staleEditB.data.status).toBe('conflict');
    expect(staleEditB.data.conflicts[0].compactDiff).toContain('+export const PORT = 8080;');
    expect(fs.readFileSync(path.join(workspaceDir, 'config.ts'), 'utf8')).toContain('PORT = 8080');

    // Client A starts a background process; Client B sees it in inspect(status) and stops it!
    const bg = await callTool(ideClient, 'run', {
      opId: 'shared-bg-worker',
      cmd: `${JSON.stringify(process.execPath)} -e "console.log('READY_NOW'); setInterval(() => {}, 1000)"`,
      background: true,
      waitOutputPattern: 'READY_NOW',
    });
    expect(bg.data.status).toBe('running');

    const obsB = await callTool(cliClient, 'inspect', { mode: 'status' });
    expect(obsB.data.activeProcesses.some((p: any) => p.opId === 'shared-bg-worker')).toBe(true);

    const stopped = await callTool(cliClient, 'run', { stopOpId: 'shared-bg-worker' });
    expect(stopped.data.status).toBe('stopped');
  });

  it('spills oversized command output to blobRef and inspects it via grep/slice, plus speculative branch', async () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: workspaceDir });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(workspaceDir, 'app.txt'), 'v1\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    const { client } = await openMcpClient(['--driver', 'node']);
    const flood = await callTool(client, 'run', {
      execPath: process.execPath,
      args: ['-e', 'for (let i = 1; i <= 1500; i++) console.log(i === 999 ? "FATAL_NEEDLE_999" : "info log padding line " + i);'],
    });
    expect(flood.data.stdoutTruncated).toBe(true);
    expect(flood.data.stdoutBlob?.blobRef).toMatch(/^blob:/);

    const grepRes = await callTool(client, 'inspect', {
      target: flood.data.stdoutBlob.blobRef,
      pattern: 'FATAL_NEEDLE_999',
    });
    expect(grepRes.data.matches).toHaveLength(1);
    expect(grepRes.data.matches[0].line).toBe(999);

    // Failed branch leaves zero residue in main workspace
    const failedBranch = await callTool(client, 'branch', {
      mutations: [{ kind: 'write', path: 'app.txt', content: 'broken\n' }],
      gateCmd: 'exit 1',
    });
    expect(failedBranch.data.status).toBe('rolled_back');
    expect(fs.readFileSync(path.join(workspaceDir, 'app.txt'), 'utf8')).toBe('v1\n');

    // Passing branch merges cleanly via OCC
    const okBranch = await callTool(client, 'branch', {
      mutations: [{ kind: 'write', path: 'app.txt', content: 'v2\n' }],
      gateCmd: 'grep -q v2 app.txt',
    });
    expect(okBranch.data.status).toBe('committed');
    expect(fs.readFileSync(path.join(workspaceDir, 'app.txt'), 'utf8')).toBe('v2\n');
  });

  it('exports the journal to an OTLP/HTTP endpoint while serving v2 surface', async () => {
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
      const { client } = await openMcpClient([
        '--driver',
        'node',
        '--otlp-endpoint',
        endpoint,
        '--otlp-header',
        'authorization=Bearer t0ken',
        '--otlp-interval-ms',
        '100',
      ]);
      await callTool(client, 'run', { execPath: process.execPath, args: ['-e', 'process.exit(3)'], opId: 'exit-3' });
      for (let i = 0; i < 60 && bodies.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(bodies.length).toBeGreaterThan(0);

      const { url, contentType, auth, body } = bodies[0];
      expect(url).toBe('/v1/traces');
      expect(contentType).toBe('application/json');
      expect(auth).toBe('Bearer t0ken');
      const scope = body.resourceSpans[0].scopeSpans[0];
      const span = scope.spans.find((s: any) =>
        s.attributes.some((a: any) => a.key === 'xioflow.op.id' && a.value.stringValue === 'exit-3'),
      );
      expect(span).toBeDefined();
      expect(span.status).toEqual({ code: 2, message: 'failed' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('preserves --surface legacy operational tools when explicitly opted in', async () => {
    const { client } = await openMcpClient(['--surface', 'legacy', '--driver', 'node']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'abort_transaction',
      'begin_transaction',
      'cancel_operation',
      'commit_transaction',
      'execute',
      'operation_status',
      'rollback_workspace',
      'run_command',
      'snapshot_workspace',
    ]);
    const r = await callTool(client, 'run_command', {
      command: process.execPath,
      args: ['-e', 'console.log("legacy-ok")'],
      cwd: workspaceDir,
      opId: 'leg-1',
    });
    expect(r.data).toMatchObject({ status: 'succeeded', stdout: 'legacy-ok\n' });
  });
});
