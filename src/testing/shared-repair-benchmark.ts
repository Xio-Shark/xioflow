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
import { prepareWorkspaceBranchRepair, prepareWorkspaceRepair } from '../workspace/causal-repair.js';
import type { CommitValidation, WorkspaceTransaction } from '../workspace/transactions.js';
import type { CausalBenchmarkOptions } from './causal-repair-benchmark.js';

const exec = promisify(execFile);
const modes = ['independent-repair', 'shared-repair', 'unchecked-reuse'] as const;
type Mode = typeof modes[number];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function derive(value: string, rounds: number): string {
  for (let i = 0; i < rounds; i++) value = hash(value);
  return value;
}

/** A fixed shared-ancestor workload; not a model or agent scheduling benchmark. */
export async function runSharedRepairBenchmark(options: CausalBenchmarkOptions = {}) {
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
      const mean = (key: 'executionToolCalls' | 'distributionReads' | 'distributionWrites' | 'distributionBytes' | 'distributionValidationReads' | 'transactionsStarted') =>
        selected.reduce((sum, sample) => sum + sample[key], 0) / selected.length;
      const middle = Math.floor(times.length / 2);
      return { mode, successRate: selected.filter((sample) => sample.success).length / selected.length,
        meanExecutionToolCalls: mean('executionToolCalls'), meanDistributionReads: mean('distributionReads'),
        meanDistributionWrites: mean('distributionWrites'), meanDistributionBytes: mean('distributionBytes'),
        meanDistributionValidationReads: mean('distributionValidationReads'),
        meanTransactionsStarted: mean('transactionsStarted'),
        medianElapsedMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 };
    }),
  };
}

