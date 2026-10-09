import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ExecutionDomain } from '../domain.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import { estimateWorkspaceCausalRefreshHistory } from '../workspace/causal-refresh-history.js';
import { refreshWorkspaceCausalBranchesWithPolicy, type CausalRefreshForecast } from '../workspace/causal-refresh-policy.js';
import { listWorkspaceCausalRefreshTelemetry } from '../workspace/causal-refresh-telemetry.js';
import type { ObservationEntry } from '../workspace/transactions.js';

export interface CausalDriftBenchmarkOptions {
  repetitions?: number;
  hashRounds?: number;
  oldChanges?: boolean[];
  recentChanges?: boolean[];
  evaluationChanges?: boolean[];
}

/** Predeclared drift schedules, independently trained repetitions, and paired fresh workspaces. */
export async function runCausalDriftBenchmark(options: CausalDriftBenchmarkOptions = {}) {
  const config = { repetitions: options.repetitions ?? 3, hashRounds: options.hashRounds ?? 1000,
    oldChanges: [...(options.oldChanges ?? [false, false, false, true])],
    recentChanges: [...(options.recentChanges ?? [false, true, true, true])],
    evaluationChanges: [...(options.evaluationChanges ?? [true, true, true, false])] };
  for (const n of [config.repetitions, config.hashRounds]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Counts must be positive safe integers');
  }
  for (const schedule of [config.oldChanges, config.recentChanges, config.evaluationChanges]) {
    if (!schedule.length || schedule.some(value => typeof value !== 'boolean')) throw new Error('Invalid change schedule');
  }
  if (![config.oldChanges, config.recentChanges].every(s => s.includes(true) && s.includes(false))) {
    throw new Error('Each training era requires changed and unchanged probes');
  }
  const exec = promisify(execFile);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const derive = (value: string) => {
    for (let i = 0; i < config.hashRounds; i++) value = hash(value);
    return value;
  };
  const repetitions = [];
  for (let repetition = 0; repetition < config.repetitions; repetition++) {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-drift-')));
    const domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'drift-benchmark');
    try {
      const store = domain.getStore();
      const supervisor = new ProcessSupervisor(domain);
      const graph = new WorkspaceCausalGraph(domain);
      let serial = 0;
      const run = async (changed: boolean, forecast: CausalRefreshForecast, taskKey: string,
        costs = { execute: 1, reuse: 1, replay: 1 }) => {
        const id = `sample-${serial++}`;
        const root = path.join(temp, id);
        fs.mkdirSync(root);
        await exec('git', ['init', '-q', '-b', 'main', root]);
        fs.writeFileSync(path.join(root, 'input'), 'initial');
        await exec('git', ['add', '.'], { cwd: root });
        await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
        const now = new Date().toISOString();
        store.saveTask({ id, domainId: domain.domainId, name: 'drift', createdAt: now });
        store.saveRun({ id, taskId: id, domainId: domain.domainId, owner: 'drift-benchmark', status: 'running', startedAt: now });
        const perform = async (entry: ObservationEntry, dir: string) => {
          const value = fs.readFileSync(path.join(dir, 'input'), 'utf8');
          if (entry.call.tool === 'read') return hash(value);
          if (entry.call.tool !== 'derive') throw new Error('Unknown fixture tool');
          const output = derive(value);
          fs.writeFileSync(path.join(dir, 'output'), output);
          return hash(output);
        };
        const initial = await supervisor.beginWorkspaceTransaction({ runId: id, txId: `${id}-initial`, root,
          forkPath: path.join(temp, `${id}-initial`) });
        let heads: number[] = [];
        for (const tool of ['read', 'derive']) {
          const observation: ObservationEntry = { kind: tool === 'read' ? 'observe' : 'mutate', call: { tool, args: {} } };
          observation.resultHash = await perform(observation, initial.forkRoot);
          heads = [graph.record({ txId: initial.txId, actorId: 'agent', dependsOn: heads, observation: { ...observation, resultHash: observation.resultHash! },
            writes: tool === 'derive' ? [{ status: 'A', path: 'output' }] : [] }).seq];
        }
        if ((await supervisor.commitWorkspaceTransaction(initial.txId)).status !== 'committed') throw new Error('Fixture commit failed');
        await supervisor.pruneSnapshots([initial.baseSnapshotId], { runId: id });
        if (changed) fs.writeFileSync(path.join(root, 'input'), 'changed');
        const result = await refreshWorkspaceCausalBranchesWithPolicy(supervisor, {
          runId: id, txId: `${id}-probe`, root, forkPath: path.join(temp, `${id}-probe`),
          branches: [{ id: 'agent', heads }], atSeq: heads[0], taskKey, forecast, costModel: () => costs,
          closedWorld: true, replayPolicy: 'deterministic', replay: perform,
          repair: { txId: `${id}-repair`, forkPath: path.join(temp, `${id}-repair`),
            validateReuse: async (tx, nodes) => {
              for (const node of nodes) {
                if (await perform(node.observation, tx.forkRoot) !== node.observation.resultHash) throw new Error('Invalid reuse');
              }
            },
            execute: async (node, tx) => ({ actorId: node.actorId,
              observation: { ...node.observation, resultHash: await perform(node.observation, tx.forkRoot) },
              writes: node.writes?.map(write => ({ ...write, status: 'M' as const })) }),
          },
        });
        const telemetry = listWorkspaceCausalRefreshTelemetry(domain, { runId: id }).at(-1)!;
        const output = fs.readFileSync(path.join(root, 'output'), 'utf8');
        const status = result.result.status;
        const validation = status === 'committed' && result.result.commit.status === 'committed'
          ? result.result.commit.validation : null;
        return { strategy: result.strategy, status, validation, outputHash: hash(output),
          success: output === derive(changed ? 'changed' : 'initial') && (status === 'committed' || status === 'unchanged'),
          telemetry, callbackDurationMs: Object.values(telemetry.callbacks).reduce((sum, metric) => sum + metric.durationMs, 0),
          callbackCalls: Object.values(telemetry.callbacks).reduce((sum, metric) => sum + metric.calls, 0) };
      };
      // Zero-cost forecast forces independent probes; it is a control, not a learned estimate.
      const control = { changeProbability: 0, probeUnchanged: 0, probeChanged: 0, refreshChanged: 0 };
      const training: Awaited<ReturnType<typeof run>>[] = [];
      for (const changed of config.oldChanges) training.push(await run(changed, control, 'probe'));
      const trainingAfterSeq = store.getJournalEvents(domain.domainId).at(-1)!.seq;
      for (const changed of config.recentChanges) training.push(await run(changed, control, 'probe'));
      const trainingAtSeq = store.getJournalEvents(domain.domainId).at(-1)!.seq;
      const query = { taskKey: 'probe', trainingAtSeq };
      const history = estimateWorkspaceCausalRefreshHistory(domain, query);
      const recent = estimateWorkspaceCausalRefreshHistory(domain, { ...query, trainingAfterSeq });
      if (!history.forecast || !recent.forecast || training.some(s => !s.success)) throw new Error('Training failed');
      const meanCost = (phase: 'execute' | 'commitReplay') => {
        const calls = training.reduce((sum, s) => sum + s.telemetry.callbacks[phase].calls, 0);
        return training.reduce((sum, s) => sum + s.telemetry.callbacks[phase].durationMs, 0) / calls;
      };
      // Shared full-training calibration isolates forecast-window effects. No retained nodes in this fixture.
      const costs = { execute: meanCost('execute'), replay: meanCost('commitReplay'), reuse: 0 };
      const samples = [];
      for (const [trial, changed] of config.evaluationChanges.entries()) {
        const probe = await run(changed, control, 'probe', costs);
        const order = (trial + repetition) % 2 ? ['recent', 'history'] as const : ['history', 'recent'] as const;
        const paired = new Map<string, Awaited<ReturnType<typeof run>>>();
        for (const mode of order) paired.set(mode, await run(changed,
          mode === 'history' ? history.forecast : recent.forecast, `policy-${mode}`, costs));
        samples.push({ trial, changed, order, probe, history: paired.get('history')!, recent: paired.get('recent')! });
      }
      repetitions.push({ repetition, trainingAfterSeq, trainingAtSeq, costModel: costs,
        trainingCallbackCalls: training.reduce((sum, s) => sum + s.callbackCalls, 0),
        trainingDurationMs: training.reduce((sum, s) => sum + s.telemetry.durationMs, 0),
        history: estimateWorkspaceCausalRefreshHistory(domain, query),
        recent: estimateWorkspaceCausalRefreshHistory(domain, { ...query, trainingAfterSeq }), samples });
    } finally { domain.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const samples = repetitions.flatMap(r => r.samples);
  const deltas = samples.map(s => s.recent.callbackDurationMs - s.history.callbackDurationMs);
  const summary = (['history', 'recent'] as const).map(mode => ({ mode,
    successRate: samples.filter(s => s[mode].success).length / samples.length,
    meanCallbackDurationMs: samples.reduce((sum, s) => sum + s[mode].callbackDurationMs, 0) / samples.length,
    meanDurationMs: samples.reduce((sum, s) => sum + s[mode].telemetry.durationMs, 0) / samples.length,
    meanCallbackCalls: samples.reduce((sum, s) => sum + s[mode].callbackCalls, 0) / samples.length }));
  return { schemaVersion: 1, config, modelTokens: null,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, repetitions, summary,
    pairedCallbackDeltaMs: { samples: deltas.length, mean: deltas.reduce((a, b) => a + b, 0) / deltas.length,
      min: Math.min(...deltas), max: Math.max(...deltas) } };
}
