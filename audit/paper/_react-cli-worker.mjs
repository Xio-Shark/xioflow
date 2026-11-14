import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { callChatCompletions, scrubCredential } from './_ollama.mjs';

function parseArgs(argv) {
  const out = { prompt: '', maxTurns: 8, mcpCmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt' && argv[i + 1]) out.prompt = argv[++i];
    else if (a === '--max-turns' && argv[i + 1]) out.maxTurns = Number(argv[++i]);
    else if (a === '--mcp-cmd' && argv[i + 1]) out.mcpCmd = argv[++i];
  }
  return out;
}

const SHELL_TOOL = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command in the current workspace via /bin/sh -c.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

function runShell(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.once('error', (err) => resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${err.message}` }));
    child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout: stdout.slice(0, 8192), stderr: stderr.slice(0, 4096) }));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.OPENAI_BASE_URL || process.env.OLLAMA_API_BASE || 'https://ollama.com').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL || 'deepseek-v4.1-flash:1017';
  const apiKey = process.env.OPENAI_API_KEY || process.env.OLLAMA_API_KEY || 'proxy-key';
  const cwd = process.cwd();

  // Optional MCP-style helper child process spawned by the agent runtime on startup (never closing stdin cleanly if killed)
  let mcpChild = null;
  if (opts.mcpCmd) {
    mcpChild = spawn('/bin/sh', ['-c', opts.mcpCmd], { cwd, stdio: ['pipe', 'ignore', 'ignore'] });
  }

  const messages = [
    {
      role: 'system',
      content: 'You are a concise CLI coding agent. Use the `shell` tool when asked to run workspace scripts or inspect files, then provide a short final summary.',
    },
    { role: 'user', content: opts.prompt },
  ];

  const trace = { turns: 0, toolCalls: [], finalText: '', promptTokens: 0, completionTokens: 0 };
  try {
    for (let turn = 0; turn < opts.maxTurns; turn++) {
      trace.turns += 1;
      const resp = await callChatCompletions({ baseUrl, apiKey, model, messages, tools: SHELL_TOOL, timeoutMs: 45_000 });
      trace.promptTokens += resp.usage.promptTokens;
      trace.completionTokens += resp.usage.completionTokens;
      messages.push({
        role: 'assistant',
        content: resp.content || null,
        ...(resp.toolCalls.length > 0
          ? {
              tool_calls: resp.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      });
      if (resp.toolCalls.length === 0) {
        trace.finalText = resp.content;
        break;
      }
      for (const tc of resp.toolCalls) {
        if (tc.name === 'shell' && typeof tc.args?.command === 'string') {
          const r = await runShell(tc.args.command, cwd);
          trace.toolCalls.push({ command: tc.args.command, exitCode: r.exitCode });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(r),
          });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Unknown tool ${tc.name}` }),
          });
        }
      }
    }
    process.stdout.write(`${JSON.stringify(trace)}\n`);
  } catch (err) {
    process.stderr.write(`${scrubCredential(String(err?.stack ?? err), apiKey)}\n`);
    process.exitCode = 1;
  } finally {
    // Deliberate realistic agent bug modeled after real CLIs in S8 mcp-orphan:
    // Close pipe without killing/reaping subprocesses, OR leave detached helper un-reaped!
    try { mcpChild?.stdin?.end(); } catch {}
  }
}

main();
