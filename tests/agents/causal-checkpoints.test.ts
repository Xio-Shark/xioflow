import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, prepareWorkspaceRepair, forkAgentCheckpoint, compareAgentCheckpoints, compareAgentCheckpointFiles, recoverAgentCausalBatch, recoverAgentSharedCausalBatch, refreshAgentSharedCausalBatch, listAgentCausalRefreshPlans, listAgentCausalBindingAttempts, listAgentCheckpointWorkspaceReferences, planAgentCausalResourceCleanup, cleanupAgentCausalFork, listAgentCausalForkCleanups, listAgentCausalRefreshExecutions, resumeAgentSharedCausalRefresh, resumeAgentSharedCausalRefreshWithValidation, retryAgentSharedCausalRefresh, prepareWorkspaceBranchRepair } from '../../src/index.js';
import type { AgentRuntimeOptions, AgentWorkspace, AgentSharedCausalRecoveryOptions } from '../../src/index.js';

describe('agent checkpoint causal branches', () => {
  let temp: string;
  let domain: ExecutionDomain;
  let runtime: AgentRuntime;
  let graph: WorkspaceCausalGraph;
  let workspace: AgentWorkspace;
  const open = (options: Partial<AgentRuntimeOptions> = {}) => {
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1,
      step: async (agent) => ({ status: 'ready', checkpoint: agent.stepsUsed }), ...options });
  };
  const node = (dependsOn: number[] = []) => graph.record({ txId: 'tx', actorId: 'a', dependsOn,
    observation: { kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'value' } });
  const create = (causalHeads?: number[] | null) => runtime.create({ id: 'a', runId: 'run',
    input: null, checkpoint: 'initial', workspace, causalHeads, maxSteps: 3 });
  beforeEach(async () => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-causal-checkpoint-')));
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'input'), 'value');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: root });
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    workspace = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'tx', runId: 'run', root, forkPath: path.join(temp, 'fork') });
    graph = new WorkspaceCausalGraph(domain);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    runtime?.close();
    domain.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('reconstructs cleanup outcomes with exact lineage, cutoffs and domain reopen', () => {
    const record = (type: string, payload: Record<string, unknown>) => domain.getStore().recordJournalEvent({
      domainId: domain.domainId, type, timestamp: new Date().toISOString(), payload,
    });
    const request = () => record('AGENT_CAUSAL_FORK_CLEANUP_REQUESTED', {
      txId: 'tx', atSeq: 0, forkRoot: workspace.forkRoot, baseSnapshotId: 'baseline', preserveBaseline: true,
    });
    const first = request();
    record('TX_ABORTED', { txId: 'other', reason: `causal fork cleanup request ${first}` });
    record('TX_ABORTED', { txId: 'tx', reason: 'aborted by host' });
    expect(listAgentCausalForkCleanups(domain)[0].status).toBe('pending');
    const aborted = record('TX_ABORTED', { txId: 'tx', reason: `causal fork cleanup request ${first}` });
    const second = request();
    const failed = record('AGENT_CAUSAL_FORK_CLEANUP_FAILED', { txId: 'tx', requestSeq: second, error: 'disk unavailable' });
    const third = request();
    const before = domain.getStore().getJournalEvents(domain.domainId);
    const history = listAgentCausalForkCleanups(domain, { runId: 'run', txId: 'tx' });
    expect(history).toMatchObject([
      { requestSeq: first, status: 'aborted', outcomeSeq: aborted },
      { requestSeq: second, status: 'failed', outcomeSeq: failed, error: 'disk unavailable' },
      { requestSeq: third, status: 'pending' },
    ]);
    expect(listAgentCausalForkCleanups(domain, { atSeq: first })).toMatchObject([{ status: 'pending' }]);
    expect(listAgentCausalForkCleanups(domain, { runId: 'other' })).toEqual([]);
    expect(listAgentCausalForkCleanups(domain, { txId: 'other' })).toEqual([]);
    expect(() => listAgentCausalForkCleanups(domain, { atSeq: -1 })).toThrow('sequence');
    expect(domain.getStore().getJournalEvents(domain.domainId)).toEqual(before);
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    expect(listAgentCausalForkCleanups(domain)).toEqual(history);
  });

  it('queries historical workspace references across restore and reopen', async () => {
    open();
    create([]);
    const created = runtime.checkpoints('a')[0].seq;
    runtime.pause('a');
    runtime.restoreCheckpoint('a', created);
    const restored = runtime.checkpoints('a').at(-1)!.seq;
    const refs = listAgentCheckpointWorkspaceReferences(domain);
    expect(refs.map(ref => [ref.checkpointSeq, ref.current])).toEqual([[created, false], [restored, true]]);
    expect(refs[0]).toMatchObject({ agentId: 'a', runId: 'run', txId: 'tx', baseline: {
      beginSeq: (workspace as import('../../src/index.js').WorkspaceTransaction).beginSeq,
      snapshotId: (workspace as import('../../src/index.js').WorkspaceTransaction).baseSnapshotId,
    } });
    expect(listAgentCheckpointWorkspaceReferences(domain, { atSeq: created })[0].current).toBe(true);
    expect(listAgentCheckpointWorkspaceReferences(domain, { txId: 'absent' })).toEqual([]);
    expect(listAgentCheckpointWorkspaceReferences(domain, { runId: 'absent' })).toEqual([]);
    expect(() => listAgentCheckpointWorkspaceReferences(domain, { atSeq: NaN })).toThrow('sequence');
    expect(() => planAgentCausalResourceCleanup(domain, { atSeq: -1 })).toThrow('sequence');
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    expect(listAgentCheckpointWorkspaceReferences(domain)).toEqual(refs);
    expect(planAgentCausalResourceCleanup(domain).resources).toEqual([]);
  });

  it('rejects unknown refresh identities without invoking host binding', async () => {
    open();
    const bind = vi.fn(async () => undefined);
    await expect(resumeAgentSharedCausalRefresh(runtime, 999999, bind)).rejects.toThrow('Unknown causal refresh plan');
    await expect(retryAgentSharedCausalRefresh(runtime, 999999, { agentId: 'a', failureSeq: 1 }, bind))
      .rejects.toThrow('Unknown causal refresh plan');
    expect(bind).not.toHaveBeenCalled();
  });

  it.each(['success', 'failed_again', 'interrupted', 'closed', 'advanced', 'intent_failed'] as const)(
    'explicitly retries only the selected durable failure: %s', async (mode) => {
    const source = node();
    open();
    for (const id of ['first', 'second']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      runtime.pause(id);
    }
    const supervisor = new ProcessSupervisor(domain);
    const execute = vi.fn(async (entry: import('../../src/index.js').CausalNode) => ({
      actorId: entry.actorId, observation: { ...entry.observation, resultHash: 'new' },
    }));
    const result = await refreshAgentSharedCausalBatch(runtime, supervisor, {
      agentIds: ['first', 'second'],
      validation: { txId: 'probe', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'probe'),
        closedWorld: true, replayPolicy: 'deterministic', replay: async () => 'new' },
      prepare: plan => prepareWorkspaceBranchRepair(supervisor, {
        txId: 'shared', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'shared'),
        atSeq: Math.max(...plan.affected.map(entry => entry.checkpoint.seq)), changed: plan.changed,
        branches: plan.affected.map(entry => ({ id: entry.agentId, heads: entry.checkpoint.causalHeads! })),
        validateReuse: async () => {}, execute,
      }),
      bind: async () => { throw new Error('initial failure'); },
    });
    if (result.status !== 'recovered') throw new Error(result.status);
    const initial = listAgentCausalRefreshExecutions(domain)[0];
    const failed = initial.publications[1];
    if (failed.status !== 'failed') throw new Error('expected failure');
    const failure = { agentId: 'second', failureSeq: failed.seq };
    const usage = runtime.getRunUsage('run');
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    const bind = vi.fn<AgentSharedCausalRecoveryOptions['bind']>(async (_impact, _repair, attempt) => {
      await expect(retryAgentSharedCausalRefresh(runtime, result.planSeq, failure, bind)).rejects.toThrow('already active');
      if (mode === 'failed_again' || mode === 'interrupted') throw new Error('retry failure');
      const txId = `retry-${attempt!.attemptSeq}`;
      attempt!.reserveTransaction(txId);
      return { checkpoint: 'retried', workspace: await new ProcessSupervisor(domain).beginWorkspaceTransaction({
        txId, runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, txId),
      }) };
    });
    await expect(retryAgentSharedCausalRefresh(runtime, result.planSeq, { ...failure, failureSeq: failed.seq - 1 }, bind))
      .rejects.toThrow('failure changed');
    if (mode === 'closed') await new ProcessSupervisor(domain).abortWorkspaceTransaction('shared', 'test');
    if (mode === 'advanced') runtime.restoreCheckpoint('second', failed.checkpointSeq);
    if (mode === 'interrupted' || mode === 'intent_failed') {
      const store = domain.getStore();
      const record = store.recordJournalEvent.bind(store);
      vi.spyOn(store, 'recordJournalEvent').mockImplementation(event => {
        if (event.type === (mode === 'interrupted' ? 'AGENT_CAUSAL_REFRESH_OUTCOME' : 'AGENT_CAUSAL_BINDING_RETRY_REQUESTED')) {
          throw new Error('disk unavailable');
        }
        return record(event);
      });
    }
    if (mode === 'closed' || mode === 'intent_failed') {
      await expect(retryAgentSharedCausalRefresh(runtime, result.planSeq, failure, bind))
        .rejects.toThrow(mode === 'closed' ? 'open transaction' : 'disk unavailable');
      expect(bind).not.toHaveBeenCalled();
      expect(listAgentCausalRefreshExecutions(domain)[0].publications).toEqual(initial.publications);
      return;
    }
    if (mode === 'interrupted') {
      await expect(retryAgentSharedCausalRefresh(runtime, result.planSeq, failure, bind)).rejects.toThrow('disk unavailable');
      vi.restoreAllMocks();
      runtime.close(); domain.close();
      domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
      open();
      expect(listAgentCausalRefreshExecutions(domain)[0].publications[1]).toMatchObject({ status: 'pending' });
      const resumed = await resumeAgentSharedCausalRefresh(runtime, result.planSeq, async () => undefined);
      expect(resumed.outcomes).toMatchObject([{ agentId: 'second', status: 'skipped' }]);
    } else {
      const retried = await retryAgentSharedCausalRefresh(runtime, result.planSeq, failure, bind);
      expect(retried.outcomes).toMatchObject([{ agentId: 'second',
        status: mode === 'advanced' ? 'skipped' : mode === 'failed_again' ? 'failed' : 'repaired' }]);
      if (mode === 'failed_again') {
        const latest = listAgentCausalRefreshExecutions(domain)[0].publications[1];
        if (latest.status !== 'failed') throw new Error('expected second failure');
        await retryAgentSharedCausalRefresh(runtime, result.planSeq,
          { agentId: 'second', failureSeq: latest.seq }, async () => undefined);
      }
    }
    await expect(retryAgentSharedCausalRefresh(runtime, result.planSeq, failure, bind)).rejects.toThrow('failure changed');
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const intent = events.find(event => event.type === 'AGENT_CAUSAL_BINDING_RETRY_REQUESTED')!;
    expect(listAgentCausalRefreshExecutions(domain, { atSeq: intent.seq - 1 })[0].publications).toEqual(initial.publications);
    expect(listAgentCausalRefreshExecutions(domain, { atSeq: intent.seq })[0].publications[1])
      .toMatchObject({ status: 'pending', retrySeq: intent.seq });
    expect(listAgentCausalRefreshExecutions(domain)[0].publications[0]).toEqual(initial.publications[0]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    const savedExecutions = listAgentCausalRefreshExecutions(domain);
    const savedAttempts = listAgentCausalBindingAttempts(domain, { planSeq: result.planSeq });
    expect(savedAttempts).toHaveLength(mode === 'advanced' ? 2 : mode === 'failed_again' || mode === 'interrupted' ? 4 : 3);
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(listAgentCausalRefreshExecutions(domain)).toEqual(savedExecutions);
    expect(listAgentCausalBindingAttempts(domain, { planSeq: result.planSeq })).toEqual(savedAttempts);
    if (mode === 'success') {
      domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: 'run',
        type: intent.type, timestamp: new Date().toISOString(), payload: intent.payload });
      expect(() => listAgentCausalRefreshExecutions(domain)).toThrow('Invalid causal binding retry reference');
    }
  });

  it.each(['resume', 'advanced', 'closed', 'legacy', 'allocated', 'reservation_failed', 'validated', 'stale', 'probe_failed', 'probe_advanced', 'probe_closed'] as const)('resumes pending publication after reopen: %s', async (mode) => {
    const source = node();
    open();
    for (const id of ['first', 'second']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', maxSteps: 2, causalHeads: [source.seq] });
      runtime.pause(id);
    }
    const supervisor = new ProcessSupervisor(domain);
    const store = domain.getStore();
    const record = store.recordJournalEvent.bind(store);
    vi.spyOn(store, 'recordJournalEvent').mockImplementation(event => {
      if (event.type === 'AGENT_CAUSAL_REFRESH_OUTCOME') throw new Error('outcome disk failure');
      if (mode === 'reservation_failed' && event.type === 'AGENT_CAUSAL_BINDING_RESERVED'
        && event.payload.txId === 'second-bound') throw new Error('reservation disk failure');
      if (mode === 'legacy' && event.type === 'AGENT_CAUSAL_REFRESH_PREPARED') {
        const { repair: _repair, ...payload } = event.payload;
        return record({ ...event, payload });
      }
      return record(event);
    });
    await expect(refreshAgentSharedCausalBatch(runtime, supervisor, {
      agentIds: ['first', 'second'],
      validation: { txId: 'probe', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'probe'),
        closedWorld: true, replayPolicy: 'deterministic', replay: async () => 'new' },
      prepare: plan => prepareWorkspaceBranchRepair(supervisor, {
        txId: 'shared', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'shared'),
        atSeq: Math.max(...plan.affected.map(entry => entry.checkpoint.seq)), changed: plan.changed,
        branches: plan.affected.map(entry => ({ id: entry.agentId, heads: entry.checkpoint.causalHeads! })),
        validateReuse: async () => {}, execute: async entry => ({ actorId: entry.actorId,
          observation: { ...entry.observation, resultHash: 'new' } }),
      }),
      bind: async ({ agentId }, _repair, attempt) => {
        expect(attempt).toBeDefined();
        expect(() => attempt!.reserveTransaction('')).toThrow('nonempty');
        expect(() => attempt!.reserveTransaction('shared')).toThrow('already allocated');
        attempt!.reserveTransaction(`${agentId}-bound`);
        expect(() => attempt!.reserveTransaction(`${agentId}-bound`)).toThrow('already allocated');
        if (agentId === 'second') {
          if (mode === 'allocated') await supervisor.beginWorkspaceTransaction({
            txId: 'second-bound', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'second-bound'),
          });
          throw new Error('process interrupted before publication');
        }
        return { checkpoint: 'first-new', workspace: await supervisor.beginWorkspaceTransaction({
          txId: 'first-bound', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'first-bound'),
        }) };
      },
    })).rejects.toThrow('outcome disk failure');
    vi.restoreAllMocks();
    const execution = listAgentCausalRefreshExecutions(domain)[0];
    expect(execution.publications.map(entry => entry.status)).toEqual(['repaired', 'pending']);
    const first = runtime.checkpoints('first').at(-1);
    const attempts = listAgentCausalBindingAttempts(domain);
    const resourcePlan = planAgentCausalResourceCleanup(domain, { planSeq: execution.seq });
    expect(resourcePlan.resources.find(entry => entry.txId === 'shared'))
      .toMatchObject({ disposition: 'retain', reasons: ['shared_repair'] });
    expect(resourcePlan.resources.find(entry => entry.txId === 'first-bound'))
      .toMatchObject({ disposition: 'retain', reasons: ['current_checkpoint'] });
    if (mode !== 'reservation_failed') expect(resourcePlan.resources.find(entry => entry.txId === 'second-bound'))
      .toMatchObject({ disposition: 'retain', reasons: ['pending_publication'] });
    expect(planAgentCausalResourceCleanup(domain, { runId: 'other' }).resources).toEqual([]);
    if (mode === 'allocated') {
      await expect(cleanupAgentCausalFork(supervisor, { txId: 'shared', atSeq: resourcePlan.atSeq })).rejects.toThrow('retained');
      await expect(cleanupAgentCausalFork(supervisor, { txId: 'first-bound', atSeq: resourcePlan.atSeq })).rejects.toThrow('retained');
      await expect(cleanupAgentCausalFork(supervisor, { txId: 'second-bound', atSeq: resourcePlan.atSeq })).rejects.toThrow('retained');
    }
    expect(attempts).toHaveLength(2);
    expect(attempts[0].reservations[0]).toMatchObject({ txId: 'first-bound', state: 'open', referencedBy: ['first'] });
    if (mode === 'reservation_failed') {
      expect(attempts[1].reservations).toEqual([]);
      expect(fs.existsSync(path.join(temp, 'second-bound'))).toBe(false);
    } else expect(attempts[1].reservations[0]).toMatchObject({ txId: 'second-bound',
      state: mode === 'allocated' ? 'open' : 'reserved', referencedBy: [] });
    expect(listAgentCausalBindingAttempts(domain, { atSeq: attempts[0].seq })[0].reservations).toEqual([]);
    expect(listAgentCausalBindingAttempts(domain, { atSeq: attempts[0].reservations[0].seq })[0].reservations[0].state).toBe('reserved');
    expect(listAgentCausalBindingAttempts(domain, { runId: 'other' })).toEqual([]);
    expect(() => listAgentCausalBindingAttempts(domain, { atSeq: -1 })).toThrow('sequence');
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(listAgentCausalBindingAttempts(domain)).toEqual(attempts);
    expect(planAgentCausalResourceCleanup(domain, { planSeq: execution.seq })).toEqual(resourcePlan);
    const usage = runtime.getRunUsage('run');
    if (mode === 'advanced') runtime.restoreCheckpoint('second', runtime.checkpoints('second').at(-1)!.seq);
    if (mode === 'closed') domain.getStore().recordJournalEvent({ domainId: domain.domainId,
      runId: 'run', type: 'TX_ABORTED', timestamp: new Date().toISOString(), payload: { txId: 'shared' } });
    let savedAttempt: import('../../src/index.js').AgentCausalBindingAttempt | undefined;
    const bind = vi.fn(async ({ agentId }: { agentId: string }, _repair: unknown,
      attempt?: import('../../src/index.js').AgentCausalBindingAttempt) => {
      savedAttempt = attempt;
      expect(attempt!.attemptSeq).toBeGreaterThan(attempts[1].seq);
      if (mode !== 'reservation_failed') expect(() => attempt!.reserveTransaction('second-bound')).toThrow('already allocated');
      attempt!.reserveTransaction('second-resumed');
      expect(agentId).toBe('second');
      await expect(resumeAgentSharedCausalRefresh(runtime, execution.seq, bind)).rejects.toThrow('already active');
      return { checkpoint: 'second-new', workspace: await new ProcessSupervisor(domain).beginWorkspaceTransaction({
        txId: 'second-resumed', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'second-resumed'),
      }) };
    });
    if (mode === 'closed' || mode === 'legacy') {
      await expect(resumeAgentSharedCausalRefresh(runtime, execution.seq, bind))
        .rejects.toThrow(mode === 'closed' ? 'open transaction' : 'no durable repair');
      expect(bind).not.toHaveBeenCalled();
      return;
    }
    if (['validated', 'stale', 'probe_failed', 'probe_advanced', 'probe_closed'].includes(mode)) {
      const supervisor = new ProcessSupervisor(domain);
      fs.writeFileSync(path.join(temp, 'repo', 'input'), mode === 'stale' ? 'changed-again' : 'new');
      const replay = vi.fn(async (_entry: unknown, root: string) => {
        await expect(resumeAgentSharedCausalRefresh(runtime, execution.seq, bind)).rejects.toThrow('already active');
        if (mode === 'probe_failed') throw new Error('read unavailable');
        if (mode === 'probe_advanced') runtime.restoreCheckpoint('second', runtime.checkpoints('second').at(-1)!.seq);
        if (mode === 'probe_closed') await supervisor.abortWorkspaceTransaction('shared', 'closed during probe');
        return fs.readFileSync(path.join(root, 'input'), 'utf8');
      });
      const options = { validation: { txId: 'resume-check', runId: 'run', root: path.join(temp, 'repo'),
        forkPath: path.join(temp, 'resume-check'), closedWorld: true as const,
        replayPolicy: 'deterministic' as const, replay }, bind };
      if (mode === 'probe_closed') {
        await expect(resumeAgentSharedCausalRefreshWithValidation(runtime, supervisor, execution.seq, options))
          .rejects.toThrow('open transaction');
        expect(bind).not.toHaveBeenCalled();
        return;
      }
      const checked = await resumeAgentSharedCausalRefreshWithValidation(runtime, supervisor, execution.seq, options);
      expect(checked.status).toBe(mode === 'stale' ? 'stale' : mode === 'probe_failed' ? 'validation_failed' : 'resumed');
      expect(replay).toHaveBeenCalledTimes(1);
      expect(runtime.checkpoints('first').at(-1)).toEqual(first);
      if (checked.status === 'completed') throw new Error('expected validation');
      expect(checked.validation.sourceBranches).toEqual([
        { id: 'second', heads: (domain.getStore().getJournalEvent(domain.domainId, execution.repair!.seq)!.payload.repair as import('../../src/index.js').WorkspaceBranchRepairResult).branches.find(branch => branch.id === 'second')!.heads },
      ]);
      const linked = domain.getStore().getJournalEvent(domain.domainId, checked.validationSeq);
      expect(linked?.payload).toMatchObject({ planSeq: execution.seq, preparationSeq: execution.repair!.seq,
        validationSeq: checked.validation.seq, status: checked.status });
      if (checked.status === 'resumed') {
        expect(checked.batch.outcomes[0]).toMatchObject(mode === 'probe_advanced'
          ? { status: 'skipped', reason: 'checkpoint_changed' } : { status: 'repaired' });
        const completed = await resumeAgentSharedCausalRefreshWithValidation(runtime, supervisor, execution.seq, options);
        expect(completed.status).toBe('completed');
        expect(replay).toHaveBeenCalledTimes(1);
      } else {
        expect(bind).not.toHaveBeenCalled();
        expect(checked.validation.changed).toHaveLength(mode === 'stale' ? 1 : 0);
        expect(listAgentCausalRefreshExecutions(domain)[0].publications[1].status).toBe('pending');
        runtime.close(); domain.close();
        domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
        open();
        expect(domain.getStore().getJournalEvent(domain.domainId, checked.validationSeq)).toEqual(linked);
        fs.writeFileSync(path.join(temp, 'repo', 'input'), 'new');
        const recovered = await resumeAgentSharedCausalRefreshWithValidation(runtime, new ProcessSupervisor(domain), execution.seq, {
          ...options, validation: { ...options.validation, txId: 'recheck', forkPath: path.join(temp, 'recheck'),
            replay: async (_entry, root) => fs.readFileSync(path.join(root, 'input'), 'utf8') },
        });
        expect(recovered.status).toBe('resumed');
        expect(bind).toHaveBeenCalledTimes(1);
      }
      expect(runtime.getRunUsage('run')).toEqual(usage);
      return;
    }
    const result = await resumeAgentSharedCausalRefresh(runtime, execution.seq, bind);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject(mode === 'advanced'
      ? { status: 'skipped', reason: 'checkpoint_changed' } : { status: 'repaired' });
    expect(bind).toHaveBeenCalledTimes(mode === 'advanced' ? 0 : 1);
    if (savedAttempt) expect(() => savedAttempt!.reserveTransaction('late')).toThrow('no longer active');
    expect(listAgentCausalBindingAttempts(domain, { planSeq: execution.seq })).toHaveLength(mode === 'advanced' ? 2 : 3);
    if (mode === 'allocated') {
      const beforeQuery = domain.getStore().getJournalEvents(domain.domainId);
      expect(planAgentCausalResourceCleanup(domain, { planSeq: execution.seq }).resources
        .find(entry => entry.txId === 'second-bound')).toMatchObject({ disposition: 'review', reasons: [], state: 'open' });
      expect(domain.getStore().getJournalEvents(domain.domainId)).toEqual(beforeQuery);
      expect(planAgentCausalResourceCleanup(domain, { planSeq: execution.seq, atSeq: resourcePlan.atSeq })).toEqual(resourcePlan);
      // A different Run can retain this baseline even though the candidate has no direct binding.
      domain.getStore().saveRun({ id: 'other', taskId: 'task', domainId: domain.domainId,
        owner: 'test', status: 'running', startedAt: new Date().toISOString() });
      const orphanBegin = beforeQuery.find(event => event.type === 'TX_BEGUN' && event.payload.txId === 'second-bound')!;
      const external = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'external', runId: 'other',
        root: path.join(temp, 'repo'), forkPath: path.join(temp, 'external'),
        baseSnapshotId: orphanBegin.payload.baseSnapshotId as string });
      runtime.create({ id: 'external', runId: 'other', input: null, checkpoint: null, workspace: external, maxSteps: 1 });
      const protectedResource = planAgentCausalResourceCleanup(domain, { runId: 'run', planSeq: execution.seq })
        .resources.find(entry => entry.txId === 'second-bound')!;
      expect(protectedResource).toMatchObject({ disposition: 'retain', reasons: ['referenced_baseline'] });
      expect(protectedResource.references).toMatchObject([{ agentId: 'external', runId: 'other', txId: 'external' }]);
      expect(protectedResource.fork).toEqual({ disposition: 'review', reasons: [] });
      await expect(cleanupAgentCausalFork(new ProcessSupervisor(domain), {
        txId: 'second-bound', atSeq: resourcePlan.atSeq,
      })).rejects.toThrow('stale');
      const cleanupPlan = planAgentCausalResourceCleanup(domain);
      const recordCleanup = domain.getStore().recordJournalEvent.bind(domain.getStore());
      vi.spyOn(domain.getStore(), 'recordJournalEvent').mockImplementation(event => {
        if (event.type === 'AGENT_CAUSAL_FORK_CLEANUP_REQUESTED') throw new Error('cleanup journal unavailable');
        return recordCleanup(event);
      });
      await expect(cleanupAgentCausalFork(new ProcessSupervisor(domain), {
        txId: 'second-bound', atSeq: cleanupPlan.atSeq,
      })).rejects.toThrow('cleanup journal unavailable');
      expect(fs.existsSync(path.join(temp, 'second-bound'))).toBe(true);
      vi.restoreAllMocks();
      const failingSupervisor = new ProcessSupervisor(domain);
      vi.spyOn(failingSupervisor, 'abortWorkspaceTransaction').mockRejectedValue(new Error('disk unavailable'));
      await expect(cleanupAgentCausalFork(failingSupervisor, {
        txId: 'second-bound', atSeq: cleanupPlan.atSeq,
      })).rejects.toThrow('disk unavailable');
      expect(listAgentCausalForkCleanups(domain, { txId: 'second-bound' }))
        .toMatchObject([{ status: 'failed', error: 'disk unavailable' }]);
      expect(fs.existsSync(path.join(temp, 'second-bound'))).toBe(true);
      vi.spyOn(domain.getStore(), 'recordJournalEvent').mockImplementation(event => {
        if (event.type === 'AGENT_CAUSAL_FORK_CLEANUP_FAILED') throw new Error('outcome journal unavailable');
        return recordCleanup(event);
      });
      await expect(cleanupAgentCausalFork(failingSupervisor, {
        txId: 'second-bound', atSeq: planAgentCausalResourceCleanup(domain).atSeq,
      })).rejects.toBeInstanceOf(AggregateError);
      expect(listAgentCausalForkCleanups(domain, { txId: 'second-bound' }).at(-1)?.status).toBe('pending');
      vi.restoreAllMocks();
      const cleaned = await cleanupAgentCausalFork(new ProcessSupervisor(domain), {
        txId: 'second-bound', atSeq: planAgentCausalResourceCleanup(domain).atSeq,
      });
      expect(listAgentCausalForkCleanups(domain, { txId: 'second-bound' }).at(-1))
        .toMatchObject({ requestSeq: cleaned.requestSeq, status: 'aborted' });
      expect(fs.existsSync(path.join(temp, 'second-bound'))).toBe(false);
      expect(domain.getStore().getJournalEvents(domain.domainId).find(event => event.seq === cleaned.requestSeq))
        .toMatchObject({ type: 'AGENT_CAUSAL_FORK_CLEANUP_REQUESTED', payload: { preserveBaseline: true } });
      await expect(cleanupAgentCausalFork(new ProcessSupervisor(domain), {
        txId: 'second-bound', atSeq: planAgentCausalResourceCleanup(domain).atSeq,
      })).rejects.toThrow('open or conflicted');
      expect(listAgentCausalBindingAttempts(domain)[1].reservations[0].state).toBe('aborted');
      expect(listAgentCausalBindingAttempts(domain, { atSeq: attempts[1].reservations[0].seq })[1].reservations[0].state).toBe('reserved');
    }
    expect(runtime.checkpoints('first').at(-1)).toEqual(first);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(listAgentCausalRefreshExecutions(domain)[0].publications.map(entry => entry.status))
      .toEqual(['repaired', mode === 'advanced' ? 'skipped' : 'repaired']);
    expect((await resumeAgentSharedCausalRefresh(runtime, execution.seq, bind)).outcomes).toEqual([]);
    expect(listAgentCausalRefreshExecutions(domain, { atSeq: execution.repair!.seq })[0].publications
      .map(entry => entry.status)).toEqual(['pending', 'pending']);
    if (mode === 'allocated') {
      const replacement = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'replacement', runId: 'run',
        root: path.join(temp, 'repo'), forkPath: path.join(temp, 'replacement') });
      runtime.restoreCheckpoint('first', first!.seq, replacement);
      const historical = planAgentCausalResourceCleanup(domain, { planSeq: execution.seq }).resources
        .find(entry => entry.txId === 'first-bound')!;
      expect(historical).toMatchObject({ disposition: 'retain', reasons: ['historical_checkpoint'] });
      expect(historical.references).toMatchObject([{ checkpointSeq: first!.seq, current: false }]);
      expect(historical.fork).toEqual({ disposition: 'review', reasons: [] });
      await cleanupAgentCausalFork(new ProcessSupervisor(domain), {
        txId: 'first-bound', atSeq: planAgentCausalResourceCleanup(domain).atSeq,
      });
      expect(fs.existsSync(path.join(temp, 'first-bound'))).toBe(false);
      // Replay starts from the preserved baseline after both fork removal and domain reopen.
      runtime.close(); domain.close();
      domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
      open();
      const debug = await forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
        sourceAgentId: 'first', checkpointSeq: first!.seq, agentId: 'debug-cleaned', txId: 'debug-cleaned',
        forkPath: path.join(temp, 'debug-cleaned'), maxSteps: 1, replayPolicy: 'deterministic',
        observations: () => ({ closedWorld: true, log: [{ kind: 'observe',
          call: { tool: 'read', args: {} }, resultHash: 'value' }],
          replay: async (_entry, root) => fs.readFileSync(path.join(root, 'input'), 'utf8') }),
      });
      expect(debug.status).toBe('forked');
      if (debug.status === 'forked') expect(fs.readFileSync(path.join(debug.transaction.forkRoot, 'input'), 'utf8')).toBe('value');

      const cutoff = planAgentCausalResourceCleanup(domain, { planSeq: execution.seq });
      runtime.close(); domain.close();
      domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
      open();
      expect(planAgentCausalResourceCleanup(domain, { planSeq: execution.seq, atSeq: cutoff.atSeq })).toEqual(cutoff);
    }
  });

  it.each(['repaired', 'failed', 'skipped', 'publication_failed'] as const)('tracks shared publication with second binding %s durably', async (mode) => {
    const secondStatus = mode === 'publication_failed' ? 'failed' : mode;
    const source = node();
    const derived = node([source.seq]);
    open();
    for (const [id, heads] of [['first', [derived.seq]], ['second', [source.seq]], ['excluded', [source.seq]], ['unknown', null]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', maxSteps: 2,
        causalHeads: heads === null ? null : [...heads] });
      runtime.pause(id);
    }
    const supervisor = new ProcessSupervisor(domain);
    const usage = runtime.getRunUsage('run');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'new');
    const executed: number[] = [];
    if (mode === 'publication_failed') {
      const store = domain.getStore();
      const record = store.recordJournalEvent.bind(store);
      vi.spyOn(store, 'recordJournalEvent').mockImplementation(event => {
        if (event.type === 'AGENT_STATE' && event.payload.transition === 'causal_repaired'
          && (event.payload.state as { id: string }).id === 'second') {
          record(event); // Simulate failure after insertion, before transaction commit.
          throw new Error('checkpoint disk failure');
        }
        return record(event);
      });
    }
    const result = await refreshAgentSharedCausalBatch(runtime, supervisor, {
      agentIds: ['first', 'second', 'unknown'],
      validation: { txId: 'probe', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'probe'),
        closedWorld: true, replayPolicy: 'deterministic', replayReuse: 'baseline_observations',
        replay: async (_, root) => fs.readFileSync(path.join(root, 'input'), 'utf8') },
      prepare: (plan) => prepareWorkspaceBranchRepair(supervisor, {
        txId: 'shared', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'shared'),
        atSeq: Math.max(...plan.affected.map(({ checkpoint }) => checkpoint.seq)), changed: plan.changed,
        branches: plan.affected.map(({ agentId, checkpoint }) => ({ id: agentId, heads: checkpoint.causalHeads! })),
        validateReuse: async () => {}, execute: async (entry) => {
          executed.push(entry.seq);
          return { actorId: entry.actorId, observation: { ...entry.observation, resultHash: 'new' } };
        },
      }),
      bind: async ({ agentId }) => {
        if (agentId === 'second' && mode === 'failed') throw new Error('binding unavailable');
        if (agentId === 'second' && secondStatus === 'skipped') return undefined;
        return { checkpoint: 'new', workspace: await supervisor.beginWorkspaceTransaction({
        txId: `bound-${agentId}`, runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, `bound-${agentId}`),
      }) }; },
    });
    expect(result.status).toBe('recovered');
    if (result.status !== 'recovered') throw new Error(result.status);
    expect(result.validation).toMatchObject({ changed: [source.seq], replayedSteps: 1, reusedSteps: 1 });
    expect(result.preview.untracked).toEqual(['unknown']);
    expect(result.preview.affected.map(({ agentId }) => agentId)).toEqual(['first', 'second']);
    expect(result.preview.affected[0].recomputation.explanations.at(-1)).toEqual({ nodeSeq: derived.seq,
      causes: [{ changedSeq: source.seq, path: [source.seq, derived.seq] }] });
    expect(executed).toEqual([source.seq, derived.seq]);
    expect(result.batch.outcomes.map(({ status }) => status)).toEqual(['repaired', secondStatus]);
    expect(runtime.get('excluded')!.checkpoint).toBe('old');
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(fs.existsSync(path.join(temp, 'probe', '0'))).toBe(false);
    if (mode === 'publication_failed') expect(runtime.get('second')!.checkpoint).toBe('old');
    const execution = listAgentCausalRefreshExecutions(domain)[0];
    expect(execution.repair).toMatchObject({ txId: 'shared' });
    expect(execution.publications.map(entry => entry.status)).toEqual(['repaired', secondStatus]);
    expect(listAgentCausalRefreshExecutions(domain, { atSeq: result.planSeq })[0].publications
      .map(entry => entry.status)).toEqual(['pending', 'pending']);
    expect(listAgentCausalRefreshExecutions(domain, { atSeq: execution.repair!.seq })[0].publications
      .map(entry => entry.status)).toEqual(['pending', 'pending']);
    if (mode === 'publication_failed') expect(execution.publications[1]).toMatchObject({
      status: 'failed', error: 'Error: checkpoint disk failure',
    });
    const first = execution.publications[0];
    if (first.status !== 'repaired') throw new Error('missing publication');
    const publication = domain.getStore().getJournalEvent(domain.domainId, first.seq)!;
    expect(publication.payload).toMatchObject({ transition: 'causal_repaired',
      refreshPreparationSeq: execution.repair!.seq, checkpointRef: first.checkpointSeq });
    expect(listAgentCausalRefreshExecutions(domain, { atSeq: first.seq })[0].publications
      .map(entry => entry.status)).toEqual(['repaired', 'pending']);
    expect(listAgentCausalRefreshExecutions(domain, { runId: 'other' })).toEqual([]);
    const saved = runtime.checkpoints('first').at(-1);
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    const beforeQuery = domain.getStore().getJournalEvents(domain.domainId);
    expect(listAgentCausalRefreshExecutions(domain)[0]).toEqual(execution);
    const records = listAgentCausalRefreshPlans(domain);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ seq: result.planSeq, validationSeq: result.validation.seq, preview: result.preview });
    expect(listAgentCausalRefreshPlans(domain, { atSeq: result.planSeq - 1 })).toEqual([]);
    expect(listAgentCausalRefreshPlans(domain, { atSeq: result.planSeq, runId: 'run' })).toEqual(records);
    expect(listAgentCausalRefreshPlans(domain, { runId: 'other' })).toEqual([]);
    records[0].preview.affected[0].checkpoint.checkpoint = 'tampered';
    expect(listAgentCausalRefreshPlans(domain)[0].preview).toEqual(result.preview);
    expect(domain.getStore().getJournalEvents(domain.domainId)).toEqual(beforeQuery);
    open();
    expect(runtime.checkpoints('first').at(-1)).toEqual(saved);
    const terminalBind = vi.fn(async () => undefined);
    expect((await resumeAgentSharedCausalRefresh(runtime, result.planSeq, terminalBind)).outcomes).toEqual([]);
    expect(terminalBind).not.toHaveBeenCalled();
    expect(domain.getStore().getJournalEvent(domain.domainId, result.planSeq)?.payload).toMatchObject({
      validationSeq: result.validation.seq, checkpoints: [{ agentId: 'first' }, { agentId: 'second' }, { agentId: 'unknown' }],
    });
  });

  it.each(['unchanged', 'validation_failed', 'checkpoint_changed'] as const)(
    'does not prepare recovery when probing returns %s', async (status) => {
      const source = node();
      open(); create([source.seq]); runtime.pause('a');
      let prepared = 0;
      const before = runtime.checkpoints('a').at(-1)!;
      const result = await refreshAgentSharedCausalBatch(runtime, new ProcessSupervisor(domain), {
        agentIds: ['a'],
        validation: { txId: 'probe', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'probe'),
          closedWorld: true, replayPolicy: 'deterministic', replay: async () => {
            if (status === 'validation_failed') throw new Error('tool unavailable');
            if (status === 'checkpoint_changed') runtime.restoreCheckpoint('a', before.seq);
            return status === 'unchanged' ? 'value' : 'new';
          } },
        prepare: async () => { prepared++; throw new Error('must not prepare'); }, bind: async () => undefined,
      });
      expect(result.status).toBe(status);
      expect(prepared).toBe(0);
      if (result.status === 'checkpoint_changed') expect(result.agentIds).toEqual(['a']);
      if (result.status === 'validation_failed') expect(result.validation.changed).toEqual([]);
      if (result.status === 'unchanged') {
        expect(result.preview.unaffected).toEqual(['a']);
        expect(listAgentCausalRefreshPlans(domain)[0].preview).toEqual(result.preview);
      }
      expect(fs.existsSync(path.join(temp, 'probe', '0'))).toBe(false);
    },
  );

  it('blocks a mixed changed/failed probe and does not mistake untracked agents for valid evidence', async () => {
    const source = node();
    const sibling = node();
    open(); create([source.seq]); runtime.pause('a');
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: null, maxSteps: 1, causalHeads: [sibling.seq] });
    runtime.create({ id: 'unknown', runId: 'run', input: null, checkpoint: null, maxSteps: 1 });
    let calls = 0;
    const options = { agentIds: ['a', 'b'], validation: { txId: 'probe', runId: 'run',
      root: path.join(temp, 'repo'), forkPath: path.join(temp, 'probe'), closedWorld: true as const,
      replayPolicy: 'deterministic' as const, replay: async () => { if (++calls === 2) throw new Error('offline'); return 'new'; } },
      prepare: async () => { throw new Error('must not prepare'); }, bind: async () => undefined };
    const result = await refreshAgentSharedCausalBatch(runtime, new ProcessSupervisor(domain), options);
    expect(result).toMatchObject({ status: 'validation_failed', validation: { changed: [source.seq] } });
    expect(await refreshAgentSharedCausalBatch(runtime, new ProcessSupervisor(domain), { ...options, agentIds: ['unknown'] }))
      .toEqual({ status: 'untracked', untracked: ['unknown'] });
    await expect(refreshAgentSharedCausalBatch(runtime, new ProcessSupervisor(domain), { ...options, agentIds: ['a', 'a'] }))
      .rejects.toThrow('unique');
    expect(calls).toBe(2);
  });

  it('reconstructs intent after prepare fails, including restored context and historical restart candidates', async () => {
    const source = node();
    const derived = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: { answer: 'old' }, causalHeads: [derived.seq] };
    } });
    create([]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    runtime.restoreCheckpoint('a', runtime.checkpoints('a').at(-1)!.seq);
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: null, maxSteps: 1, causalHeads: [] });
    runtime.create({ id: 'unknown', runId: 'run', input: null, checkpoint: null, maxSteps: 1 });
    const expected = runtime.explainCausalRecovery([source.seq]);
    await expect(refreshAgentSharedCausalBatch(runtime, new ProcessSupervisor(domain), {
      agentIds: ['unknown', 'b', 'a'],
      validation: { txId: 'probe', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'probe'),
        closedWorld: true, replayPolicy: 'deterministic', replay: async () => 'new' },
      prepare: async () => { throw new Error('preparation unavailable'); },
      bind: async () => { throw new Error('must not bind'); },
    })).rejects.toThrow('preparation unavailable');
    const records = listAgentCausalRefreshPlans(domain);
    expect(records[0].preview).toEqual(expected);
    expect(listAgentCausalRefreshExecutions(domain)[0]).toMatchObject({ publications: [
      { agentId: 'a', status: 'pending' },
    ] });
    expect(listAgentCausalRefreshExecutions(domain)[0].repair).toBeUndefined();
    await expect(resumeAgentSharedCausalRefresh(runtime, records[0].seq, async () => undefined))
      .rejects.toThrow('no durable repair');
    expect(records[0].preview.affected[0].restartFrom).toEqual(initial);
    expect(records[0].preview.affected[0].checkpoint.checkpoint).toEqual({ answer: 'old' });
    runtime.restoreCheckpoint('a', initial.seq);
    node([derived.seq]);
    expect(runtime.planCausalRecovery([source.seq]).affected).toEqual([]);
    expect(listAgentCausalRefreshPlans(domain)).toEqual(records);
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    expect(listAgentCausalRefreshPlans(domain)).toEqual(records);
    const original = domain.getStore().getJournalEvent(domain.domainId, records[0].seq)!;
    domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: 'run',
      type: original.type, timestamp: new Date().toISOString(), payload: { ...original.payload,
        checkpoints: [{ agentId: 'another-agent', checkpointSeq: initial.seq }] } });
    expect(() => listAgentCausalRefreshPlans(domain)).toThrow('refresh checkpoint');
    expect(listAgentCausalRefreshPlans(domain, { atSeq: records[0].seq })).toEqual(records);
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid recovery history cutoff %s', (atSeq) => {
    expect(() => listAgentCausalRefreshPlans(domain, { atSeq })).toThrow('history sequence');
  });

  it.each([
    { version: 2 },
    { version: 1, validationSeq: 999, changed: [], checkpoints: [] },
  ])('rejects unsupported or incomplete historical intent $version', (payload) => {
    const seq = domain.getStore().recordJournalEvent({ domainId: domain.domainId, runId: 'run',
      type: 'AGENT_CAUSAL_REFRESH_PLANNED', timestamp: new Date().toISOString(), payload });
    expect(listAgentCausalRefreshPlans(domain, { atSeq: seq - 1 })).toEqual([]);
    expect(() => listAgentCausalRefreshPlans(domain)).toThrow();
  });

  it('compares reconstructed files after source disposal without changing agents or live files', async () => {
    open({ step: async () => {
      fs.unlinkSync(path.join(workspace.forkRoot, 'input'));
      fs.writeFileSync(path.join(workspace.forkRoot, '新文件\n.bin'), Buffer.from([0, 255, 1]));
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'edited', causalHeads: [] };
    } });
    create([]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    const edited = runtime.checkpoints('a').at(-1)!;
    const supervisor = new ProcessSupervisor(domain);
    await supervisor.abortWorkspaceTransaction('tx');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'future');
    const usage = runtime.getRunUsage('run');
    const source = runtime.get('a');
    const result = await compareAgentCheckpointFiles(runtime, supervisor, {
      left: { sourceAgentId: 'a', checkpointSeq: initial.seq, txId: 'compare-left',
        forkPath: path.join(temp, 'compare-left'), replayPolicy: 'deterministic',
        observations: () => ({ closedWorld: true, log: [], replay: async () => '' }) },
      right: { sourceAgentId: 'a', checkpointSeq: edited.seq, txId: 'compare-right',
        forkPath: path.join(temp, 'compare-right'), replayPolicy: 'deterministic',
        observations: () => ({ closedWorld: true,
          log: [{ kind: 'mutate', call: { tool: 'edit', args: {} }, resultHash: 'ok' }],
          replay: async (_, root) => {
            expect(fs.readFileSync(path.join(root, 'input'), 'utf8')).toBe('value');
            fs.unlinkSync(path.join(root, 'input'));
            fs.writeFileSync(path.join(root, '新文件\n.bin'), Buffer.from([0, 255, 1]));
            return 'ok';
          } }) },
    });
    expect(result).toMatchObject({ status: 'compared', replayedSteps: { left: 0, right: 1 },
      files: [{ status: 'D', path: 'input' }, { status: 'A', path: '新文件\n.bin' }] });
    expect(runtime.get('a')).toEqual(source);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(fs.readFileSync(path.join(temp, 'repo', 'input'), 'utf8')).toBe('future');
    for (const side of ['left', 'right']) expect(fs.existsSync(path.join(temp, `compare-${side}`))).toBe(false);
    expect(domain.getStore().getSnapshot('tx-base')).toBeDefined();
  });

  it('compares different baselines within a subdirectory and excludes outside changes', async () => {
    open();
    const supervisor = new ProcessSupervisor(domain);
    const root = path.join(temp, 'repo', 'nested');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'data'), 'old');
    fs.writeFileSync(path.join(root, 'link'), 'regular');
    const refs = [];
    for (const name of ['before', 'after']) {
      if (name === 'after') {
        fs.writeFileSync(path.join(root, 'data'), 'new');
        fs.unlinkSync(path.join(root, 'link'));
        fs.symlinkSync('data', path.join(root, 'link'));
        fs.writeFileSync(path.join(temp, 'repo', 'input'), 'outside change');
      }
      const tx = await supervisor.beginWorkspaceTransaction({ txId: name, runId: 'run', root,
        forkPath: path.join(temp, name) });
      runtime.create({ id: name, runId: 'run', input: null, checkpoint: name,
        workspace: tx, causalHeads: [], maxSteps: 1 });
      refs.push({ sourceAgentId: name, checkpointSeq: runtime.checkpoints(name)[0].seq,
        txId: `compare-${name}`, forkPath: path.join(temp, `compare-${name}`), replayPolicy: 'deterministic' as const,
        observations: () => ({ closedWorld: true as const, log: [], replay: async () => '' }) });
      await supervisor.abortWorkspaceTransaction(name);
    }
    const result = await compareAgentCheckpointFiles(runtime, supervisor, { left: refs[0], right: refs[1] });
    expect(result).toMatchObject({ status: 'compared',
      files: [{ status: 'M', path: 'data' }, { status: 'T', path: 'link' }] });
  });

  it.each(['left', 'right'] as const)('reports %s replay divergence and cleans every prepared fork', async (side) => {
    open(); create([]);
    const checkpointSeq = runtime.checkpoints('a')[0].seq;
    const options = (name: 'left' | 'right') => ({ sourceAgentId: 'a', checkpointSeq,
      txId: `compare-${name}`, forkPath: path.join(temp, `compare-${name}`), replayPolicy: 'deterministic' as const,
      observations: () => ({ closedWorld: true as const,
        log: [{ kind: 'observe' as const, call: { tool: 'read', args: {} }, resultHash: 'value' }],
        replay: async () => name === side ? 'changed' : 'value' }) });
    const result = await compareAgentCheckpointFiles(runtime, new ProcessSupervisor(domain), {
      left: options('left'), right: options('right') });
    expect(result).toMatchObject({ status: 'diverged', side, replay: { divergedAt: 0 } });
    for (const name of ['left', 'right']) expect(fs.existsSync(path.join(temp, `compare-${name}`))).toBe(false);
    expect(runtime.getRunUsage('run').agentsCreated).toBe(1);
  });

  it('compares identical reconstructed worlds and rejects an invalid second log with cleanup', async () => {
    open(); create([]);
    const checkpointSeq = runtime.checkpoints('a')[0].seq;
    const options = (name: string) => ({ sourceAgentId: 'a', checkpointSeq, txId: name,
      forkPath: path.join(temp, name), replayPolicy: 'deterministic' as const,
      observations: () => ({ closedWorld: true as const, log: [], replay: async () => '' }) });
    const supervisor = new ProcessSupervisor(domain);
    expect(await compareAgentCheckpointFiles(runtime, supervisor, {
      left: options('same-left'), right: options('same-right') })).toMatchObject({ status: 'compared', files: [] });
    await expect(compareAgentCheckpointFiles(runtime, supervisor, {
      left: options('bad-left'), right: { ...options('bad-right'), observations: () => ({ closedWorld: true,
        log: [{ kind: 'mutate', call: { tool: 'write', args: {} } }], replay: async () => '' }) },
    })).rejects.toThrow('result hashes');
    expect(fs.existsSync(path.join(temp, 'bad-left'))).toBe(false);
    expect(fs.existsSync(path.join(temp, 'bad-right'))).toBe(false);
  });

  it('compares cross-agent branches with shared evidence, divergence roots and declared writes', async () => {
    const shared = node();
    const left = node([shared.seq]);
    const right = node([shared.seq]); // Identical hashes are still different executions.
    const output = graph.record({ txId: 'tx', actorId: 'b', dependsOn: [right.seq],
      observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'output' },
      writes: [{ status: 'M', path: 'input' }] });
    const sibling = node();
    open(); create([left.seq]);
    const branchWorkspace = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'branch',
      runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'branch') });
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: 'alternative',
      workspace: branchWorkspace, causalHeads: [output.seq], maxSteps: 1 });
    const refs = { left: { agentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq },
      right: { agentId: 'b', checkpointSeq: runtime.checkpoints('b')[0].seq } };
    const count = domain.getStore().getJournalEvents(domain.domainId).length;
    const result = compareAgentCheckpoints(runtime, refs.left, refs.right);
    expect(result.context).toEqual([{ kind: 'changed', path: '', before: 'initial', after: 'alternative' }]);
    expect(result.evidence).toEqual({ status: 'compared', leftHeads: [left.seq], rightHeads: [output.seq],
      shared: [shared], leftOnly: [left], rightOnly: [right, output], leftRoots: [left.seq], rightRoots: [right.seq] });
    expect(JSON.stringify(result.evidence)).not.toContain(`"seq":${sibling.seq}`);
    expect(domain.getStore().getJournalEvents(domain.domainId)).toHaveLength(count);
    result.left.saved.checkpoint = 'tampered';
    if (result.evidence.status === 'compared') result.evidence.shared[0].observation.resultHash = 'tampered';
    expect(runtime.checkpoints('a')[0].checkpoint).toBe('initial');
    expect(graph.nodes()[0].observation.resultHash).toBe('value');
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(compareAgentCheckpoints(runtime, refs.left, refs.right).evidence).toMatchObject({
      shared: [shared], rightOnly: [right, output] });
  });

  it('compares selected historical context with stable JSON pointers and atomic arrays', () => {
    open();
    const before = JSON.parse('{"nested":{"a/b~c":1},"removed":null,"array":[1],"same":{"a":1,"b":2},"__proto__":1}');
    const after = JSON.parse('{"nested":{"a/b~c":2},"added":null,"array":[1,2],"same":{"b":2,"a":1},"__proto__":2}');
    runtime.create({ id: 'a', runId: 'run', input: null, checkpoint: before, causalHeads: [], maxSteps: 1 });
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: after, causalHeads: [], maxSteps: 1 });
    const left = { agentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq };
    const right = { agentId: 'b', checkpointSeq: runtime.checkpoints('b')[0].seq };
    expect(compareAgentCheckpoints(runtime, left, right).context).toEqual([
      { kind: 'changed', path: '/__proto__', before: 1, after: 2 },
      { kind: 'added', path: '/added', after: null },
      { kind: 'changed', path: '/array', before: [1], after: [1, 2] },
      { kind: 'changed', path: '/nested/a~1b~0c', before: 1, after: 2 },
      { kind: 'removed', path: '/removed', before: null },
    ]);
    expect(compareAgentCheckpoints(runtime, left, left)).toMatchObject({ context: [], evidence: {
      status: 'compared', shared: [], leftOnly: [], rightOnly: [], leftRoots: [], rightRoots: [] } });
    expect(() => compareAgentCheckpoints(runtime, left, { ...right, checkpointSeq: left.checkpointSeq })).toThrow('No checkpoint');
  });

  it.each([undefined, null])('keeps missing provenance distinct from an explicitly empty branch (%s)', (heads) => {
    open(); create(heads);
    runtime.create({ id: 'b', runId: 'run', input: null, checkpoint: 'initial', causalHeads: [], maxSteps: 1 });
    const result = compareAgentCheckpoints(runtime,
      { agentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq },
      { agentId: 'b', checkpointSeq: runtime.checkpoints('b')[0].seq });
    expect(result.context).toEqual([]);
    expect(result.evidence).toEqual({ status: 'untracked', left: null, right: { heads: [], nodes: [] } });
  });

  it('compares an ancestor checkpoint without including later or sibling observations', async () => {
    const source = node();
    let output = 0;
    open({ step: async () => {
      output = node([source.seq]).seq;
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'derived', causalHeads: [output] };
    } });
    create([source.seq]);
    const first = runtime.checkpoints('a')[0];
    await runtime.drain();
    const last = runtime.checkpoints('a').at(-1)!;
    node([output]);
    const result = compareAgentCheckpoints(runtime, { agentId: 'a', checkpointSeq: first.seq },
      { agentId: 'a', checkpointSeq: last.seq });
    expect(result.evidence).toMatchObject({ status: 'compared', shared: [source], leftOnly: [],
      rightOnly: [{ seq: output }], leftRoots: [], rightRoots: [output] });
    expect(result.left.saved.stepsUsed).toBe(0);
    expect(result.right.saved.stepsUsed).toBe(1);
  });

  it('forks an old checkpoint from its historical baseline after live changes and source disposal', async () => {
    const source = node();
    const output = graph.record({ txId: 'tx', actorId: 'a', dependsOn: [source.seq],
      observation: { kind: 'mutate', call: { tool: 'write', args: {} }, resultHash: 'derived' },
      writes: [{ status: 'M', path: 'input' }] });
    open({ step: async () => {
      fs.writeFileSync(path.join(workspace.forkRoot, 'input'), 'derived');
      runtime.pause('a');
      return { status: 'ready', checkpoint: { answer: 'derived' }, causalHeads: [output.seq] };
    } });
    create([source.seq]);
    await runtime.drain();
    const saved = runtime.checkpoints('a').at(-1)!;
    const original = runtime.get('a');
    const usage = runtime.getRunUsage('run');
    const supervisor = new ProcessSupervisor(domain);
    await supervisor.abortWorkspaceTransaction('tx');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'future');
    const result = await forkAgentCheckpoint(runtime, supervisor, {
      sourceAgentId: 'a', checkpointSeq: saved.seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: (checkpoint) => {
        expect(checkpoint).toEqual(saved);
        return { closedWorld: true, log: [source.observation, output.observation],
          replay: async (entry, root) => {
            if (entry.kind === 'mutate') fs.writeFileSync(path.join(root, 'input'), 'derived');
            return fs.readFileSync(path.join(root, 'input'), 'utf8');
          } };
      },
    });
    expect(result.status).toBe('forked');
    if (result.status !== 'forked') throw new Error('Expected fork');
    expect(result).toMatchObject({ replayedSteps: 2, agent: { id: 'debug', status: 'ready',
      checkpoint: { answer: 'derived' }, causalHeads: [output.seq], stepsUsed: 0, runId: 'run' } });
    expect(fs.readFileSync(path.join(result.transaction.forkRoot, 'input'), 'utf8')).toBe('derived');
    expect(fs.readFileSync(path.join(temp, 'repo', 'input'), 'utf8')).toBe('future');
    expect(runtime.get('a')).toEqual(original);
    expect(runtime.getRunUsage('run')).toMatchObject({ stepsUsed: usage.stepsUsed, agentsCreated: usage.agentsCreated + 1 });
    expect(domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'AGENT_CHECKPOINT_FORK_PREPARED')?.payload)
      .toMatchObject({ sourceAgentId: 'a', checkpointSeq: saved.seq, agentId: 'debug', txId: 'debug-tx', replayedSteps: 2 });
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.get('debug')).toMatchObject({ status: 'paused', checkpoint: saved.checkpoint, causalHeads: saved.causalHeads });
    expect(runtime.checkpointCausalView('debug', runtime.checkpoints('debug')[0].seq)?.heads).toEqual([output.seq]);
    const comparison = compareAgentCheckpoints(runtime, { agentId: 'a', checkpointSeq: saved.seq },
      { agentId: 'debug', checkpointSeq: runtime.checkpoints('debug')[0].seq });
    expect(comparison).toMatchObject({ context: [], evidence: { status: 'compared', leftOnly: [], rightOnly: [] } });
    expect(comparison.left.saved.workspace?.txId).toBe('tx');
    expect(comparison.right.saved.workspace?.txId).toBe('debug-tx');
  });

  it.each(['hash', 'throw'])('discards a divergent historical replay (%s) and retains the source baseline', async (failure) => {
    const source = node();
    open(); create([source.seq]);
    const saved = runtime.checkpoints('a')[0];
    const baseline = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'TX_BEGUN')!.payload.baseSnapshotId as string;
    const result = await forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
      sourceAgentId: 'a', checkpointSeq: saved.seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [source.observation], replay: async (_entry, root) => {
        fs.writeFileSync(path.join(root, 'input'), 'dirty');
        if (failure === 'throw') throw new Error('adapter failed');
        return 'different';
      } }),
    });
    expect(result).toMatchObject({ status: 'diverged', replay: { divergedAt: 0, matchedSteps: 0,
      ...(failure === 'throw' ? { error: 'adapter failed' } : {}) } });
    expect(runtime.get('debug')).toBeUndefined();
    expect(fs.existsSync(path.join(temp, 'debug'))).toBe(false);
    expect(domain.getStore().getSnapshot(baseline)).toBeDefined();
    expect(fs.readFileSync(path.join(workspace.forkRoot, 'input'), 'utf8')).toBe('value');
  });

  it('cleans a matched fork if agent creation exhausts the shared Run budget', async () => {
    const source = node();
    open({ runBudget: { maxAgents: 1, maxSteps: 10, maxPendingCommands: 1 } });
    create([source.seq]);
    await expect(forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
      sourceAgentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [source.observation], replay: async () => 'value' }),
    })).rejects.toThrow('Run agent budget exhausted');
    expect(runtime.get('debug')).toBeUndefined();
    expect(fs.existsSync(path.join(temp, 'debug'))).toBe(false);
    expect(runtime.getRunUsage('run').agentsCreated).toBe(1);
  });

  it('does not fall back to the live world when the historical snapshot was pruned', async () => {
    const source = node();
    open(); create([source.seq]);
    const supervisor = new ProcessSupervisor(domain);
    const baseline = domain.getStore().getJournalEvents(domain.domainId).find((e) => e.type === 'TX_BEGUN')!.payload.baseSnapshotId as string;
    await supervisor.abortWorkspaceTransaction('tx');
    await supervisor.pruneSnapshots([baseline], { runId: 'run' });
    let replayed = false;
    await expect(forkAgentCheckpoint(runtime, supervisor, {
      sourceAgentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [source.observation], replay: async () => {
        replayed = true; return 'value';
      } }),
    })).rejects.toThrow('base snapshot');
    expect(replayed).toBe(false);
    expect(runtime.get('debug')).toBeUndefined();
    expect(fs.existsSync(path.join(temp, 'debug'))).toBe(false);
  });

  it('replays the selected historical checkpoint and isolates recorded hashes from adapter mutation', async () => {
    const source = node();
    open({ step: async () => { runtime.pause('a'); return { status: 'ready', checkpoint: 'later', causalHeads: [] }; } });
    create([source.seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    const result = await forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), {
      sourceAgentId: 'a', checkpointSeq: initial.seq, agentId: 'debug', txId: 'debug-tx',
      forkPath: path.join(temp, 'debug'), maxSteps: 2, replayPolicy: 'deterministic',
      observations: (checkpoint) => {
        expect(checkpoint.checkpoint).toBe('initial');
        return { closedWorld: true, log: [source.observation], replay: async (entry) => {
          entry.resultHash = 'changed'; return 'changed';
        } };
      },
    });
    expect(result).toMatchObject({ status: 'diverged', replay: { divergedAt: 0 } });
    expect(runtime.get('a')?.checkpoint).toBe('later');
  });

  it('rejects incomplete replay evidence before allocating a historical fork', async () => {
    const source = node();
    open(); create([source.seq]);
    const options = { sourceAgentId: 'a', checkpointSeq: runtime.checkpoints('a')[0].seq,
      agentId: 'debug', txId: 'debug-tx', forkPath: path.join(temp, 'debug'), maxSteps: 2,
      replayPolicy: 'deterministic' as const,
      observations: () => ({ closedWorld: true as const,
        log: [{ kind: 'mutate' as const, call: { tool: 'write', args: {} } }], replay: async () => undefined }) };
    await expect(forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), options)).rejects.toThrow('result hashes');
    expect(fs.existsSync(options.forkPath)).toBe(false);
    await expect(forkAgentCheckpoint(runtime, new ProcessSupervisor(domain), { ...options, checkpointSeq: 999999 }))
      .rejects.toThrow('No checkpoint');
  });

  it('persists explicit branches, workspace bindings and restored context across reopen', async () => {
    const source = node();
    const sibling = node();
    let output = 0;
    open({ step: async () => {
      output = node([source.seq]).seq;
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'derived', causalHeads: [output] };
    } });
    const heads = [source.seq, source.seq];
    create(heads);
    heads.push(sibling.seq);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    const derived = runtime.checkpoints('a')[1];
    expect(runtime.checkpointCausalView('a', derived.seq)?.nodes.map((n) => n.seq)).toEqual([source.seq, output]);
    expect(derived.workspace).toEqual({ txId: workspace.txId, forkRoot: workspace.forkRoot });
    const next = await new ProcessSupervisor(domain).beginWorkspaceTransaction({ txId: 'restored', runId: 'run',
      root: path.join(temp, 'repo'), forkPath: path.join(temp, 'restored') });
    runtime.restoreCheckpoint('a', initial.seq, next);
    expect(runtime.get('a')).toMatchObject({ checkpoint: 'initial', causalHeads: [source.seq], stepsUsed: 1,
      workspace: { txId: 'restored' } });
    expect(runtime.checkpoints('a')[0].workspace?.txId).toBe('tx');
    runtime.restoreCheckpoint('a', runtime.checkpoints('a').at(-1)!.seq);
    runtime.close();
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpointCausalView('a', derived.seq)?.heads).toEqual([output]);
    expect(runtime.get('a')?.causalHeads).toEqual([source.seq]);
    expect(runtime.checkpointCausalView('a', initial.seq)?.nodes.map((n) => n.seq)).toEqual([source.seq]);
    const returned = runtime.checkpoints('a');
    returned[0].causalHeads!.push(output);
    expect(runtime.checkpoints('a')[0].causalHeads).toEqual([source.seq]);
    expect(runtime.checkpoints('a').at(-1)?.workspace?.txId).toBe('restored');
  });

  it('validates each candidate using its own causal branch', async () => {
    const source = node();
    const later = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'later', causalHeads: [later.seq] };
    }, validate: async (agent) => agent.causalHeads?.includes(later.seq) ? 'stale' : 'valid' });
    create([source.seq]);
    await runtime.drain();
    const saved = await runtime.findValidCheckpoint('a');
    expect(saved?.checkpoint).toBe('initial');
    expect(saved?.causalHeads).toEqual([source.seq]);
  });

  it('clears omitted evidence and distinguishes an explicit empty branch', async () => {
    open({ step: async () => { runtime.pause('a'); return { status: 'ready', checkpoint: 'untracked' }; } });
    create([]);
    const initial = runtime.checkpoints('a')[0];
    expect(runtime.checkpointCausalView('a', initial.seq)).toEqual({ heads: [], nodes: [] });
    await runtime.drain();
    expect(runtime.get('a')?.causalHeads).toBeNull();
    expect(runtime.checkpointCausalView('a', runtime.checkpoints('a')[1].seq)).toBeUndefined();
    runtime.restoreCheckpoint('a', initial.seq);
    expect(runtime.get('a')?.causalHeads).toEqual([]);
  });

  it('binds recovered heads atomically and preserves the prior branch on preparation failure', async () => {
    const source = node();
    const later = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'later', causalHeads: [later.seq] };
    } });
    create([source.seq]);
    await runtime.drain();
    await expect(runtime.recoverCheckpoint('a', async () => { throw new Error('replay failed'); })).rejects.toThrow('replay failed');
    expect(runtime.get('a')).toMatchObject({ checkpoint: 'later', causalHeads: [later.seq] });
    const restored = await runtime.recoverCheckpoint('a', async (saved) => {
      expect(saved.map((entry) => entry.causalHeads)).toEqual([[source.seq], [later.seq]]);
      return { seq: saved[0].seq };
    });
    expect(restored).toMatchObject({ checkpoint: 'initial', causalHeads: [source.seq], stepsUsed: 1, status: 'paused' });
    expect(runtime.checkpointCausalView('a', runtime.checkpoints('a').at(-1)!.seq)?.heads).toEqual([source.seq]);
  });

  it('rejects unknown heads before creation or checkpoint completion', async () => {
    open({ step: async () => ({ status: 'ready', checkpoint: 'invalid', causalHeads: [999999] }) });
    expect(() => create([999999])).toThrow('absent');
    expect(runtime.get('a')).toBeUndefined();
    create([node().seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: 'initial', causalHeads: initial.causalHeads, stepsUsed: 1 });
    expect(runtime.checkpoints('a')).toHaveLength(1);
    expect(() => runtime.checkpointCausalView('a', 999999)).toThrow('No checkpoint');
  });

  it('routes transitive cross-agent impact while excluding independent and sibling branches', async () => {
    const source = node();
    const independent = node();
    const derived = graph.record({ txId: 'tx', actorId: 'producer', dependsOn: [source.seq],
      observation: { kind: 'observe', call: { tool: 'derive', args: {} }, resultHash: 'derived' } });
    const sibling = node([source.seq]);
    open({ step: async (agent) => {
      runtime.pause(agent.id);
      return { status: 'ready', checkpoint: 'derived', causalHeads: [derived.seq, independent.seq] };
    } });
    create([independent.seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    for (const [id, heads] of [['consumer', [derived.seq]], ['independent', [independent.seq]],
      ['empty', []], ['untracked', null]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: id,
        causalHeads: heads === null ? null : [...heads], maxSteps: 1 });
    }
    const before = domain.getStore().getJournalEvents(domain.domainId).length;
    const plan = runtime.planCausalRecovery([source.seq, source.seq]);
    expect(plan.changed).toEqual([source.seq]);
    expect(plan.affected.map((entry) => entry.agentId)).toEqual(['a', 'consumer']);
    expect(plan.affected[0]).toMatchObject({ invalidatedHeads: [derived.seq],
      invalidatedNodes: [source.seq, derived.seq], restartFrom: initial });
    expect(plan.affected[0].invalidatedNodes).not.toContain(sibling.seq);
    expect(plan.affected[1].restartFrom).toBeUndefined();
    expect(plan.unaffected).toEqual(['independent', 'empty']);
    expect(plan.untracked).toEqual(['untracked']);
    expect(domain.getStore().getJournalEvents(domain.domainId)).toHaveLength(before);
    plan.affected[0].restartFrom!.causalHeads!.push(source.seq);
    expect(runtime.checkpoints('a')[0]).toEqual(initial);
    const recovered = await runtime.recoverCheckpoint('a', async () => ({ seq: initial.seq }));
    expect(recovered).toMatchObject({ causalHeads: [independent.seq], stepsUsed: 1 });
    expect(runtime.planCausalRecovery([source.seq]).affected.map((entry) => entry.agentId)).toEqual(['consumer']);
  });

  it('explains checkpoint recovery with all relevant causes and cross-actor paths', async () => {
    const first = node();
    const second = node();
    const stable = node();
    const left = node([first.seq]);
    const right = node([first.seq]);
    const joined = graph.record({ txId: 'tx', actorId: 'producer', dependsOn: [right.seq, second.seq, left.seq],
      observation: { kind: 'observe', call: { tool: 'join', args: {} }, resultHash: 'joined' } });
    const sibling = node([first.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'joined', causalHeads: [joined.seq, stable.seq] };
    } });
    create([stable.seq]);
    const initial = runtime.checkpoints('a')[0];
    await runtime.drain();
    // A later changed result must not leak into the older checkpoint report.
    const future = node([joined.seq]);
    for (const [id, heads] of [['consumer', [second.seq]], ['empty', []], ['untracked', null]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: id,
        causalHeads: heads === null ? null : [...heads], maxSteps: 1 });
    }
    const changed = [future.seq, second.seq, first.seq, first.seq, sibling.seq];
    const states = runtime.list();
    const budget = runtime.getRunUsage('run');
    const events = domain.getStore().getJournalEvents(domain.domainId);
    const preview = runtime.explainCausalRecovery(changed);
    const { recomputation, ...impact } = preview.affected[0];
    expect(impact).toEqual(runtime.planCausalRecovery(changed).affected[0]);
    expect(impact.restartFrom).toEqual(initial);
    expect(recomputation.invalidated.map((entry) => entry.seq)).toEqual(impact.invalidatedNodes);
    expect(recomputation.unaffected.map((entry) => entry.seq)).toEqual([stable.seq]);
    expect(recomputation.explanations.find((entry) => entry.nodeSeq === joined.seq)?.causes).toEqual([
      { changedSeq: first.seq, path: [first.seq, left.seq, joined.seq] },
      { changedSeq: second.seq, path: [second.seq, joined.seq] },
    ]);
    expect(recomputation.invalidated.at(-1)).toMatchObject({ actorId: 'producer', txId: 'tx',
      observation: { call: { tool: 'join' } } });
    expect(preview.affected[1].recomputation.explanations).toEqual([
      { nodeSeq: second.seq, causes: [{ changedSeq: second.seq, path: [second.seq] }] },
    ]);
    expect(preview.unaffected).toEqual(['empty']);
    expect(preview.untracked).toEqual(['untracked']);
    expect(runtime.list()).toEqual(states);
    expect(runtime.getRunUsage('run')).toEqual(budget);
    expect(domain.getStore().getJournalEvents(domain.domainId)).toEqual(events);
    const original = structuredClone(preview);
    recomputation.explanations[0].causes[0].path.push(future.seq);
    recomputation.invalidated[0].observation.call.tool = 'tampered';
    preview.affected[0].checkpoint.causalHeads!.push(future.seq);
    expect(runtime.explainCausalRecovery(changed)).toEqual(original);
    runtime.close();
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.explainCausalRecovery(changed)).toEqual(original);
    expect(runtime.explainCausalRecovery([...changed].reverse()).affected).toEqual(original.affected);
  });

  it('keeps terminal outputs visible and validates explanation seeds before branch filtering', async () => {
    const source = node();
    open({ step: async () => ({ status: 'completed', checkpoint: 'output', causalHeads: [source.seq] }) });
    create();
    await runtime.drain();
    runtime.create({ id: 'untracked', runId: 'run', input: null, checkpoint: null, maxSteps: 1 });
    const preview = runtime.explainCausalRecovery([source.seq]);
    expect(preview.affected[0].restartFrom).toBeUndefined();
    expect(preview.affected[0].recomputation.explanations).toEqual([
      { nodeSeq: source.seq, causes: [{ changedSeq: source.seq, path: [source.seq] }] },
    ]);
    expect(runtime.get('a')?.status).toBe('completed');
    expect(runtime.explainCausalRecovery([])).toEqual({ changed: [], affected: [], unaffected: ['a'], untracked: ['untracked'] });
    expect(() => runtime.explainCausalRecovery([999999])).toThrow('absent');
    expect(() => runtime.explainCausalRecovery([NaN])).toThrow('absent');
  });

  it('selects the nearest unaffected tracked checkpoint and survives domain reopen', async () => {
    const changed = node();
    const stable = node();
    let steps = 0;
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: ++steps, causalHeads: steps === 1 ? [stable.seq] : [changed.seq] };
    } });
    create([]);
    await runtime.drain();
    const nearest = runtime.checkpoints('a').at(-1)!;
    runtime.resume('a');
    await runtime.drain();
    const before = runtime.planCausalRecovery([changed.seq]);
    expect(before.affected[0].restartFrom).toEqual(nearest);
    runtime.close();
    domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.planCausalRecovery([changed.seq])).toEqual(before);
  });

  it('does not use untracked history as a restart candidate and includes completed outputs', async () => {
    const changed = node();
    open({ step: async () => ({ status: 'completed', checkpoint: 'output', causalHeads: [changed.seq] }) });
    create();
    await runtime.drain();
    const plan = runtime.planCausalRecovery([changed.seq]);
    expect(plan.affected[0].agentId).toBe('a');
    expect(plan.affected[0].restartFrom).toBeUndefined();
    expect(runtime.get('a')?.status).toBe('completed');
    expect(runtime.planCausalRecovery([])).toEqual({ changed: [], affected: [], unaffected: ['a'], untracked: [] });
    expect(() => runtime.planCausalRecovery([999999])).toThrow('absent');
    expect(() => runtime.planCausalRecovery([NaN])).toThrow('absent');
  });

  it('shares recomputation while binding isolated contexts durably without spending budgets', async () => {
    const source = node();
    const derived = node([source.seq]);
    open();
    for (const [id, heads] of [['first', [derived.seq]], ['second', [source.seq]]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', maxSteps: 2, causalHeads: [...heads] });
      runtime.pause(id);
    }
    const supervisor = new ProcessSupervisor(domain);
    const usage = runtime.getRunUsage('run');
    const executed: number[] = [];
    const batch = await recoverAgentSharedCausalBatch(runtime, [source.seq], {
      prepare: async (plan) => prepareWorkspaceBranchRepair(supervisor, {
        txId: 'shared', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'shared'),
        atSeq: Math.max(...plan.affected.map(({ checkpoint }) => checkpoint.seq)), changed: plan.changed,
        branches: plan.affected.map(({ agentId, checkpoint }) => ({ id: agentId, heads: checkpoint.causalHeads! })),
        validateReuse: async () => {}, execute: async (entry, tx) => {
          executed.push(entry.seq);
          fs.writeFileSync(path.join(tx.forkRoot, 'result'), 'recomputed');
          return { actorId: entry.actorId, observation: { ...entry.observation, resultHash: 'new' } };
        },
      }),
      bind: async ({ agentId }, repair) => {
        const transaction = await supervisor.beginWorkspaceTransaction({ txId: `bound-${agentId}`,
          runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, `bound-${agentId}`) });
        fs.copyFileSync(path.join(repair.transaction.forkRoot, 'result'), path.join(transaction.forkRoot, 'result'));
        repair.branches.length = 0; // Callback copies cannot corrupt later bindings.
        return { checkpoint: fs.readFileSync(path.join(transaction.forkRoot, 'result'), 'utf8'), workspace: transaction };
      },
    });
    expect(executed).toEqual([source.seq, derived.seq]);
    expect(batch.outcomes.map(({ status }) => status)).toEqual(['repaired', 'repaired']);
    expect(batch.repair!.branches).toHaveLength(2);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(runtime.get('first')!.workspace!.txId).toBe('bound-first');
    expect(runtime.get('second')!.workspace!.txId).toBe('bound-second');
    expect(runtime.planCausalRecovery([source.seq]).affected).toEqual([]);
    const saved = runtime.checkpoints('second').at(-1);
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpoints('second').at(-1)).toEqual(saved);
    expect(fs.existsSync(path.join(temp, 'shared', 'result'))).toBe(true);
  });

  it('retains shared resources across failed, stale and successful context bindings', async () => {
    const source = node();
    open();
    for (const id of ['bad', 'stale', 'good']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', maxSteps: 2, causalHeads: [source.seq] });
      runtime.pause(id);
    }
    const supervisor = new ProcessSupervisor(domain);
    let discarded = 0;
    const batch = await recoverAgentSharedCausalBatch(runtime, [source.seq], {
      prepare: async (plan) => {
        const repair = await prepareWorkspaceBranchRepair(supervisor, {
          txId: 'shared', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'shared'),
          atSeq: Math.max(...plan.affected.map(({ checkpoint }) => checkpoint.seq)), changed: plan.changed,
          branches: plan.affected.map(({ agentId, checkpoint }) => ({ id: agentId, heads: checkpoint.causalHeads! })),
          validateReuse: async () => {}, execute: async (entry) => ({ actorId: entry.actorId, observation: entry.observation }),
        });
        runtime.restoreCheckpoint('stale', runtime.checkpoints('stale')[0].seq);
        plan.affected.length = 0;
        return repair;
      },
      bind: async ({ agentId }) => ({ checkpoint: agentId === 'bad' ? NaN : 'new', workspace,
        discard: async () => { discarded++; } }),
    });
    expect(batch.outcomes.map((o) => o.status === 'skipped' ? o.reason : o.status))
      .toEqual(['failed', 'checkpoint_changed', 'repaired']);
    expect(discarded).toBe(1);
    expect(batch.plan.affected).toHaveLength(3);
    expect(fs.existsSync(batch.repair!.transaction.forkRoot)).toBe(true);
    expect(runtime.get('bad')!.checkpoint).toBe('old');
  });

  it('rejects mismatched repair mappings and prevents shared transaction ownership transfer', async () => {
    const source = node();
    open(); create([source.seq]); runtime.pause('a');
    const supervisor = new ProcessSupervisor(domain);
    let binds = 0;
    let discarded = 0;
    const repair = await prepareWorkspaceBranchRepair(supervisor, {
      txId: 'shared', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'shared'),
      atSeq: runtime.checkpoints('a').at(-1)!.seq, changed: [source.seq], branches: [{ id: 'a', heads: [source.seq] }],
      validateReuse: async () => {}, execute: async (entry) => ({ actorId: entry.actorId, observation: entry.observation }),
    });
    const options = { prepare: async () => repair, bind: async () => {
      binds++;
      return { checkpoint: 'new', workspace: repair.transaction, discard: async () => { discarded++; } };
    } };
    const rejected = await recoverAgentSharedCausalBatch(runtime, [source.seq], options);
    expect(rejected.outcomes[0]).toMatchObject({ status: 'failed', error: expect.any(Error) });
    expect(discarded).toBe(0);
    expect(binds).toBe(1);
    repair.branches[0].sourceHeads = [];
    const mismatched = await recoverAgentSharedCausalBatch(runtime, [source.seq], options);
    expect(mismatched.outcomes[0]).toMatchObject({ status: 'failed' });
    expect(binds).toBe(1);
    expect(runtime.get('a')!.checkpoint).toBe('initial');
    expect(await recoverAgentSharedCausalBatch(runtime, [], options)).toEqual({
      plan: { changed: [], affected: [], unaffected: ['a'], untracked: [] }, outcomes: [],
    });
  });

  it('repairs a batch with real causal recomputation and preserves independent agents and budgets', async () => {
    const source = node();
    const derived = node([source.seq]);
    const stable = node();
    open();
    for (const [id, heads] of [['first', [derived.seq]], ['second', [source.seq]],
      ['stable', [stable.seq]], ['unknown', null]] as const) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', maxSteps: 2,
        causalHeads: heads === null ? null : [...heads] });
      runtime.pause(id);
    }
    const usage = runtime.getRunUsage('run');
    const untouched = runtime.get('stable');
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'updated');
    const executed: number[] = [];
    const batch = await recoverAgentCausalBatch(runtime, [source.seq, source.seq], async (impact) => {
      const result = await prepareWorkspaceRepair(new ProcessSupervisor(domain), {
        txId: `batch-${impact.agentId}`, runId: 'run', root: path.join(temp, 'repo'),
        forkPath: path.join(temp, `batch-${impact.agentId}`), atSeq: impact.checkpoint.seq,
        heads: impact.checkpoint.causalHeads!, changed: [source.seq],
        validateReuse: async () => {},
        execute: async (entry, tx) => {
          executed.push(entry.seq);
          return { actorId: impact.agentId, observation: { ...entry.observation,
            resultHash: fs.readFileSync(path.join(tx.forkRoot, 'input'), 'utf8') } };
        },
      });
      // Host mutation must not corrupt the retained impact snapshot.
      impact.invalidatedNodes.length = 0;
      return { checkpoint: 'updated', causalHeads: result.heads, workspace: result.transaction };
    });
    expect(batch.plan.changed).toEqual([source.seq]);
    expect(batch.plan.affected[0].invalidatedNodes).toEqual([source.seq, derived.seq]);
    expect(batch.plan.unaffected).toEqual(['stable']);
    expect(batch.plan.untracked).toEqual(['unknown']);
    expect(batch.outcomes.map(({ status }) => status)).toEqual(['repaired', 'repaired']);
    expect(executed).toEqual([source.seq, derived.seq, source.seq]);
    expect(runtime.planCausalRecovery([source.seq]).affected).toEqual([]);
    expect(runtime.getRunUsage('run')).toEqual(usage);
    expect(runtime.get('stable')).toEqual(untouched);
    const saved = runtime.checkpoints('first').at(-1)!;
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpoints('first').at(-1)).toEqual(saved);
    expect(runtime.get('second')).toMatchObject({ checkpoint: 'updated', status: 'paused' });
  });

  it('reports binding failures and declined recovery while continuing the batch', async () => {
    const source = node();
    open();
    for (const id of ['bad', 'declined', 'good']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      runtime.pause(id);
    }
    let discarded = 0;
    const batch = await recoverAgentCausalBatch(runtime, [source.seq], async ({ agentId }) => {
      if (agentId === 'declined') return undefined;
      return { checkpoint: 'new', causalHeads: agentId === 'bad' ? [999999] : [], workspace,
        discard: async () => { discarded++; } };
    });
    expect(batch.outcomes[0]).toMatchObject({ agentId: 'bad', status: 'failed', error: expect.any(Error) });
    expect(batch.outcomes[1]).toMatchObject({ agentId: 'declined', status: 'skipped', reason: 'not_repaired' });
    expect(batch.outcomes[2]).toMatchObject({ agentId: 'good', status: 'repaired' });
    expect(discarded).toBe(1);
    expect(runtime.get('bad')).toMatchObject({ status: 'paused', checkpoint: 'old' });
    expect(runtime.get('declined')).toMatchObject({ status: 'paused', checkpoint: 'old' });
  });

  it('skips active and terminal agents and detects checkpoint changes during an earlier preparation', async () => {
    const source = node();
    open({ step: async () => ({ status: 'completed', checkpoint: 'done', causalHeads: [source.seq] }) });
    runtime.create({ id: 'done', runId: 'run', input: null, checkpoint: null, maxSteps: 1, causalHeads: [source.seq] });
    await runtime.drain();
    for (const id of ['first', 'stale', 'active']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      if (id !== 'active') runtime.pause(id);
    }
    const called: string[] = [];
    const batch = await recoverAgentCausalBatch(runtime, [source.seq], async ({ agentId }) => {
      called.push(agentId);
      runtime.restoreCheckpoint('stale', runtime.checkpoints('stale')[0].seq);
      return { checkpoint: 'new', causalHeads: [], workspace };
    });
    expect(called).toEqual(['first']);
    expect(batch.outcomes.map((entry) => entry.status === 'skipped' ? entry.reason : entry.status))
      .toEqual(['not_stopped', 'repaired', 'checkpoint_changed', 'not_stopped']);
    await expect(recoverAgentCausalBatch(runtime, [999999], async () => undefined)).rejects.toThrow('absent');
    expect(await recoverAgentCausalBatch(runtime, [], async () => { throw new Error('unexpected'); }))
      .toMatchObject({ outcomes: [] });
  });

  it('reports interrupted preparation without publishing context and continues to another agent', async () => {
    const source = node();
    open();
    for (const id of ['first', 'second']) {
      runtime.create({ id, runId: 'run', input: null, checkpoint: 'old', causalHeads: [source.seq], maxSteps: 2 });
      runtime.pause(id);
    }
    let stopping: Promise<unknown> | undefined;
    let discarded = 0;
    const batch = await recoverAgentCausalBatch(runtime, [source.seq], async ({ agentId }) => {
      if (agentId === 'first') stopping = runtime.interrupt(agentId);
      return { checkpoint: 'new', causalHeads: [], workspace, discard: async () => { discarded++; } };
    });
    await stopping;
    expect(batch.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'not_repaired' });
    expect(batch.outcomes[1]).toMatchObject({ status: 'repaired' });
    expect(discarded).toBe(1);
    expect(runtime.get('first')).toMatchObject({ status: 'interrupted', checkpoint: 'old' });
  });

  it('binds an actual incremental repair with rebuilt context and reopens its history', async () => {
    const source = node();
    const stable = node();
    const derived = node([source.seq]);
    open({ step: async () => {
      runtime.pause('a');
      return { status: 'ready', checkpoint: 'old context', causalHeads: [derived.seq, stable.seq] };
    } });
    create([]);
    await runtime.drain();
    fs.writeFileSync(path.join(temp, 'repo', 'input'), 'updated');
    const impact = runtime.planCausalRecovery([source.seq]).affected[0];
    const executed: number[] = [];
    const repaired = await runtime.recoverCausalCheckpoint('a', impact.checkpoint.seq, async (saved) => {
      expect(runtime.get('a')?.status).toBe('recovering');
      expect(() => runtime.resume('a')).toThrow();
      const result = await prepareWorkspaceRepair(new ProcessSupervisor(domain), {
        txId: 'repair', runId: 'run', root: path.join(temp, 'repo'), forkPath: path.join(temp, 'repair'),
        atSeq: saved.seq, heads: saved.causalHeads!, changed: [source.seq],
        validateReuse: async (tx, unaffected) => {
          expect(unaffected.map((entry) => entry.seq)).toEqual([stable.seq]);
          expect(fs.readFileSync(path.join(tx.forkRoot, 'input'), 'utf8')).toBe('updated');
        },
        execute: async (entry, tx) => {
          executed.push(entry.seq);
          const value = fs.readFileSync(path.join(tx.forkRoot, 'input'), 'utf8');
          return { actorId: 'a', observation: { ...entry.observation, resultHash: value } };
        },
      });
      return { checkpoint: { results: result.replacements.map(({ node }) => node.observation.resultHash) },
        causalHeads: result.heads, workspace: result.transaction };
    });
    expect(executed).toEqual([source.seq, derived.seq]);
    expect(repaired).toMatchObject({ checkpoint: { results: ['updated', 'updated'] }, stepsUsed: 1,
      status: 'paused', workspace: { txId: 'repair' }, validatedWorkspaceVersion: null });
    const saved = runtime.checkpoints('a').at(-1)!;
    expect(saved.causalHeads).toContain(stable.seq);
    expect(saved.causalHeads).not.toContain(derived.seq);
    expect(runtime.planCausalRecovery([source.seq]).affected).toEqual([]);
    expect(runtime.planCausalRecovery([saved.causalHeads![0]]).affected[0].checkpoint.seq).toBe(saved.seq);
    expect(runtime.checkpointCausalView('a', impact.checkpoint.seq)?.heads).toEqual([derived.seq, stable.seq]);
    const event = domain.getStore().getJournalEvent(domain.domainId, saved.seq)!;
    expect(event.payload).toMatchObject({ transition: 'causal_repaired', checkpointRef: impact.checkpoint.seq });
    runtime.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'causal-checkpoints');
    open();
    expect(runtime.checkpoints('a').at(-1)).toEqual(saved);
    expect(runtime.get('a')).toEqual(repaired);
    runtime.restoreCheckpoint('a', saved.seq);
    expect(runtime.get('a')?.checkpoint).toEqual(saved.checkpoint);
  });

  it('rejects stale plans before preparation and preserves context on invalid binding', async () => {
    open(); create([node().seq]); runtime.pause('a');
    const saved = runtime.checkpoints('a')[0];
    let called = false;
    await expect(runtime.recoverCausalCheckpoint('a', saved.seq + 1, async () => {
      called = true; return undefined;
    })).rejects.toThrow('replan');
    expect(called).toBe(false);
    let discarded = 0;
    await expect(runtime.recoverCausalCheckpoint('a', saved.seq, async () => ({
      checkpoint: 'bad', causalHeads: [999999], workspace,
      discard: async () => { discarded++; },
    }))).rejects.toThrow('absent');
    expect(discarded).toBe(1);
    expect(runtime.get('a')).toMatchObject({ status: 'paused', checkpoint: saved.checkpoint, causalHeads: saved.causalHeads });
    expect(runtime.checkpoints('a')).toEqual([saved]);
    await expect(runtime.recoverCausalCheckpoint('a', saved.seq, async () => { throw new Error('rebuild failed'); }))
      .rejects.toThrow('rebuild failed');
    expect(await runtime.recoverCausalCheckpoint('a', saved.seq, async () => undefined)).toBeUndefined();
    expect(runtime.checkpoints('a')).toEqual([saved]);
  });

  it('joins interruption and discards a prepared causal context without publishing it', async () => {
    open(); create([node().seq]); runtime.pause('a');
    const saved = runtime.checkpoints('a')[0];
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let discarded = 0;
    const pending = runtime.recoverCausalCheckpoint('a', saved.seq, async () => {
      entered(); await gate;
      return { checkpoint: 'new', causalHeads: [], workspace, discard: async () => { discarded++; } };
    });
    await started;
    const stopping = runtime.interrupt('a');
    release();
    expect(await pending).toBeUndefined();
    await stopping;
    expect(discarded).toBe(1);
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', checkpoint: saved.checkpoint, causalHeads: saved.causalHeads });
    expect(runtime.checkpoints('a')).toEqual([saved]);
  });

  it('rejects untracked contexts and terminal agents before preparation', async () => {
    open({ step: async () => ({ status: 'completed', checkpoint: 'done', causalHeads: [] }) });
    create(); runtime.pause('a');
    let called = false;
    const prepare = async () => { called = true; return undefined; };
    await expect(runtime.recoverCausalCheckpoint('a', runtime.checkpoints('a')[0].seq, prepare)).rejects.toThrow('tracked');
    runtime.create({ id: 'done', runId: 'run', input: null, checkpoint: null, causalHeads: [], maxSteps: 1 });
    await runtime.drain();
    await expect(runtime.recoverCausalCheckpoint('done', runtime.checkpoints('done').at(-1)!.seq, prepare)).rejects.toThrow('Cannot recover');
    expect(called).toBe(false);
  });

});
