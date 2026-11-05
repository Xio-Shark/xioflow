import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { digest } from './observation.mjs';
import { accounted, writeJson, reviewedCall, snapshotSources } from './research-budget.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const experiment = process.argv[2];
const definitions = {
  'wait-v1': { folder: 'process-model-v1', report: 'WAIT-MODEL-REPORT.md', arms: ['agent-poll', 'server-poll', 'event-view'], planned: 108, title: '真实进程等待模型对照' },
  'action-v1': { folder: 'action-model-v1', report: 'ACTION-MODEL-REPORT.md', arms: ['command', 'object'], planned: 72, title: '真实进程操作模型对照' },
};
const definition = definitions[experiment];
const partial = process.argv[3] === '--partial';
if (!definition || process.argv.length !== (partial ? 4 : 3)) throw new Error('Usage: research-report.mjs wait-v1|action-v1 [--partial]');
const root = path.join(directory, 'results', definition.folder);
const ledger = JSON.parse(fs.readFileSync(path.join(directory, 'results/model-20261103/budget.json')));
const history = JSON.parse(fs.readFileSync(path.join(directory, 'results/model-20261103/budget-through-0541.json')));
assert.deepEqual(ledger.calls.slice(0, 541), history.calls, 'Historical ledger changed');
const calls = ledger.calls.filter((call) => call.experiment === experiment);
const unreviewed = ledger.calls.filter((call) => !reviewedCall(call, path.join(directory, 'results/model-20261103')));
assert.ok(partial || unreviewed.length === 0, 'Unreviewed request prevents complete report; use --partial to report the hold without releasing it');
const records = [];
const notAttempted = [];
const manifests = [];
for (const phase of ['pilot', 'dev', 'heldout']) {
  const file = path.join(root, `${phase}-manifest.json`);
  if (!fs.existsSync(file)) continue;
  const manifest = JSON.parse(fs.readFileSync(file));
  manifests.push(manifest);
  for (const [name, sha] of Object.entries(manifest.sourceHashes)) {
    assert.equal(digest(fs.readFileSync(path.join(root, 'source-snapshots', `${sha}.source`))), sha, name);
  }
  for (const entry of manifest.planned) {
    const recordFile = path.join(root, `${phase}-${entry.taskId}-${entry.arm}-${entry.repetition}.json`);
    if (!fs.existsSync(recordFile)) { notAttempted.push({ phase, ...entry, reason: 'no_episode_record' }); continue; }
    const record = JSON.parse(fs.readFileSync(recordFile));
    const amendedFile = path.join(root, `${phase}-runtime-amendment.json`);
    const amendment = fs.existsSync(amendedFile) ? JSON.parse(fs.readFileSync(amendedFile)) : null;
    assert.ok(JSON.stringify(record.sourceHashes) === JSON.stringify(manifest.sourceHashes) ||
      amendment && JSON.stringify(record.sourceHashes) === JSON.stringify(amendment.resumedSourceHashes), 'Unrecognized execution epoch');
    for (const [name, sha] of Object.entries(record.sourceHashes)) assert.equal(digest(fs.readFileSync(path.join(root, 'source-snapshots', `${sha}.source`))), sha, name);
    assert.equal(record.trace.cleaned, true);
    for (const id of record.modelCalls) {
      const call = calls.find((item) => item.id === id);
      assert.ok(call, `Missing request ${id}`);
      assert.equal(call.phase, phase); assert.equal(call.taskId, entry.taskId);
      assert.equal(call.arm, entry.arm); assert.equal(call.repetition, entry.repetition);
      const prefix = path.join(root, 'requests', String(id).padStart(4, '0'));
      const request = JSON.parse(fs.readFileSync(`${prefix}-request.json`));
      assert.equal(request.payload.model, manifest.config.configuredModel);
      assert.equal(request.payload.temperature, manifest.temperature);
      assert.equal(request.payload.max_tokens, manifest.maxTokens);
      if (call.state === 'settled') {
        const response = JSON.parse(fs.readFileSync(`${prefix}-response.json`));
        assert.deepEqual(response.usage, call.usage);
        assert.equal(response.model, manifest.config.expectedReturnedModel);
        assert.ok(call.accountedUsd <= call.reservedUsd);
      }
    }
    records.push(record);
  }
}
assert.ok(manifests.length > 0, 'No experiment manifest exists');
const assigned = records.flatMap((record) => record.modelCalls);
assert.equal(new Set(assigned).size, assigned.length, 'Request assigned to multiple episodes');
assert.deepEqual([...assigned].sort((a, b) => a - b), calls.map((call) => call.id).sort((a, b) => a - b), 'Orphan request');
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const sumUsage = (group, field) => group.reduce((sum, call) => sum + (call.usage?.[field] ?? 0), 0);
const groups = [];
for (const phase of ['dev', 'heldout']) for (const arm of definition.arms) {
  const selected = records.filter((record) => record.phase === phase && record.arm === arm);
  const ids = new Set(selected.flatMap((record) => record.modelCalls));
  const usage = calls.filter((call) => ids.has(call.id));
  groups.push({ phase, arm, planned: 18, attempted: selected.length, passed: selected.filter((record) => record.trace.verdict.passed).length,
    modelRequests: usage.length, medianModelRequests: median(selected.map((record) => record.modelCalls.length)),
    medianElapsedMs: median(selected.map((record) => record.elapsedMs)),
    toolErrors: selected.reduce((sum, record) => sum + record.toolEvents.filter((event) => event.response.error).length, 0),
    watchCalls: selected.reduce((sum, record) => sum + record.toolEvents.filter((event) => event.name === 'watch').length, 0),
    toolCalls: selected.reduce((sum, record) => sum + record.toolEvents.length, 0),
    scans: selected.reduce((sum, record) => sum + record.trace.metrics.scans, 0),
    probes: selected.reduce((sum, record) => sum + record.trace.metrics.probes, 0),
    notifications: selected.reduce((sum, record) => sum + record.trace.metrics.notifications, 0),
    submitted: selected.filter((record) => record.trace.submitted).length,
    infrastructureFailures: selected.filter((record) => record.error || record.stopReason === 'provider_empty_response').length,
    knownPromptTokens: sumUsage(usage, 'prompt_tokens'), knownCompletionTokens: sumUsage(usage, 'completion_tokens'),
    cachedTokens: usage.reduce((sum, call) => sum + (call.usage?.prompt_tokens_details?.cached_tokens ?? 0), 0),
    accountedUsd: usage.reduce((sum, call) => sum + (call.accountedUsd ?? call.reservedUsd), 0),
    providerReportedKnownUsd: usage.reduce((sum, call) => sum + (call.providerReportedUsd ?? 0), 0), unknownUsageRequests: usage.filter((call) => !call.usage).length });
}
const formal = records.filter((record) => record.phase !== 'pilot');
const pilot = records.filter((record) => record.phase === 'pilot');
assert.ok(partial || formal.length === definition.planned, 'Incomplete matrix requires --partial');
const result = { experiment, status: formal.length === definition.planned && unreviewed.length === 0 ? 'COMPLETE' : 'PARTIAL',
  throughRequest: ledger.calls.at(-1)?.id, sourceSnapshotsVerified: true, requestAssignmentVerified: true,
  plannedFormal: definition.planned, attemptedFormal: formal.length, passedFormal: formal.filter((record) => record.trace.verdict.passed).length,
  submittedFormal: formal.filter((record) => record.trace.submitted).length,
  infrastructureFailuresFormal: formal.filter((record) => record.error || record.stopReason === 'provider_empty_response').length,
  notAttemptedFormal: definition.planned - formal.length, notAttempted,
  budgetHold: unreviewed.length > 0,
  unreviewedRequests: unreviewed.map((call) => ({ id: call.id, state: call.state, reservedUsd: call.reservedUsd, error: call.error })),
  pilot: { attempted: pilot.length, passed: pilot.filter((record) => record.trace.verdict.passed).length }, groups,
  failures: records.filter((record) => !record.trace.verdict.passed).map((record) => ({ phase: record.phase, taskId: record.taskId, arm: record.arm,
    repetition: record.repetition, stopReason: record.stopReason, verdict: record.trace.verdict,
    accountingReviews: calls.filter((call) => record.modelCalls.includes(call.id) && call.failureClass).map((call) => ({ id: call.id, failureClass: call.failureClass, accountedUsd: call.accountedUsd })) })),
  modelRequests: calls.length, experimentAccountedUsd: calls.reduce((sum, call) => sum + (call.accountedUsd ?? call.reservedUsd), 0),
  unknownUsageRequests: calls.filter((call) => !call.usage).map((call) => call.id),
  cumulativeAccountedUsd: accounted(ledger), cumulativeRequests: ledger.calls.length, allCleaned: records.every((record) => record.trace.cleaned) };
