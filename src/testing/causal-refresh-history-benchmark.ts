import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { estimateWorkspaceCausalRefreshHistory } from '../workspace/causal-refresh-history.js';
import { planWorkspaceCausalRefreshPolicy, type CausalRefreshForecast } from '../workspace/causal-refresh-policy.js';
import { runSample } from './causal-refresh-benchmark.js';

export interface CausalRefreshHistoryBenchmarkOptions {
  hashRounds?: number;
  /** Predeclared schedules; each entry is the number of changed inputs (0..2). */
  trainingChanges?: number[];
  evaluationChanges?: number[];
  /** Fixed host prior in callback milliseconds, before observing any samples. */
  staticForecast?: CausalRefreshForecast;
}

/** Real journal training, frozen temporal holdout, and paired policy trials in fresh workspaces. */
export async function runCausalRefreshHistoryBenchmark(options: CausalRefreshHistoryBenchmarkOptions = {}) {
  const config = { hashRounds: options.hashRounds ?? 1000,
    trainingChanges: [...(options.trainingChanges ?? [0, 1, 0, 1])],
    evaluationChanges: [...(options.evaluationChanges ?? [0, 1, 2])],
    staticForecast: { ...(options.staticForecast ?? { changeProbability: 0.5,
      probeUnchanged: 1, probeChanged: 1, refreshChanged: 2 }) } };
  if (!Number.isSafeInteger(config.hashRounds) || config.hashRounds < 1) throw new Error('Invalid hashRounds');
  if (!config.trainingChanges.includes(0) || !config.trainingChanges.includes(1)
    || !config.evaluationChanges.length
    || [...config.trainingChanges, ...config.evaluationChanges].some(n => !Number.isInteger(n) || n < 0 || n > 2)) {
    throw new Error('Schedules require unchanged and partially changed training and changed input counts in 0..2');
  }
  planWorkspaceCausalRefreshPolicy([], config.staticForecast, () => ({ execute: 1, reuse: 1, replay: 1 }));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-history-bench-'));
  const domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'history-benchmark');
  try {
    const probeForecast = { changeProbability: 0, probeUnchanged: 0, probeChanged: 0, refreshChanged: 0 };
    let serial = 0;
    const run = (changedBranches: number, trial: number, forecast: CausalRefreshForecast,
      taskKey: string, costs: { execute: number; reuse: number; replay: number }) =>
      runSample('causal-refresh-policy', trial, { trials: 1, branches: 2, hashRounds: config.hashRounds,
        changedBranches, reusePasses: 1, estimatedReusePasses: 1, sharedInput: true,
        changeSharedInput: false, forecast },
      { domain, id: `sample-${serial++}`, taskKey, costModel: () => costs });
    const training: Awaited<ReturnType<typeof run>>[] = [];
    for (const [trial, changed] of config.trainingChanges.entries()) {
      training.push(await run(changed, trial, probeForecast, 'independent-probe', { execute: 1, reuse: 1, replay: 1 }));
    }
    const trainingAtSeq = domain.getStore().getJournalEvents(domain.domainId).at(-1)!.seq;
    const frozen = estimateWorkspaceCausalRefreshHistory(domain, { taskKey: 'independent-probe', trainingAtSeq });
    if (!frozen.forecast || training.some(sample => !sample.success)) throw new Error('Training probes did not complete successfully');
    // Calibrate per-node costs only from the frozen training window; reuse measures one batch callback.
    const cost = (phase: 'execute' | 'reuse' | 'commitReplay', calls: 'executionToolCalls' | 'reuseToolCalls' | 'commitReplayToolCalls') => {
      const count = training.reduce((sum, sample) => sum + sample[calls], 0);
      if (!count) throw new Error(`Training lacks ${phase} calibration`);
      return training.reduce((sum, sample) => sum + sample.telemetry!.callbacks[phase].durationMs, 0) / count;
    };
    const costs = { execute: cost('execute', 'executionToolCalls'), reuse: cost('reuse', 'reuseToolCalls'),
      replay: cost('commitReplay', 'commitReplayToolCalls') };
    const summarize = (sample: Awaited<ReturnType<typeof run>>) => ({
        expectedCallbackCostMs: sample.policyDecision!.strategy === 'probe'
          ? sample.policyDecision!.expectedProbeCost : sample.policyDecision!.recomputeCost,
        strategy: sample.policyDecision!.strategy, success: sample.success, status: sample.status,
        commitValidation: sample.commitValidation, outputHashes: sample.outputHashes,
        totalToolCalls: sample.totalToolCalls, elapsedMs: sample.elapsedMs,
        callbackDurationMs: Object.values(sample.telemetry!.callbacks).reduce((sum, metric) => sum + metric.durationMs, 0),
        decisionSeq: sample.telemetry!.decisionSeq, telemetrySeq: sample.telemetry!.seq,
      });
    const samples: { trial: number; changedBranches: number; probe: ReturnType<typeof summarize>;
      history: ReturnType<typeof summarize>; static: ReturnType<typeof summarize> }[] = [];
    for (const [trial, changed] of config.evaluationChanges.entries()) {
      // This probe is independent of either policy's selection, preserving change labels.
      const probe = await run(changed, trial, probeForecast, 'independent-probe', costs);
      const paired = new Map<string, Awaited<ReturnType<typeof run>>>();
      for (const mode of trial % 2 ? ['history', 'static'] : ['static', 'history']) {
        paired.set(mode, await run(changed, trial, mode === 'history' ? frozen.forecast : config.staticForecast,
          `policy-${mode}`, costs));
      }

      samples.push({ trial, changedBranches: changed, probe: summarize(probe),
        history: summarize(paired.get('history')!), static: summarize(paired.get('static')!) });
    }
    const estimate = estimateWorkspaceCausalRefreshHistory(domain, { taskKey: 'independent-probe', trainingAtSeq });
    const summary = (['probe', 'history', 'static'] as const).map(mode => ({ mode,
      successRate: samples.filter(sample => sample[mode].success).length / samples.length,
      meanCallbackDurationMs: samples.reduce((sum, sample) => sum + sample[mode].callbackDurationMs, 0) / samples.length,
      meanElapsedMs: samples.reduce((sum, sample) => sum + sample[mode].elapsedMs, 0) / samples.length,
      meanToolCalls: samples.reduce((sum, sample) => sum + sample[mode].totalToolCalls, 0) / samples.length,
    }));
    return { schemaVersion: 1, config, unit: 'callback_duration_ms', modelTokens: null,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      trainingAtSeq, trainingSamples: training.length, trainingToolCalls: training.reduce((sum, sample) => sum + sample.totalToolCalls, 0),
      trainingElapsedMs: training.reduce((sum, sample) => sum + sample.elapsedMs, 0),
      frozenForecast: frozen.forecast, costModel: costs, estimate, samples, summary };
  } finally { domain.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