async function runSample(mode: Mode, trial: number, config: Required<CausalBenchmarkOptions>) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-shared-bench-')));
  let domain: ExecutionDomain | undefined;
  try {
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    await exec('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'input.txt'), 'initial');
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'benchmark');
    const store = domain.getStore();
    const now = new Date().toISOString();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'shared repair benchmark', createdAt: now });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'benchmark', status: 'running', startedAt: now });
    const supervisor = new ProcessSupervisor(domain);
    const graph = new WorkspaceCausalGraph(domain);
    const counters = { executionToolCalls: 0, changeDetectionReads: 0, distributionReads: 0,
      distributionWrites: 0, distributionBytes: 0, distributionValidationReads: 0, transactionsStarted: 0 };
    const values = new Map<string, string>();
    const execute = async (source: CausalNode, tx: WorkspaceTransaction, dependencies: readonly CausalNode[]) => {
      counters.executionToolCalls++;
      const tool = source.observation.call.tool;
      let value: string;
      let writes = source.writes;
      if (tool === 'read') value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8');
      else {
        const upstream = values.get(dependencies[0]?.observation.resultHash ?? '');
        if (upstream === undefined) throw new Error('Missing adapter dependency value');
        if (tool === 'derive') value = derive(upstream, config.hashRounds);
        else if (tool === 'write') {
          value = `${source.observation.call.args.branch}:${upstream}`;
          const filename = `output-${source.observation.call.args.branch}.txt`;
          const output = path.join(tx.forkRoot, filename);
          writes = [{ status: fs.existsSync(output) ? 'M' : 'A', path: filename }];
          fs.writeFileSync(output, value);
        } else throw new Error(`Unknown tool: ${tool}`);
      }
      const resultHash = hash(value);
      values.set(resultHash, value);
      return { actorId: source.actorId, observation: { ...source.observation, resultHash }, writes };
    };
    const txOptions = (txId: string) => ({ txId, runId: 'run', root, forkPath: path.join(temp, txId) });
    const begin = async (txId: string) => {
      counters.transactionsStarted++;
      return supervisor.beginWorkspaceTransaction(txOptions(txId));
    };
    const commit = async (tx: WorkspaceTransaction) => {
      const result = await supervisor.commitWorkspaceTransaction(tx.txId);
      if (result.status !== 'committed') throw new Error(`Unexpected fixture OCC conflict: ${tx.txId}`);
      await supervisor.pruneSnapshots([tx.baseSnapshotId], { runId: 'run' });
      return result.validation;
    };
    const initial = await begin('initial');
    const record = async (tool: string, dependencies: CausalNode[], branch = -1) => {
      const source: CausalNode = { seq: 0, runId: 'run', txId: initial.txId, baseSnapshotId: initial.baseSnapshotId,
        actorId: branch < 0 ? 'shared' : `agent-${branch}`, dependsOn: dependencies.map((node) => node.seq),
        observation: { kind: tool === 'write' ? 'mutate' : 'observe', call: { tool, args: { branch } }, resultHash: 'pending' },
        writes: tool === 'write' ? [{ status: 'A', path: `output-${branch}.txt` }] : [] };
      return graph.record({ ...await execute(source, initial, dependencies), txId: initial.txId, dependsOn: source.dependsOn });
    };
    const input = await record('read', []);
    const common = await record('derive', [input]);
    const branches = [];
    for (let branch = 0; branch < config.branches; branch++) {
      branches.push({ id: `agent-${branch}`, heads: [(await record('write', [common], branch)).seq] });
    }
    await commit(initial);
    const atSeq = graph.view(branches.flatMap(({ heads }) => heads)).nodes.at(-1)!.seq;
    const updated = `changed-${trial}`;
    fs.writeFileSync(path.join(root, 'input.txt'), updated);
    counters.executionToolCalls = 0;
    counters.transactionsStarted = 0;
    const validations: CommitValidation[] = [];
    const start = performance.now();
    if (mode !== 'unchecked-reuse') {
      counters.changeDetectionReads++;
      const changed = hash(fs.readFileSync(path.join(root, 'input.txt'), 'utf8')) !== input.observation.resultHash ? [input.seq] : [];
      const repairOptions = {
        changed, atSeq, execute,
        validateReuse: async (_tx: WorkspaceTransaction, unaffected: readonly CausalNode[]) => {
          if (unaffected.length) throw new Error('This fixture must invalidate every selected node');
        },
      };
      const outputs: WorkspaceTransaction[] = [];
      if (mode === 'independent-repair') {
        for (const branch of branches) {
          counters.transactionsStarted++;
          const repair = await prepareWorkspaceRepair(supervisor, {
            ...txOptions(branch.id), ...repairOptions, heads: branch.heads,
          });
          outputs.push(repair.transaction);
        }
      } else {
        counters.transactionsStarted++;
        const repair = await prepareWorkspaceBranchRepair(supervisor, {
          ...txOptions('shared'), ...repairOptions, branches,
        });
        const repairedInput = repair.replacements.find(({ sourceSeq }) => sourceSeq === input.seq)!.node;
        for (let branch = 0; branch < branches.length; branch++) {
          const tx = await begin(branches[branch].id);
          // Copying outputs does not transfer read evidence. Validate the fixed adapter's sole input in each fork.
          counters.distributionValidationReads++;
          if (hash(fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8')) !== repairedInput.observation.resultHash) {
            throw new Error('Shared input changed before distribution');
          }
          // Fixed adapter distributes only this branch's output, not other agents' writes.
          const filename = `output-${branch}.txt`;
          const value = fs.readFileSync(path.join(repair.transaction.forkRoot, filename));
          counters.distributionReads++;
          fs.writeFileSync(path.join(tx.forkRoot, filename), value);
          counters.distributionWrites++;
          counters.distributionBytes += value.length;
          outputs.push(tx);
        }
        await supervisor.abortWorkspaceTransaction(repair.transaction.txId, 'outputs distributed');
        await supervisor.pruneSnapshots([repair.transaction.baseSnapshotId], { runId: 'run' });
      }
      // All independent transactions are prepared before any publication; use ordinary OCC for each.
      for (const tx of outputs) validations.push(await commit(tx));
    }
    const elapsedMs = performance.now() - start;
    const outputHashes: string[] = [];
    let correctOutputs = 0;
    for (let branch = 0; branch < config.branches; branch++) {
      const actual = fs.readFileSync(path.join(root, `output-${branch}.txt`), 'utf8');
      outputHashes.push(hash(actual));
      if (actual === `${branch}:${derive(updated, config.hashRounds)}`) correctOutputs++;
    }
    return { mode, trial, ...counters, elapsedMs, outputHashes, correctOutputs, totalOutputs: config.branches,
      success: correctOutputs === config.branches, commitValidations: validations };
  } finally {
    domain?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
