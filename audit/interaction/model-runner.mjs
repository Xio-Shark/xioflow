import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TaskEpisode } from './task-episode.mjs';
import { ARMS } from './task-host.mjs';
import { digest } from './observation.mjs';
import { RATES, PRICE_SOURCE, reserveCost, usageCost, mayReserve } from './model-budget.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const [phase] = process.argv.slice(2);
if (!['pilot', 'dev', 'heldout'].includes(phase) || process.argv.length !== 3) throw new Error('Usage: node audit/interaction/model-runner.mjs pilot|dev|heldout');
const output = path.join(directory, 'results/model-20261103');
fs.mkdirSync(output, { recursive: true });
const ledgerPath = path.join(output, 'budget.json');
const lock = path.join(output, 'runner.lock');
const lockFd = fs.openSync(lock, 'wx');
fs.writeFileSync(lockFd, `${process.pid}\n`);
fs.closeSync(lockFd);
const writeJson = (file, value) => {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};
let token;
const clean = (value) => token ? String(value).split(token).join('[REDACTED]') : String(value);
const sources = ['model-runner.mjs', 'model-budget.mjs', 'task-cases.mjs', 'task-host.mjs', 'task-episode.mjs',
  'task-grader.mjs', 'observation.mjs', 'MODEL-PROTOCOL.md'];
const system = '你正在通过只读工具完成一个系统观察任务。先理解工具与数据字段，再自行决定获取哪些信息；缺少依据时继续观察。结果预算可在说明范围内调整，遇到分页必须判断是否需要继续。不要臆造对象、字段或版本。完成后调用 submit 提交一次最终答案；不得把自然语言说明当作提交。只使用本轮提供的工具。';
const expectedReturnedModel = 'vmc/deepseek-v4p1-flash-1017-contributor-fallbacks';
let ledger;
let config;
let endpoint;
let activeSourceHashes;

async function requestModel(payload, context) {
  const reservedUsd = reserveCost(payload, payload.max_tokens);
  if (!mayReserve(ledger, reservedUsd)) throw new Error('Budget reservation refused; no request sent');
  const call = { id: ledger.calls.length + 1, ...context, reservedUsd, state: 'pending', startedAt: new Date().toISOString() };
  ledger.calls.push(call);
  writeJson(ledgerPath, ledger);
  writeJson(path.join(output, `request-${String(call.id).padStart(4, '0')}.json`), { context, payload });
  const began = performance.now();
  try {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'X-Response-Format': 'openai', 'X-Title': 'xioflow-interaction-research' },
      body: JSON.stringify(payload) });
    const raw = clean(await response.text());
    fs.writeFileSync(path.join(output, `response-${String(call.id).padStart(4, '0')}.json`), raw);
    call.httpStatus = response.status;
    if (response.status === 500) {
      let body;
      try { body = JSON.parse(raw); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (body?.error === 'empty response content') call.failureClass = 'provider_empty_response';
    }
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}; response saved without credentials`);
    const result = JSON.parse(raw);
    const cost = usageCost(result.usage);
    Object.assign(call, cost, { usage: result.usage, returnedModel: result.model, state: 'settled', elapsedMs: Number((performance.now() - began).toFixed(3)) });
    writeJson(ledgerPath, ledger);
    if (call.accountedUsd > reservedUsd) throw new Error('Actual cost exceeded pre-request reservation; stop for inspection');
    if (result.model !== expectedReturnedModel) throw new Error('Provider returned a different model identity; stop rather than mix models');
    if (!Array.isArray(result.choices) || !result.choices[0]?.message) throw new Error('Missing model message');
    return result;
  } catch (error) {
    if (call.failureClass === 'provider_empty_response') {
      call.state = 'unknown-charge-reserved';
      call.accountedUsd = call.reservedUsd;
      call.accountingNote = 'No usage supplied; retain full reservation. Do not retry this episode.';
    } else call.state = call.state === 'settled' ? 'settled-error' : 'unknown-charge';
    call.error = clean(error.message);
    call.elapsedMs = Number((performance.now() - began).toFixed(3));
    writeJson(ledgerPath, ledger);
    const failure = new Error(call.error);
    failure.code = call.failureClass;
    throw failure;
  }
}

async function runTask(taskId, arm, repetition) {
  const key = `${phase}-${taskId}-${arm}-${repetition}`;
  const file = path.join(output, `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  const episode = new TaskEpisode(taskId, arm);
  const ready = episode.ready;
  const tools = ready.tools.map((tool) => ({ type: 'function', function: { name: tool.op, description: tool.description, parameters: tool.args } }));
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ task: ready.task, budgets: ready.budgets }) }];
  const modelCalls = [];
  let stopReason = 'model_step_limit';
  let toolCalls = 0;
  let fatal;
  const started = performance.now();
  try {
    for (let step = 0; step < 12 && !episode.finished; step += 1) {
      const result = await requestModel({ model: config.model, messages, tools, temperature: 0, max_tokens: 2048, stream: false }, { phase, taskId, arm, repetition, step });
      modelCalls.push(ledger.calls.at(-1).id);
      const message = result.choices[0].message;
      messages.push(message);
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) { stopReason = 'no_tool_call'; break; }
      for (const tool of message.tool_calls) {
        if (toolCalls >= 24) { stopReason = 'tool_step_limit'; break; }
        toolCalls += 1;
        let args;
        let reply;
        try { args = JSON.parse(tool.function.arguments); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          reply = episode.handleLine(tool.function.arguments);
        }
        if (!reply) reply = episode.handle({ id: tool.id, op: tool.function.name, args });
        messages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify(reply) });
        if (episode.finished) { stopReason = 'submitted'; break; }
      }
      if (stopReason === 'tool_step_limit') break;
    }
  } catch (error) {
    const last = ledger.calls.at(-1);
    if (last?.taskId === taskId && last.arm === arm && last.repetition === repetition && last.phase === phase && !modelCalls.includes(last.id)) modelCalls.push(last.id);
    if (error.code === 'provider_empty_response') stopReason = 'provider_empty_response';
    else { fatal = error; stopReason = 'infrastructure_error'; }
  } finally {
    episode.close();
    const record = { phase, taskId, arm, repetition, modelCalls, toolCalls, stopReason, sourceHashes: activeSourceHashes,
      elapsedMs: Number((performance.now() - started).toFixed(3)), ...(fatal ? { error: clean(fatal.message) } : {}), trace: episode.trace };
    writeJson(file, record);
    console.log(JSON.stringify({ taskId, arm, repetition, passed: record.trace.verdict.passed, stopReason, modelCalls: modelCalls.length,
      totalAccountedUsd: ledger.calls.reduce((sum, call) => sum + (call.accountedUsd ?? call.reservedUsd), 0) }));
  }
  if (fatal) throw fatal;
  return JSON.parse(fs.readFileSync(file));
}

