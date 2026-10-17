#!/usr/bin/env node
/**
 * P5 Benchmark: Real Multi-File Refactoring Recovery & Virtual Workspace Gate Benchmark
 *
 * Evaluates `xio wrap` (HTTP-304 + Early Cutoff + Virtual Workspace `--shadow --gate` + `xio race`)
 * against raw uncached restart on a multi-file refactoring workflow (10-turn agent trajectory):
 *   1. Mid-Refactoring Crash Recovery (Turn 7/10 crash -> resume)
 *   2. Concurrent Comment/Formatting Edit + Suffix Change (Symbol-Slice Early Cutoff vs Linear SHA)
 *   3. Multi-Agent Virtual Workspace Gate Deduplication & Zero-Pollution Fault Isolation
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ExecutionDomain,
  Http304CausalCache,
  ProcessSupervisor,
  raceAgentsInVirtualWorkspaces,
  runInVirtualWorkspace,
  wrapAgent,
} from '../../dist/index.js';

const tscBin = path.resolve(import.meta.dirname, '../../node_modules/typescript/bin/tsc');

function gitInit(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'xf-bench');
  git('config', 'user.email', 'bench@xioflow.local');
  git('add', '.');
  git('commit', '-qm', 'initial multi-file project');
}

/**
 * Create an 8-file multi-module billing/order codebase for refactoring
 * `computeLegacySubtotal` -> `computeAuditedSubtotal`.
 */
function createMultiFileRefactorProject(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          types: [],
          target: 'es2022',
          module: 'es2022',
          moduleResolution: 'bundler',
        },
        include: ['src'],
      },
      null,
      2
    )
  );

  const modules = [
    {
      name: 'types.ts',
      content: `export interface LineItem { sku: string; priceCents: number; qty: number; }\nexport interface OrderContext { orderId: string; items: readonly LineItem[]; discountBps: number; }\n`,
    },
    {
      name: 'pricing-core.ts',
      content: `import type { LineItem } from './types.js';\n// Core subtotal calculation\nexport function computeLegacySubtotal(items: readonly LineItem[]): number {\n  return items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);\n}\n`,
    },
    {
      name: 'discount-engine.ts',
      content: `import type { OrderContext } from './types.js';\nimport { computeLegacySubtotal } from './pricing-core.js';\nexport function applyOrderDiscount(ctx: OrderContext): number {\n  const raw = computeLegacySubtotal(ctx.items);\n  return raw - Math.floor((raw * ctx.discountBps) / 10000);\n}\n`,
    },
    {
      name: 'tax-calculator.ts',
      content: `import type { OrderContext } from './types.js';\nimport { computeLegacySubtotal } from './pricing-core.js';\nexport function estimateTaxCents(ctx: OrderContext, taxRateBps: number): number {\n  const base = computeLegacySubtotal(ctx.items);\n  return Math.round((base * taxRateBps) / 10000);\n}\n`,
    },
    {
      name: 'invoice-builder.ts',
      content: `import type { OrderContext } from './types.js';\nimport { computeLegacySubtotal } from './pricing-core.js';\nimport { applyOrderDiscount } from './discount-engine.js';\nexport function buildInvoiceSummary(ctx: OrderContext) {\n  return {\n    orderId: ctx.orderId,\n    subtotalCents: computeLegacySubtotal(ctx.items),\n    netCents: applyOrderDiscount(ctx),\n  };\n}\n`,
    },
    {
      name: 'ledger-exporter.ts',
      content: `import type { OrderContext } from './types.js';\nimport { computeLegacySubtotal } from './pricing-core.js';\nexport function formatLedgerRow(ctx: OrderContext): string {\n  return \`\${ctx.orderId}:\${computeLegacySubtotal(ctx.items)}\`;\n}\n`,
    },
    {
      name: 'checkout-service.ts',
      content: `import type { OrderContext } from './types.js';\nimport { buildInvoiceSummary } from './invoice-builder.js';\nimport { estimateTaxCents } from './tax-calculator.js';\nexport function finalizeCheckout(ctx: OrderContext) {\n  const inv = buildInvoiceSummary(ctx);\n  const tax = estimateTaxCents(ctx, 825);\n  return { ...inv, taxCents: tax, grandTotalCents: inv.netCents + tax };\n}\n`,
    },
    {
      name: 'verify-refactor.mjs',
      content: `import fs from 'node:fs';\nimport path from 'node:path';\nconst files = ['pricing-core.ts', 'discount-engine.ts', 'tax-calculator.ts', 'invoice-builder.ts', 'ledger-exporter.ts'];\nfor (const f of files) {\n  const text = fs.readFileSync(path.join('src', f), 'utf8');\n  if (text.includes('computeLegacySubtotal')) {\n    console.error('Unrefactored symbol in ' + f);\n    process.exit(1);\n  }\n  if (!text.includes('computeAuditedSubtotal')) {\n    console.error('Missing refactored symbol in ' + f);\n    process.exit(1);\n  }\n}\nconsole.log('REFACTOR_VERIFIED_OK');\n`,
    },
  ];

  for (const mod of modules) {
    fs.writeFileSync(path.join(root, 'src', mod.name), mod.content);
  }
}

