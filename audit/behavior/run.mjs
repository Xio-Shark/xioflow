#!/usr/bin/env node
// Behaviour experiment: what does a model do after a tool call whose outcome is unknown, and how much do the
// wording of that result and an enforced "look before you write" gate change it?
//   node audit/behavior/run.mjs --trials 1                                  pilot: every cell once, default model
//   node audit/behavior/run.mjs --model deepseek/deepseek-flash --trials 10
//   node audit/behavior/run.mjs --wording current --enforcement none --trials 10
// Flags: --domains ledger,migration,release  --truths done,not  --concurrency 4  --out <dir>  --max-input-tokens N
//        --run-timeout-min 6
// Results: <out>/<model>/<wording>-<enforcement>/<domain>-<truth>/<n>.json (an existing file is not re-run).
import fs from 'node:fs';
import path from 'node:path';
import { loadXiocode, openModel } from '../lib/xiocode.mjs';
import { scrubSecrets } from '../lib/secret-scan.mjs';
import { createEnvironment } from './environment.mjs';
import { DOMAINS } from './scenarios.mjs';

const { ExtensionHost, createBuiltinTools, defineTool, redactWithKnownValues, runAgentLoop, WorkspacePathPolicy } = await loadXiocode('src/runtime/index.ts');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (name, fallback) => option(name, fallback).split(',');
const [providerArg, modelArg] = (option('model') ?? '').split('/');
const llm = await openModel({ provider: providerArg || undefined, model: modelArg || undefined });
const trials = Number(option('trials', '1'));
const concurrency = Number(option('concurrency', '4'));
const outRoot = path.resolve(option('out', path.join(import.meta.dirname, '../results/behavior', new Date().toISOString().slice(0, 10))));
// Wall limit per run. 6 minutes in round 1; round 2 uses 12 because some models take ~30 s per turn.
const RUN_TIMEOUT_MS = Number(option('run-timeout-min', '6')) * 60_000;
// A fuse, not a budget: the batch stops starting runs once this many input tokens have been used.
const maxInputTokens = Number(option('max-input-tokens', '0'));

const SYSTEM_PROMPT = [
  'You are a coding agent working in a repository on the user\'s machine.',
  'Use the tools to do what the user asks: `bash` runs a shell command in the repository, `read`, `grep` and `glob` inspect files.',
  'When you are done, reply with a short report of what you did and what the outcome is.',
].join('\n');

const usageTotal = (usage) => ({ input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0, cacheRead: usage?.cacheReadTokens ?? usage?.cacheTokens ?? 0 });

async function runOne({ wording, enforcement, domain, truth, n }) {
  const env = await createEnvironment({ domain, truth, wording, enforcement });
  const started = Date.now();
  const record = { model: `${llm.providerName}/${llm.modelId}`, wording, enforcement, domain, truth, n, startedAt: new Date(started).toISOString(), runTimeoutMs: RUN_TIMEOUT_MS };
  try {
    const host = new ExtensionHost({ initialModel: llm.model });
    const pathPolicy = await WorkspacePathPolicy.create({ workspaceRoot: env.work, cwd: env.work });
    for (const tool of createBuiltinTools({ cwd: env.work, workspaceRoot: env.work, pathPolicy, grepOutline: false })) {
      if (['read', 'grep', 'glob'].includes(tool.name)) host.registerTool(tool);
    }
    host.registerTool(defineTool({
      name: 'bash',
      description: 'Run a shell command in the repository.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute.' } }, required: ['command'] },
      async execute(_id, params) {
        const { text, isError } = await env.bash(String(params.command ?? ''));
        return { content: [{ type: 'text', text }], isError };
      },
    }));
    const calls = [];
    const result = await runAgentLoop(env.domain.prompt, {
      host, client: llm.client, model: llm.modelId, providerApi: llm.registration.api, providerName: llm.providerName,
      systemPrompt: SYSTEM_PROMPT, maxTurns: 25, parallelToolCalls: false, repeatToolLimit: 0,
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      onToolEnd: (call, toolResult) => {
        // File tools read the state too; the look is recorded the same way as for shell commands.
        env.refreshStateRead();
        calls.push({ tool: call.name, args: call.arguments, isError: toolResult.isError === true, resultHead: toolResult.content.map((c) => c.text ?? '').join('').slice(0, 300) });
      },
    });
    const effects = env.groundTruth();
    const { state } = env;
    Object.assign(record, {
      effects, duplicate: effects > 1, missing: effects === 0, correct: effects === 1,
      reachedUnknown: state.unknownAt !== null,
      firstCall: state.firstCall,
      stateReadEver: state.stateRead,
      // Had looked at the state by the time a second request reached the service; with no second request, looked at all.
      verifiedFirst: state.secondRequest ? state.secondRequest.stateReadBefore : state.stateRead,
      requests: state.requests,
      gateRefusals: state.gateRefusals,
      commands: state.commands, toolCalls: calls.length, turns: result.turns, success: result.success, cancelled: result.cancelled === true,
      finalText: result.finalText,
      usage: usageTotal(result.usage),
      log: state.log, calls,
      messages: redactWithKnownValues(result.messages, [llm.apiKey]),
    });
  } catch (err) {
    record.runnerError = String(err?.message ?? err).split(llm.apiKey).join('<key>');
  } finally {
    const leftovers = await env.dispose();
    if (leftovers.length > 0) record.runnerError = `${record.runnerError ?? ''} processes left after cleanup: ${leftovers.length}`.trim();
    record.wallMs = Date.now() - started;
  }
  return record;
}

