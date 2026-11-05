import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS } from './task-host.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, 'results/model-20261103');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file)));
const historical = process.argv.slice(2).join(' ') === '--historical';
assert.ok(process.argv.length === 2 || historical, 'Usage: model-report.mjs [--historical]');
const history = historical ? read('historical-ledger.json') : null;
if (history) assert.equal(digest(fs.readFileSync(path.join(root, history.file))), history.sha256);
const ledger = read(history?.file ?? 'budget.json');
assert.ok(ledger.calls.every((call) => call.state === 'settled' || (call.state === 'unknown-charge-reserved' &&
  call.failureClass === 'provider_empty_response' && call.accountedUsd === call.reservedUsd)), 'Unreviewed requests prevent a complete report');
const amendment = read('runtime-amendment.json');
const totalAccountedUsd = ledger.calls.reduce((sum, call) => sum + call.accountedUsd, 0);
assert.ok(totalAccountedUsd <= ledger.limitUsd);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};
const allRecords = [];
const byPhase = [];
const failures = [];
for (const phase of ['dev', 'heldout']) {
  const manifest = read(`${phase}-manifest.json`);
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
    const current = digest(fs.readFileSync(path.join(directory, file)));
    if (current !== expected) {
      assert.equal(amendment.originalSourceHashes[file], expected);
      assert.equal(amendment.resumedSourceHashes[file], current);
      assert.equal(digest(fs.readFileSync(path.join(root, 'source-snapshots', `${expected}.source`))), expected);
    }
  }
  assert.equal(digest(fs.readFileSync(path.resolve(directory, '../../spec/isa-v1/registry.json'))), manifest.registrySha256);
  const records = [];
  for (let repetition = 0; repetition < 3; repetition += 1) for (let index = 1; index <= 6; index += 1) for (const arm of ARMS) {
    const taskId = `${phase}-${String(index).padStart(2, '0')}`;
    const record = read(`${phase}-${taskId}-${arm}-${repetition}.json`);
    assert.equal(record.trace.cleaned, true);
    assert.ok(record.stopReason !== 'infrastructure_error' || record.reviewedFailureClass === 'provider_empty_response');
    const epoch = record.sourceHashes ?? manifest.sourceHashes;
    assert.ok(JSON.stringify(epoch) === JSON.stringify(manifest.sourceHashes) || JSON.stringify(epoch) === JSON.stringify(amendment.resumedSourceHashes), 'Unknown execution source identity');
    assert.equal(record.trace.provenance.type === 'real-repository-copy' ? record.trace.provenance.initialSha256 : manifest.registrySha256, manifest.registrySha256);
    if (!record.trace.verdict.passed) failures.push({ phase, taskId, arm, repetition, stopReason: record.stopReason,
      failureClass: record.reviewedFailureClass ?? record.stopReason,
      failedChecks: Object.entries(record.trace.verdict.checks ?? {}).filter(([_key, passed]) => !passed).map(([key]) => key) });
    records.push(record);
  }
  allRecords.push(...records);
  const summaries = ARMS.map((arm) => {
    const selected = records.filter((record) => record.arm === arm);
    const ids = new Set(selected.flatMap((record) => record.modelCalls));
    const calls = ledger.calls.filter((call) => ids.has(call.id));
    assert.equal(calls.length, ids.size);
    assert.ok(calls.every((call) => call.state === 'unknown-charge-reserved' || call.returnedModel === manifest.expectedReturnedModel));
    return { arm, passed: selected.filter((record) => record.trace.verdict.passed).length, episodes: selected.length,
      modelRequests: calls.length, medianModelRequests: median(selected.map((record) => record.modelCalls.length)),
      toolCalls: selected.reduce((sum, record) => sum + record.toolCalls, 0), toolErrors: selected.reduce((sum, record) => sum + record.trace.metrics.errors, 0),
      promptTokens: calls.reduce((sum, call) => sum + (call.usage?.prompt_tokens ?? 0), 0),
      completionTokens: calls.reduce((sum, call) => sum + (call.usage?.completion_tokens ?? 0), 0),
      cachedTokens: calls.reduce((sum, call) => sum + (call.usage?.prompt_tokens_details?.cached_tokens ?? 0), 0),
      unknownUsageRequests: calls.filter((call) => !call.usage).length,
      serviceFailures: selected.filter((record) => ['infrastructure_error', 'provider_empty_response'].includes(record.stopReason)).length,
      providerReportedUsd: calls.every((call) => typeof call.providerReportedUsd === 'number') ? calls.reduce((sum, call) => sum + call.providerReportedUsd, 0) : null,
      accountedUsd: calls.reduce((sum, call) => sum + call.accountedUsd, 0),
      medianEpisodeMs: median(selected.map((record) => record.elapsedMs)) };
  });
  byPhase.push({ phase, summaries, byTask: Array.from({ length: 6 }, (_unused, index) => {
    const taskId = `${phase}-${String(index + 1).padStart(2, '0')}`;
    return { taskId, arms: Object.fromEntries(ARMS.map((arm) => [arm, records.filter((record) => record.taskId === taskId && record.arm === arm && record.trace.verdict.passed).length])) };
  }) });
}
const pilot = read('pilot-summary.json');
const formalCallIds = new Set(allRecords.flatMap((record) => record.modelCalls));
assert.equal(formalCallIds.size, ledger.calls.filter((call) => call.phase !== 'pilot').length, 'A formal request is missing from the episode accounting');
assert.ok(ledger.calls.filter((call) => call.phase !== 'pilot').every((call) => formalCallIds.has(call.id)));
const devManifest = read('dev-manifest.json');
const heldoutManifest = read('heldout-manifest.json');
assert.deepEqual({ ...devManifest, phase: 'same' }, { ...heldoutManifest, phase: 'same' }, 'Development and holdout protocols differ');
const result = { evidenceClass: 'actual-model-tool-calling-controlled-readonly-tasks', date: '2026-11-03',
  configuredModel: read('dev-manifest.json').config.model, returnedModels: [...new Set(ledger.calls.map((call) => call.returnedModel).filter(Boolean))],
  episodes: allRecords.length, passed: allRecords.filter((record) => record.trace.verdict.passed).length,
  pilot: { episodes: pilot.episodes, passed: pilot.passed, excludedFromFormalScores: true }, byPhase, failures,
  budget: { limitUsd: ledger.limitUsd, totalAccountedUsd, includesPilot: true,
    providerReportedKnownUsd: ledger.calls.reduce((sum, call) => sum + (call.providerReportedUsd ?? 0), 0),
    unknownUsageRequests: ledger.calls.filter((call) => !call.usage).length,
    reservedUnknownUsd: ledger.calls.filter((call) => call.state === 'unknown-charge-reserved').reduce((sum, call) => sum + call.reservedUsd, 0),
    actualInvoiceVerified: false }, modelRequestsIncludingPilot: ledger.calls.length,
  promptTokensIncludingPilot: ledger.calls.reduce((sum, call) => sum + (call.usage?.prompt_tokens ?? 0), 0),
  completionTokensIncludingPilot: ledger.calls.reduce((sum, call) => sum + (call.usage?.completion_tokens ?? 0), 0),
  allCleaned: allRecords.every((record) => record.trace.cleaned), executionSourceHashesVerified: true, runtimeAmendment: amendment };
