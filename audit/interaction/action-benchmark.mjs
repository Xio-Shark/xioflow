import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ActionEpisode, referenceAction, ACTION_ARMS } from './action-episode.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(directory, 'results/action-mechanism-v1.json');
if (fs.existsSync(destination)) throw new Error('Refuse to overwrite action benchmark');
const sources = ['action-command.mjs', 'action-coordinator.mjs', 'action-episode.mjs', 'action-benchmark.mjs',
  'process-service.mjs', 'process-fixture.mjs', 'process-host.mjs', 'process-episode.mjs', 'ACTION-PROTOCOL.md'];
const result = { protocol: 'action-v1/mechanism', modelRequests: 0,
  sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])), runs: [] };
for (const split of ['dev', 'heldout']) for (let index = 1; index <= 6; index += 1) for (const arm of ACTION_ARMS) {
  const episode = await ActionEpisode.create(`${split}-${String(index).padStart(2, '0')}`, arm);
  try { await referenceAction(episode); }
  finally { await episode.close(); }
  const trace = episode.trace;
  result.runs.push(trace);
  assert.equal(trace.verdict.passed, true);
  assert.equal(trace.activeCommands, 0);
  assert.equal(trace.cleaned, true);
}
result.passed = result.runs.filter((run) => run.verdict.passed).length;
result.allCleaned = result.runs.every((run) => run.cleaned);
fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(directory, 'ACTION-REPORT.md'), `# 真实配置操作环境验证\n\n2026-11-03，action-v1。24/24 个确定性任务通过，模型请求为 0；两组为真实受限 Node CLI 与对象动作，共用授权目标和版本保护。\n\n正常写入、版本冲突和实例替换最终 applied；退出、reload 拒绝及回执 accepted 但未生效最终 blocked。blocked 是正确识别未完成目标，不算业务变更成功。独立检查器通过配置文件和 HTTP 运行态核对，不能只信动作回执。\n\n存活目标恢复初始 setting 并验证，已退出目标记录无需恢复运行态；CLI、服务进程与目录全部清理。错误对象、重复旧版本、假成功和取消的专项验证见 action-suite.test.mjs。\n\n原始动作和检查证据见 [action-mechanism-v1.json](results/action-mechanism-v1.json)。这是单一实验协调器内的版本保护，不保证任意外部写者下的原子提交。\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'PASS', tasks: result.runs.length, passed: result.passed, allCleaned: result.allCleaned, modelRequests: 0 }));
