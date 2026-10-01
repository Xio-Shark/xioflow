// Endpoint behaviour that no harness run exercises on demand. Run: node --test audit/test/endpoint.check.mjs  (named .check so vitest does not collect it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEndpoint } from '../endpoint/server.mjs';
import { renderTape, validateTape } from '../endpoint/tape.mjs';
import { discoverShellTool } from '../endpoint/tool-discovery.mjs';

const tape = validateTape({
  schema_version: 'xio-agent-tape.v1',
  name: 'endpoint-test',
  turns: [
    { steps: [{ type: 'tool_call', action: 'shell', command: 'echo one' }] },
    { steps: [{ type: 'delta', channel: 'text', chunks: ['done'] }] },
  ],
});
const bashTool = { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } };

async function withEndpoint(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-endpoint-test-'));
  const endpoint = await startEndpoint({ tape, transcriptPath: path.join(dir, 'transcript.jsonl') });
  const chat = async (body) => {
    const res = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: true, ...body }) });
    return { status: res.status, text: await res.text() };
  };
  try {
    await run({ endpoint, chat });
  } finally {
    await endpoint.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a request without tools is a helper and does not consume the tape', async () => {
  await withEndpoint(async ({ endpoint, chat }) => {
    const helper = await chat({ messages: [{ role: 'user', content: 'title please' }] });
    assert.match(helper.text, /xf-audit/);
    assert.equal(endpoint.state.cursor, 0);
    const main = await chat({ messages: [{ role: 'user', content: 'go' }], tools: [bashTool] });
    assert.match(main.text, /"name":"bash"/);
    assert.equal(endpoint.state.cursor, 1);
  });
});

test('a retry of the same conversation replays the same turn', async () => {
  await withEndpoint(async ({ endpoint, chat }) => {
    const body = { messages: [{ role: 'user', content: 'go' }], tools: [bashTool] };
    const first = await chat(body);
    const retry = await chat(body);
    assert.match(first.text, /echo/);
    assert.match(retry.text, /echo/);
    assert.equal(endpoint.state.cursor, 1);
    assert.equal(endpoint.state.mainRequests, 2);
  });
});

test('requests after the last turn get a closing line and the state says tape_exhausted', async () => {
  await withEndpoint(async ({ endpoint, chat }) => {
    for (const content of ['a', 'b']) await chat({ messages: [{ role: 'user', content }], tools: [bashTool] });
    assert.equal(endpoint.state.tapeExhausted, false);
    const extra = await chat({ messages: [{ role: 'user', content: 'c' }], tools: [bashTool] });
    assert.match(extra.text, /tape exhausted/);
    assert.equal(endpoint.state.tapeExhausted, true);
  });
});

test('no recognisable shell tool is reported as adapter_needed, not executed as something else', async () => {
  await withEndpoint(async ({ endpoint, chat }) => {
    const other = { type: 'function', function: { name: 'execute', parameters: { type: 'object', properties: { code: { type: 'string' } } } } };
    const reply = await chat({ messages: [{ role: 'user', content: 'go' }], tools: [other] });
    assert.match(reply.text, /no shell tool/);
    assert.equal(endpoint.state.adapterNeeded, true);
  });
});

test('a barrier holds the response until it is released', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-endpoint-test-'));
  const held = validateTape({ schema_version: 'xio-agent-tape.v1', name: 'barrier', turns: [{ steps: [{ type: 'barrier', id: 'gate' }, { type: 'delta', channel: 'text', chunks: ['after'] }] }] });
  const endpoint = await startEndpoint({ tape: held, transcriptPath: path.join(dir, 't.jsonl') });
  try {
    const reached = new Promise((resolve) => endpoint.events.once('barrier', resolve));
    let settled = false;
    const pending = fetch(`${endpoint.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [bashTool] }) })
      .then((res) => res.text()).then((text) => { settled = true; return text; });
    assert.deepEqual(await reached, { id: 'gate', turn: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false);
    endpoint.release('gate');
    assert.match(await pending, /after/);
  } finally {
    await endpoint.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool discovery finds each harness shape and tape placeholders must resolve', () => {
  assert.equal(discoverShellTool([{ name: 'exec_command', properties: { cmd: { type: 'string' }, yield_time_ms: { type: 'number' } } }]).commandParam, 'cmd');
  assert.equal(discoverShellTool([{ name: 'run_shell_command', properties: { command: { type: 'STRING' } } }]).name, 'run_shell_command');
  assert.equal(discoverShellTool([{ name: 'execute', properties: { code: { type: 'string' } } }]), undefined);
  assert.throws(() => renderTape({ ...tape, turns: [{ steps: [{ type: 'tool_call', action: 'shell', command: '{{missing}}' }] }] }, {}), /no value for placeholder/);
});
