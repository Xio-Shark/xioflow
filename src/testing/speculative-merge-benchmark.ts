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
import { speculateWorkspace } from '../workspace/speculation.js';
import type { WorkspaceTransaction } from '../workspace/transactions.js';
import type { CausalBenchmarkOptions } from './causal-repair-benchmark.js';

const exec = promisify(execFile);
const modes = ['full-rerun', 'incremental-repair'] as const;
type Mode = typeof modes[number];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function derive(value: string, rounds: number): string {
  for (let i = 0; i < rounds; i++) value = hash(value);
  return value;
}

/** Two actual speculative candidates, one ordered merge conflict, identical deterministic tools. */
export async function runSpeculativeMergeBenchmark(options: CausalBenchmarkOptions = {}) {
  const config = { trials: options.trials ?? 3, branches: options.branches ?? 4, hashRounds: options.hashRounds ?? 1000 };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  const samples: Awaited<ReturnType<typeof runSample>>[] = [];
  for (let trial = 0; trial < config.trials; trial++) {
    for (let offset = 0; offset < modes.length; offset++) {
      samples.push(await runSample(modes[(trial + offset) % modes.length], trial, config));
    }
  }
  return {
    schemaVersion: 1, config, modelTokens: null,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      git: (await exec('git', ['--version'])).stdout.trim() },
    samples,
    summary: modes.map((mode) => {
      const selected = samples.filter((sample) => sample.mode === mode);
      const times = selected.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
      const mean = (key: 'executionToolCalls' | 'recoveryToolCalls' | 'changeDetectionReads' | 'reuseValidationReads' | 'materializationWrites') =>
        selected.reduce((sum, sample) => sum + sample[key], 0) / selected.length;
      const middle = Math.floor(times.length / 2);
      return { mode, successRate: selected.filter((sample) => sample.success).length / selected.length,
        meanExecutionToolCalls: mean('executionToolCalls'), meanRecoveryToolCalls: mean('recoveryToolCalls'),
        meanChangeDetectionReads: mean('changeDetectionReads'), meanReuseValidationReads: mean('reuseValidationReads'),
        meanMaterializationWrites: mean('materializationWrites'),
        medianElapsedMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 };
    }),
  };
}

