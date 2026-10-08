import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ExecutionDomain } from '../domain.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { WorkspaceCausalGraph, type CausalNode } from '../workspace/causal-graph.js';
import { prepareWorkspaceRepair } from '../workspace/causal-repair.js';
import type { CommitValidation, WorkspaceTransaction } from '../workspace/transactions.js';

export interface CausalBenchmarkOptions {
  trials?: number;
  branches?: number;
  /** Real deterministic CPU work per transform; no artificial sleeps. */
  hashRounds?: number;
}

type Mode = 'full-rerun' | 'incremental-repair' | 'unchecked-reuse';
export interface CausalBenchmarkSample {
  trial: number;
  changedBranch: number;
  mode: Mode;
  executionToolCalls: number;
  changeDetectionReads: number;
  reuseValidationReads: number;
  reusedNodes: number;
  elapsedMs: number;
  correctOutputs: number;
  totalOutputs: number;
  success: boolean;
  outputHashes: string[];
  commitValidation: CommitValidation | null;
}

const exec = promisify(execFile);
const modes: Mode[] = ['full-rerun', 'incremental-repair', 'unchecked-reuse'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function derive(input: string, rounds: number): string {
  let result = input;
  for (let i = 0; i < rounds; i++) result = hash(result);
  return result;
}

/** Repository benchmark fixture, not an agent runner or a model-cost estimator. */
export async function runCausalRepairBenchmark(options: CausalBenchmarkOptions = {}) {
  const config = { trials: options.trials ?? 3, branches: options.branches ?? 4, hashRounds: options.hashRounds ?? 1000 };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  const samples: CausalBenchmarkSample[] = [];
  for (let trial = 0; trial < config.trials; trial++) {
    // Rotate order to reduce systematic warm-cache/order bias. Each mode gets a fresh world.
    for (let offset = 0; offset < modes.length; offset++) {
      samples.push(await runSample(modes[(trial + offset) % modes.length], trial, config));
    }
  }
  const summary = modes.map((mode) => {
    const selected = samples.filter((sample) => sample.mode === mode);
    const times = selected.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
    const mean = (key: 'executionToolCalls' | 'changeDetectionReads' | 'reuseValidationReads') =>
      selected.reduce((sum, sample) => sum + sample[key], 0) / selected.length;
    const middle = Math.floor(times.length / 2);
    return {
      mode, successRate: selected.filter((sample) => sample.success).length / selected.length,
      meanExecutionToolCalls: mean('executionToolCalls'),
      meanChangeDetectionReads: mean('changeDetectionReads'),
      meanReuseValidationReads: mean('reuseValidationReads'),
      medianElapsedMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
    };
  });
  return {
    schemaVersion: 1, config,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      git: (await exec('git', ['--version'])).stdout.trim() },
    modelTokens: null, samples, summary,
  };
}

