import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ActionEpisode, ACTION_ARMS } from './action-episode.mjs';
import { ResearchBudget, snapshotSources, writeJson, accounted, reviewedCall } from './research-budget.mjs';
import { ResearchClient, MODEL } from './research-client.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, 'results/model-20261103');
const output = path.join(directory, 'results/action-model-v1');
const [mode, phase, capText] = process.argv.slice(2);
const running = mode === 'run';
if (!(running && ['pilot', 'dev', 'heldout'].includes(phase) && process.argv.length === 5) &&
    !(['prepare', 'preflight'].includes(mode) && process.argv.length === 3)) {
  throw new Error('Usage: action-model-runner.mjs prepare|preflight OR run pilot|dev|heldout CUMULATIVE_CAP_USD');
}
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'budget.json')));
const waitSummaryFile = path.join(directory, 'results/process-model-v1/summary.json');
const waitSummary = fs.existsSync(waitSummaryFile) ? JSON.parse(fs.readFileSync(waitSummaryFile)) : null;
const holds = [];
if (!waitSummary || waitSummary.status !== 'COMPLETE' || waitSummary.attemptedFormal !== 108 || !waitSummary.allCleaned) holds.push('P2_formal_matrix_and_analysis_incomplete');
const unreviewed = ledger.calls.filter((call) => !reviewedCall(call, root)).map((call) => call.id);
if (unreviewed.length) holds.push(`unreviewed_requests:${unreviewed.join(',')}`);
if (fs.existsSync(path.join(root, 'runner.lock'))) holds.push('model_runner_lock_exists');
if (mode === 'preflight') {
  console.log(JSON.stringify({ status: holds.length ? 'HOLD' : 'READY_FOR_EXPLICIT_BATCH_ALLOCATION', newModelRequests: 0,
    throughRequest: ledger.calls.at(-1)?.id, cumulativeAccountedUsd: accounted(ledger), holds }, null, 2));
  process.exitCode = holds.length ? 2 : 0;
} else {
  fs.mkdirSync(output, { recursive: true });
  const planned = {};
  for (const split of ['pilot', 'dev', 'heldout']) {
    planned[split] = [];
    for (let repetition = 0; repetition < (split === 'pilot' ? 1 : 3); repetition += 1) {
      for (const index of split === 'pilot' ? [1, 2, 5] : [1, 2, 3, 4, 5, 6]) {
        const taskId = `${split === 'heldout' ? 'heldout' : 'dev'}-${String(index).padStart(2, '0')}`;
        const offset = repetition % ACTION_ARMS.length;
        for (const arm of [...ACTION_ARMS.slice(offset), ...ACTION_ARMS.slice(0, offset)]) planned[split].push({ taskId, arm, repetition });
      }
    }
  }
  const sources = ['action-model-runner.mjs', 'research-client.mjs', 'research-budget.mjs', 'model-budget.mjs', 'observation.mjs',
    'action-command.mjs', 'action-coordinator.mjs', 'action-episode.mjs', 'process-service.mjs', 'process-fixture.mjs',
    'process-host.mjs', 'process-grader.mjs', 'process-episode.mjs', 'ACTION-PROTOCOL.md', 'PROCESS-PROTOCOL.md'];
  const plan = { experiment: 'action-v1', system: '你正在通过真实系统工具完成配置操作任务。理解目标与字段，自行选择当前对象、观察证据和动作。遵守身份与版本前提，变化后重新观察。文件写入、reload接受或工具成功回执不足以证明目标完成；依据真实运行态调用submit提交一次最终结果。只使用本轮工具，不臆造标识。',
    temperature: 0, maxTokens: 2048, maxModelSteps: 12, maxToolCalls: 24, requestTimeoutMs: 45000, episodeTimeoutMs: 180000,
    faultTiming: 'after_first_observation', planned, sourceHashes: snapshotSources(directory, output, sources) };
  const planFile = path.join(output, 'plan.json');
  if (fs.existsSync(planFile)) assert.deepEqual(JSON.parse(fs.readFileSync(planFile)), plan, 'Prepared action protocol changed; version it before running');
  else writeJson(planFile, plan, { immutable: true });
  if (!running) {
    console.log(JSON.stringify({ status: 'PREPARED_NOT_RUN', pilot: planned.pilot.length, formal: planned.dev.length + planned.heldout.length,
      newModelRequests: 0, batchCumulativeLimitUsd: null, holds }, null, 2));
  } else {
    if (holds.length) throw new Error(`Action model phase is held: ${holds.join('; ')}`);
    const capUsd = Number(capText);
    if (!(capUsd > accounted(ledger) && capUsd <= 5)) throw new Error('Explicit cumulative batch cap must exceed accounted cost and remain within $5');
    if (phase !== 'pilot') {
      const pilotFile = path.join(output, 'pilot-summary.json');
      if (!fs.existsSync(pilotFile)) throw new Error('Pilot must complete before formal action experiments');
      const pilot = JSON.parse(fs.readFileSync(pilotFile));
      assert.equal(pilot.attempted, 6); assert.equal(pilot.allCleaned, true); assert.ok(!pilot.stopped);
    }
    if (phase === 'heldout') {
      const dev = JSON.parse(fs.readFileSync(path.join(output, 'dev-summary.json')));
      assert.equal(dev.attempted, 36); assert.equal(dev.allCleaned, true); assert.ok(!dev.stopped);
    }
    const budget = new ResearchBudget(root, { capUsd, experiment: 'action-v1' });
    const client = new ResearchClient(budget, output);
    const interrupted = new AbortController();
    const onSignal = () => interrupted.abort(new Error('runner_interrupted'));
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    const keyOf = (entry) => `${phase}-${entry.taskId}-${entry.arm}-${entry.repetition}.json`;
    let failure;
    try {
      budget.freezeHistory();
      const batchFile = path.join(output, 'batch.json');
      if (fs.existsSync(batchFile)) assert.equal(JSON.parse(fs.readFileSync(batchFile)).cumulativeLimitUsd, capUsd, 'Do not reset batch allowance');
      else writeJson(batchFile, { anchorThroughRequest: ledger.calls.at(-1)?.id, anchorAccountedUsd: accounted(ledger), cumulativeLimitUsd: capUsd }, { immutable: true });
      const config = await client.connect();
      const manifest = { ...plan, phase, planned: planned[phase], config, batchCumulativeLimitUsd: capUsd };
      const manifestFile = path.join(output, `${phase}-manifest.json`);
      if (fs.existsSync(manifestFile)) assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)), manifest);
      else writeJson(manifestFile, manifest, { immutable: true });
      for (const entry of planned[phase]) {
        interrupted.signal.throwIfAborted();
        const destination = path.join(output, keyOf(entry));
        if (fs.existsSync(destination)) continue;
        const episode = await ActionEpisode.create(entry.taskId, entry.arm);
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(new Error('episode_deadline')); episode.host.close(); }, plan.episodeTimeoutMs);
        const signal = AbortSignal.any([controller.signal, interrupted.signal]);
        const messages = [{ role: 'system', content: plan.system }, { role: 'user', content: JSON.stringify({ task: episode.ready.task, facts: episode.ready.facts }) }];
        const modelCalls = [];
        const toolEvents = [];
        const started = Date.now();
        let stopReason = 'model_step_limit';
        let fatal;
        try {
          for (let step = 0; step < plan.maxModelSteps && !episode.finished; step += 1) {
            const { message, callId } = await client.request({ model: MODEL, messages, tools: episode.ready.tools,
              temperature: plan.temperature, max_tokens: plan.maxTokens, stream: false }, { phase, ...entry, step }, signal);
            modelCalls.push(callId); messages.push(message);
            if (!message.tool_calls?.length) { stopReason = 'no_tool_call'; break; }
            for (const tool of message.tool_calls) {
              if (toolEvents.length >= plan.maxToolCalls) { stopReason = 'tool_step_limit'; break; }
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
          if (last?.experiment === 'action-v1' && last.phase === phase && last.taskId === entry.taskId && last.arm === entry.arm && last.repetition === entry.repetition && !modelCalls.includes(last.id)) modelCalls.push(last.id);
          stopReason = error.code ?? 'infrastructure_error';
          if (stopReason !== 'provider_empty_response') fatal = error;
        } finally {
          clearTimeout(timer);
          try { await episode.close(); }
          catch (error) { fatal = error; stopReason = 'cleanup_error'; }
          const record = { experiment: 'action-v1', phase, ...entry, modelCalls, toolEvents, stopReason,
            elapsedMs: Date.now() - started, sourceHashes: plan.sourceHashes, trace: episode.trace,
            ...(fatal ? { error: client.clean(fatal.message) } : {}) };
          writeJson(destination, record, { immutable: true });
          console.log(JSON.stringify({ phase, ...entry, passed: record.trace.verdict.passed, stopReason, modelCalls: modelCalls.length, totalAccountedUsd: accounted(budget.ledger) }));
        }
        if (fatal) throw fatal;
      }
    } catch (error) { failure = error; }
    finally {
      const records = planned[phase].filter((entry) => fs.existsSync(path.join(output, keyOf(entry)))).map((entry) => JSON.parse(fs.readFileSync(path.join(output, keyOf(entry)))));
      writeJson(path.join(output, `${phase}-summary.json`), { experiment: 'action-v1', phase, planned: planned[phase].length, attempted: records.length,
        passed: records.filter((record) => record.trace.verdict.passed).length, allCleaned: records.every((record) => record.trace.cleaned),
        notAttempted: planned[phase].filter((entry) => !fs.existsSync(path.join(output, keyOf(entry)))), totalAccountedUsd: accounted(budget.ledger),
        ...(failure ? { stopped: client.clean(failure.message) } : {}) });
      client.close(); budget.close();
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    }
    if (failure) throw failure;
  }
}
