// Tape-driven model endpoint. It impersonates four wire protocols on one port and answers each "main" request
// (one that offers tools) with the next turn of the tape. Requests without tools are helpers (title generation,
// routing classifiers, health checks): they get a fixed short answer and never consume the tape.
// Everything a harness sends is appended to the transcript: the tool results in those requests are what the
// harness told the model, which the audit compares against what actually happened.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { discoverShellTool, resolveToolCall } from './tool-discovery.mjs';
import { sendJson } from './wire/sse.mjs';
import * as chatCompletions from './wire/chat-completions.mjs';
import * as responses from './wire/responses.mjs';
import * as gemini from './wire/gemini.mjs';
import * as anthropic from './wire/anthropic.mjs';

const WIRES = [chatCompletions, responses, gemini, anthropic];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{ tape: object, transcriptPath: string }} options
 * Events: 'request' (every request, after parsing), 'barrier' ({ id, turn }), 'turn' (a tape turn was fully served).
 */
export async function startEndpoint({ tape, transcriptPath }) {
  const events = new EventEmitter();
  const state = { requests: 0, mainRequests: 0, cursor: 0, tapeExhausted: false, adapterNeeded: false, shellTool: undefined };
  const turnByConversation = new Map();
  const barriers = new Map(); // id -> { promise, release }
  const record = (entry) => fs.appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);

  const barrier = (id) => {
    if (!barriers.has(id)) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      barriers.set(id, { promise, release });
    }
    return barriers.get(id);
  };

  async function serveTurn(wire, res, body, turnIndex, parsed) {
    const served = [];
    const turn = tape.turns[turnIndex];
    let writer;
    const out = () => (writer ??= wire.open(res, body));
    if (!turn) {
      // A harness that keeps asking after the tape ended gets a closing line, and the verdict says so.
      state.tapeExhausted = true;
      out().text('[xf-audit: tape exhausted]');
      out().end();
      return ['tape_exhausted'];
    }
    let calls = 0;
    for (const step of turn.steps) {
      if (res.destroyed) { served.push('client_gone'); break; }
      if (step.type === 'delta') {
        if (step.channel !== 'thinking') for (const chunk of step.chunks) out().text(chunk);
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
        out().toolCall({ id, ...call });
        served.push({ tool_call: call.name, id, args: call.args });
      } else if (step.type === 'hang') {
        await sleep(step.ms);
        served.push('hang');
      } else if (step.type === 'barrier') {
        events.emit('barrier', { id: step.id, turn: turnIndex });
        await Promise.race([barrier(step.id).promise, new Promise((resolve) => res.once('close', resolve))]);
        served.push({ barrier: step.id });
      } else if (step.type === 'error') {
        served.push({ error: step.class });
        if (step.class === 'disconnect' || res.headersSent) res.destroy();
        else sendJson(res, step.status ?? 500, { error: { message: step.message ?? 'xf-audit injected error', type: step.class } });
        return served;
      } else if (step.type === 'done') {
        break;
      }
    }
    if (!res.destroyed) out().end();
    return served;
  }

  const server = http.createServer(async (req, res) => {
    const seq = ++state.requests;
    const at = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return; // the client went away while sending (a killed harness): nothing to answer
    }
    const base = { seq, at, method: req.method, url: req.url, userAgent: req.headers['user-agent'] ?? '', bodyBytes: raw.length };
    const wire = WIRES.find((w) => w.matches(req.method, url.pathname));
    try {
      if (!wire) {
        record({ ...base, kind: 'other' });
        events.emit('request', { ...base, kind: 'other' });
        if (req.method === 'HEAD' || req.method === 'GET') { res.writeHead(200); return res.end(); }
        if (url.pathname.endsWith('/count_tokens')) return sendJson(res, 200, { input_tokens: 100 });
        return sendJson(res, 404, { error: { message: `xf-audit endpoint: no handler for ${req.method} ${url.pathname}`, type: 'not_found' } });
      }
      const body = JSON.parse(raw);
      const parsed = wire.parse(body, url);
      if (!parsed.main) {
        record({ ...base, wire: wire.name, kind: 'aux', model: parsed.model, body });
        events.emit('request', { ...base, wire: wire.name, kind: 'aux' });
        return wire.aux(res, body, url);
      }

      parsed.shellTool = discoverShellTool(parsed.tools);
      state.shellTool ??= parsed.shellTool;
      state.mainRequests++;
      // A retry of the same conversation replays the same turn instead of advancing the tape.
      const conversationKey = crypto.createHash('sha256').update(JSON.stringify(parsed.conversation)).digest('hex');
      const replay = turnByConversation.has(conversationKey);
      const turnIndex = replay ? turnByConversation.get(conversationKey) : state.cursor++;
      turnByConversation.set(conversationKey, turnIndex);
      const info = {
        ...base, wire: wire.name, kind: 'main', turn: turnIndex, replay, model: parsed.model,
        tools: parsed.tools.map((t) => t.name), shellTool: parsed.shellTool,
        // The harness's account of earlier tool calls: which calls it replays, and what it says each returned.
        toolCalls: parsed.toolCalls, toolResults: parsed.toolResults,
      };
      record({ ...info, body });
      events.emit('request', info);
      const served = await serveTurn(wire, res, body, turnIndex, parsed);
      record({ seq, at: Date.now(), kind: 'response', turn: turnIndex, served });
      events.emit('turn', { seq, turn: turnIndex, served, at: Date.now() });
    } catch (err) {
      record({ ...base, kind: 'endpoint_error', error: String(err?.stack ?? err) });
      events.emit('endpoint-error', err);
      if (!res.headersSent) sendJson(res, 400, { error: { message: `xf-audit endpoint error: ${err.message}`, type: 'invalid_request_error' } });
      else res.destroy();
    }
  });
  // A harness that is killed mid-request resets its sockets; that must not take the bench down.
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    events,
    state,
    release: (id) => barrier(id).release(),
    async close() {
      for (const { release } of barriers.values()) release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
