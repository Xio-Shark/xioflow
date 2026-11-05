import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ProcessEpisode } from './process-episode.mjs';
import { WAIT_ARMS } from './process-host.mjs';
import { ResearchBudget, snapshotSources, writeJson, accounted } from './research-budget.mjs';
import { ResearchClient, MODEL } from './research-client.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const [phase] = process.argv.slice(2);
if (!['pilot', 'dev', 'heldout'].includes(phase) || process.argv.length !== 3) throw new Error('Usage: process-model-runner.mjs pilot|dev|heldout');
const output = path.join(directory, 'results/process-model-v1');
fs.mkdirSync(output, { recursive: true });
const budget = new ResearchBudget(path.join(directory, 'results/model-20261103'), { capUsd: 1.5504097, experiment: 'wait-v1' });
const client = new ResearchClient(budget, output);
const interrupted = new AbortController();
const onSignal = () => interrupted.abort(new Error('runner_interrupted'));
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
const system = '你正在通过真实系统工具完成进程观察任务。理解目标与字段，自行选择观察对象、条件和等待方式；状态变化后重新判断证据。日志、进程存在或工具成功回执不足以证明目标完成。只使用本轮工具，依据返回的真实证据调用 submit 提交一次最终结果，不臆造标识。';
const sources = ['process-model-runner.mjs', 'research-client.mjs', 'research-budget.mjs', 'model-budget.mjs',
  'process-service.mjs', 'process-fixture.mjs', 'process-host.mjs', 'process-grader.mjs', 'process-episode.mjs', 'WAIT-PROTOCOL.md', 'PROCESS-PROTOCOL.md'];
const planned = [];
for (let repetition = 0; repetition < (phase === 'pilot' ? 1 : 3); repetition += 1) {
  for (const index of phase === 'pilot' ? [1, 3, 4] : [1, 2, 3, 4, 5, 6]) {
    const taskId = `${phase === 'heldout' ? 'heldout' : 'dev'}-${String(index).padStart(2, '0')}`;
    for (const arm of [...WAIT_ARMS.slice(repetition), ...WAIT_ARMS.slice(0, repetition)]) planned.push({ taskId, arm, repetition });
  }
}
const keyOf = ({ taskId, arm, repetition }) => `${phase}-${taskId}-${arm}-${repetition}.json`;
let manifest;
let failure;
try {
  budget.freezeHistory();
  const config = await client.connect();
  manifest = { experiment: 'wait-v1', phase, config, system, temperature: 0, maxTokens: 2048, maxModelSteps: 12,
    maxToolCalls: 24, tickMs: 2000, intervalMs: 100, taskDeadlineMs: 120000, episodeTimeoutMs: 180000,
    batchCumulativeLimitUsd: 1.5504097, planned, sourceHashes: snapshotSources(directory, output, sources) };
  const manifestPath = path.join(output, `${phase}-manifest.json`);
  if (fs.existsSync(manifestPath)) {
    const original = JSON.parse(fs.readFileSync(manifestPath));
    if (JSON.stringify(original) !== JSON.stringify(manifest)) {
      const amendment = JSON.parse(fs.readFileSync(path.join(output, `${phase}-runtime-amendment.json`)));
      assert.deepEqual({ ...manifest, sourceHashes: original.sourceHashes }, original, 'Public protocol changed');
      assert.deepEqual(amendment.originalSourceHashes, original.sourceHashes);
      assert.deepEqual(amendment.resumedSourceHashes, manifest.sourceHashes);
    }
  } else writeJson(manifestPath, manifest, { immutable: true });
  for (const entry of planned) {
    interrupted.signal.throwIfAborted();
    const destination = path.join(output, keyOf(entry));
    if (fs.existsSync(destination)) continue;
    const episode = await ProcessEpisode.create(entry.taskId, entry.arm, { tickMs: manifest.tickMs,
      intervalMs: manifest.intervalMs, deadlineMs: manifest.taskDeadlineMs, dropHints: entry.taskId.endsWith('06') });
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(new Error('episode_deadline')); episode.host.close(); }, manifest.episodeTimeoutMs);
    const signal = AbortSignal.any([controller.signal, interrupted.signal]);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ task: episode.ready.task, facts: episode.ready.facts, deadlineMs: episode.ready.deadlineMs }) }];
    const calls = [];
    const toolEvents = [];
    const started = Date.now();
    let stopReason = 'model_step_limit';
    let fatal;
    try {
      for (let step = 0; step < manifest.maxModelSteps && !episode.finished; step += 1) {
        const { message, callId } = await client.request({ model: MODEL, messages, tools: episode.ready.tools, temperature: 0, max_tokens: 2048, stream: false },
          { phase, ...entry, step }, signal);
        calls.push(callId); messages.push(message);
        if (!message.tool_calls?.length) { stopReason = 'no_tool_call'; break; }
        for (const tool of message.tool_calls) {
          if (toolEvents.length >= manifest.maxToolCalls) { stopReason = 'tool_step_limit'; break; }
          signal.throwIfAborted();
          let args;
          let response;
          try { args = JSON.parse(tool.function.arguments); }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; response = { error: { code: 'invalid_json', message: 'Expected a JSON argument object' } }; }
          if (!response) response = await episode.handle(tool.function.name, args);
          toolEvents.push({ name: tool.function.name, rawArgs: tool.function.arguments, response, at: Date.now() });
          messages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify(response) });
          if (episode.finished) { stopReason = 'submitted'; break; }
        }
        if (stopReason === 'tool_step_limit') break;
      }
    } catch (error) {
      const last = budget.ledger.calls.at(-1);
      if (last?.experiment === 'wait-v1' && last.phase === phase && last.taskId === entry.taskId && last.arm === entry.arm && last.repetition === entry.repetition && !calls.includes(last.id)) calls.push(last.id);
      stopReason = error.code ?? 'infrastructure_error';
      if (stopReason !== 'provider_empty_response') fatal = error;
    } finally {
      clearTimeout(timer);
      await episode.close();
      const record = { experiment: 'wait-v1', phase, ...entry, modelCalls: calls, toolEvents, stopReason,
        elapsedMs: Date.now() - started, sourceHashes: manifest.sourceHashes, trace: episode.trace,
        ...(fatal ? { error: client.clean(fatal.message) } : {}) };
      writeJson(destination, record, { immutable: true });
      console.log(JSON.stringify({ phase, ...entry, passed: record.trace.verdict.passed, stopReason, modelCalls: calls.length, totalAccountedUsd: accounted(budget.ledger) }));
    }
    if (fatal) throw fatal;
  }
} catch (error) { failure = error; }
finally {
  const records = planned.filter((entry) => fs.existsSync(path.join(output, keyOf(entry)))).map((entry) => JSON.parse(fs.readFileSync(path.join(output, keyOf(entry)))));
  writeJson(path.join(output, `${phase}-summary.json`), { experiment: 'wait-v1', phase, planned: planned.length, attempted: records.length,
    passed: records.filter((record) => record.trace.verdict.passed).length, allCleaned: records.every((record) => record.trace.cleaned),
    notAttempted: planned.filter((entry) => !fs.existsSync(path.join(output, keyOf(entry)))), totalAccountedUsd: accounted(budget.ledger),
    ...(failure ? { stopped: client.clean(failure.message) } : {}) });
  client.close(); budget.close();
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
}
if (failure) throw failure;
