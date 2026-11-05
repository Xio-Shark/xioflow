import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TaskEpisode } from './task-episode.mjs';
import { taskDefinitions } from './task-cases.mjs';
import { solveReference } from './task-reference.mjs';
import { digest, wireBytes } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(directory, 'results/budget-ablation-v2.json');
if (fs.existsSync(destination)) throw new Error('Refuse to overwrite budget ablation');
const sources = ['budget-ablation.mjs', 'task-episode.mjs', 'task-host.mjs', 'task-cases.mjs', 'task-reference.mjs', 'task-grader.mjs', 'observation.mjs', 'ABLATION-PROTOCOL.md'];
const result = { protocol: 'ablation-v1/result-budget-v2', modelRequests: 0, evidenceClass: 'deterministic-reference-budget-policy',
  sourceHashes: Object.fromEntries(sources.map((file) => [file, digest(fs.readFileSync(path.join(directory, file)))])), runs: [] };
for (const spec of taskDefinitions()) for (const arm of ['full', 'jq', 'structured']) for (const policy of ['fixed', 'expand']) {
  const episode = new TaskEpisode(spec.id, arm);
  let limit = 2048;
  const decisions = [];
  // This is a documented caller policy, not a host that silently clips results.
  const caller = { handle(request) {
    const isData = ['full', 'jq', 'query', 'readText'].includes(request.op);
    if (!isData) return episode.handle(request);
    const invoke = () => {
      const actual = { ...request, args: { ...request.args, maxBytes: limit } };
      const response = episode.handle(actual);
      decisions.push({ op: request.op, limit, status: response.status, error: response.error?.code ?? null });
      if (response.status === 'ok') assert.ok(wireBytes(response.result) <= limit);
      return response;
    };
    let response = invoke();
    if (policy === 'expand' && limit < 65536 && response.error?.code === 'budget_too_small') { limit = 65536; response = invoke(); }
    if (policy === 'expand' && response.status === 'ok' && response.result.nextCursor) limit = 65536;
    return response;
  } };
  let stopped = null;
  try {
    const answer = solveReference(caller, spec, arm);
    episode.handle({ op: 'submit', args: answer });
  } catch (error) {
    if (!error.message.includes('budget_too_small')) throw error;
    stopped = 'reference_result_exceeds_fixed_cap';
  } finally { episode.close(); }
  const trace = episode.trace;
  assert.equal(trace.cleaned, true);
  if (policy === 'expand' || arm === 'structured') assert.equal(trace.verdict.passed, true, `${spec.id}/${arm}/${policy}`);
  result.runs.push({ taskId: spec.id, arm, policy, stopped, decisions, trace });
}
result.summary = ['fixed', 'expand'].flatMap((policy) => ['full', 'jq', 'structured'].map((arm) => {
  const group = result.runs.filter((run) => run.policy === policy && run.arm === arm);
  return { policy, arm, runs: group.length, passed: group.filter((run) => run.trace.verdict.passed).length,
    referenceBudgetStops: group.filter((run) => run.stopped).length,
    calls: group.reduce((sum, run) => sum + run.trace.metrics.calls, 0),
    transportBytes: group.reduce((sum, run) => sum + run.trace.metrics.transportBytes, 0) };
}));
fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'PASS', modelRequests: 0, runs: result.runs.length, summary: result.summary }, null, 2));
