import type { ExecutionDomain } from '../domain.js';
import { isAgentCheckpoint, projectAgentEvent, readAgentCheckpoint } from './journal.js';
import { AgentCommandGroup, type AgentCommandOptions, type AgentCommandResult, type AgentExecution } from './execution.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';

export interface AgentWorkspace {
  txId: string;
  forkRoot: string;
}

export type AgentData = null | boolean | number | string | AgentData[] | { [key: string]: AgentData };
export type AgentStatus = 'ready' | 'checking' | 'running' | 'recovering' | 'paused' | 'completed' | 'failed' | 'interrupted';

export interface AgentCheckpoint {
  seq: number;
  checkpoint: AgentData;
  stepsUsed: number;
}

export interface AgentState {
  id: string;
  runId: string;
  parentId: string | null;
  input: AgentData;
  checkpoint: AgentData;
  workspace: AgentWorkspace | null;
  status: AgentStatus;
  maxSteps: number;
  stepsUsed: number;
  pauseRequested: boolean;
  reason: string | null;
  error: string | null;
}

export interface AgentStepResult {
  status: 'ready' | 'completed';
  checkpoint: AgentData;
}

export interface AgentRuntimeOptions {
  maxConcurrentAgents: number;
  /** One cooperative quantum, normally one provider response and its tool batch. */
  step(agent: AgentState, execution: AgentExecution): Promise<AgentStepResult>;
  /** Read-only check before dispatch. Omission means no evidence validation claim. */
  validate?(agent: AgentState): Promise<'valid' | 'stale' | 'unknown'>;
}

const owners = new WeakSet<ExecutionDomain>();

function data(value: AgentData): AgentData {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item === undefined || ['function', 'symbol', 'bigint'].includes(typeof item)
      || (typeof item === 'number' && !Number.isFinite(item))) {
      throw new Error('Agent input/checkpoint must be JSON data without non-finite numbers');
    }
    return item;
  }));
}

/**
 * Experimental, single-domain cooperative scheduler. The existing journal is
 * the state source; the map is an incremental projection, not a second store.
 * Steps reserve budget before calling the adapter. Interrupted steps retain
 * that charge and require explicit restoration, never automatic retry.
 */
export class AgentRuntime {
  private readonly states = new Map<string, { seq: number; state: AgentState }>();
  private cursor = 0;
  private closed = false;
  private draining?: Promise<void>;
  private readonly recoveries = new Set<string>();
  private readonly operationOwners = new Map<string, string>();
  private processSupervisor?: ProcessSupervisor;

  constructor(private readonly domain: ExecutionDomain, private readonly options: AgentRuntimeOptions) {
    if (!Number.isSafeInteger(options.maxConcurrentAgents) || options.maxConcurrentAgents < 1) {
      throw new Error('maxConcurrentAgents must be a positive safe integer');
    }
    if (owners.has(domain)) throw new Error('This domain already has an AgentRuntime');
    this.sync();
    for (const { state } of this.states.values()) {
      if (state.status === 'running' || state.status === 'recovering') this.record({ ...state, status: 'interrupted', reason: 'host_restarted' }, 'recovered');
      else if (state.status === 'checking' || state.status === 'ready') {
        this.record({ ...state, status: 'paused', reason: 'host_restarted' }, 'recovered');
      }
    }
    owners.add(domain);
  }

