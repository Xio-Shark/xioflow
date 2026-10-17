import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionDomain,
  Http304CausalCache,
  startWireProxy,
  WorkspaceCausalGraph,
} from '../../src/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'xio-http304-test-'): string {
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

describe('P2: HTTP ETag + 304 Protocol-Layer Causal Fast-Forward & Early Cutoff', () => {
  it('tracks causal provenance and computes exact invalidation closures in WorkspaceCausalGraph', () => {
    const dir = makeTempDir();
    const domain = ExecutionDomain.acquire(path.join(dir, '.xioflow-kernel'), 'causal-test');
    try {
      const graph = new WorkspaceCausalGraph(domain);
      const txId = 'gateway:causal-test';

      const n1 = graph.record({
        txId,
        actorId: 'agent-1',
        observation: { kind: 'observe', call: { tool: 'read', args: { path: 'a.ts' } }, resultHash: 'h1' },
        dependsOn: [],
      });
      const n2 = graph.record({
        txId,
        actorId: 'agent-1',
        observation: { kind: 'observe', call: { tool: 'read', args: { path: 'b.ts' } }, resultHash: 'h2' },
        dependsOn: [],
      });
      const n3 = graph.record({
        txId,
        actorId: 'agent-1',
        observation: { kind: 'mutate', call: { tool: 'edit', args: { path: 'c.ts' } }, resultHash: 'h3' },
        dependsOn: [n1.seq],
        writes: [{ status: 'M', path: 'c.ts' }],
      });

      expect(graph.ancestors(n3.seq).map((n) => n.seq)).toEqual([n1.seq]);

      const explained = graph.explainRecomputation([n1.seq]);
      expect(explained.invalidated.map((n) => n.seq)).toEqual([n1.seq, n3.seq]);
      expect(explained.unaffected.map((n) => n.seq)).toEqual([n2.seq]);
      expect(explained.explanations.find((e) => e.nodeSeq === n3.seq)?.causes).toEqual([
        { changedSeq: n1.seq, path: [n1.seq, n3.seq] },
      ]);
    } finally {
      domain.close();
    }
  });

  it('fast-forwards 4 prefix turns via HIT-304 with 0 upstream requests and survives comment/unrelated edits via Early Cutoff', async () => {
    const dir = makeTempDir();
    const domainPath = path.join(dir, '.xioflow-kernel');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const pricingFile = path.join(dir, 'src', 'pricing.ts');
    fs.writeFileSync(
      pricingFile,
      [
        'export function calculateTotal(price: number, qty: number): number {',
        '  return price * qty;',
        '}',
        '',
        'export function unrelatedHelper(): string {',
        '  return "v1";',
        '}',
      ].join('\n')
    );

    let upstreamCalls = 0;
    const lastRequestBodies: any[] = [];
    const upstream = http.createServer(async (req, res) => {
      upstreamCalls++;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      lastRequestBodies.push(body);

      const turnNum = upstreamCalls;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${turnNum}`,
          choices: [
            {
              message: {
                role: 'assistant',
                content: `turn-${turnNum}-response`,
                tool_calls: [
                  {
                    id: `call_${turnNum}`,
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({ command: 'cat src/pricing.ts', symbol: 'calculateTotal' }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 15 },
        })
      );
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const buildRequestForTurn = (turnIdx: number) => {
      const messages: any[] = [{ role: 'user', content: 'Refactor calculateTotal' }];
      for (let i = 1; i <= turnIdx; i++) {
        messages.push({
          role: 'assistant',
          content: `turn-${i}-response`,
          tool_calls: [
            {
              id: `call_${i}`,
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command: 'cat src/pricing.ts', symbol: 'calculateTotal' }),
              },
            },
          ],
        });
        messages.push({
          role: 'tool',
          tool_call_id: `call_${i}`,
          content: `step-${i}-ok`,
        });
      }
      return {
        model: 'gpt-4o',
        tools: [
          {
            type: 'function',
            function: { name: 'bash', parameters: { properties: { command: { type: 'string' } } } },
          },
        ],
        messages,
      };
    };

    const domain = ExecutionDomain.acquire(domainPath, 'http304-domain');
    const cache = new Http304CausalCache({
      domain,
      domainPath,
      workspaceRoot: dir,
      symbolHints: { 'src/pricing.ts': ['calculateTotal'] },
    });

    const proxy = await startWireProxy({
      domain,
      domainPath,
      workspaceRoot: dir,
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      http304Cache: cache,
    });

    try {
      // 1. Initial run: execute 4 turns (all MISS -> 4 upstream calls)
      for (let t = 0; t < 4; t++) {
        const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildRequestForTurn(t)),
        });
        expect(res.headers.get('x-xio-cache')).toBe('MISS');
        await res.json();
      }
      expect(upstreamCalls).toBe(4);
      expect(proxy.state.cacheHits304).toBe(0);

      // 2. Exact replay of turns 0..3 -> all 4 should be HIT-304 with 0 new upstream calls
      for (let t = 0; t < 4; t++) {
        const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildRequestForTurn(t)),
        });
        expect(res.headers.get('x-xio-cache')).toBe('HIT-304');
        expect(res.headers.get('etag')).toMatch(/^W\/"xio-/);
        const data: any = await res.json();
        expect(data.choices[0].message.content).toBe(`turn-${t + 1}-response`);
      }
      expect(upstreamCalls).toBe(4); // Still 4! Zero upstream calls during replay!
      expect(proxy.state.cacheHits304).toBe(4);

      // 3. Modify comments, whitespace, AND unrelatedHelper() in src/pricing.ts
      // Physical SHA changes, but calculateTotal symbol slice is unchanged -> Early Cutoff HIT-304!
      fs.writeFileSync(
        pricingFile,
        [
          '// Added header comment and extra whitespace',
          'export function calculateTotal(price: number,   qty: number): number {',
          '  /* inline comment */ return price * qty;',
          '}',
          '',
          'export function unrelatedHelper(): string {',
          '  return "v2-modified-unrelated-function";',
          '}',
        ].join('\n')
      );

      for (let t = 0; t < 4; t++) {
        const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildRequestForTurn(t)),
        });
        expect(res.headers.get('x-xio-cache')).toBe('HIT-304');
        expect(res.headers.get('x-xio-early-cutoff')).toBe('true');
        expect(res.headers.get('etag')).toContain('-cutoff"');
        await res.json();
      }
      expect(upstreamCalls).toBe(4); // Still 4! Early Cutoff prevented 4 redundant LLM calls!
      expect(proxy.state.cacheHits304).toBe(8);

      // 4. Now semantically modify calculateTotal() -> Cache MISS + Stale Read diff notice injected!
      fs.writeFileSync(
        pricingFile,
        [
          'export function calculateTotal(price: number, qty: number): number {',
          '  return price * qty * 1.25;',
          '}',
        ].join('\n')
      );

      const missRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildRequestForTurn(0)),
      });
      expect(missRes.headers.get('x-xio-cache')).toBe('MISS');
      await missRes.json();
      expect(upstreamCalls).toBe(5);

      const injectedBodyStr = JSON.stringify(lastRequestBodies.at(-1));
      expect(injectedBodyStr).toContain('xioflow: context stale');
      expect(injectedBodyStr).toContain('src/pricing.ts');
      expect(injectedBodyStr).toContain('return price * qty * 1.25;');
    } finally {
      await proxy.close();
      domain.close();
      upstream.close();
    }
  });

  it('handles additive discovery superset cutoff and reports added files in deltaNotice', async () => {
    const dir = makeTempDir();
    const cache = new Http304CausalCache({ workspaceRoot: dir });

    // Record turn 0 with an ls discovery output
    cache.recordToolExecution({
      turnIndex: 0,
      callId: 'call_ls',
      command: 'ls src',
      readFiles: [],
      writeFiles: [],
      output: 'a.ts\nb.ts\n',
    });

    const parsedReq = {
      wire: 'chat-completions' as const,
      main: true,
      model: 'gpt-4o',
      tools: [],
      conversation: [{ role: 'user', content: 'list files' }],
      toolCalls: [],
      toolResults: [],
      stream: false,
    };

    await cache.recordTurn(
      {
        turnIndex: 0,
        wire: 'chat-completions',
        model: 'gpt-4o',
        requestPath: '/v1/chat/completions',
        requestBody: {},
        parsedRequest: parsedReq,
        responseStatus: 200,
        responseHeaders: {},
        rawResponseBody: '{"ok":true}',
        parsedResponse: { text: 'ok', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } },
        cacheStatus: 'MISS',
        opIds: [],
        readFiles: [],
        timestamp: new Date().toISOString(),
      },
      dir
    );

    // Update discovery output with an additive superset (c.ts added, a.ts and b.ts unchanged)
    cache.recordToolExecution({
      turnIndex: 1,
      callId: 'call_ls_2',
      command: 'ls src',
      readFiles: [],
      writeFiles: [],
      output: 'a.ts\nb.ts\nc.ts\n',
    });

    const lookup = await cache.lookup({
      turnIndex: 0,
      parsed: parsedReq,
      body: {},
      workspaceRoot: dir,
    });
    expect(lookup.hit).toBe(true);
    expect(lookup.cutoffUsed).toBe(true);
    expect(lookup.deltaNotice).toContain('c.ts');
  });
});