result.analysisSourceHashes = snapshotSources(directory, path.join(root, 'analysis'), ['research-report.mjs', 'research-budget.mjs', 'observation.mjs']);
writeJson(path.join(root, 'summary.json'), result);
writeJson(path.join(root, 'analysis', `summary-through-${result.throughRequest}.json`), result);
const rows = groups.map((group) => `| ${group.phase} | ${group.arm} | ${group.passed}/${group.attempted}（计划${group.planned}） | ${group.medianModelRequests ?? '—'} | ${group.toolErrors} | ${group.knownPromptTokens}${group.unknownUsageRequests ? '+' : ''} | ${group.knownCompletionTokens}${group.unknownUsageRequests ? '+' : ''} | ${group.accountedUsd.toFixed(6)} |`).join('\n');
const failures = result.failures.length ? result.failures.map((entry) => `- ${entry.phase}/${entry.taskId}/${entry.arm}/${entry.repetition}：${entry.stopReason}；${JSON.stringify(entry.verdict.checks ?? entry.verdict.reason)}`).join('\n') : '已尝试的运行没有失败。';
const holds = result.budgetHold ? `**当前有费用门禁：请求 ${unreviewed.map((call) => call.id).join(', ')} 仍未审计，用量未知，完整预留继续计入。本报告不解除停止条件。**\n\n` : '';
const reviews = calls.filter((call) => call.failureClass === 'reviewed_request_timeout').map((call) =>
  `请求 ${call.id} 的[逐笔审计](results/model-20261103/reviews/request-${call.id}.json)保留完整预留与失败；恢复规则及源码变化见 [timeout-review.md](results/${definition.folder}/timeout-review.md)，该失败 episode 没有重试。`).join('\n\n');
