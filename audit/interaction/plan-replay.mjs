import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ProcessEpisode } from './process-episode.mjs';
import { digest } from './observation.mjs';
import { snapshotSources } from './research-budget.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, 'results/process-model-v1');
const destination = path.join(directory, 'results/plan-replay-v2.json');
if (fs.existsSync(destination)) throw new Error('Refuse to overwrite model-plan replay');
const result = { protocol: 'ablation-v1/model-plan-replay', replayImplementation: 'v2',
  supersedes: 'plan-replay-v1.json: until.instanceId was not rebound; that failure is a replay defect, not model evidence', newModelRequests: 0,
  hypothesis: 'first model wake condition can serve as terminal condition', runs: [],
  sourceHashes: snapshotSources(directory, path.join(directory, 'results/plan-replay-v2'),
    ['plan-replay.mjs', 'process-service.mjs', 'process-episode.mjs', 'process-fixture.mjs', 'process-host.mjs', 'process-grader.mjs', 'observation.mjs', 'research-budget.mjs', 'ABLATION-PROTOCOL.md']) };
for (const phase of ['dev', 'heldout']) for (let index = 1; index <= 6; index += 1) for (const arm of ['server-poll', 'event-view']) {
  const taskId = `${phase}-${String(index).padStart(2, '0')}`;
  const originFile = `${phase}-${taskId}-${arm}-0.json`;
  if (!fs.existsSync(path.join(root, originFile))) {
    result.runs.push({ taskId, arm, originFile, available: false, applicable: false, reason: 'source_episode_not_attempted' });
    continue;
  }
  const original = JSON.parse(fs.readFileSync(path.join(root, originFile)));
  for (const [name, sha] of Object.entries(original.sourceHashes)) assert.equal(digest(fs.readFileSync(path.join(root, 'source-snapshots', `${sha}.source`))), sha, name);
  const originSha256 = digest(fs.readFileSync(path.join(root, originFile)));
  const watch = original.trace.events.find((event) => event.op === 'watch' && !event.response.error);
  if (!watch) { result.runs.push({ taskId, arm, originFile, originSha256, available: true, applicable: false, reason: 'no_model_watch_plan' }); continue; }
  const plan = { where: { ...(watch.args.where ?? {}) }, until: { ...(watch.args.until ?? {}) } };
  const originalPlan = structuredClone(plan);
  const episode = await ProcessEpisode.create(taskId, arm, { intervalMs: 50, dropHints: index === 6 });
  let stopReason = 'step_limit';
  try {
    let current = await episode.handle('inspect');
    for (const predicate of [plan.where, plan.until]) {
      if (!predicate.instanceId) continue;
      const old = original.trace.events.flatMap((event) => event.response.rows ?? []).find((row) => row.instanceId === predicate.instanceId);
      const candidates = old ? current.rows.filter((row) => row.name === old.name && row.environment === old.environment) : [];
      if (candidates.length !== 1) { stopReason = 'unbound_model_identity'; break; }
      predicate.instanceId = candidates[0].instanceId;
    }
    for (let step = 0; step < 12 && stopReason !== 'unbound_model_identity'; step += 1) {
      current = await episode.handle('watch', { ...plan, after: current.evidenceId, maxWaitMs: 500 });
      if (current.error) { stopReason = current.error.code; break; }
      if (current.rows.length === 0 && plan.where.instanceId && plan.where.name && plan.where.environment) {
        const logical = { ...plan.where }; delete logical.instanceId;
        current = await episode.handle('inspect', { where: logical, delayMs: 50 });
        if (current.rows.length === 1) {
          if (plan.until.instanceId === plan.where.instanceId) plan.until.instanceId = current.rows[0].instanceId;
          plan.where.instanceId = current.rows[0].instanceId;
        }
        continue;
      }
      if (['condition_met', 'exited'].includes(current.reason) && current.rows.length === 1) {
        const row = current.rows[0];
        await episode.handle('submit', { outcome: row.alive ? 'ready' : 'exited', instanceId: row.instanceId, evidenceId: current.evidenceId });
        stopReason = 'submitted'; break;
      }
    }
  } finally { await episode.close(); }
  result.runs.push({ taskId, arm, originFile, originSha256, available: true,
    applicable: true, plan: originalPlan, originalModelRequests: original.modelCalls.length, stopReason, trace: episode.trace });
}
const applicable = result.runs.filter((run) => run.applicable);
assert.equal(result.runs.length, 24);
result.summary = { planned: 24, applicable: applicable.length, passed: applicable.filter((run) => run.trace.verdict.passed).length,
  notApplicable: result.runs.filter((run) => run.available && !run.applicable).length,
  sourceNotAttempted: result.runs.filter((run) => !run.available).length,
  allCleaned: applicable.every((run) => run.trace.cleaned), newModelRequests: 0 };
assert.equal(result.summary.allCleaned, true);
fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: result.summary.passed === result.summary.planned ? 'PASS' : 'PASS WITH CONCERNS', ...result.summary,
  failures: applicable.filter((run) => !run.trace.verdict.passed).map((run) => ({ taskId: run.taskId, arm: run.arm, stopReason: run.stopReason })) }, null, 2));