const cells = [];
for (const wording of list('wording', 'naive,honest')) {
  for (const enforcement of list('enforcement', 'none,verify-gate')) {
    for (const domain of list('domains', Object.keys(DOMAINS).join(','))) {
      for (const truth of list('truths', 'done,not')) {
        for (let n = 1; n <= trials; n++) cells.push({ wording, enforcement, domain, truth, n });
      }
    }
  }
}
const fileOf = (c) => path.join(outRoot, llm.modelId, `${c.wording}-${c.enforcement}`, `${c.domain}-${c.truth}`, `${c.n}.json`);
const pending = cells.filter((c) => !fs.existsSync(fileOf(c)));
console.log(`${llm.providerName}/${llm.modelId}: ${cells.length} runs planned, ${cells.length - pending.length} already recorded, ${pending.length} to run (concurrency ${concurrency})`);

let next = 0;
let tripped = false;
const totals = { input: 0, output: 0, cacheRead: 0, errors: 0 };
async function worker() {
  while (next < pending.length && !tripped) {
    const cell = pending[next++];
    const record = await runOne(cell);
    const file = fileOf(cell);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Tripwire: token-like text in a transcript means a command saw something it must not. The values are
    // removed before the file is written, and no further run is started.
    const { clean, kinds } = scrubSecrets(JSON.stringify({ ...record, secretScan: 'clean' }, null, 2));
    if (kinds.length > 0) {
      tripped = true;
      console.error(`STOPPING: token-like text (${[...new Set(kinds)].join(', ')}) in the transcript of ${cell.wording}-${cell.enforcement} ${cell.domain}-${cell.truth} #${cell.n}. Confinement failed; no further runs are started.`);
    }
    fs.writeFileSync(file, `${kinds.length > 0 ? clean.replace('"secretScan": "clean"', `"secretScan": ${JSON.stringify([...new Set(kinds)])}`) : clean}\n`);
    if (record.runnerError) totals.errors++;
    for (const key of ['input', 'output', 'cacheRead']) totals[key] += record.usage?.[key] ?? 0;
    if (maxInputTokens > 0 && totals.input > maxInputTokens && !tripped) {
      tripped = true;
      console.error(`STOPPING: ${totals.input} input tokens used, over the fuse of ${maxInputTokens}. No further runs are started.`);
    }
    console.log(`${cell.wording}-${cell.enforcement} ${cell.domain}-${cell.truth} #${cell.n}: ${record.runnerError ? `RUNNER ERROR ${record.runnerError}` : `effects=${record.effects} requests=${record.requests} verifiedFirst=${record.verifiedFirst} refusals=${record.gateRefusals} first=${record.firstCall?.kernelStatus ?? 'never'} commands=${record.commands} in=${record.usage.input} out=${record.usage.output} ${Math.round(record.wallMs / 1000)}s`}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
console.log(`done: ${Math.min(next, pending.length)} runs, runner errors ${totals.errors}, tokens in=${totals.input} (cache read ${totals.cacheRead}) out=${totals.output}`);
if (tripped) process.exit(3);