if (!historical) fs.writeFileSync(path.join(directory, 'results/model-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
const rows = byPhase.flatMap(({ phase, summaries }) => summaries.map((s) =>
  `| ${phase} | ${s.arm} | ${s.passed}/${s.episodes} | ${s.medianModelRequests} | ${s.unknownUsageRequests ? '≥' : ''}${s.promptTokens} | ${s.unknownUsageRequests ? '≥' : ''}${s.completionTokens} | ${s.toolErrors} | $${s.accountedUsd.toFixed(6)} |`)).join('\n');
const taskRows = byPhase.flatMap(({ byTask }) => byTask.map((task) => `| ${task.taskId} | ${ARMS.map((arm) => `${task.arms[arm]}/3`).join(' | ')} |`)).join('\n');
const failureText = failures.length ? failures.map((failure) => `- ${failure.taskId} / ${failure.arm} / repeat ${failure.repetition}: ${failure.failureClass}; ${failure.failedChecks.join(', ') || 'no terminal submission'}`).join('\n') : '正式运行均通过终局检查。';
const report = `# ClinePass 真实模型对照结果\n\n2026-11-03。已执行 ${result.episodes} 个正式任务运行，${result.passed} 个通过独立检查。另有 ${pilot.episodes} 个 pilot 运行，单独保存且不计入正式成功率。\n\n` +
  `配置模型：\`${result.configuredModel}\`。服务返回标签：\`${result.returnedModels.join('`, `')}\`。三组使用相同模型、指令、temperature=0 和请求上限，各任务重复三次并轮换组顺序。\n\n` +
  `## 正式结果\n\n| 集合 | 接口 | 正确终局 | 每任务模型请求中位数 | 输入 Token 合计 | 输出 Token 合计 | 工具错误 | 保守折算 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
  `成功率以所有计划任务为分母，包括服务失败未完成的任务；它衡量只读答案与当前版本，不是任意 OS 操作成功率。Token 来自实际 usage；含未知用量的组用 ≥ 表示已知下界。模型请求与工具执行次数可能不同。缓存使用和固定任务重复会影响计量，不把单次低成本当作普遍保证。\n\n` +
  `## 各任务\n\n| 任务 | full | jq | structured |\n| --- | ---: | ---: | ---: |\n${taskRows}\n\n` +
  `## 失败保留\n\n${failureText}\n\n` +
  `## 本轮预算\n\n包括 pilot 共 ${ledger.calls.length} 次模型请求，已返回的用量为 ${result.promptTokensIncludingPilot} 输入 Token、${result.completionTokensIncludingPilot} 输出 Token；另有 ${result.budget.unknownUsageRequests} 次请求用量未知。预算保守计入 **$${totalAccountedUsd.toFixed(6)} / $5.00**，其中未知用量预留 $${result.budget.reservedUnknownUsd.toFixed(6)}；服务已返回 cost 合计 $${result.budget.providerReportedKnownUsd.toFixed(6)}，不包含未知部分。\n\n` +
  `[ClinePass 是订阅额度制](https://docs.cline.bot/getting-started/clinepass)。这里采用峰值参考价并忽略缓存折扣，服务 cost 也不是核验过的现金账单。逐请求预留和结算在 [budget.json](results/model-20261103/budget.json)。\n\n` +
  `## 解释边界\n\n语料规模为 12 个任务，除真实 ISA 注册表副本外均为合成数据；保留集不是外部盲测。只验证一个配置模型、可调整结果预算和受控状态更新。尚未测固定预算、跨模型迁移、真实服务等待、订阅发现延迟或系统写操作。返回模型标签稳定不证明权重完全不变。\n\n` +
  `上游空响应触发过一次协议修订：保存失败，不重试失败任务，保留完整费用预留并继续其他任务。模型、提示、任务数据未变；这次中途修订必须随结果披露。原始源码快照与恢复后哈希均已核验，详见 [runtime-amendment.json](results/model-20261103/runtime-amendment.json)。\n\n` +
  `所有任务临时目录已清理；未修改或关闭已有本地代理。原始请求、响应、工具轨迹、评分和 manifest 保存在 results/model-20261103；汇总见 [model-summary.json](results/model-summary.json)。\n`;
if (!historical) fs.writeFileSync(path.join(directory, 'MODEL-REPORT.md'), report);
console.log(JSON.stringify({ status: 'PASS', episodes: result.episodes, passed: result.passed, budget: result.budget, failures: result.failures, byPhase: result.byPhase }, null, 2));
