import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  interceptAgentUpstream,
  parseWireRequest,
  parseWireResponse,
  readGatewayInterruptedTool,
  wrapAgent,
} from '../../src/index.js';
import { SqliteStore } from '../../src/store/sqlite.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'xio-wrap-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('P1: Dual-Boundary Wrap Gateway (Wire Proxy + Shell Shim)', () => {
  it('parses requests and responses across all 4 LLM wire protocols', () => {
    // 1. OpenAI Chat Completions
    const chatReq = parseWireRequest(
      'POST',
      '/v1/chat/completions',
      JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        tools: [
          {
            type: 'function',
            function: { name: 'bash', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
          },
        ],
        messages: [
          { role: 'user', content: 'run ls' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'README.md' },
        ],
      })
    )!;
    expect(chatReq.wire).toBe('chat-completions');
    expect(chatReq.main).toBe(true);
    expect(chatReq.toolResults.map((r) => r.callId)).toEqual(['call_1']);

    const chatRes = parseWireResponse(
      'chat-completions',
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{"content":"done"}}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
        'data: [DONE]',
      ].join('\n\n') + '\n\n'
    );
    expect(chatRes.text).toBe('done');
    expect(chatRes.toolCalls).toEqual([{ id: 'call_2', name: 'bash', args: { cmd: 'pwd' }, timeoutMs: undefined }]);
    expect(chatRes.usage).toEqual({ inputTokens: 12, outputTokens: 4 });

    // 2. OpenAI Responses API
    const respReq = parseWireRequest(
      'POST',
      '/v1/responses',
      JSON.stringify({
        model: 'gpt-5',
        tools: [{ type: 'function', name: 'shell', parameters: { properties: { cmd: { type: 'string' } } } }],
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'check status' }] },
          { type: 'function_call_output', call_id: 'fc_1', output: 'ok' },
        ],
      })
    )!;
    expect(respReq.wire).toBe('responses');
    expect(respReq.toolResults.map((r) => r.callId)).toEqual(['fc_1']);

    const respRes = parseWireResponse(
      'responses',
      [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"fc_2","name":"shell","arguments":"{\\"cmd\\":\\"date\\"}"}],"usage":{"input_tokens":20,"output_tokens":5}}}',
      ].join('\n') + '\n\n'
    );
    expect(respRes.toolCalls).toEqual([{ id: 'fc_2', name: 'shell', args: { cmd: 'date' }, timeoutMs: undefined }]);
    expect(respRes.usage).toEqual({ inputTokens: 20, outputTokens: 5 });

    // 3. Anthropic Messages API
    const anthReq = parseWireRequest(
      'POST',
      '/v1/messages',
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        tools: [{ name: 'Bash', input_schema: { properties: { command: { type: 'string' } } } }],
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file contents' }],
          },
        ],
      })
    )!;
    expect(anthReq.wire).toBe('anthropic');
    expect(anthReq.main).toBe(true);
    expect(anthReq.toolResults.map((r) => r.callId)).toEqual(['toolu_01']);

    const anthRes = parseWireResponse(
      'anthropic',
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":30,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_02","name":"Bash","input":{}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo hi\\"}"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":9}}',
      ].join('\n')
    );
    expect(anthRes.toolCalls).toEqual([
      { id: 'toolu_02', name: 'Bash', args: { command: 'echo hi' }, timeoutMs: undefined },
    ]);
    expect(anthRes.usage).toEqual({ inputTokens: 30, outputTokens: 9 });

    // 4. Google Gemini GenerateContent API
    const gemReq = parseWireRequest(
      'POST',
      '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      JSON.stringify({
        tools: [
          {
            functionDeclarations: [
              { name: 'run_shell_command', parameters: { properties: { command: { type: 'string' } } } },
            ],
          },
        ],
        contents: [
          { role: 'user', parts: [{ text: 'hello' }] },
          { role: 'user', parts: [{ functionResponse: { id: 'gem_1', name: 'run_shell_command', response: { output: 'ok' } } }] },
        ],
      })
    )!;
    expect(gemReq.wire).toBe('gemini');
    expect(gemReq.toolResults.map((r) => r.callId)).toEqual(['gem_1']);

    const gemRes = parseWireResponse(
      'gemini',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"gem_2","name":"run_shell_command","args":{"command":"ls"}}}]}}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":6}}\n\n'
    );
    expect(gemRes.toolCalls).toEqual([
      { id: 'gem_2', name: 'run_shell_command', args: { command: 'ls' }, timeoutMs: undefined },
    ]);
    expect(gemRes.usage).toEqual({ inputTokens: 15, outputTokens: 6 });
  });

  it('intercepts upstream URLs across env vars, codex -c flags, opencode config, and xio config', () => {
    const dir = makeTempDir();
    const opencodeCfg = path.join(dir, 'opencode.json');
    const xioCfg = path.join(dir, 'xio.json');
    fs.writeFileSync(
      opencodeCfg,
      JSON.stringify({
        provider: {
          local: {
            options: { baseURL: 'http://127.0.0.1:4100/v1' },
          },
        },
      })
    );
    fs.writeFileSync(
      xioCfg,
      JSON.stringify({
        providers: {
          local: { baseUrl: 'http://127.0.0.1:4200/v1' },
        },
      })
    );

    const intercepted = interceptAgentUpstream({
      args: ['exec', '-c', 'model_providers.local.base_url="http://127.0.0.1:4300/v1"'],
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:4001/v1',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4002',
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:4003',
        OPENCODE_CONFIG: opencodeCfg,
        XIO_CONFIG: xioCfg,
      },
      proxyBaseUrl: 'http://127.0.0.1:9999',
    });

    expect(intercepted.rewrittenEnv.OPENAI_BASE_URL).toBe('http://127.0.0.1:9999/v1');
    expect(intercepted.rewrittenEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(intercepted.rewrittenEnv.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(intercepted.rewrittenArgs[2]).toContain('http://127.0.0.1:9999/v1');
    expect(JSON.parse(fs.readFileSync(opencodeCfg, 'utf8')).provider.local.options.baseURL).toBe(
      'http://127.0.0.1:9999/v1'
    );
    expect(JSON.parse(fs.readFileSync(xioCfg, 'utf8')).providers.local.baseUrl).toBe('http://127.0.0.1:9999/v1');

    intercepted.restoreConfigs();
    expect(JSON.parse(fs.readFileSync(opencodeCfg, 'utf8')).provider.local.options.baseURL).toBe(
      'http://127.0.0.1:4100/v1'
    );
  });

  it('supervises shell tool calls, reaps setsid orphans, bounds pipe-hold drain, and enforces timeouts', async () => {
    const dir = makeTempDir();
    const pidFile = path.join(dir, 'orphan.pid');
    const pipePidFile = path.join(dir, 'pipe.pid');

    const upstream = http.createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_shell_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const spawnDetachedScript = path.join(dir, 'spawn-detached.cjs');
    fs.writeFileSync(
      spawnDetachedScript,
      `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
c.unref();
`
    );

    const spawnPipeScript = path.join(dir, 'spawn-pipe.cjs');
    fs.writeFileSync(
      spawnPipeScript,
      `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const c = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(${JSON.stringify(pipePidFile)}, String(c.pid));
c.unref();
`
    );

    const agentScript = path.join(dir, 'fake-agent.mjs');
    fs.writeFileSync(
      agentScript,
      `
import { execFileSync } from 'node:child_process';

const baseUrl = process.env.OPENAI_BASE_URL;
const resp = await fetch(\`\${baseUrl}/chat/completions\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4o',
    tools: [{ type: 'function', function: { name: 'bash', parameters: { properties: { command: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: 'run checks' }],
  }),
});
await resp.json();

// 1. Spawn setsid detached sleeper via bash -c
execFileSync('bash', ['-c', \`${JSON.stringify(process.execPath)} ${JSON.stringify(spawnDetachedScript)} && echo orphan-spawned\`], { encoding: 'utf8' });

// 2. Spawn background pipe-holder that inherits stdout
const t0 = Date.now();
execFileSync('bash', ['-c', \`${JSON.stringify(process.execPath)} ${JSON.stringify(spawnPipeScript)} && echo pipe-done\`], { encoding: 'utf8' });
const elapsedPipe = Date.now() - t0;

// 3. Timed-out command via [xio-timeout=800ms]
let timedOutExit = 0;
try {
  execFileSync('bash', ['-c', 'echo "[xio-timeout=800ms]"; sleep 30'], { encoding: 'utf8' });
} catch (err) {
  timedOutExit = err.status ?? 1;
}

console.log(JSON.stringify({ elapsedPipe, timedOutExit }));
`
    );

    try {
      const result = await wrapAgent({
        command: process.execPath,
        args: [agentScript],
        cwd: dir,
        env: {
          ...process.env,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        },
      });

      expect(result.exitCode).toBe(0);
      const parsedOut = JSON.parse(result.stdout.trim());
      expect(parsedOut.elapsedPipe).toBeLessThan(6000);
      expect(parsedOut.timedOutExit).not.toBe(0);

      // Verify both setsid orphan and pipe-holding child were reaped
      const orphanPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      const pipePid = Number(fs.readFileSync(pipePidFile, 'utf8').trim());
      expect(orphanPid).toBeGreaterThan(0);
      expect(pipePid).toBeGreaterThan(0);
      expect(isPidAlive(orphanPid)).toBe(false);
      expect(isPidAlive(pipePid)).toBe(false);

      // Verify journal entries in domain.db
      const store = new SqliteStore(path.join(result.domainPath, 'domain.db'));
      try {
        const events = store.getJournalEvents('default', 0);
        expect(events.some((e) => e.type === 'OPERATION_INTENT_REGISTERED')).toBe(true);
        expect(events.some((e) => e.type === 'OPERATION_RESULT_RECORDED')).toBe(true);
        expect(events.some((e) => e.type === 'GATEWAY_TURN_COMPLETED')).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      upstream.close();
    }
  });

  it('reaps in-flight tool tree on SIGKILL via watchdog and injects indeterminate recovery notice on resume', async () => {
    const dir = makeTempDir();
    const domainPath = path.join(dir, '.xioflow-kernel');
    const effectFile = path.join(dir, 'effect.txt');
    const toolPidFile = path.join(dir, 'tool.pid');
    const receivedBodies: any[] = [];

    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      receivedBodies.push(body);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${receivedBodies.length}`,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
                tool_calls: [
                  {
                    id: `call_${receivedBodies.length}`,
                    type: 'function',
                    function: { name: 'bash', arguments: '{"command":"run-effect"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const agentScript = path.join(dir, 'killable-agent.mjs');
    fs.writeFileSync(
      agentScript,
      `
import { execFileSync } from 'node:child_process';

const baseUrl = process.env.OPENAI_BASE_URL;
const mode = process.argv[2];

const resp = await fetch(\`\${baseUrl}/chat/completions\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4o',
    tools: [{ type: 'function', function: { name: 'bash', parameters: { properties: { command: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: mode === 'first' ? 'apply effect' : 'continue' }],
  }),
});
await resp.json();

if (mode === 'first') {
  execFileSync('bash', [
    '-c',
    \`echo "SIDE_EFFECT_APPLIED" > ${JSON.stringify(effectFile)}; echo $$ > ${JSON.stringify(toolPidFile)}; sleep 60\`,
  ]);
}
`
    );

    const cliDistPath = path.resolve('dist/cli.js');
    const wrapper = spawn(
      process.execPath,
      [cliDistPath, 'wrap', '--domain', domainPath, '--', process.execPath, agentScript, 'first'],
      {
        cwd: dir,
        env: {
          ...process.env,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        },
        stdio: 'ignore',
      }
    );

    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(toolPidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(toolPidFile)).toBe(true);
      const toolPid = Number(fs.readFileSync(toolPidFile, 'utf8').trim());
      expect(isPidAlive(toolPid)).toBe(true);

      // SIGKILL the wrapper process itself (simulating harness kill-mid-tool)
      wrapper.kill('SIGKILL');
      await new Promise((r) => wrapper.once('exit', r));

      // Wait briefly for the double-forked watchdog to detect socket EOF and reap the tool process
      const reapDeadline = Date.now() + 3000;
      while (
        (isPidAlive(toolPid) || !readGatewayInterruptedTool(domainPath)?.reapedByWatchdog) &&
        Date.now() < reapDeadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(isPidAlive(toolPid)).toBe(false);

      // Verify gateway-state.json recorded the interruptedToolCall
      const interruptedAfterKill = readGatewayInterruptedTool(domainPath);
      expect(interruptedAfterKill).toBeDefined();
      expect(interruptedAfterKill?.reapedByWatchdog).toBe(true);

      // Now resume with a second wrapAgent call on the same domainPath
      const resumeRes = await wrapAgent({
        command: process.execPath,
        args: [agentScript, 'resume'],
        cwd: dir,
        domainPath,
        env: {
          ...process.env,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        },
      });
      expect(resumeRes.exitCode).toBe(0);
      expect(receivedBodies.length).toBe(2);
      const secondRequestStr = JSON.stringify(receivedBodies[1]);
      expect(secondRequestStr).toContain('xioflow kernel recovery');
      expect(secondRequestStr).toContain('outcome indeterminate');
    } finally {
      upstream.close();
    }
  });

  it('exposes /__xio_proc virtual kernel introspection and intercepts absolute /bin/sh + VFS syscalls on Linux', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'input.txt'), 'kernel-input\n', 'utf8');

    const upstream = http.createServer(async (req, res) => {
      for await (const _ of req) {
        // drain
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-proc',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
                tool_calls: [
                  {
                    id: 'call_proc_1',
                    type: 'function',
                    function: { name: 'bash', arguments: '{"command":"cat input.txt > output.txt"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const agentScript = path.join(dir, 'proc-agent.mjs');
    fs.writeFileSync(
      agentScript,
      `
import { execSync, execFileSync } from 'node:child_process';

const baseUrl = process.env.OPENAI_BASE_URL;
const gatewayUrl = process.env.XIO_GATEWAY_URL;
const resp = await fetch(\`\${baseUrl}/chat/completions\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4o',
    tools: [{ type: 'function', function: { name: 'bash', parameters: { properties: { command: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: 'inspect kernel' }],
  }),
});
await resp.json();

// On Linux, execSync invokes /bin/sh directly by absolute path; on macOS, use bash via PATH
if (process.platform === 'linux') {
  execSync('cat input.txt > output.txt');
} else {
  execFileSync('bash', ['-c', 'cat input.txt > output.txt']);
}

const procResp = await fetch(\`\${gatewayUrl}/__xio_proc\`);
const procJson = await procResp.json();
console.log(JSON.stringify(procJson));
`
    );

    try {
      const res = await wrapAgent({
        command: process.execPath,
        args: [agentScript],
        cwd: dir,
        env: {
          ...process.env,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        },
      });
      expect(res.exitCode).toBe(0);
      const procInfo = JSON.parse(res.stdout.trim());
      expect(procInfo.kernel).toBe('@xioflow/kernel');
      expect(procInfo.gateway.mainRequests).toBe(1);
      expect(res.proxyStats.turns[0].opIds.length).toBeGreaterThanOrEqual(1);
      expect(res.proxyStats.turns[0].readFiles).toContain('input.txt');
      if (process.platform === 'linux') {
        expect(procInfo.ldPreloadShimActive).toBe(true);
        expect(procInfo.confinementDrivers).toContain('landlock');
        expect(res.proxyStats.turns[0].writeFiles).toContain('output.txt');
      }
    } finally {
      upstream.close();
    }
  });
});