  create(input: { id: string; runId: string; parentId?: string; input: AgentData; checkpoint: AgentData; workspace?: AgentWorkspace; maxSteps: number }): AgentState {
    this.assertOpen();
    if (!input.id || this.get(input.id)) throw new Error(`Agent id is empty or already exists: "${input.id}"`);
    if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1) throw new Error('maxSteps must be a positive safe integer');
    this.assertRun(input.runId);
    if (input.workspace) this.assertWorkspace(input.workspace, input.runId, input.id);
    if (input.parentId && this.require(input.parentId).runId !== input.runId) throw new Error('Parent agent belongs to another Run');
    return this.record({
      id: input.id, runId: input.runId, parentId: input.parentId ?? null,
      input: data(input.input), checkpoint: data(input.checkpoint), status: 'ready',
      workspace: input.workspace ? { txId: input.workspace.txId, forkRoot: input.workspace.forkRoot } : null,
      maxSteps: input.maxSteps, stepsUsed: 0, pauseRequested: false, reason: null, error: null,
    }, 'created');
  }

  get(id: string): AgentState | undefined {
    this.assertOpen();
    this.sync();
    const state = this.states.get(id)?.state;
    return state ? structuredClone(state) : undefined;
  }

  getDomain(): ExecutionDomain {
    return this.domain;
  }

  list(): AgentState[] {
    this.assertOpen();
    this.sync();
    return [...this.states.values()].map(({ state }) => structuredClone(state));
  }

  pause(id: string): AgentState {
    const state = this.require(id);
    if (!['ready', 'running', 'checking', 'recovering', 'paused'].includes(state.status)) throw new Error(`Cannot pause ${state.status} agent`);
    const active = state.status === 'running' || state.status === 'checking' || state.status === 'recovering';
    return this.record({ ...state, pauseRequested: active, status: active ? state.status : 'paused', reason: 'requested' }, 'pause_requested');
  }

  resume(id: string): AgentState {
    const state = this.require(id);
    if (state.status !== 'paused') throw new Error(`Cannot resume ${state.status} agent; restore an interrupted checkpoint explicitly`);
    if (state.stepsUsed >= state.maxSteps) throw new Error('Agent step budget exhausted');
    this.assertRun(state.runId);
    return this.record({ ...state, status: 'ready', pauseRequested: false, reason: null, error: null }, 'resumed');
  }

  checkpoints(id: string): AgentCheckpoint[] {
    this.require(id);
    const checkpoints: AgentCheckpoint[] = [];
    let state: AgentState | undefined;
    for (const event of this.domain.getStore().getJournalEvents(this.domain.domainId)) {
      if (event.type !== 'AGENT_STATE' || (event.payload.state as AgentState).id !== id) continue;
      state = projectAgentEvent(event, state, (seq, agentId) => this.readCheckpoint(seq, agentId));
      if (isAgentCheckpoint(event.payload.transition)) checkpoints.push({ seq: event.seq, checkpoint: state.checkpoint, stepsUsed: state.stepsUsed });
    }
    return checkpoints;
  }

  /** Select by recorded evidence, not by checkpoint age. Caller reconstructs before restore. */
  async findValidCheckpoint(id: string): Promise<AgentCheckpoint | undefined> {
    if (!this.options.validate) throw new Error('Checkpoint selection requires an evidence validator');
    const state = this.require(id);
    if (state.status !== 'paused' && state.status !== 'interrupted') throw new Error('Checkpoint selection requires a stopped agent');
    for (const saved of this.checkpoints(id).reverse()) {
      const verdict = await this.options.validate({ ...structuredClone(state), checkpoint: structuredClone(saved.checkpoint) });
      if (!['valid', 'stale', 'unknown'].includes(verdict)) throw new Error('Invalid agent evidence verdict');
      if (verdict === 'valid') return saved;
    }
    return undefined;
  }

  /** Caller reconstructs the workspace/tool state first. Spent budget is never rewound. */
  restoreCheckpoint(id: string, seq: number, workspace?: AgentWorkspace): AgentState {
    const state = this.require(id);
    if (state.status !== 'paused' && state.status !== 'interrupted') throw new Error('Restore requires a paused or interrupted agent');
    return this.commitRestore(state, seq, workspace);
  }

  /** Own the stopped agent until asynchronous reconstruction and binding finish. */
  async recoverCheckpoint(
    id: string,
    prepare: (checkpoints: readonly AgentCheckpoint[]) => Promise<{
      seq: number;
      workspace?: AgentWorkspace;
      /** Release prepared resources if the selected checkpoint cannot be bound. */
      discard?: () => Promise<void>;
    } | undefined>
  ): Promise<AgentState | undefined> {
    const previous = this.require(id);
    if (previous.status !== 'paused' && previous.status !== 'interrupted') throw new Error(`Cannot recover ${previous.status} agent`);
    this.assertRun(previous.runId);
    const checkpoints = this.checkpoints(id);
    this.record({ ...previous, status: 'recovering', reason: 'reconstruction', pauseRequested: false }, 'recovery_started');
    this.recoveries.add(id);
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(checkpoints);
      if (!prepared) {
        this.record(previous, 'recovery_abandoned');
        return undefined;
      }
      return this.commitRestore(this.require(id), prepared.seq, prepared.workspace);
    } catch (error) {
      let failure = error;
      if (prepared?.discard) {
        try { await prepared.discard(); }
        catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'Recovery binding and cleanup failed'); }
      }
      try { this.record(previous, 'recovery_failed'); }
      catch (restoreError) { throw new AggregateError([failure, restoreError], 'Recovery failed and its prior state could not be restored'); }
      throw failure;
    } finally {
      this.recoveries.delete(id);
    }
  }

  private commitRestore(state: AgentState, seq: number, workspace?: AgentWorkspace): AgentState {
    const saved = this.checkpoints(state.id).find((checkpoint) => checkpoint.seq === seq);
    if (!saved) throw new Error(`No checkpoint ${seq} for agent "${state.id}"`);
    this.assertRun(state.runId);
    if (workspace) this.assertWorkspace(workspace, state.runId, state.id);
    return this.record({
      ...state, checkpoint: saved.checkpoint,
      workspace: workspace ? { txId: workspace.txId, forkRoot: workspace.forkRoot } : state.workspace,
      status: 'paused', pauseRequested: false, reason: 'restored', error: null,
    }, 'restored', seq);
  }

  /** Drain runnable agents. Paused/interrupted agents do not keep this promise pending. */
  drain(): Promise<void> {
    this.assertOpen();
    if (!this.draining) this.draining = Promise.resolve().then(() => this.schedule()).finally(() => { this.draining = undefined; });
    return this.draining;
  }

  close(): void {
    if (this.closed) return;
    if (this.draining) throw new Error('Await drain() before closing AgentRuntime');
    if (this.recoveries.size > 0) throw new Error('Await active recovery before closing AgentRuntime');
    this.closed = true;
    owners.delete(this.domain);
  }

  private async schedule(): Promise<void> {
    const active = new Set<Promise<void>>();
    try {
      for (;;) {
        this.sync();
        const ready = [...this.states.values()].filter(({ state }) => state.status === 'ready').sort((a, b) => a.seq - b.seq);
        for (const { state } of ready.slice(0, this.options.maxConcurrentAgents - active.size)) {
          const pending = this.advance(state.id).finally(() => active.delete(pending));
          active.add(pending);
        }
        if (active.size === 0) return;
        await Promise.race(active);
      }
    } finally {
      // A persistence failure must not leave other adapters running after drain rejects.
      await Promise.allSettled(active);
    }
  }

  private async advance(id: string): Promise<void> {
    let state = this.require(id);
    if (state.status !== 'ready') return;
    if (state.stepsUsed >= state.maxSteps) {
      this.record({ ...state, status: 'paused', reason: 'budget_exhausted' }, 'budget_exhausted');
      return;
    }
    try {
      this.assertRun(state.runId);
    } catch (error) {
      this.record({ ...state, status: 'failed', reason: 'run_unavailable', error: String(error) }, 'failed');
      return;
    }
    this.record({ ...state, status: 'checking' }, 'checking');
    let validity: 'valid' | 'stale' | 'unknown';
    try {
      validity = this.options.validate ? await this.options.validate(this.require(id)) : 'valid';
      if (!['valid', 'stale', 'unknown'].includes(validity)) throw new Error('Invalid agent evidence verdict');
      this.assertRun(state.runId);
    } catch (error) {
      this.record({ ...this.require(id), status: 'failed', reason: 'validation_failed', error: String(error) }, 'failed');
      return;
    }
    state = this.require(id);
    if (validity !== 'valid' || state.pauseRequested) {
      this.record({ ...state, status: 'paused', pauseRequested: false, reason: validity === 'valid' ? 'requested' : `evidence_${validity}` }, 'paused');
      return;
    }
    state = this.record({ ...state, status: 'running', stepsUsed: state.stepsUsed + 1 }, 'step_started');
    let result: AgentStepResult;
    try {
      const commands = new AgentCommandGroup((options) => this.executeOwnedProcess(state, options));
      const failures: unknown[] = [];
      let returned: AgentStepResult | undefined;
      try { returned = await this.options.step(structuredClone(state), commands.context); }
      catch (error) { failures.push(error); }
      failures.push(...await commands.finish());
      const uniqueFailures = [...new Set(failures)];
      if (uniqueFailures.length === 1) throw uniqueFailures[0];
      if (uniqueFailures.length > 1) throw new AggregateError(uniqueFailures, `Agent step and commands failed: ${uniqueFailures.map(String).join('; ')}`);
      result = returned!;
      if (!['ready', 'completed'].includes(result.status)) throw new Error('Invalid agent step status');
      result = { status: result.status, checkpoint: data(result.checkpoint) };
    } catch (error) {
      this.record({ ...this.require(id), status: 'interrupted', reason: 'step_failed', error: String(error) }, 'interrupted');
      return;
    }
    state = this.require(id);
    const pause = result.status !== 'completed' && (state.pauseRequested || state.stepsUsed >= state.maxSteps);
    this.record({
      ...state, checkpoint: result.checkpoint, status: pause ? 'paused' : result.status, pauseRequested: false,
      reason: pause ? (state.pauseRequested ? 'requested' : 'budget_exhausted') : null,
    }, 'step_completed');
  }

  private async executeOwnedProcess(agent: AgentState, options: AgentCommandOptions): Promise<AgentCommandResult> {
    if (typeof options.opId !== 'string' || options.opId.length === 0) throw new Error('Agent command opId must be a nonempty string');
    this.sync();
    const current = this.states.get(agent.id)?.state;
    if (current?.status !== 'running' || current.stepsUsed !== agent.stepsUsed) throw new Error('Agent command does not belong to the active quantum');
    const store = this.domain.getStore();
    const owner = this.operationOwners.get(options.opId);
    if (owner && owner !== agent.id) throw new Error(`Operation "${options.opId}" belongs to agent "${owner}"`);
    if (!owner && store.getOperation(options.opId)) throw new Error(`Existing operation "${options.opId}" has no agent ownership`);
    store.transaction(() => store.recordJournalEvent({
      domainId: this.domain.domainId, runId: agent.runId, operationId: options.opId,
      type: 'AGENT_OPERATION_REQUESTED', payload: { agentId: agent.id, step: agent.stepsUsed }, timestamp: new Date().toISOString(),
    }));
    this.sync();
    this.processSupervisor ??= new ProcessSupervisor(this.domain, this.domain.getDriver(), this.domain.getSnapshotDriver());
    const mutationRoots = agent.workspace
      ? [...new Set([...(options.mutationRoots ?? []), agent.workspace.forkRoot])]
      : options.mutationRoots;
    return this.processSupervisor.executeProcess({ ...options, runId: agent.runId, mutationRoots });
  }

  private record(state: AgentState, transition: string, checkpointRef?: number): AgentState {
    this.assertOpen();
    const { input, checkpoint, ...metadata } = state;
    const contents = transition === 'created' ? { input, checkpoint }
      : transition === 'step_completed' ? { checkpoint }
      : transition === 'restored' ? { checkpointRef }
      : {};
    this.domain.getStore().transaction(() => this.domain.getStore().recordJournalEvent({
      domainId: this.domain.domainId, runId: state.runId, type: 'AGENT_STATE',
      payload: { version: 2, transition, state: metadata, ...contents }, timestamp: new Date().toISOString(),
    }));
    this.sync();
    return structuredClone(state);
  }

  private sync(): void {
    for (const event of this.domain.getStore().getJournalEvents(this.domain.domainId, this.cursor)) {
      if (event.type === 'AGENT_OPERATION_REQUESTED') {
        const agentId = event.payload.agentId;
        if (!event.operationId || typeof agentId !== 'string') throw new Error('Invalid agent operation ownership event');
        const owner = this.operationOwners.get(event.operationId);
        if (owner && owner !== agentId) throw new Error('Conflicting agent operation ownership');
        this.operationOwners.set(event.operationId, agentId);
      }
      if (event.type !== 'AGENT_STATE') { this.cursor = event.seq + 1; continue; }
      const id = (event.payload.state as AgentState).id;
      const state = projectAgentEvent(event, this.states.get(id)?.state, (seq, agentId) => this.readCheckpoint(seq, agentId));
      this.states.set(state.id, { seq: event.seq, state });
      this.cursor = event.seq + 1;
    }
  }

  private readCheckpoint(seq: number, agentId: string): AgentData {
    return readAgentCheckpoint(seq, agentId, (ref) => this.domain.getStore().getJournalEvent(this.domain.domainId, ref));
  }

  private require(id: string): AgentState {
    const state = this.get(id);
    if (!state) throw new Error(`Agent "${id}" not found`);
    return state;
  }

  private assertRun(id: string): void {
    const run = this.domain.getStore().getRun(id);
    if (!run || run.domainId !== this.domain.domainId || !['queued', 'starting', 'running'].includes(run.status)) {
      throw new Error(`Run "${id}" cannot accept agent execution`);
    }
  }

  private assertWorkspace(workspace: AgentWorkspace, runId: string, agentId: string): void {
    const events = this.domain.getStore().getJournalEvents(this.domain.domainId)
      .filter((event) => event.type.startsWith('TX_') && event.payload.txId === workspace.txId);
    const begun = events.find((event) => event.type === 'TX_BEGUN');
    if (!begun || begun.runId !== runId || begun.payload.forkRoot !== workspace.forkRoot
      || events.some((event) => ['TX_COMMITTED', 'TX_ABORTED', 'TX_CONFLICTED', 'TX_COMMITTING'].includes(event.type))) {
      throw new Error('Agent workspace must be an open transaction of its Run');
    }
    if ([...this.states.values()].some(({ state }) => state.id !== agentId
      && state.workspace?.txId === workspace.txId && !['completed', 'failed'].includes(state.status))) {
      throw new Error('Workspace transaction is already bound to another active agent');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AgentRuntime is closed');
  }
}