/**
 * 10-turn refactoring plan executed by our black-box agent script over OpenAI Chat Completions:
 *   Turn 0: Read src/pricing-core.ts
 *   Turn 1: Read src/discount-engine.ts
 *   Turn 2: Read src/tax-calculator.ts
 *   Turn 3: Read src/invoice-builder.ts
 *   Turn 4: Read src/ledger-exporter.ts
 *   Turn 5: Read src/checkout-service.ts
 *   Turn 6: Refactor pricing-core.ts & discount-engine.ts
 *   Turn 7: Refactor tax-calculator.ts & invoice-builder.ts
 *   Turn 8: Refactor ledger-exporter.ts & run verify-refactor.mjs
 *   Turn 9: Final completion response
 */
const REFACTOR_COMMANDS = [
  'cat src/types.ts',
  'cat src/pricing-core.ts',
  'cat src/discount-engine.ts',
  'cat src/tax-calculator.ts',
  'cat src/invoice-builder.ts',
  'cat src/ledger-exporter.ts',
  'cat src/checkout-service.ts',
  `node -e "const fs = require('fs'); for (const f of ['src/pricing-core.ts','src/discount-engine.ts','src/tax-calculator.ts']) fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/computeLegacySubtotal/g,'computeAuditedSubtotal'));"`,
  `node -e "const fs = require('fs'); for (const f of ['src/invoice-builder.ts','src/ledger-exporter.ts']) fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/computeLegacySubtotal/g,'computeAuditedSubtotal'));" && node src/verify-refactor.mjs`,
];

const TOKENS_PER_TURN = [1500, 1750, 2000, 2250, 2500, 2750, 3000, 2800, 3100, 1850]; // Total = 23,500 tokens across 10 turns (Turns 0..6 = 15,750 = 67.0%)

