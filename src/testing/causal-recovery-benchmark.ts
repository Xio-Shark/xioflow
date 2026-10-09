import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ExecutionDomain } from '../domain.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { AgentRuntime } from '../agents/runtime.js';
import { refreshAgentSharedCausalBatch, resumeAgentSharedCausalRefresh, retryAgentSharedCausalRefresh,
  type AgentSharedCausalRecoveryOptions } from '../agents/causal-recovery.js';
import { listAgentCausalRefreshExecutions } from '../agents/causal-recovery-history.js';
import { planAgentCausalResourceCleanup, cleanupAgentCausalFork } from '../agents/workspace-resources.js';
import { WorkspaceCausalGraph, type CausalNode } from '../workspace/causal-graph.js';
import { prepareWorkspaceBranchRepair } from '../workspace/causal-repair.js';
import type { WorkspaceTransaction } from '../workspace/transactions.js';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const modes = ['durable-recovery', 'rerun-unfinished'] as const;
const faults = ['binding-failure', 'outcome-interruption'] as const;

/** Measures durable recovery, with optional OCC publication after a second input change. */
export async function runCausalRecoveryBenchmark(options: { trials?: number; branches?: number; hashRounds?: number; publication?: 'stable' | 'input-changed' } = {}) {
  if (options.publication !== undefined && !['stable', 'input-changed'].includes(options.publication)) throw new Error('Invalid publication');
  const config = { trials: options.trials ?? 3, branches: options.branches ?? 4, hashRounds: options.hashRounds ?? 1000 };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < (key === 'branches' ? 2 : 1)) throw new Error(`Invalid ${key}`);
  }
  const samples: Awaited<ReturnType<typeof runSample>>[] = [];
  for (let trial = 0; trial < config.trials; trial++) {
    for (const fault of faults) {
      for (let offset = 0; offset < modes.length; offset++) {
        samples.push(await runSample(modes[(trial + offset) % modes.length], fault, trial, config, options.publication));
      }
    }
  }
  return { schemaVersion: 2, config, publication: options.publication ?? null, modelTokens: null,
    scope: options.publication ? 'recovery-through-occ-publication' : 'checkpoint-and-isolated-workspace-recovery',
    environment: { node: process.version, platform: process.platform, arch: process.arch }, samples,
    summary: faults.flatMap(fault => modes.map(mode => {
      const rows = samples.filter(row => row.mode === mode && row.fault === fault);
      const mean = (key: 'executionToolCalls' | 'probeCalls' | 'recoveryMs' | 'elapsedMs') =>
        rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
      return { fault, mode, successRate: rows.filter(row => row.success).length / rows.length,
        meanExecutionToolCalls: mean('executionToolCalls'), meanProbeCalls: mean('probeCalls'),
        meanRecoveryMs: mean('recoveryMs'), meanElapsedMs: mean('elapsedMs') };
    })) };
}

