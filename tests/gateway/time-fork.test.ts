import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionDomain } from '../../src/domain.js';
import { wrapAgent } from '../../src/gateway/shell-shim.js';
import {
  forkGatewayRunAtStep,
  formatGatewayRunTrace,
  traceGatewayRun,
} from '../../src/gateway/time-fork.js';
import { startWireProxy, WireProxyHandle } from '../../src/gateway/wire-proxy.js';
import { journalToOtlpTraces } from '../../src/otel/otlp.js';

function initGitWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-tf-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@xioflow.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Xioflow Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.xioflow-kernel/\n');

  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('P4: Flight Recorder Trace (xio trace), OTLP Export & Cross-Protocol Time-Travel Fork (xio fork)', () => {
  const handles: WireProxyHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.pop()!;
      await h.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('records 3-in-1 causal trace (LLM turns + git-shadow snapshots + opIds), exports OTLP spans, and forks at step N with cross-protocol 304 fast-forward', async () => {
    const workspaceRoot = initGitWorkspace({
      'src/base.ts': 'export const base = 1;\n',
    });
    const domainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-tf-domain-'));
    const domainPath = path.join(domainDir, 'kernel');
    tempDirs.push(workspaceRoot, domainDir);

    // 1. Upstream mock for the original OpenAI Chat Completions agent (3 steps)
    const openAiUpstream = await startWireProxy({
      tape: {
        name: 'orig-openai-tape',
        turns: [
          {
            // Step 1 (turnIndex 0): create src/stage1.ts
            steps: [
              {
                type: 'tool_call',
                tool: 'shell',
                id: 'call_s1',
                command: 'printf "export const s1 = 10;\\n" > src/stage1.ts',
              },
            ],
          },
          {
            // Step 2 (turnIndex 1): create buggy src/stage2.ts
            steps: [
              {
                type: 'tool_call',
                tool: 'shell',
                id: 'call_s2',
                command: 'printf "export const s2 = -999; // wrong\\n" > src/stage2.ts',
              },
            ],
          },
          {
            // Step 3 (turnIndex 2): finish
            steps: [{ type: 'delta', chunks: ['Original OpenAI run completed.'] }],
          },
        ],
      },
    });
    handles.push(openAiUpstream);

    // Script for the original OpenAI Chat Completions agent
    const openAiAgentScript = path.join(domainDir, 'openai-agent.mjs');
    fs.writeFileSync(
      openAiAgentScript,
      `
      import { execFileSync } from 'node:child_process';

      const baseUrl = process.env.OPENAI_BASE_URL;
      const tools = [{
        type: 'function',
        function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
      }];
      const messages = [{ role: 'user', content: 'Build stage1 and stage2 modules' }];

      for (let step = 0; step < 3; step++) {
        const res = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages, tools }),
        });
        const text = await res.text();
        const frames = text
          .split('\\n')
          .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
          .map((l) => JSON.parse(l.slice(5)));

        let callId = '';
        let name = '';
        let argsStr = '';
        let content = '';
        for (const f of frames) {
          const d = f.choices?.[0]?.delta;
          if (d?.content) content += d.content;
          if (d?.tool_calls?.[0]) {
            const tc = d.tool_calls[0];
            if (tc.id) callId = tc.id;
            if (tc.function?.name) name = tc.function.name;
            if (tc.function?.arguments) argsStr += tc.function.arguments;
          }
        }
        if (!callId) break;
        const args = JSON.parse(argsStr);
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: argsStr } }],
        });
        const out = execFileSync(process.env.SHELL || '/bin/sh', ['-c', args.command], {
          cwd: process.cwd(),
          encoding: 'utf8',
        });
        messages.push({ role: 'tool', tool_call_id: callId, content: out || 'ok' });
      }
      `
    );

    const origRunId = 'run-orig-openai';
    const origRes = await wrapAgent({
      runId: origRunId,
      cwd: workspaceRoot,
      domainPath,
      command: process.execPath,
      args: [openAiAgentScript],
      env: {
        ...process.env,
        OPENAI_BASE_URL: `${openAiUpstream.baseUrl}/v1`,
      },
    });

    expect(origRes.exitCode, `stderr: ${origRes.stderr} stdout: ${origRes.stdout}`).toBe(0);
    expect(origRes.proxyStats.turns.length).toBe(3);

    // 2. Inspect Flight Recorder Trace (`xio trace`)
    const trace = await traceGatewayRun({
      runId: origRunId,
      workspaceRoot,
      domainPath,
    });

    expect(trace.steps.length).toBe(3);
    expect(trace.steps[0].step).toBe(1);
    expect(trace.steps[0].wire).toBe('chat-completions');
    expect(trace.steps[0].promptSummary).toContain('Build stage1 and stage2 modules');
    expect(trace.steps[0].opIds.length).toBe(1);
    expect(trace.steps[0].snapshotId).toBeDefined();
    expect(trace.steps[0].snapshotJournalSeq).toBeGreaterThan(0);
    expect(trace.steps[0].treeFingerprint).toBeDefined();

    expect(trace.steps[1].step).toBe(2);
    expect(trace.steps[1].opIds.length).toBe(1);
    expect(trace.steps[1].treeFingerprint).toBeDefined();
    // Step 2's snapshot has stage1.ts, so its treeFingerprint differs from Step 1's initial treeFingerprint
    expect(trace.steps[1].treeFingerprint).not.toBe(trace.steps[0].treeFingerprint);

    expect(trace.steps[2].step).toBe(3);
    expect(trace.steps[2].treeFingerprint).not.toBe(trace.steps[1].treeFingerprint);

    const formatted = formatGatewayRunTrace(trace);
    expect(formatted).toContain('[Step 1]');
    expect(formatted).toContain('[Step 2]');
    expect(formatted).toContain('[Step 3]');
    expect(formatted).toContain('Build stage1 and stage2 modules');

    // 3. Verify OTLP Trace export includes xioflow.gateway.turn spans with cache status & tree SHA
    const domain = ExecutionDomain.acquire(domainPath, 'default');
    try {
      const store = domain.getStore();
      const otlp = journalToOtlpTraces({
        domainId: domain.domainId,
        events: store.getJournalEvents(domain.domainId),
        lookupOperation: (id) => store.getOperation(id),
      });
      const spans = (otlp.payload.resourceSpans[0] as any).scopeSpans[0].spans as any[];
      const turnSpans = spans.filter((s) => s.name.startsWith('xioflow.gateway.turn'));
      expect(turnSpans.length).toBe(3);
      const step2Span = turnSpans.find((s) => s.name === 'xioflow.gateway.turn 1');
      expect(step2Span).toBeDefined();
      const attrMap = Object.fromEntries(
        step2Span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]])
      );
      expect(attrMap['xioflow.cache.status']).toBe('MISS');
      expect(attrMap['xioflow.snapshot.id']).toBe(trace.steps[1].snapshotId);
      expect(attrMap['xioflow.workspace.tree_sha']).toBe(trace.steps[1].treeFingerprint);
      expect(attrMap['xioflow.turn.op_ids']).toContain(`${origRunId}-tool-2`);
    } finally {
      domain.close();
    }

    // 4. Time-Travel Fork at Step 2 (`xio fork --at-step 2`) using a DIFFERENT wire protocol (Anthropic Messages)!
    // In this parallel universe:
    // - Step 1 (turnIndex 0) is fast-forwarded via HIT-304 (transcoded from OpenAI Chat -> Anthropic Messages!) with 0 upstream requests!
    // - At Step 2 (turnIndex 1), the workspace matches original Step 2's snapshot 100% (stage1.ts exists, stage2.ts does NOT exist),
    //   and the new Anthropic agent diverges to write `src/stage2-fixed.ts`!
    let anthropicUpstreamTurnCount = 0;
    const anthropicUpstream = await startWireProxy({
      tape: {
        name: 'fork-anthropic-tape',
        turns: [
          {
            // Note: wire-proxy upstream sees its own first request when Step 2 misses the 304 cache!
            steps: [
              {
                type: 'tool_call',
                tool: 'shell',
                id: 'toolu_fork_s2',
                command: 'printf "export const s2 = 20; // fixed by claude\\n" > src/stage2-fixed.ts',
              },
            ],
          },
          {
            steps: [{ type: 'delta', chunks: ['Forked Anthropic agent finished.'] }],
          },
        ],
      },
    });
    anthropicUpstream.events.on('request', (ev) => {
      if (ev.kind === 'main') anthropicUpstreamTurnCount++;
    });
    handles.push(anthropicUpstream);

    const anthropicAgentScript = path.join(domainDir, 'anthropic-agent.mjs');
    fs.writeFileSync(
      anthropicAgentScript,
      `
      import { execFileSync } from 'node:child_process';

      const baseUrl = process.env.ANTHROPIC_BASE_URL;
      const tools = [{
        name: 'Bash',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } }
      }];
      const messages = [{ role: 'user', content: 'Build stage1 and stage2 modules' }];

      for (let step = 0; step < 3; step++) {
        const res = await fetch(baseUrl + '/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-3-7-sonnet', max_tokens: 1024, stream: true, messages, tools }),
        });
        const text = await res.text();
        const frames = text
          .split('\\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => {
            try { return JSON.parse(l.slice(5)); } catch { return null; }
          })
          .filter(Boolean);

        let toolId = '';
        let toolName = '';
        let jsonStr = '';
        for (const f of frames) {
          if (f.type === 'content_block_start' && f.content_block?.type === 'tool_use') {
            toolId = f.content_block.id;
            toolName = f.content_block.name;
          } else if (f.type === 'content_block_delta' && f.delta?.type === 'input_json_delta') {
            jsonStr += f.delta.partial_json;
          }
        }
        if (!toolId) break;
        const input = JSON.parse(jsonStr);
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
        });
        const out = execFileSync(process.env.SHELL || '/bin/sh', ['-c', input.command], {
          cwd: process.cwd(),
          encoding: 'utf8',
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: out || 'ok' }],
        });
      }
      `
    );

    const forkDest = path.join(domainDir, 'fork-step-2-worktree');
    const forkRes = await forkGatewayRunAtStep({
      runId: origRunId,
      atStep: 2,
      workspaceRoot,
      domainPath,
      forkPath: forkDest,
      command: process.execPath,
      args: [anthropicAgentScript],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: anthropicUpstream.baseUrl,
      },
    });

    // Fingerprint at Step 2 before divergent execution matched original Step 2's snapshot 100%!
    expect(forkRes.forkTreeFingerprintAtStep).toBe(trace.steps[1].treeFingerprint);
    expect(forkRes.fastForwardedSteps).toBe(1);
    expect(forkRes.agentResult?.exitCode).toBe(0);
    expect(forkRes.agentResult?.proxyStats.cacheHits304).toBe(1);
    expect(forkRes.agentResult?.proxyStats.turns[0].cacheStatus).toBe('HIT-304');
    expect(forkRes.agentResult?.proxyStats.turns[0].wire).toBe('anthropic');
    expect(forkRes.agentResult?.proxyStats.turns[1].cacheStatus).toBe('MISS');
    // Upstream only received Steps 2 and 3 (0 upstream requests for Step 1!)
    expect(anthropicUpstreamTurnCount).toBe(2);

    // Verify forked worktree contents: stage1.ts from Step 1 is preserved, buggy stage2.ts is absent, and stage2-fixed.ts is created!
    expect(fs.existsSync(path.join(forkRes.forkWorktreePath, 'src/stage1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(forkRes.forkWorktreePath, 'src/stage2.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(forkRes.forkWorktreePath, 'src/stage2-fixed.ts'), 'utf8')).toContain(
      'fixed by claude'
    );
  });
});