const coverageNote = result.notAttemptedFormal === 0
  ? `正式矩阵已按计划补齐（${result.attemptedFormal}/${definition.planned}）；仍有 ${result.infrastructureFailuresFormal} 个基础设施失败，组间比较需结合失败与成本边界。`
  : '各组缺项不均衡；未完成保留集不能支持组间总体排名。';
const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const report = `# ${definition.title}\n\n${reportDate}，${experiment}，**${result.status}**（截至请求 ${result.throughRequest}）。正式矩阵计划 ${definition.planned} 次，已尝试 ${result.attemptedFormal}，提交并通过 ${result.passedFormal}，基础设施失败 ${result.infrastructureFailuresFormal}，未尝试 ${result.notAttemptedFormal}；pilot 单列 ${result.pilot.passed}/${result.pilot.attempted}。\n\n${holds}` +
  `| 集合 | 接口 | 通过/尝试 | 模型请求中位数 | 工具错误 | 已知输入 Token | 已知输出 Token | 保守美元 |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
  `## 失败与边界\n\n${failures}\n\n${reviews}\n\n同一 ClinePass 配置模型、受控真实子进程与合成任务；保留集不是外部盲测。模型必须自行建立观察条件。工具数量及说明不同、缓存不可控、短等待可能在下一次模型响应前结束，不能把某组结果概括为任意 OS 场景优势。${coverageNote}\n\n` +
  `本实验含 pilot 共 ${calls.length} 次请求，保守计入 $${result.experimentAccountedUsd.toFixed(7)}；所有阶段累计 $${result.cumulativeAccountedUsd.toFixed(7)} / $5。费用含失败预留，不是现金账单；usage 缺失单列，已知 Token 带 + 表示下界。各组缓存量、服务 cost、耗时和具体失败保存在 [summary.json](results/${definition.folder}/summary.json)。\n\n` +
  `源码快照、请求归属和独立清理记录均已核对；原始证据在 results/${definition.folder}/。已知输入/输出、缓存、底层扫描、探针、通知与模型调用分别统计。未尝试的矩阵部分不计为通过。\n`;
fs.writeFileSync(path.join(directory, definition.report), report);
console.log(JSON.stringify(result, null, 2));
