import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ObservedView } from './view-watch.mjs';
import { createWatchFixture, serviceView } from './watch-fixture.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const modes = ['agent-poll', 'server-poll', 'watch-view'];
const definitions = [
  { name: 'idle', phases: 6, phaseMs: 80 },
  { name: 'irrelevant-writes', phases: 6, phaseMs: 80 },
  { name: 'relevant-writes', phases: 6, phaseMs: 80 },
  { name: 'replacement-burst', phases: 3, phaseMs: 80 },
  { name: 'dropped-hints', phases: 3, phaseMs: 80 },
  { name: 'noise-slow-poll', phases: 10, phaseMs: 60, pollMs: 100, reconcileMs: 500 },
];
const trials = [];

async function run(definition, trial) {
  const fixture = createWatchFixture();
  const observers = new Map();
  const parameters = { pollMs: definition.pollMs ?? 20, reconcileMs: definition.reconcileMs ?? 120, coalesceMs: 5, phaseMs: definition.phaseMs };
  const order = [...modes.slice(trial), ...modes.slice(0, trial)];
  const checkpoints = [];
  const begin = performance.now();
  try {
    for (const mode of order) observers.set(mode, new ObservedView(fixture.file, serviceView, {
      mode, ...parameters, acceptHint: () => definition.name !== 'dropped-hints',
    }));
    for (let phase = 0; phase < definition.phases; phase += 1) {
      const phaseStart = performance.now();
      if (definition.name === 'irrelevant-writes' || definition.name === 'noise-slow-poll') {
        fixture.records[20].notes = `unrelated update ${phase}`;
        fixture.replace();
      } else if (definition.name === 'relevant-writes' || definition.name === 'dropped-hints') {
        fixture.records[0].enabled = phase % 2 === 0;
        fixture.replace();
      } else if (definition.name === 'replacement-burst') {
        for (let write = 0; write < 16; write += 1) {
          fixture.records[20].notes = `burst ${phase}/${write}`;
          fixture.records[0].enabled = write === 15 ? phase % 2 === 0 : false;
          fixture.replace();
        }
      }
      await delay(definition.phaseMs);
      const expected = serviceView(JSON.parse(fs.readFileSync(fixture.file, 'utf8')));
      const matches = () => [...observers.values()].every((observer) => observer.latest.status === 'ok' &&
        JSON.stringify(observer.latest.view) === JSON.stringify(expected));
      const deadline = performance.now() + 1000;
      while (!matches() && performance.now() < deadline) await delay(10);
      assert.ok(matches(), `${definition.name} did not converge to the independently read current view`);
      checkpoints.push({ phase, expected, elapsedMs: Number((performance.now() - phaseStart).toFixed(3)), allViewsMatch: true });
    }
    if (definition.name === 'dropped-hints') {
      const watched = observers.get('watch-view');
      assert.ok(watched.metrics.suppressedHints > 0, 'Fault injection did not drop an actual OS hint');
      assert.ok(watched.messages.slice(1).every((message) => message.cause === 'reconcile'));
    }
    const expectedMessages = ['idle', 'irrelevant-writes', 'noise-slow-poll'].includes(definition.name) ? 1 : definition.phases + 1;
    for (const mode of ['server-poll', 'watch-view']) assert.equal(observers.get(mode).messages.length, expectedMessages);
    for (const observer of observers.values()) {
      assert.equal(observer.metrics.watchErrors, 0);
      observer.close();
    }
    const stopped = [...observers.values()].map((observer) => observer.metrics);
    await delay(25);
    assert.deepEqual([...observers.values()].map((observer) => observer.metrics), stopped, 'Reads continued after close');
    return { workload: definition.name, trial, parameters, elapsedMs: Number((performance.now() - begin).toFixed(3)),
      checkpoints, observers: Object.fromEntries([...observers].map(([mode, observer]) => [mode, {
        metrics: observer.metrics, latest: observer.latest, messages: observer.messages,
      }])) };
  } finally {
    for (const observer of observers.values()) observer.close();
    fixture.cleanup();
  }
}