async function runSample(mode: Mode, trial: number, config: Required<CausalBenchmarkOptions>) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-merge-bench-')));
  let domain: ExecutionDomain | undefined;
  try {
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    await exec('git', ['init', '-q', '-b', 'main', root]);
    const inputs = Array.from({ length: config.branches }, (_, branch) => `branch-${branch}:initial`);
    const file = (branch: number) => `input-${branch}.txt`;
    inputs.forEach((value, branch) => fs.writeFileSync(path.join(root, file(branch)), value));
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'benchmark');
    const store = domain.getStore();
    const now = new Date().toISOString();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'merge benchmark', createdAt: now });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'benchmark', status: 'running', startedAt: now });
    const supervisor = new ProcessSupervisor(domain);
    const graph = new WorkspaceCausalGraph(domain);
    const changedBranch = trial % config.branches;
    const updated = `branch-${changedBranch}:changed-${trial}`;
    const counters = { initialToolCalls: 0, recoveryToolCalls: 0, changeDetectionReads: 0,
      reuseValidationReads: 0, materializationWrites: 0, reusedNodes: 0 };
    let recovering = false;
    const values = new Map<string, string>();
    const heads: number[] = [];
    const execute = async (source: CausalNode, tx: WorkspaceTransaction, dependencies: readonly CausalNode[]) => {
      counters[recovering ? 'recoveryToolCalls' : 'initialToolCalls']++;
      const branch = Number(source.observation.call.args.branch);
      const tool = source.observation.call.tool;
      let value: string;
      if (tool === 'read') value = fs.readFileSync(path.join(tx.forkRoot, file(branch)), 'utf8');
      else {
        const upstream = values.get(dependencies[0]?.observation.resultHash ?? '');
        if (upstream === undefined) throw new Error('Missing adapter dependency value');
        if (tool === 'derive') value = derive(upstream, config.hashRounds);
        else if (tool === 'write') {
          value = upstream;
          fs.writeFileSync(path.join(tx.forkRoot, file(branch)), value);
        } else throw new Error(`Unknown benchmark tool: ${tool}`);
      }
      const resultHash = hash(value);
      values.set(resultHash, value);
      return { actorId: 'transform', observation: { ...source.observation, resultHash }, writes: source.writes };
    };
    const start = performance.now();
    const result = await speculateWorkspace(supervisor, {
      speculationId: 'merge', runId: 'run', root, forkPath: path.join(temp, 'candidate'), commitPolicy: 'all_valid',
      strategies: [
        { id: 'update', execute: async (tx) => {
          counters.initialToolCalls++;
          fs.writeFileSync(path.join(tx.forkRoot, file(changedBranch)), updated);
          graph.record({ txId: tx.txId, actorId: 'update', dependsOn: [],
            observation: { kind: 'mutate', call: { tool: 'update', args: { branch: changedBranch } }, resultHash: hash(updated) },
            writes: [{ status: 'M', path: file(changedBranch) }] });
        } },
        { id: 'transform', execute: async (tx) => {
          for (let branch = 0; branch < config.branches; branch++) {
            let dependencies: CausalNode[] = [];
            for (const tool of ['read', 'derive', 'write']) {
              const source: CausalNode = { seq: 0, runId: 'run', baseSnapshotId: tx.baseSnapshotId,
                txId: tx.txId, actorId: 'transform', dependsOn: dependencies.map((node) => node.seq),
                observation: { kind: tool === 'write' ? 'mutate' : 'observe', call: { tool, args: { branch } }, resultHash: 'pending' },
                writes: tool === 'write' ? [{ status: 'M', path: file(branch) }] : [] };
              dependencies = [graph.record({ ...await execute(source, tx, dependencies), txId: tx.txId, dependsOn: source.dependsOn })];
            }
            heads.push(dependencies[0].seq);
          }
        }, repair: async (original, conflict) => {
          if (!conflict.conflicts.some((entry) => entry.path === file(changedBranch) && entry.kind === 'write_write')) {
            throw new Error('Expected an actual conflict with the earlier winner');
          }
          recovering = true;
          const view = graph.view(heads);
          const reads = view.nodes.filter((node) => node.observation.call.tool === 'read');
          // Full rerun deliberately invalidates all branches; both modes use the same tools and OCC path.
          const changed = mode === 'full-rerun' ? reads : reads.filter((node) => {
            counters.changeDetectionReads++;
            return hash(fs.readFileSync(path.join(root, file(Number(node.observation.call.args.branch))), 'utf8')) !== node.observation.resultHash;
          });
          return { changed: changed.map((node) => node.seq), heads, atSeq: view.nodes.at(-1)!.seq, execute,
            validateReuse: async (tx, unaffected) => {
              counters.reusedNodes = unaffected.length;
              const outputs: { filename: string; value: string }[] = [];
              for (const node of unaffected) {
                const tool = node.observation.call.tool;
                if (tool === 'derive') continue;
                const filename = file(Number(node.observation.call.args.branch));
                counters.reuseValidationReads++;
                // In-place transforms: validate inputs in the new baseline and outputs in the original fork.
                const value = fs.readFileSync(path.join(tool === 'read' ? tx.forkRoot : original.forkRoot, filename), 'utf8');
                if (hash(value) !== node.observation.resultHash) throw new Error(`Reusable evidence changed: ${filename}`);
                if (tool === 'write') outputs.push({ filename, value });
              }
              for (const { filename, value } of outputs) {
                counters.materializationWrites++;
                fs.writeFileSync(path.join(tx.forkRoot, filename), value);
              }
            },
          };
        } },
      ],
    });
    const elapsedMs = performance.now() - start;
    const outputHashes: string[] = [];
    let correctOutputs = 0;
    for (let branch = 0; branch < config.branches; branch++) {
      const actual = fs.readFileSync(path.join(root, file(branch)), 'utf8');
      outputHashes.push(hash(actual));
      if (actual === derive(branch === changedBranch ? updated : inputs[branch], config.hashRounds)) correctOutputs++;
    }
    const recovery = result.candidates[1].repair?.commit;
    return { mode, trial, changedBranch, ...counters,
      executionToolCalls: counters.initialToolCalls + counters.recoveryToolCalls, elapsedMs,
      correctOutputs, totalOutputs: config.branches, outputHashes,
      success: correctOutputs === config.branches && result.winners.length === 2,
      winners: result.winners, conflictDetected: result.candidates[1].commit?.status === 'conflict',
      commitValidation: recovery?.status === 'committed' ? recovery.validation : null };
  } finally {
    domain?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
