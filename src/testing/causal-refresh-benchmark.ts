import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ExecutionDomain } from '../domain.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import { recomputeWorkspaceCausalBranches, refreshWorkspaceCausalBranches } from '../workspace/causal-refresh.js';
import type { CausalRefreshDecision } from '../workspace/causal-refresh-cost.js';
import type { ObservationEntry, CommitValidation } from '../workspace/transactions.js';
import type { CausalBenchmarkOptions } from './causal-repair-benchmark.js';

export interface CausalRefreshBenchmarkOptions extends CausalBenchmarkOptions {
  /** Number of independent inputs changed per trial; zero measures the unchanged fast path. */
  changedBranches?: number;
  /** Actual complete validation passes over retained evidence (sensitivity workload). */
  reusePasses?: number;
  /** Estimated calls per retained node; defaults to reusePasses. */
  estimatedReusePasses?: number;
  /** Add one pure observation shared by every branch. */
  sharedInput?: boolean;
  /** Change the shared input, invalidating every dependent branch. */
  changeSharedInput?: boolean;
}
const exec = promisify(execFile);
const modes = ['full-rerun', 'causal-recompute', 'causal-refresh', 'causal-refresh-reuse', 'causal-refresh-adaptive', 'unchecked-reuse'] as const;
type Mode = typeof modes[number];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function output(value: string, rounds: number): string {
  for (let i = 0; i < rounds; i++) value = hash(value);
  return value;
}

