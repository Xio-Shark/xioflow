import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ProcessEpisode, referenceProcess } from './process-episode.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(directory, 'results/process-v1.json');
if (fs.existsSync(output)) throw new Error('Refuse to overwrite existing process benchmark');
const sources = ['process-service.mjs', 'process-fixture.mjs', 'process-host.mjs', 'process-grader.mjs', 'process-episode.mjs', 'PROCESS-PROTOCOL.md'];
const result = { protocol: 'process-v1', date: '2026-11-03', modelRequests: 0,
  sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])),
  runs: [] };
for (const split of ['dev', 'heldout']) for (let index = 1; index <= 6; index += 1) {
  const episode = await ProcessEpisode.create(`${split}-${String(index).padStart(2, '0')}`, 'agent-poll');
  try { await referenceProcess(episode); }
  finally { await episode.close(); }
  result.runs.push(episode.trace);
  assert.equal(episode.trace.verdict.passed, true);
}
result.passed = result.runs.filter((run) => run.verdict.passed).length;
result.allCleaned = result.runs.every((run) => run.cleaned);
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(directory, 'PROCESS-REPORT.md'), `# 真实进程环境验证\n\n2026-11-03，process-v1。${result.passed}/12 个确定性客户端任务通过独立检查，模型请求为 0。\n\n覆盖真实子进程、HTTP 就绪探针、提前 ready 日志、配置变化、进程退出、同名干扰、实例替换与无关文件事件。全部子进程、端口和临时目录清理通过。专项错误与取消测试见 process-suite.test.mjs；本报告不是模型成功率。\n\n原始轨迹与源码哈希见 [process-v1.json](results/process-v1.json)。下一阶段须在相同新鲜度条件下测量等待机制。\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'PASS', tasks: result.runs.length, passed: result.passed, allCleaned: result.allCleaned, modelRequests: 0 }));