async function runSample(mode: Mode, trial: number, config: Required<CausalBenchmarkOptions>): Promise<CausalBenchmarkSample> {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-causal-bench-')));
  let domain: ExecutionDomain | undefined;
  try {
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    await exec('git', ['init', '-q', '-b', 'main', root]);
    const inputs = Array.from({ length: config.branches }, (_, branch) => `branch-${branch}:initial`);
    inputs.forEach((value, branch) => fs.writeFileSync(path.join(root, `input-${branch}.txt`), value));
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'benchmark');
    const store = domain.getStore();
    const now = new Date().toISOString();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'causal benchmark', createdAt: now });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'benchmark', status: 'running', startedAt: now });
    const supervisor = new ProcessSupervisor(domain);
    const graph = new WorkspaceCausalGraph(domain);
    const sample: CausalBenchmarkSample = {
      mode, trial, changedBranch: trial % config.branches, executionToolCalls: 0,
      changeDetectionReads: 0, reuseValidationReads: 0, reusedNodes: 0, elapsedMs: 0,
      correctOutputs: 0, totalOutputs: config.branches, success: false, outputHashes: [], commitValidation: null,
    };
    // Values belong to this deterministic adapter; graph hashes alone are not tool return values.
    const values = new Map<string, string>();
    const execute = async (node: CausalNode, tx: WorkspaceTransaction, dependencies: readonly CausalNode[]) => {
      sample.executionToolCalls++;
      const branch = Number(node.observation.call.args.branch);
      const tool = node.observation.call.tool;
      let value: string;
      let writes = node.writes;
      if (tool === 'read') value = fs.readFileSync(path.join(tx.forkRoot, `input-${branch}.txt`), 'utf8');
      else {
        const upstream = values.get(dependencies[0]?.observation.resultHash ?? '');
        if (upstream === undefined) throw new Error('Missing adapter dependency value');
        if (tool === 'derive') value = derive(upstream, config.hashRounds);
        else if (tool === 'write') {
          value = upstream;
          const output = path.join(tx.forkRoot, `output-${branch}.txt`);
          writes = [{ status: fs.existsSync(output) ? 'M' : 'A', path: `output-${branch}.txt` }];
          fs.writeFileSync(output, value);
        } else throw new Error(`Unknown benchmark tool: ${tool}`);
      }
      const resultHash = hash(value);
      values.set(resultHash, value);
      return { actorId: `agent-${branch}`, observation: { ...node.observation, resultHash }, writes };
    };
    const begin = (txId: string) => supervisor.beginWorkspaceTransaction({ txId, runId: 'run', root, forkPath: path.join(temp, txId) });
    const commit = async (tx: WorkspaceTransaction) => {
      const result = await supervisor.commitWorkspaceTransaction(tx.txId);
      if (result.status !== 'committed') throw new Error(`Unexpected fixture OCC conflict: ${tx.txId}`);
      await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId: 'run' });
      return result.validation;
    };
    const initial = await begin('initial');
    const heads: number[] = [];
    for (let branch = 0; branch < config.branches; branch++) {
      let dependencies: CausalNode[] = [];
      for (const tool of ['read', 'derive', 'write']) {
        const step = { actorId: `agent-${branch}`, txId: initial.txId,
          observation: { kind: tool === 'write' ? 'mutate' as const : 'observe' as const,
            call: { tool, args: { branch } }, resultHash: 'pending' },
          writes: tool === 'write' ? [{ status: 'A' as const, path: `output-${branch}.txt` }] : [],
        };
        const source = { ...step, seq: 0, runId: 'run', baseSnapshotId: initial.baseSnapshotId,
          dependsOn: dependencies.map((node) => node.seq) };
        const node = graph.record({ ...step, ...await execute(source, initial, dependencies), dependsOn: source.dependsOn });
        dependencies = [node];
      }
      heads.push(dependencies[0].seq);
    }
    await commit(initial);
    inputs[sample.changedBranch] = `branch-${sample.changedBranch}:changed-${trial}`;
    fs.writeFileSync(path.join(root, `input-${sample.changedBranch}.txt`), inputs[sample.changedBranch]);
    sample.executionToolCalls = 0;
    const start = performance.now();
    const view = graph.view(heads);
    if (mode === 'full-rerun') {
      const tx = await begin('full');
      const replacements = new Map<number, CausalNode>();
      for (const node of view.nodes) {
        const dependencies = node.dependsOn.map((seq) => replacements.get(seq)!);
        const result = await execute(node, tx, dependencies);
        replacements.set(node.seq, graph.record({ ...result, txId: tx.txId, dependsOn: dependencies.map((dep) => dep.seq) }));
      }
      sample.commitValidation = await commit(tx);
    } else if (mode === 'incremental-repair') {
      const changed = view.nodes.filter((node) => {
        if (node.observation.call.tool !== 'read') return false;
        sample.changeDetectionReads++;
        const branch = node.observation.call.args.branch;
        return hash(fs.readFileSync(path.join(root, `input-${branch}.txt`), 'utf8')) !== node.observation.resultHash;
      }).map((node) => node.seq);
      const repair = await prepareWorkspaceRepair(supervisor, {
        txId: 'repair', runId: 'run', root, forkPath: path.join(temp, 'repair'), changed, heads,
        atSeq: view.nodes.at(-1)!.seq, execute,
        validateReuse: async (tx, unaffected) => {
          // Fixed graph declares every dependency. Recheck independent inputs AND materialized outputs.
          for (const node of unaffected) {
            const tool = node.observation.call.tool;
            if (tool === 'derive') continue;
            sample.reuseValidationReads++;
            const file = `${tool === 'read' ? 'input' : 'output'}-${node.observation.call.args.branch}.txt`;
            if (hash(fs.readFileSync(path.join(tx.forkRoot, file), 'utf8')) !== node.observation.resultHash) {
              throw new Error(`Reusable evidence changed: ${file}`);
            }
          }
        },
      });
      sample.reusedNodes = repair.reused.length;
      sample.commitValidation = await commit(repair.transaction);
    } else sample.reusedNodes = view.nodes.length;
    sample.elapsedMs = performance.now() - start;
    // Oracle work is excluded equally for all modes; verify every output, including reused branches.
    for (let branch = 0; branch < config.branches; branch++) {
      const actual = fs.readFileSync(path.join(root, `output-${branch}.txt`), 'utf8');
      sample.outputHashes.push(hash(actual));
      if (actual === derive(inputs[branch], config.hashRounds)) sample.correctOutputs++;
    }
    sample.success = sample.correctOutputs === sample.totalOutputs;
    return sample;
  } finally {
    domain?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