/** End-to-end validation cost, with identical mandatory replay for all publishing modes. */
export async function runCausalRefreshBenchmark(options: CausalRefreshBenchmarkOptions = {}) {
  const config = { trials: options.trials ?? 3, branches: options.branches ?? 4,
    hashRounds: options.hashRounds ?? 1000, changedBranches: options.changedBranches ?? 1,
    reusePasses: options.reusePasses ?? 1, estimatedReusePasses: options.estimatedReusePasses ?? options.reusePasses ?? 1,
    sharedInput: options.sharedInput ?? false, changeSharedInput: options.changeSharedInput ?? false };
  for (const key of ['trials', 'branches', 'hashRounds', 'reusePasses'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  if (!Number.isFinite(config.estimatedReusePasses) || config.estimatedReusePasses < 0) {
    throw new Error('estimatedReusePasses must be finite and nonnegative');
  }
  if (!Number.isSafeInteger(config.changedBranches) || config.changedBranches < 0 || config.changedBranches > config.branches) {
    throw new Error('changedBranches must be an integer between zero and branches');
  }
  if (typeof config.sharedInput !== 'boolean' || typeof config.changeSharedInput !== 'boolean'
    || (config.changeSharedInput && !config.sharedInput)) {
    throw new Error('shared input flags must be booleans; changeSharedInput requires sharedInput');
  }
  const samples: Awaited<ReturnType<typeof runSample>>[] = [];
  for (let trial = 0; trial < config.trials; trial++) {
    for (let offset = 0; offset < modes.length; offset++) {
      samples.push(await runSample(modes[(trial + offset) % modes.length], trial, config));
    }
  }
  return { schemaVersion: 3, config, modelTokens: null,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      git: (await exec('git', ['--version'])).stdout.trim() },
    samples, summary: modes.map((mode) => {
      const selected = samples.filter((sample) => sample.mode === mode);
      const mean = (key: 'executionToolCalls' | 'probeToolCalls' | 'reuseToolCalls' | 'commitReplayToolCalls' | 'totalToolCalls' | 'reusedProbeSteps') =>
        selected.reduce((sum, sample) => sum + sample[key], 0) / selected.length;
      const predictions = selected.flatMap(sample => sample.costPrediction ? [sample.costPrediction] : []);
      const times = selected.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      return { mode, successRate: selected.filter((sample) => sample.success).length / selected.length,
        meanExecutionToolCalls: mean('executionToolCalls'), meanProbeToolCalls: mean('probeToolCalls'),
        meanReuseToolCalls: mean('reuseToolCalls'), meanCommitReplayToolCalls: mean('commitReplayToolCalls'),
        meanTotalToolCalls: mean('totalToolCalls'), meanReusedProbeSteps: mean('reusedProbeSteps'),
        strategySelections: { incremental: selected.filter(sample => sample.decision?.strategy === 'incremental').length,
          full: selected.filter(sample => sample.decision?.strategy === 'full').length },
        meanAbsoluteCostErrorToolCalls: predictions.length
          ? predictions.reduce((sum, prediction) => sum + Math.abs(prediction.errorToolCalls), 0) / predictions.length : null,
        medianElapsedMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 };
    }) };
}

async function runSample(mode: Mode, trial: number, config: Required<CausalRefreshBenchmarkOptions>) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-refresh-bench-')));
  let domain: ExecutionDomain | undefined;
  try {
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    await exec('git', ['init', '-q', '-b', 'main', root]);
    for (let branch = 0; branch < config.branches; branch++) fs.writeFileSync(path.join(root, `input-${branch}.txt`), `initial-${branch}`);
    if (config.sharedInput) fs.writeFileSync(path.join(root, 'shared.txt'), 'shared-initial');
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'benchmark');
    const store = domain.getStore();
    const now = new Date().toISOString();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'refresh benchmark', createdAt: now });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'benchmark', status: 'running', startedAt: now });
    const supervisor = new ProcessSupervisor(domain);
    const graph = new WorkspaceCausalGraph(domain);
    const counters = { executionToolCalls: 0, probeToolCalls: 0, reuseToolCalls: 0, commitReplayToolCalls: 0 };
    type Phase = keyof typeof counters;
    // The adapter has no cache: each invocation reads its workspace and reproduces effects.
    const perform = async (entry: ObservationEntry, dir: string, phase: Phase): Promise<string> => {
      counters[phase]++;
      if (entry.call.tool === 'read-shared') return hash(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'));
      const branch = entry.call.args.branch;
      const value = fs.readFileSync(path.join(dir, `input-${branch}.txt`), 'utf8');
      if (entry.call.tool === 'read') return hash(value);
      if (entry.call.tool !== 'write') throw new Error(`Unknown benchmark tool: ${entry.call.tool}`);
      const shared = config.sharedInput ? `${fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8')}\n` : '';
      const derived = output(shared + value, config.hashRounds);
      fs.writeFileSync(path.join(dir, `output-${branch}.txt`), derived);
      return hash(derived);
    };
    const txOptions = (txId: string) => ({ txId, runId: 'run', root, forkPath: path.join(temp, txId) });
    const initial = await supervisor.beginWorkspaceTransaction(txOptions('initial'));
    const sharedHeads: number[] = [];
    if (config.sharedInput) {
      const entry: ObservationEntry = { kind: 'observe', call: { tool: 'read-shared', args: {} } };
      sharedHeads.push(graph.record({ txId: initial.txId, actorId: 'shared-reader', dependsOn: [],
        observation: { ...entry, resultHash: await perform(entry, initial.forkRoot, 'executionToolCalls') } }).seq);
    }
    const branches = [];
    for (let branch = 0; branch < config.branches; branch++) {
      let heads: number[] = [...sharedHeads];
      for (const tool of ['read', 'write']) {
        const entry: ObservationEntry = { kind: tool === 'read' ? 'observe' : 'mutate', call: { tool, args: { branch } } };
        const resultHash = await perform(entry, initial.forkRoot, 'executionToolCalls');
        const node = graph.record({ txId: initial.txId, actorId: `agent-${branch}`, dependsOn: heads,
          observation: { ...entry, resultHash }, writes: tool === 'write' ? [{ status: 'A', path: `output-${branch}.txt` }] : [] });
        heads = [node.seq];
      }
      branches.push({ id: `agent-${branch}`, heads });
    }
    if ((await supervisor.commitWorkspaceTransaction(initial.txId)).status !== 'committed') throw new Error('Initial fixture commit failed');
    await supervisor.pruneSnapshots([initial.baseSnapshotId], { runId: 'run' });
    const heads = branches.flatMap((branch) => branch.heads);
    const view = graph.view(heads);
    const changed = Array.from({ length: config.changedBranches }, (_, i) => (trial + i) % config.branches);
    for (const branch of changed) fs.writeFileSync(path.join(root, `input-${branch}.txt`), `changed-${trial}-${branch}`);
    if (config.changeSharedInput) fs.writeFileSync(path.join(root, 'shared.txt'), `shared-changed-${trial}`);
    counters.executionToolCalls = 0;
    const journalStart = store.getJournalEvents(domain.domainId).at(-1)!.seq;
    const start = performance.now();
    let status: string = 'reused';
    let reusedProbeSteps = 0;
    let commitValidation: CommitValidation | null = null;
    let decision: CausalRefreshDecision | null = null;
    if (mode === 'full-rerun') {
      const tx = await supervisor.beginWorkspaceTransaction(txOptions('rerun'));
      const log: ObservationEntry[] = [];
      for (const node of view.nodes) log.push({ ...node.observation,
        resultHash: await perform(node.observation, tx.forkRoot, 'executionToolCalls') });
      const result = await supervisor.commitWorkspaceTransaction(tx.txId, { observationPolicy: 'always',
        observations: { closedWorld: true, log, replay: (entry, dir) => perform(entry, dir, 'commitReplayToolCalls') } });
      status = result.status;
      if (result.status === 'committed') commitValidation = result.validation;
      else await supervisor.abortWorkspaceTransaction(tx.txId, 'benchmark conflict');
      await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId: 'run' });
    } else if (mode === 'causal-recompute') {
      const result = await recomputeWorkspaceCausalBranches(supervisor, {
        ...txOptions('recompute'), atSeq: view.nodes.at(-1)!.seq, branches,
        closedWorld: true, replayPolicy: 'deterministic',
        replay: (entry, dir) => perform(entry, dir, 'commitReplayToolCalls'),
        execute: async (node, tx) => ({ actorId: node.actorId,
          observation: { ...node.observation, resultHash: await perform(node.observation, tx.forkRoot, 'executionToolCalls') },
          writes: node.writes?.map((write) => ({ ...write, status: 'M' as const })) }),
      });
      status = result.status;
      if (result.commit.status === 'committed') commitValidation = result.commit.validation;
    } else if (mode === 'causal-refresh' || mode === 'causal-refresh-reuse' || mode === 'causal-refresh-adaptive') {
      let repairing = false;
      const result = await refreshWorkspaceCausalBranches(supervisor, {
        ...txOptions('probe'), atSeq: view.nodes.at(-1)!.seq, branches,
        closedWorld: true, replayPolicy: 'deterministic',
        replayReuse: mode === 'causal-refresh' ? 'none' : 'baseline_observations',
        ...(mode === 'causal-refresh-adaptive' ? { costModel: () => ({
          execute: 1, reuse: config.estimatedReusePasses, replay: 1,
        }) } : {}),
        replay: (entry, dir) => perform(entry, dir, repairing ? 'commitReplayToolCalls' : 'probeToolCalls'),
        repair: { txId: 'repair', forkPath: path.join(temp, 'repair'),
          validateReuse: async (tx, unaffected) => {
            repairing = true;
            for (let pass = 0; pass < config.reusePasses; pass++) {
              for (const node of unaffected) {
                if (await perform(node.observation, tx.forkRoot, 'reuseToolCalls') !== node.observation.resultHash) {
                  throw new Error(`Invalid reused evidence: ${node.seq}`);
                }
              }
            }
          },
          execute: async (node, tx) => ({ actorId: node.actorId,
            observation: { ...node.observation, resultHash: await perform(node.observation, tx.forkRoot, 'executionToolCalls') },
            writes: node.writes?.map((write) => ({ ...write, status: 'M' as const })) }),
        },
      });
      decision = 'decision' in result ? result.decision ?? null : null;
      status = result.status;
      reusedProbeSteps = result.validation.reusedSteps;
      if (result.status === 'committed' && result.commit.status === 'committed') commitValidation = result.commit.validation;
    }
    const elapsedMs = performance.now() - start;
    const events = store.getJournalEvents(domain.domainId).filter((event) => event.seq > journalStart);
    let correctOutputs = 0;
    const outputHashes = [];
    for (let branch = 0; branch < config.branches; branch++) {
      const actual = fs.readFileSync(path.join(root, `output-${branch}.txt`), 'utf8');
      outputHashes.push(hash(actual));
      const expectedInput = changed.includes(branch) ? `changed-${trial}-${branch}` : `initial-${branch}`;
      const expectedShared = config.sharedInput ? `${config.changeSharedInput ? `shared-changed-${trial}` : 'shared-initial'}\n` : '';
      if (actual === output(expectedShared + expectedInput, config.hashRounds)) correctOutputs++;
    }
    const actualRemainingToolCalls = counters.executionToolCalls + counters.reuseToolCalls + counters.commitReplayToolCalls;
    const estimatedRemainingToolCalls = decision ? decision[decision.strategy].total : null;
    const costPrediction = estimatedRemainingToolCalls === null ? null : {
      unit: 'toolCalls' as const, estimatedRemainingToolCalls, actualRemainingToolCalls,
      errorToolCalls: actualRemainingToolCalls - estimatedRemainingToolCalls,
    };
    return { mode, trial, decision, costPrediction, changedBranches: changed, status, ...counters, reusedProbeSteps,
      totalToolCalls: Object.values(counters).reduce((a, b) => a + b, 0), elapsedMs,
      causalStepsRecorded: events.filter((event) => event.type === 'CAUSAL_STEP').length,
      validationsCompleted: events.filter((event) => event.type === 'CAUSAL_VALIDATION_COMPLETED').length,
      recomputationsPrepared: events.filter((event) => event.type === 'CAUSAL_RECOMPUTATION_PREPARED').length,
      transactionsStarted: events.filter((event) => event.type === 'TX_BEGUN').length,
      snapshotsCaptured: events.filter((event) => event.type === 'SNAPSHOT_CAPTURED').length,
      correctOutputs, totalOutputs: config.branches, outputHashes, commitValidation,
      success: correctOutputs === config.branches && (mode === 'unchecked-reuse' || status === 'committed' || status === 'unchanged') };
  } finally {
    domain?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