try {
  const db = new Database(path.join(os.homedir(), '.cc-switch/cc-switch.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT settings_config FROM providers WHERE name = 'ClinePass' AND app_type = 'claude'").all();
    if (rows.length !== 1) throw new Error('Expected exactly one configured ClinePass provider');
    const env = JSON.parse(rows[0].settings_config).env;
    token = env.ANTHROPIC_AUTH_TOKEN;
    config = { model: env.ANTHROPIC_MODEL, configuredBaseUrl: env.ANTHROPIC_BASE_URL };
    if (config.model !== 'cline-pass/deepseek-v4.1-flash-1017' || config.configuredBaseUrl !== 'http://127.0.0.1:8788' || typeof token !== 'string' || !token) {
      throw new Error('Provider differs from reviewed configuration; stop before inference');
    }
  } finally { db.close(); }
  const healthResponse = await fetch(`${config.configuredBaseUrl}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!healthResponse.ok) throw new Error('Configured local adapter is unavailable');
  const health = await healthResponse.json();
  endpoint = health.upstream;
  if (endpoint !== 'http://127.0.0.1:8787/api/v1/chat/completions') throw new Error('Local route differs from reviewed proxy chain');
  ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath)) : { limitUsd: 5, accounting: 'conservative-reference-usd-not-invoice', rates: RATES, source: PRICE_SOURCE, calls: [] };
  if (ledger.limitUsd !== 5 || ledger.calls.some((call) => call.state !== 'settled' &&
      !(call.state === 'unknown-charge-reserved' && call.failureClass === 'provider_empty_response' && call.accountedUsd === call.reservedUsd))) {
    throw new Error('Unsettled or unreviewed prior request requires inspection before another run');
  }
  const manifest = { protocol: 'RFC-SI-003/model-v1', phase, config, endpoint, expectedReturnedModel, system, temperature: 0, maxTokens: 2048,
    maxModelSteps: 12, maxToolCalls: 24, repetitions: phase === 'pilot' ? 1 : 3, budgetLimitUsd: 5, rates: RATES,
    sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])),
    registrySha256: digest(fs.readFileSync(path.resolve(directory, '../../spec/isa-v1/registry.json'))),
    environment: { node: process.version, platform: process.platform, arch: process.arch } };
  const manifestPath = path.join(output, `${phase}-manifest.json`);
  activeSourceHashes = manifest.sourceHashes;
  if (fs.existsSync(manifestPath)) {
    const original = JSON.parse(fs.readFileSync(manifestPath));
    if (JSON.stringify(original) !== JSON.stringify(manifest)) {
      const amendment = JSON.parse(fs.readFileSync(path.join(output, 'runtime-amendment.json')));
      if (JSON.stringify({ ...manifest, sourceHashes: original.sourceHashes }) !== JSON.stringify(original) ||
          JSON.stringify(amendment.originalSourceHashes) !== JSON.stringify(original.sourceHashes) ||
          JSON.stringify(amendment.resumedSourceHashes) !== JSON.stringify(manifest.sourceHashes)) {
        throw new Error('Unreviewed manifest change; refuse to mix runs');
      }
    }
  } else {
    writeJson(manifestPath, manifest);
  }
  const records = [];
  for (let repetition = 0; repetition < manifest.repetitions; repetition += 1) {
    for (let index = 1; index <= (phase === 'pilot' ? 1 : 6); index += 1) {
      const taskId = `${phase === 'heldout' ? 'heldout' : 'dev'}-${String(index).padStart(2, '0')}`;
      const order = [...ARMS.slice(repetition), ...ARMS.slice(0, repetition)];
      for (const arm of order) records.push(await runTask(taskId, arm, repetition));
    }
  }
  const summary = { phase, episodes: records.length, passed: records.filter((record) => record.trace.verdict.passed).length,
    byArm: Object.fromEntries(ARMS.map((arm) => [arm, { passed: records.filter((record) => record.arm === arm && record.trace.verdict.passed).length,
      total: records.filter((record) => record.arm === arm).length }])),
    totalAccountedUsd: ledger.calls.reduce((sum, call) => sum + call.accountedUsd, 0), allCleaned: records.every((record) => record.trace.cleaned) };
  writeJson(path.join(output, `${phase}-summary.json`), summary);
  console.log(JSON.stringify(summary));
} finally {
  token = undefined;
  fs.unlinkSync(lock);
}