for (const definition of definitions) {
  for (let trial = 0; trial < 3; trial += 1) trials.push(await run(definition, trial));
  console.log(JSON.stringify({ workload: definition.name, trials: 3, status: 'PASS' }));
}
const range = (values) => [Math.min(...values), Math.max(...values)];
const summaries = definitions.flatMap((definition) => modes.map((mode) => {
  const metrics = trials.filter((trial) => trial.workload === definition.name).map((trial) => trial.observers[mode].metrics);
  return { workload: definition.name, mode, readAttempts: range(metrics.map((metric) => metric.readAttempts)),
    notifications: range(metrics.map((metric) => metric.notifications)), notificationBytes: range(metrics.map((metric) => metric.notificationBytes)),
    successfulSourceBytes: range(metrics.map((metric) => metric.successfulSourceBytes)),
    osHints: range(metrics.map((metric) => metric.osHints)), reconciliations: range(metrics.map((metric) => metric.reconciliations)),
    closed: metrics.every((metric) => metric.closed) };
}));
const sources = ['observation.mjs', 'fixtures.mjs', 'view-watch.mjs', 'watch-fixture.mjs', 'watch-benchmark.mjs'];
const result = { protocol: 'RFC-SI-002/watch-v1', date: '2026-11-03', recordedAt: new Date().toISOString(),
  evidenceClass: 'real-local-filesystem-events-scripted-interest-no-model',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])),
  limitations: [
    'Notifications are not actual model calls or tokens.',
    'Current-state checkpoints do not establish a complete event history.',
    'Projection is caller-supplied, not chosen by an LLM.',
    'Observed ranges depend on local OS event delivery and timer scheduling.',
    'Polling and reconciliation intervals differ; no matched detection-latency or freshness bound was tested.',
    'Periodic reconciliation catches dropped hints; the OS is not claimed lossless.',
    'Each view is recomputed, not maintained by a differential dataflow engine.',
  ], summaries, trials };
fs.mkdirSync(path.join(directory, 'results'), { recursive: true });
fs.writeFileSync(path.join(directory, 'results/watch.json'), `${JSON.stringify(result, null, 2)}\n`);
const format = ([low, high]) => low === high ? String(low) : `${low}–${high}`;
const rows = summaries.map((row) => `| ${row.workload} | ${row.mode} | ${format(row.readAttempts)} | ${format(row.notifications)} | ${format(row.notificationBytes)} |`).join('\n');
const report = `# 关注状态订阅实验结果\n\n2026-11-03。18 个场景运行，每个同时比较三组，共 54 个观察器运行。每个场景重复三次并轮换初始化顺序。\n\n` +
  `假设与对照在 [WATCH-PROTOCOL.md](WATCH-PROTOCOL.md) 中预先记录。以下为三个重复的观测范围，包含初始读取与初始通知。\n\n` +
  `| 场景 | 模式 | 真实读取次数 | 调用方通知数 | 通知字节 |\n| --- | --- | ---: | ---: | ---: |\n${rows}\n\n` +
  `## 结果判读\n\n系统侧去重轮询与事件订阅都能避免把未变化的查询结果反复发给调用方。因此不能将消息减少全部归因于 OS 事件。事件订阅的独立作用是改变何时扫描，收益随更新频率、轮询间隔和重同步周期变化。noise-slow-poll 特意采用低频轮询与高频无关变化，检验事件方案增加扫描的可能。\n\n` +
  `本轮轮询与定期核对的间隔不同，没有在相同发现延迟或新鲜度要求下比较成本，也没有测量逐次变化的发现延迟。较少读取不能直接解释为同等服务质量下更高效；下一轮需要联合报告延迟、遗漏与开销。\n\n` +
  `所有阶段末的投影视图与独立文件读取相符。人为丢弃提示时通过定期核对恢复。数据无效、恢复、原子替换与关闭行为另由测试覆盖。每个观察器已关闭，关闭后检查没有新增读取或消息；所有临时文件已清理。\n\n` +
  `这些是本机文件系统上的确定性兴趣声明实验，没有模型决策收益证据。订阅维护当前状态，不保证看到每个短暂中间状态；这里每次重算视图，也不是 Differential Dataflow 的实现。原始轨迹、参数、环境和源码哈希在 [watch.json](results/watch.json)。\n\n` +
  `## 复现\n\n\`node --test audit/interaction/view-watch.test.mjs\`\n\n\`node audit/interaction/watch-benchmark.mjs\`\n`;
fs.writeFileSync(path.join(directory, 'WATCH-REPORT.md'), report);
console.log(JSON.stringify({ status: 'PASS', scenarios: trials.length, observerRuns: trials.length * modes.length,
  checkpoints: trials.reduce((sum, trial) => sum + trial.checkpoints.length, 0), allClosed: summaries.every((row) => row.closed), summaries }, null, 2));