async function runSample(mode: typeof modes[number], fault: typeof faults[number], trial: number,
  config: { branches: number; hashRounds: number }, publication?: 'stable' | 'input-changed') {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-recovery-bench-')));
  let domain: ExecutionDomain | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    await exec('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'input.txt'), 'old');
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'recovery-benchmark');
    const now = new Date().toISOString();
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'recovery benchmark', createdAt: now });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId,
      owner: 'benchmark', status: 'running', startedAt: now });
    const openRuntime = () => new AgentRuntime(domain!, { maxConcurrentAgents: 1,
      step: async () => { throw new Error('Benchmark does not schedule model steps'); } });
    runtime = openRuntime();
    let supervisor = new ProcessSupervisor(domain);
    const graph = new WorkspaceCausalGraph(domain);
    const txOptions = (txId: string) => ({ txId, runId: 'run', root, forkPath: path.join(temp, txId) });
    const derive = (input: string) => {
      for (let i = 0; i < config.hashRounds; i++) input = hash(input);
      return input;
    };
    const initial = await supervisor.beginWorkspaceTransaction(txOptions('initial'));
    const input = graph.record({ txId: initial.txId, actorId: 'shared', dependsOn: [],
      observation: { kind: 'observe', call: { tool: 'read', args: {} }, resultHash: hash('old') } });
    const output = graph.record({ txId: initial.txId, actorId: 'shared', dependsOn: [input.seq],
      observation: { kind: 'mutate', call: { tool: 'derive', args: {} }, resultHash: hash(derive('old')) },
      writes: [{ status: 'A', path: 'derived.txt' }] });
    fs.writeFileSync(path.join(initial.forkRoot, 'derived.txt'), derive('old'));
    const ids = Array.from({ length: config.branches }, (_, i) => `agent-${i}`);
    for (const id of ids) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: derive('old'), causalHeads: [output.seq], maxSteps: 2 });
      runtime.pause(id);
    }
    const updated = `new-${trial}`;
    fs.writeFileSync(path.join(root, 'input.txt'), updated);
    const counters = { executionToolCalls: 0, probeCalls: 0, bindingCalls: 0, distributionReads: 0,
      distributionWrites: 0, distributionValidationReads: 0, injectedFaults: 0 };
    const execute = async (entry: CausalNode, tx: WorkspaceTransaction) => {
      counters.executionToolCalls++;
      const value = fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8');
      const result = entry.observation.call.tool === 'read' ? value : derive(value);
      if (entry.observation.kind === 'mutate') fs.writeFileSync(path.join(tx.forkRoot, 'derived.txt'), result);
      return { actorId: entry.actorId, observation: { ...entry.observation, resultHash: hash(result) }, writes: entry.writes };
    };
    let inject = true;
    let abandonedTxId = '';
    const bind: AgentSharedCausalRecoveryOptions['bind'] = async ({ agentId }, repair, attempt) => {
      counters.bindingCalls++;
      const txId = `bound-${attempt!.attemptSeq}`;
      attempt!.reserveTransaction(txId);
      const tx = await supervisor.beginWorkspaceTransaction(txOptions(txId));
      counters.distributionValidationReads++;
      const read = repair.replacements.find(row => row.node.observation.call.tool === 'read')!.node;
      if (hash(fs.readFileSync(path.join(tx.forkRoot, 'input.txt'), 'utf8')) !== read.observation.resultHash) {
        throw new Error('Input changed during output distribution');
      }
      counters.distributionReads++;
      const value = fs.readFileSync(path.join(repair.transaction.forkRoot, 'derived.txt'), 'utf8');
      counters.distributionWrites++;
      fs.writeFileSync(path.join(tx.forkRoot, 'derived.txt'), value);
      if (inject && agentId === ids.at(-1)) {
        counters.injectedFaults++;
        abandonedTxId = txId;
        throw new Error('Injected failure after output allocation');
      }
      return { checkpoint: value, workspace: tx };
    };
    const refresh = (prefix: string, agentIds: string[]) => refreshAgentSharedCausalBatch(runtime!, supervisor, {
      agentIds, validation: { ...txOptions(`${prefix}-probe`), closedWorld: true, replayPolicy: 'deterministic',
        replay: async (entry, context) => {
          counters.probeCalls++;
          const value = fs.readFileSync(path.join(context, 'input.txt'), 'utf8');
          if (entry.call.tool === 'read') return hash(value);
          const result = derive(value);
          fs.writeFileSync(path.join(context, 'derived.txt'), result);
          return hash(result);
        } },
      prepare: plan => prepareWorkspaceBranchRepair(supervisor, { ...txOptions(`${prefix}-shared`),
        changed: plan.changed, atSeq: Math.max(...plan.affected.map(row => row.checkpoint.seq)),
        branches: plan.affected.map(row => ({ id: row.agentId, heads: row.checkpoint.causalHeads! })),
        validateReuse: async (_tx, nodes) => { if (nodes.length) throw new Error('Unexpected reuse'); }, execute }), bind,
    });
    const started = performance.now();
    const store = domain.getStore();
    const record = store.recordJournalEvent.bind(store);
    if (fault === 'outcome-interruption') store.recordJournalEvent = event => {
      if (event.type === 'AGENT_CAUSAL_REFRESH_OUTCOME') throw new Error('Injected outcome journal interruption');
      return record(event);
    };
    try {
      const result = await refresh('first', ids);
      if (result.status !== 'recovered') throw new Error(`Unexpected refresh: ${result.status}`);
    } catch (error) {
      if (fault !== 'outcome-interruption' || !(error instanceof Error) || error.message !== 'Injected outcome journal interruption') throw error;
    } finally { store.recordJournalEvent = record; }
    const before = listAgentCausalRefreshExecutions(domain)[0];
    if (before.publications.at(-1)?.status !== (fault === 'binding-failure' ? 'failed' : 'pending')) {
      throw new Error('Fault did not produce the expected durable state');
    }
    const settled = ids.slice(0, -1).map(id => runtime!.checkpoints(id).at(-1)!.seq);
    const executionBeforeRecovery = counters.executionToolCalls;
    const recoveryStarted = performance.now();
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'recovery-benchmark');
    runtime = openRuntime();
    supervisor = new ProcessSupervisor(domain);
    const historySurvived = JSON.stringify(listAgentCausalRefreshExecutions(domain)[0]) === JSON.stringify(before);
    inject = false;
    if (mode === 'rerun-unfinished') await refresh('rerun', [ids.at(-1)!]);
    else if (fault === 'outcome-interruption') await resumeAgentSharedCausalRefresh(runtime, before.seq, bind);
    else {
      const failed = before.publications.at(-1)!;
      if (failed.status !== 'failed') throw new Error('Expected durable failed publication');
      await retryAgentSharedCausalRefresh(runtime, before.seq, { agentId: failed.agentId, failureSeq: failed.seq }, bind);
    }
    const recoveryMs = performance.now() - recoveryStarted;
    // This fixture has no external users or concurrent writers. Keep all time-travel baselines.
    const cleanupStarted = performance.now();
    const cleanup = planAgentCausalResourceCleanup(domain);
    const abandoned = cleanup.resources.find(row => row.txId === abandonedTxId)!;
    let cleanedForks = 0;
    if (abandoned.fork?.disposition === 'review') {
      await cleanupAgentCausalFork(supervisor, { txId: abandonedTxId, atSeq: cleanup.atSeq });
      if (fs.existsSync(abandoned.forkRoot!)) throw new Error('Abandoned fork still exists');
      cleanedForks++;
    }
    const cleanupMs = performance.now() - cleanupStarted;
    const expected = derive(updated);
    const correctOutputs = ids.filter(id => {
      const agent = runtime!.get(id)!;
      return agent.checkpoint === expected && !!agent.workspace
        && fs.readFileSync(path.join(agent.workspace.forkRoot, 'derived.txt'), 'utf8') === expected;
    }).length;
    const preservedPublications = ids.slice(0, -1).every((id, i) => runtime!.checkpoints(id).at(-1)!.seq === settled[i]);
    const recoveryExecutionToolCalls = counters.executionToolCalls - executionBeforeRecovery;
    let publicationResult: {
      scenario: string; firstStatus: string; finalStatus: string; conflictReason: string | null;
      staleOutputBlocked: boolean; checkpointsCurrent: boolean; rootCorrect: boolean;
      commitAttempts: number; commitReplayToolCalls: number; executionToolCalls: number;
      probeCalls: number; elapsedMs: number; finalTxId: string; validation: string | null;
      transactionHistoryVerified: boolean;
    } | null = null;
    if (publication) {
      const publicationStarted = performance.now();
      const executionBefore = counters.executionToolCalls;
      const probesBefore = counters.probeCalls;
      let commitReplayToolCalls = 0;
      let commitAttempts = 0;
      const currentInput = publication === 'input-changed' ? `changed-again-${trial}` : updated;
      fs.writeFileSync(path.join(root, 'input.txt'), currentInput);
      const publish = async () => {
        const agent = runtime!.get(ids.at(-1)!)!;
        const log = new WorkspaceCausalGraph(domain!).view(agent.causalHeads!).nodes.map(node => node.observation);
        commitAttempts++;
        return supervisor.commitWorkspaceTransaction(agent.workspace!.txId, {
          observationPolicy: 'always', observations: { closedWorld: true, log,
            replay: async (entry, context) => {
              commitReplayToolCalls++;
              const value = fs.readFileSync(path.join(context, 'input.txt'), 'utf8');
              if (entry.call.tool === 'read') return hash(value);
              const result = derive(value);
              fs.writeFileSync(path.join(context, 'derived.txt'), result);
              return hash(result);
            } },
        });
      };
      const first = await publish();
      const staleOutputBlocked = publication === 'stable' || (first.status === 'conflict'
        && first.observation?.reason === 'observation_changed' && !fs.existsSync(path.join(root, 'derived.txt')));
      let final = first;
      if (publication === 'input-changed') {
        if (!staleOutputBlocked) throw new Error('OCC failed to block stale recovered output');
        const refreshed = await refresh('publication', ids);
        if (refreshed.status !== 'recovered') throw new Error(`Publication refresh: ${refreshed.status}`);
        final = await publish();
      }
      const checkpointsCurrent = ids.every(id => runtime!.get(id)!.checkpoint === derive(currentInput));
      publicationResult = { scenario: publication, firstStatus: first.status, finalStatus: final.status,
        conflictReason: first.status === 'conflict' ? first.observation?.reason ?? null : null,
        staleOutputBlocked, checkpointsCurrent,
        rootCorrect: fs.existsSync(path.join(root, 'derived.txt'))
          && fs.readFileSync(path.join(root, 'derived.txt'), 'utf8') === derive(currentInput)
          && fs.readFileSync(path.join(root, 'input.txt'), 'utf8') === currentInput,
        commitAttempts, commitReplayToolCalls, executionToolCalls: counters.executionToolCalls - executionBefore,
        probeCalls: counters.probeCalls - probesBefore, elapsedMs: performance.now() - publicationStarted,
        finalTxId: final.txId, validation: final.status === 'committed' ? final.validation : null,
        transactionHistoryVerified: domain.getStore().getJournalEvents(domain.domainId).some(event =>
          event.type === 'TX_COMMITTED' && event.payload.txId === final.txId)
          && (first.status !== 'conflict' || domain.getStore().getJournalEvents(domain.domainId).some(event =>
            event.type === 'TX_CONFLICTED' && event.payload.txId === first.txId)) };
    }
    const elapsedMs = performance.now() - started;
    return { mode, fault, trial, ...counters, executionBeforeRecovery, publication: publicationResult,
      recoveryExecutionToolCalls,
      recoveryMs, cleanupMs, elapsedMs, historySurvived, preservedPublications, correctOutputs,
      totalOutputs: ids.length, cleanedForks, abandonedForkDisposition: abandoned.fork?.disposition,
      retainedForks: planAgentCausalResourceCleanup(domain).resources.filter(row => row.state === 'open' && row.fork?.disposition === 'retain').length,
      success: correctOutputs === ids.length && historySurvived && preservedPublications && counters.injectedFaults === 1
        && (!publicationResult || (publicationResult.finalStatus === 'committed' && publicationResult.staleOutputBlocked
          && publicationResult.rootCorrect && publicationResult.checkpointsCurrent
          && publicationResult.validation === 'observations' && publicationResult.transactionHistoryVerified)) };
  } finally {
    runtime?.close(); domain?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