async function startSimulatedUpstream(delayMs = 450) {
  let upstreamRequests = 0;
  let totalTokensCharged = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages ?? [];
    const toolResultsCount = messages.filter((m) => m.role === 'tool').length;
    const turnIdx = Math.min(toolResultsCount, 9);

    upstreamRequests++;
    const turnTokens = TOKENS_PER_TURN[turnIdx] ?? 2000;
    totalTokensCharged += turnTokens;

    await new Promise((r) => setTimeout(r, delayMs));

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (turnIdx < REFACTOR_COMMANDS.length) {
      const cmd = REFACTOR_COMMANDS[turnIdx];
      const chunk1 = {
        id: `chatcmpl_turn_${turnIdx}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_refactor_${turnIdx}`,
                  type: 'function',
                  function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      const chunk2 = {
        id: `chatcmpl_turn_${turnIdx}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: turnTokens - 180, completion_tokens: 180, total_tokens: turnTokens },
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      res.write('data: [DONE]\n\n');
    } else {
      const chunk = {
        id: `chatcmpl_turn_${turnIdx}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Refactoring completed and verified across all 5 modules.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: turnTokens - 120, completion_tokens: 120, total_tokens: turnTokens },
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stats: () => ({ upstreamRequests, totalTokensCharged }),
    resetStats: () => {
      upstreamRequests = 0;
      totalTokensCharged = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Create a standalone black-box agent script that speaks OpenAI Chat Completions SSE
 * and executes `bash` tool calls via `/bin/sh -c`.
 */
function writeBlackBoxAgentScript(scriptPath) {
  const code = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const baseUrl = (process.env.OPENAI_BASE_URL || '').replace(/\\/+$/, '');
const maxTurns = Number(process.env.BENCH_STOP_AFTER_TURN ?? 20);
const messages = [{ role: 'user', content: 'Refactor computeLegacySubtotal to computeAuditedSubtotal across src/.' }];
const tools = [{
  type: 'function',
  function: {
    name: 'bash',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}];

for (let turn = 0; turn < maxTurns; turn++) {
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bench' },
    body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages, tools }),
  });
  const raw = await res.text();
  let toolCall = null;
  let text = '';
  for (const line of raw.split('\\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) text += delta.content;
    if (delta?.tool_calls?.[0]) {
      const tc = delta.tool_calls[0];
      toolCall = toolCall || { id: tc.id || '', name: '', args: '' };
      if (tc.id) toolCall.id = tc.id;
      if (tc.function?.name) toolCall.name += tc.function.name;
      if (tc.function?.arguments) toolCall.args += tc.function.arguments;
    }
  }
  if (!toolCall) {
    process.stdout.write(text + '\\n');
    process.exit(0);
  }
  const args = JSON.parse(toolCall.args);
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }],
  });
  const sh = spawnSync('/bin/sh', ['-c', args.command], { encoding: 'utf8' });
  const out = (sh.stdout || '') + (sh.stderr || '');
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: out || 'ok' });
}
process.exit(1);
`;
  fs.writeFileSync(scriptPath, code, { mode: 0o755 });
}

async function runScenario1CrashRecovery() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-bench-s1-')));
  const upstream = await startSimulatedUpstream(450);
  try {
    const agentScript = path.join(tmp, 'agent.mjs');
    writeBlackBoxAgentScript(agentScript);

    // 1A: Raw Restart (crashes after 6 turns, then restarts from scratch without xio wrap)
    const rawRepo = path.join(tmp, 'repo-raw');
    fs.mkdirSync(rawRepo, { recursive: true });
    createMultiFileRefactorProject(rawRepo);
    gitInit(rawRepo);

    // Crash after 7 read turns
    await wrapAgent({
      command: process.execPath,
      args: [agentScript],
      cwd: rawRepo,
      env: { ...process.env, OPENAI_BASE_URL: `${upstream.baseUrl}/v1`, BENCH_STOP_AFTER_TURN: '7' },
      domainPath: path.join(tmp, 'domain-raw-1'),
      http304Cache: false,
    });
    upstream.resetStats();

    const rawStart = performance.now();
    const rawRecovery = await wrapAgent({
      command: process.execPath,
      args: [agentScript],
      cwd: rawRepo,
      env: { ...process.env, OPENAI_BASE_URL: `${upstream.baseUrl}/v1` },
      domainPath: path.join(tmp, 'domain-raw-2'),
      http304Cache: false,
    });
    const rawRecoveryMs = Math.round(performance.now() - rawStart);
    const rawStats = upstream.stats();
    assert.equal(rawRecovery.exitCode, 0);

    // 1B: xio wrap HTTP-304 Causal Fast-Forward Recovery
    const wrapRepo = path.join(tmp, 'repo-wrap');
    fs.mkdirSync(wrapRepo, { recursive: true });
    createMultiFileRefactorProject(wrapRepo);
    gitInit(wrapRepo);
    const wrapDomainPath = path.join(tmp, 'domain-wrap');

    await wrapAgent({
      command: process.execPath,
      args: [agentScript],
      cwd: wrapRepo,
      env: { ...process.env, OPENAI_BASE_URL: `${upstream.baseUrl}/v1`, BENCH_STOP_AFTER_TURN: '7' },
      domainPath: wrapDomainPath,
    });
    upstream.resetStats();

    const wrapStart = performance.now();
    const wrapRecovery = await wrapAgent({
      command: process.execPath,
      args: [agentScript],
      cwd: wrapRepo,
      env: { ...process.env, OPENAI_BASE_URL: `${upstream.baseUrl}/v1` },
      domainPath: wrapDomainPath,
    });
    const wrapRecoveryMs = Math.round(performance.now() - wrapStart);
    const wrapStats = upstream.stats();
    assert.equal(wrapRecovery.exitCode, 0);
    assert.equal(wrapRecovery.proxyStats.cacheHits304, 7);

    const tokenSavingsPct = +(((rawStats.totalTokensCharged - wrapStats.totalTokensCharged) / rawStats.totalTokensCharged) * 100).toFixed(1);
    const latencySavingsPct = +(((rawRecoveryMs - wrapRecoveryMs) / rawRecoveryMs) * 100).toFixed(1);

    return {
      scenario: 'mid-refactoring-crash-recovery (7/10 prefix cached)',
      rawRestart: {
        upstreamRequests: rawStats.upstreamRequests,
        tokensCharged: rawStats.totalTokensCharged,
        recoveryWallMs: rawRecoveryMs,
      },
      xioWrapHttp304: {
        upstreamRequests: wrapStats.upstreamRequests,
        cacheHits304: wrapRecovery.proxyStats.cacheHits304,
        tokensCharged: wrapStats.totalTokensCharged,
        recoveryWallMs: wrapRecoveryMs,
      },
      tokenSavingsPct,
      latencySavingsPct,
    };
  } finally {
    await upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runScenario2EarlyCutoffCommentEdit() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-bench-s2-')));
  const upstream = await startSimulatedUpstream(450);
  try {
    const agentScript = path.join(tmp, 'agent.mjs');
    writeBlackBoxAgentScript(agentScript);

    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    createMultiFileRefactorProject(repo);
    gitInit(repo);
    const domainPath = path.join(tmp, 'domain');
    const domain = ExecutionDomain.acquire(domainPath, 'bench-s2');
    const cache = new Http304CausalCache({
      domain,
      domainPath,
      workspaceRoot: repo,
      symbolHints: { 'src/discount-engine.ts': ['computeLegacySubtotal'] },
    });

    // Initial 7 turns (reading all 7 modules)
    await wrapAgent({
      command: process.execPath,
      args: [agentScript],
      cwd: repo,
      env: { ...process.env, OPENAI_BASE_URL: `${upstream.baseUrl}/v1`, BENCH_STOP_AFTER_TURN: '7' },
      domain,
      domainPath,
      http304Cache: cache,
    });

    // Developer adds comments/whitespace to discount-engine.ts (read at Turn 2) without changing computeLegacySubtotal slice!
    const discountFile = path.join(repo, 'src/discount-engine.ts');
    fs.writeFileSync(
      discountFile,
      `// Concurrent documentation comment added by another engineer\n${fs.readFileSync(discountFile, 'utf8')}\n// End of module\n`
    );

    upstream.resetStats();
    const start = performance.now();
    const resumed = await wrapAgent({
      command: process.execPath,
      args: [agentScript],
      cwd: repo,
      env: { ...process.env, OPENAI_BASE_URL: `${upstream.baseUrl}/v1` },
      domain,
      domainPath,
      http304Cache: cache,
    });
    const wallMs = Math.round(performance.now() - start);
    const stats = upstream.stats();
    domain.close();

    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.proxyStats.cacheHits304, 7);

    return {
      scenario: 'concurrent-comment-edit-early-cutoff',
      linearHashBaselineRequests: 8, // Turn 2 (discount-engine.ts) SHA changed -> linear cache invalidates at Turn 2, redoing 8 turns
      linearHashBaselineTokens: TOKENS_PER_TURN.slice(2).reduce((a, b) => a + b, 0),
      xioWrapEarlyCutoffRequests: stats.upstreamRequests,
      xioWrapCacheHits304: resumed.proxyStats.cacheHits304,
      xioWrapTokens: stats.totalTokensCharged,
      xioWrapWallMs: wallMs,
      tokenSavingsVsLinearPct: +(
        ((TOKENS_PER_TURN.slice(2).reduce((a, b) => a + b, 0) - stats.totalTokensCharged) /
          TOKENS_PER_TURN.slice(2).reduce((a, b) => a + b, 0)) *
        100
      ).toFixed(1),
    };
  } finally {
    await upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runScenario3VirtualWorkspaceAndGate() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-bench-s3-')));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    createMultiFileRefactorProject(repo);
    gitInit(repo);

    // 3A: Failed gate in shadow workspace -> 0 pollution in real workspace
    const badAgent = path.join(tmp, 'bad-agent.mjs');
    fs.writeFileSync(
      badAgent,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync('src/pricing-core.ts', 'BROKEN_TYPESCRIPT_SYNTAX @@@@');\n`,
      { mode: 0o755 }
    );
    const badRes = await runInVirtualWorkspace({
      command: process.execPath,
      args: [badAgent],
      workspaceRoot: repo,
      domainPath: path.join(tmp, 'domain-shadow'),
      gateCommand: `${process.execPath} ${tscBin} -p tsconfig.json`,
      http304Cache: false,
    });
    assert.equal(badRes.status, 'gate_rejected');
    const gitStatusAfterBad = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(gitStatusAfterBad, '');

    // 3B: xio race with 2 orthogonal agents + real tsc --noEmit gate
    const agentPart1 = path.join(tmp, 'agent-part1.mjs');
    fs.writeFileSync(
      agentPart1,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfor (const f of ['src/pricing-core.ts','src/discount-engine.ts','src/tax-calculator.ts','src/invoice-builder.ts','src/ledger-exporter.ts']) {\n  fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/computeLegacySubtotal/g,'computeAuditedSubtotal'));\n}\n`,
      { mode: 0o755 }
    );
    const agentPart2 = path.join(tmp, 'agent-part2.mjs');
    fs.writeFileSync(
      agentPart2,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst f = 'src/checkout-service.ts';\nfs.writeFileSync(f, '// Audited checkout pipeline\\n' + fs.readFileSync(f,'utf8'));\n`,
      { mode: 0o755 }
    );

    const raceRes = await raceAgentsInVirtualWorkspaces({
      workspaceRoot: repo,
      domainPath: path.join(tmp, 'domain-race'),
      mode: 'merge',
      gateCommand: `${process.execPath} ${tscBin} -p tsconfig.json`,
      candidates: [
        { id: 'agent-a', command: process.execPath, args: [agentPart1] },
        { id: 'agent-b', command: process.execPath, args: [agentPart2] },
      ],
    });

    assert.deepEqual(raceRes.committedCandidateIds.sort(), ['agent-a', 'agent-b']);
    const verifyOut = execFileSync(process.execPath, ['src/verify-refactor.mjs'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(verifyOut, 'REFACTOR_VERIFIED_OK');

    return {
      failedGateLeftoverDirtyFiles: gitStatusAfterBad.length,
      orthogonalRaceCommittedIds: raceRes.committedCandidateIds,
      finalVerification: verifyOut,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const s1 = await runScenario1CrashRecovery();
const s2 = await runScenario2EarlyCutoffCommentEdit();
const s3 = await runScenario3VirtualWorkspaceAndGate();

const report = {
  recordedAt: new Date().toISOString(),
  platform: `${os.platform()} ${os.arch()} ${os.release()}`,
  node: process.version,
  scenario1_crashRecovery: s1,
  scenario2_earlyCutoff: s2,
  scenario3_virtualWorkspace: s3,
};

console.log(JSON.stringify(report, null, 2));
const outFile = path.resolve(import.meta.dirname, '../results/wrap-cure-benchmark.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
