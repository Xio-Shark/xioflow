import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { taskDefinitions } from './task-cases.mjs';
import { ARMS } from './task-host.mjs';
import { TaskEpisode } from './task-episode.mjs';
import { solveReference } from './task-reference.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const jq = spawnSync('jq', ['--version'], { encoding: 'utf8', timeout: 2000 });
assert.equal(jq.status, 0, jq.error?.message ?? jq.stderr);
const registry = path.resolve(directory, '../../spec/isa-v1/registry.json');
const registryBefore = fs.readFileSync(registry);
const dev = taskDefinitions('dev');
const positives = [];
const negatives = [];

function run(spec, arm, trial, fault) {
  const episode = new TaskEpisode(spec.id, arm);
  try {
    const submission = solveReference(episode, spec, arm, { refresh: fault?.name !== 'stale-source' });
    fault?.change?.(submission.answer);
    const verdict = episode.handle({ op: 'submit', args: submission }).result;
    assert.equal(verdict.passed, !fault, `${spec.id}/${arm}/${fault?.name ?? 'reference'}`);
  } finally { episode.close(); }
  const trace = episode.trace;
  assert.equal(trace.cleaned, true);
  assert.equal(trace.metrics.errors, 0);
  return { trial, client: fault?.name ?? 'known-correct-reference', ...trace };
}

for (const spec of dev) {
  for (let trial = 0; trial < 3; trial += 1) {
    const order = [...ARMS.slice(trial), ...ARMS.slice(0, trial)];
    for (const arm of order) positives.push(run(spec, arm, trial));
  }
}
const faults = [
  { name: 'wrong-object', id: 'dev-01', change: (answer) => { answer.id = 'unrelated-instance'; } },
  { name: 'omitted-member', id: 'dev-02', change: (answer) => { answer.ids.pop(); answer.count -= 1; } },
  { name: 'duplicate-member', id: 'dev-02', change: (answer) => { answer.ids.push(answer.ids[0]); } },
  { name: 'null-collapse', id: 'dev-05', change: (answer) => { answer.null.push(...answer.missing); answer.missing = []; } },
  { name: 'earlier-failure', id: 'dev-04', change: (answer) => { answer.code = 'E_DNS'; answer.message = '早期域名解析失败，稍后已恢复'; } },
  { name: 'stale-source', id: 'dev-06' },
];
for (const fault of faults) for (const arm of ARMS) negatives.push(run(dev.find((spec) => spec.id === fault.id), arm, 0, fault));
assert.deepEqual(fs.readFileSync(registry), registryBefore);

const range = (values) => [Math.min(...values), Math.max(...values)];
const summaries = dev.map((spec) => ({ taskId: spec.id, kind: spec.kind,
  arms: Object.fromEntries(ARMS.map((arm) => {
    const runs = positives.filter((trial) => trial.taskId === spec.id && trial.arm === arm);
    return [arm, { accepted: runs.filter((trial) => trial.verdict.passed).length,
      calls: range(runs.map((trial) => trial.metrics.calls)),
      serializedMessageBytes: range(runs.map((trial) => trial.metrics.transportBytes)) }];
  })) }));
const sources = ['observation.mjs', 'task-cases.mjs', 'task-host.mjs', 'task-episode.mjs', 'task-session.mjs',
  'task-grader.mjs', 'task-reference.mjs', 'task-benchmark.mjs', 'TASK-PROTOCOL.md'];
const artifact = { protocol: 'RFC-SI-003/task-v1', date: '2026-11-03', recordedAt: new Date().toISOString(),
  evidenceClass: 'scripted-clients-natural-language-task-harness-no-model',
  environment: { node: process.version, platform: process.platform, arch: process.arch, jq: jq.stdout.trim() },
  sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])),
  registrySha256: digest(registryBefore), registryUnchanged: true,
  taskCounts: { dev: 6, heldout: 6 }, modelRuns: 0,
  limitations: ['Reference clients know task semantics; these are reachability checks, not agent scores.',
    'Model holdouts have not been run; construction and infrastructure tests can inspect them.',
    'All non-registry data is synthetic and does not describe running services.',
    'Result budgets are adjustable; reference policies differ and are not optimal.',
    'Message bytes are serialized JSON envelopes, not tokens or billed network bytes.',
    'Source changes occur after the first successful data response, not on a real-time schedule.',
    'The host is readonly research tooling, not a security boundary for malicious jq programs.'],
  summaries, positives, negatives };
fs.mkdirSync(path.join(directory, 'results'), { recursive: true });
fs.writeFileSync(path.join(directory, 'results/tasks.json'), `${JSON.stringify(artifact, null, 2)}\n`);
const format = ([low, high]) => low === high ? String(low) : `${low}–${high}`;
const rows = summaries.map((summary) => `| ${summary.taskId} / ${summary.kind} | ${ARMS.map((arm) => `${format(summary.arms[arm].calls)} / ${format(summary.arms[arm].serializedMessageBytes)}`).join(' | ')} |`).join('\n');
const report = `# 自然语言任务环境验证\n\n2026-11-03。语料含 6 个开发任务、6 个模型保留任务；本报告只对开发任务运行已知语义的参考客户端。\n\n` +
  `54 次正确客户端运行全部被接受；18 次故意错误运行全部被拒绝。每个开发任务在三组接口各重复三次并轮换顺序。没有调用模型，不能把这些结果写成模型任务成功率。\n\n` +
  `## 参考策略的交互记录\n\n单元格为完整请求次数 / 序列化消息字节。字节包含初始任务和工具说明、请求、响应与终局提交，不是 Token。full/jq 使用 65,536 B 结果预算，structured 使用 2,048 B 并继续分页；以下不是固定预算条件下的接口排名。\n\n` +
  `| 开发任务 | full | jq | structured |\n| --- | ---: | ---: | ---: |\n${rows}\n\n` +
  `## 检查器拒绝了什么\n\n错误对象、遗漏成员、重复成员、混淆缺失与 null、选择较早的错误日志，以及更新后提交旧版本。这六类错误分别在三组接口运行。完整断言与轨迹在 [tasks.json](results/tasks.json)。\n\n` +
  `## 已验证与未验证\n\n真实 jq 参与执行，ISA 注册表来自真实仓库的只读副本，原文件哈希未变。其他服务与日志是合成临时文件。所有任务结束后已清理临时目录。结果检查器独立解析源文件，不调用观察适配器、jq 或参考客户端。\n\n` +
  `本报告的保留任务仅通过基础设施测试验证可达性，不包含模型评分。后续真实模型成绩单独记录在 [MODEL-REPORT.md](MODEL-REPORT.md)，不要与这些参考脚本结果混合。版本检查只针对受控更新，不代表任意并发写入下的原子提交。\n\n` +
  `## 运行\n\n\`node --test audit/interaction/task-suite.test.mjs\`\n\n\`node audit/interaction/task-benchmark.mjs\`\n\n\`node audit/interaction/task-session.mjs dev-01 structured\`\n\n` +
  `宿主首先输出目标、回答格式与工具说明，随后接受 JSONL 请求。终局提交后退出；无提交退出为失败。可用 \`--trace NEW_FILE\` 保存轨迹，已有文件不会覆盖。协议见 [TASK-PROTOCOL.md](TASK-PROTOCOL.md)。\n`;
fs.writeFileSync(path.join(directory, 'TASK-REPORT.md'), report);
console.log(JSON.stringify({ status: 'PASS', positiveAccepted: positives.length, negativeRejected: negatives.length,
  modelRuns: 0, allCleaned: [...positives, ...negatives].every((trial) => trial.cleaned), registryUnchanged: true, summaries }, null, 2));
