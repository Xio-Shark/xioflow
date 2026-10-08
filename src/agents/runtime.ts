import type { ExecutionDomain } from '../domain.js';
import { WorkspaceCausalGraph, type CausalView } from '../workspace/causal-graph.js';
import { isAgentCheckpoint, projectAgentEvent, readAgentCheckpoint } from './journal.js';
import { AgentCommandGroup, type AgentCommandOptions, type AgentCommandResult, type AgentExecution } from './execution.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { DEFAULT_AGENT_RUN_BUDGET, validateRunBudget, type AgentRunBudget, type AgentRunUsage } from './run-budget.js';

export interface AgentWorkspace {
  txId: string;
  forkRoot: string;
}

export type AgentData = null | boolean | number | string | AgentData[] | { [key: string]: AgentData };
export type AgentStatus = 'ready' | 'checking' | 'running' | 'recovering' | 'waiting' | 'paused' | 'completed' | 'failed' | 'interrupted';

export interface AgentCheckpoint {
  seq: number;
  checkpoint: AgentData;
  stepsUsed: number;
  /** Historical workspace binding; does not imply its files still exist. */
  workspace?: AgentWorkspace | null;
  /** Explicit evidence branch, or no provenance claim. */
  causalHeads?: number[] | null;
}

export interface AgentCausalRecoveryPlan {
  /** Host-confirmed changed evidence, with duplicates removed. */
  changed: number[];
  affected: {
    agentId: string;
    /** Context that was inspected; compare its sequence before acting later. */
    checkpoint: AgentCheckpoint;
    invalidatedHeads: number[];
    /** Only invalidated nodes in this checkpoint's selected branch. */
    invalidatedNodes: number[];
    /** Latest tracked checkpoint unaffected by these seeds, not a validity claim. */
    restartFrom?: AgentCheckpoint;
  }[];
  unaffected: string[];
  /** Missing provenance is never classified as unaffected. */
  untracked: string[];
}

export interface AgentState {
  id: string;
  runId: string;
  parentId: string | null;
  input: AgentData;
  checkpoint: AgentData;
  workspace: AgentWorkspace | null;
  /** Evidence used to construct this checkpoint; null/absent means untracked. */
  causalHeads?: number[] | null;
  status: AgentStatus;
  maxSteps: number;
  stepsUsed: number;
  pauseRequested: boolean;
  reason: string | null;
  error: string | null;
  /** Version sampled around the last successful dispatch validation, or no claim. */
  validatedWorkspaceVersion?: string | null;
}

export interface AgentStepResult {
  status: 'ready' | 'completed';
  checkpoint: AgentData;
  /** Omission clears provenance for the new checkpoint; [] declares an empty branch. */
  causalHeads?: number[] | null;
}

export interface AgentRuntimeOptions {
  maxConcurrentAgents: number;
  /** Persisted on first use of a Run; reopening never replaces saved limits. */
  runBudget?: AgentRunBudget;
  /** One cooperative quantum, normally one provider response and its tool batch. */
  step(agent: AgentState, execution: AgentExecution): Promise<AgentStepResult>;
  /** Read-only check before dispatch. Omission means no evidence validation claim. */
  validate?(agent: AgentState, signal: AbortSignal): Promise<'valid' | 'stale' | 'unknown'>;
  /** Synchronous, host-owned revision of all workspace evidence used by validate. */
  workspaceVersion?(agent: AgentState): string;
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
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly dirtyScopes = new Set<string>();
  private cursor = 0;
  private closed = false;
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private draining?: Promise<void>;
  private readonly quanta = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly recoveries = new Map<string, Promise<AgentState | undefined>>();
  private readonly selections = new Set<Promise<AgentCheckpoint | undefined>>();
  private readonly interruptions = new Map<string, Promise<AgentState>>();
  private readonly runs = new Map<string, AgentRunUsage>();
  private readonly defaultRunBudget: AgentRunBudget;
  private readonly operationOwners = new Map<string, string>();
  private processSupervisor?: ProcessSupervisor;

  constructor(private readonly domain: ExecutionDomain, private readonly options: AgentRuntimeOptions) {
    if (!Number.isSafeInteger(options.maxConcurrentAgents) || options.maxConcurrentAgents < 1) {
      throw new Error('maxConcurrentAgents must be a positive safe integer');
    }
    this.defaultRunBudget = validateRunBudget(options.runBudget ?? DEFAULT_AGENT_RUN_BUDGET);
    if (options.workspaceVersion && !options.validate) throw new Error('workspaceVersion requires an evidence validator');
    if (owners.has(domain)) throw new Error('This domain already has an AgentRuntime');
    this.sync();
    for (const { state } of this.states.values()) {
      if (state.status === 'running' || state.status === 'recovering'
        || (state.status === 'checking' && state.reason === 'interrupt_requested')) {
        this.record({ ...state, status: 'interrupted', reason: 'host_restarted' }, 'recovered');
      }
      else if (state.status === 'checking' || state.status === 'ready') {
        this.record({ ...state, status: 'paused', reason: 'host_restarted' }, 'recovered');
      }
    }
    this.reconcileScopes();
    owners.add(domain);
  }

  create(input: { id: string; runId: string; parentId?: string; input: AgentData; checkpoint: AgentData; workspace?: AgentWorkspace; causalHeads?: number[] | null; maxSteps: number }): AgentState {
    this.assertAccepting();
    if (!input.id || this.get(input.id)) throw new Error(`Agent id is empty or already exists: "${input.id}"`);
    if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1) throw new Error('maxSteps must be a positive safe integer');
    this.assertRun(input.runId);
    if (input.workspace) this.assertWorkspace(input.workspace, input.runId, input.id);
    if (input.parentId !== undefined) {
      const parent = this.require(input.parentId);
      if (parent.runId !== input.runId) throw new Error('Parent agent belongs to another Run');
      this.assertScopeOpen(parent);
      if (parent.status === 'waiting') throw new Error('Parent agent is already joining its children');
    }
    const causalHeads = this.normalizeCausalHeads(input.causalHeads);
    const usage = this.ensureRunBudget(input.runId);
    if (usage.agentsCreated >= usage.budget.maxAgents) throw new Error('Run agent budget exhausted');
    return this.record({
      id: input.id, runId: input.runId, parentId: input.parentId ?? null,
      input: data(input.input), checkpoint: data(input.checkpoint), causalHeads, status: 'ready',
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

  getRunUsage(runId: string): AgentRunUsage {
    this.assertOpen();
    this.sync();
    const usage = this.runs.get(runId);
    if (!usage) throw new Error(`No agent budget for Run "${runId}"`);
    return structuredClone(usage);
  }

  pause(id: string): AgentState {
    this.assertAccepting();
    const state = this.require(id);
    if (state.reason === 'interrupt_requested' || this.quanta.get(id)?.controller.signal.aborted) throw new Error('Cannot pause agent with pending interruption');
    if (!['ready', 'running', 'checking', 'recovering', 'paused'].includes(state.status)) throw new Error(`Cannot pause ${state.status} agent`);
    const active = state.status === 'running' || state.status === 'checking' || state.status === 'recovering';
    return this.record({ ...state, pauseRequested: active, status: active ? state.status : 'paused', reason: 'requested' }, 'pause_requested');
  }

  /** Cancel the member's root task, then join its quanta and reconstruction. */
  interrupt(id: string): Promise<AgentState> {
    try { return this.interruptScope(id); }
    catch (error) { return Promise.reject(error); }
  }

  private interruptScope(id: string): Promise<AgentState> {
    const state = this.require(id);
    if (state.status === 'completed' || state.status === 'failed') throw new Error(`Cannot interrupt ${state.status} agent`);
    let root = state;
    while (root.parentId) root = this.require(root.parentId);
    const existing = this.interruptions.get(root.id);
    if (existing) return id === root.id ? existing : existing.then(() => this.require(id));
    let pending: Promise<unknown>[] = [];
    const requestFailures: unknown[] = [];
    const barrier = Promise.resolve().then(async () => {
      const settled = await Promise.allSettled(pending);
      const failures = [...requestFailures, ...settled.filter((result) => result.status === 'rejected').map((result) => result.reason)];
      if (failures.length) throw new AggregateError(failures, `Agent scope interruption failed: ${failures.map(String).join('; ')}`);
      return this.require(root.id);
    }).finally(() => { this.interruptions.delete(root.id); });
    // Register before abort listeners can reenter interruption or restoration.
    this.interruptions.set(root.id, barrier);
    try { pending = this.cancelScope(root.id); }
    catch (error) { requestFailures.push(error); }
    return id === root.id ? barrier : barrier.then(() => this.require(id));
  }

  resume(id: string): AgentState {
    this.assertAccepting();
    const state = this.require(id);
    if (state.status !== 'paused') throw new Error(`Cannot resume ${state.status} agent; restore an interrupted checkpoint explicitly`);
    if (state.stepsUsed >= state.maxSteps) throw new Error('Agent step budget exhausted');
    this.assertScopeOpen(state);
    const usage = this.ensureRunBudget(state.runId);
    if (usage.stepsUsed >= usage.budget.maxSteps) throw new Error('Run step budget exhausted');
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
      if (isAgentCheckpoint(event.payload.transition)) checkpoints.push({ seq: event.seq, checkpoint: state.checkpoint, stepsUsed: state.stepsUsed,
        workspace: state.workspace, causalHeads: state.causalHeads ?? null });
    }
    return structuredClone(checkpoints);
  }

  /** Query the evidence branch at checkpoint time, excluding later/sibling work. */
  checkpointCausalView(id: string, seq: number): CausalView | undefined {
    const saved = this.checkpoints(id).find((checkpoint) => checkpoint.seq === seq);
    if (!saved) throw new Error(`No checkpoint ${seq} for agent "${id}"`);
    if (saved.causalHeads == null) return undefined;
    return new WorkspaceCausalGraph(this.domain).view(saved.causalHeads, saved.seq);
  }

  /** Read-only cross-agent impact and rollback candidates, including terminal agents.
   * Does not cancel work, replay observations, or certify workspace validity.
   */
  planCausalRecovery(changed: readonly number[]): AgentCausalRecoveryPlan {
    const agents = this.list();
    const graph = new WorkspaceCausalGraph(this.domain);
    const invalid = new Set(graph.planRecomputation(changed).invalidated.map((node) => node.seq));
    const plan: AgentCausalRecoveryPlan = { changed: [...new Set(changed)], affected: [], unaffected: [], untracked: [] };
    for (const agent of agents) {
      const history = this.checkpoints(agent.id);
      const checkpoint = history.at(-1)!;
      if (checkpoint.causalHeads == null) {
        plan.untracked.push(agent.id);
        continue;
      }
      const invalidatedHeads = checkpoint.causalHeads.filter((seq) => invalid.has(seq));
      if (!invalidatedHeads.length) {
        plan.unaffected.push(agent.id);
        continue;
      }
      const restartFrom = [...history].reverse().find((saved) => saved.causalHeads != null
        && saved.causalHeads.every((seq) => !invalid.has(seq)));
      plan.affected.push({ agentId: agent.id, checkpoint, invalidatedHeads,
        invalidatedNodes: graph.view(checkpoint.causalHeads, checkpoint.seq).nodes
          .filter((node) => invalid.has(node.seq)).map((node) => node.seq),
        ...(restartFrom ? { restartFrom } : {}),
      });
    }
    return plan;
  }

  private normalizeCausalHeads(heads: number[] | null | undefined): number[] | null {
    if (heads == null) return null;
    if (!Array.isArray(heads)) throw new Error('Agent causal heads must be an array');
    return new WorkspaceCausalGraph(this.domain).view(heads).heads;
  }

  /** Select by recorded evidence, not by checkpoint age. Caller reconstructs before restore. */
  async findValidCheckpoint(id: string): Promise<AgentCheckpoint | undefined> {
    this.assertAccepting();
    const validate = this.options.validate;
    if (!validate) throw new Error('Checkpoint selection requires an evidence validator');
    const state = this.require(id);
    if (state.status !== 'paused' && state.status !== 'interrupted') throw new Error('Checkpoint selection requires a stopped agent');
    const checkpoints = this.checkpoints(id).reverse();
    const selection = Promise.resolve().then(async () => {
      for (const saved of checkpoints) {
        if (this.stopping) return undefined;
        const verdict = await validate({ ...structuredClone(state), checkpoint: structuredClone(saved.checkpoint),
          causalHeads: structuredClone(saved.causalHeads ?? null) }, new AbortController().signal);
        if (!['valid', 'stale', 'unknown'].includes(verdict)) throw new Error('Invalid agent evidence verdict');
        if (verdict === 'valid') return saved;
      }
      return undefined;
    }).finally(() => { this.selections.delete(selection); });
    this.selections.add(selection);
    return selection;
  }

  /** Caller reconstructs the workspace/tool state first. Spent budget is never rewound. */
  restoreCheckpoint(id: string, seq: number, workspace?: AgentWorkspace): AgentState {
    this.assertAccepting();
    const state = this.require(id);
    this.assertScopeOpen(state, true);
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
    this.assertAccepting();
    const previous = this.require(id);
    if (previous.status !== 'paused' && previous.status !== 'interrupted') throw new Error(`Cannot recover ${previous.status} agent`);
    this.assertScopeOpen(previous, true);
    this.assertRun(previous.runId);
    const checkpoints = this.checkpoints(id);
    this.record({ ...previous, status: 'recovering', reason: 'reconstruction', pauseRequested: false }, 'recovery_started');
    // Register the join before invoking host code, which may request shutdown.
    const recovery = Promise.resolve().then(async () => {
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        prepared = await prepare(checkpoints);
        if (this.require(id).reason === 'interrupt_requested') {
          const discard = prepared?.discard;
          prepared = undefined;
          await discard?.();
          this.record({ ...previous, status: 'interrupted', pauseRequested: false, reason: 'interrupt_requested' }, 'recovery_interrupted');
          return undefined;
        }
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
        const cancelled = this.require(id).reason === 'interrupt_requested';
        try { this.record(cancelled ? { ...previous, status: 'interrupted', pauseRequested: false, reason: 'interrupt_requested', error: String(failure) } : previous, 'recovery_failed'); }
        catch (restoreError) { throw new AggregateError([failure, restoreError], 'Recovery failed and its prior state could not be restored'); }
        throw failure;
      }
    }).finally(() => { this.recoveries.delete(id); });
    this.recoveries.set(id, recovery);
    return recovery;
  }

  private commitRestore(state: AgentState, seq: number, workspace?: AgentWorkspace): AgentState {
    const saved = this.checkpoints(state.id).find((checkpoint) => checkpoint.seq === seq);
    if (!saved) throw new Error(`No checkpoint ${seq} for agent "${state.id}"`);
    this.assertRun(state.runId);
    if (workspace) this.assertWorkspace(workspace, state.runId, state.id);
    return this.record({
      ...state, checkpoint: saved.checkpoint, causalHeads: saved.causalHeads ?? null,
      workspace: workspace ? { txId: workspace.txId, forkRoot: workspace.forkRoot } : state.workspace,
      status: 'paused', pauseRequested: false, reason: 'restored', error: null,
    }, 'restored', seq);
  }

  /** Drain runnable agents. Paused/interrupted agents do not keep this promise pending. */
  drain(): Promise<void> {
    this.assertAccepting();
    if (!this.draining) this.draining = Promise.resolve().then(() => this.schedule()).finally(() => { this.draining = undefined; });
    return this.draining;
  }

  close(): void {
    if (this.closed) return;
    if (this.stopping) throw new Error('Await shutdown() before closing AgentRuntime');
    if (this.draining) throw new Error('Await drain() before closing AgentRuntime');
    if (this.recoveries.size > 0) throw new Error('Await active recovery before closing AgentRuntime');
    if (this.selections.size > 0) throw new Error('Await checkpoint selection before closing AgentRuntime');
    if (this.interruptions.size > 0) throw new Error('Await scope interruption before closing AgentRuntime');
    this.closed = true;
    owners.delete(this.domain);
  }

  /** Stop admission, settle owned work, then release the runtime (not its domain). */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.closed) return Promise.resolve();
    this.stopping = true;
    const pending: Promise<unknown>[] = [
      ...[...this.quanta.values()].map((quantum) => quantum.settled),
      ...this.recoveries.values(),
      ...this.selections,
      ...this.interruptions.values(),
      ...(this.draining ? [this.draining] : []),
    ];
    this.shutdownPromise = Promise.resolve().then(() => this.settleShutdown(pending));
    return this.shutdownPromise;
  }

  private async settleShutdown(pending: Promise<unknown>[]): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (const saved of this.list()) {
        const state = this.require(saved.id);
        if (state.status === 'ready') {
          try {
            this.record({ ...state, status: 'paused', pauseRequested: false, reason: 'shutdown' }, 'shutdown_requested');
          } catch (error) { errors.push(error); }
        } else if (state.status === 'checking' || state.status === 'running' || state.status === 'waiting') {
          pending.push(this.interrupt(state.id));
        }
      }
    } catch (error) { errors.push(error); }
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    this.closed = true;
    owners.delete(this.domain);
    const failures = [...new Set(errors)];
    if (failures.length > 0) throw new AggregateError(failures, `Agent shutdown failed: ${failures.map(String).join('; ')}`);
  }

  private async schedule(): Promise<void> {
    const active = new Set<Promise<void>>();
    try {
      for (;;) {
        this.sync();
        this.reconcileScopes();
        const ready = this.stopping ? [] : [...this.states.values()].filter(({ state }) => state.status === 'ready').sort((a, b) => a.seq - b.seq);
        for (const { state } of ready.slice(0, this.options.maxConcurrentAgents - active.size)) {
          const controller = new AbortController();
          const pending = Promise.resolve().then(() => this.advance(state.id, controller.signal)).finally(() => {
            active.delete(pending);
            this.quanta.delete(state.id);
          });
          this.quanta.set(state.id, { controller, settled: pending });
          active.add(pending);
        }
        if (active.size === 0) {
          const cancelled = [...this.recoveries].filter(([id]) => this.require(id).reason === 'interrupt_requested').map(([, recovery]) => recovery);
          if (cancelled.length === 0) return;
          const settled = await Promise.allSettled(cancelled);
          const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
          if (failures.length) throw new AggregateError(failures, 'Cancelled scope reconstruction failed');
          continue;
        }
        await Promise.race(active);
      }
    } finally {
      // A persistence failure must not leave other adapters running after drain rejects.
      await Promise.allSettled(active);
    }
  }

  private async advance(id: string, signal: AbortSignal): Promise<void> {
    if (this.stopping) return;
    let state = this.require(id);
    if (state.status !== 'ready') return;
    const usage = this.ensureRunBudget(state.runId);
    if (state.stepsUsed >= state.maxSteps || usage.stepsUsed >= usage.budget.maxSteps) {
      this.record({ ...state, status: 'paused', reason: state.stepsUsed >= state.maxSteps ? 'budget_exhausted' : 'run_budget_exhausted' }, 'budget_exhausted');
      return;
    }
    try {
      this.assertRun(state.runId);
      this.assertScopeOpen(state);
    } catch (error) {
      this.record({ ...state, status: 'failed', reason: 'run_unavailable', error: String(error) }, 'failed');
      this.reconcileScopes();
      return;
    }
    this.record({ ...state, status: 'checking' }, 'checking');
    let validity: 'valid' | 'stale' | 'unknown';
    let workspaceVersion: string | null = null;
    try {
      workspaceVersion = this.readWorkspaceVersion(state);
      validity = this.options.validate ? await this.options.validate(this.require(id), signal) : 'valid';
      signal.throwIfAborted();
      if (!['valid', 'stale', 'unknown'].includes(validity)) throw new Error('Invalid agent evidence verdict');
      this.assertRun(state.runId);
      if (state.workspace) this.assertWorkspace(state.workspace, state.runId, id);
      if (workspaceVersion !== this.readWorkspaceVersion(state)) validity = 'stale';
      signal.throwIfAborted();
      this.assertScopeOpen(this.require(id));
    } catch (error) {
      this.record({ ...this.require(id), status: signal.aborted ? 'interrupted' : 'failed',
        pauseRequested: false, reason: signal.aborted ? 'interrupt_requested' : 'validation_failed', error: String(error),
      }, signal.aborted ? 'interrupted' : 'failed');
      this.reconcileScopes();
      return;
    }
    state = this.require(id);
    if (validity !== 'valid' || state.pauseRequested || this.stopping) {
      const reason = validity !== 'valid' ? `evidence_${validity}` : this.stopping ? 'shutdown' : 'requested';
      this.record({ ...state, status: 'paused', pauseRequested: false, reason }, this.stopping ? 'shutdown_requested' : 'paused');
      return;
    }
    // Validators may run concurrently; reserve against the latest shared projection.
    if (usage.stepsUsed >= usage.budget.maxSteps) {
      this.record({ ...state, status: 'paused', reason: 'run_budget_exhausted' }, 'budget_exhausted');
      return;
    }
    state = this.record({ ...state, status: 'running', stepsUsed: state.stepsUsed + 1, validatedWorkspaceVersion: workspaceVersion }, 'step_started');
    let result: AgentStepResult;
    try {
      const commands = new AgentCommandGroup((options) => this.executeOwnedProcess(state, options), signal, () => this.reserveCommand(state));
      const failures: unknown[] = [];
      let returned: AgentStepResult | undefined;
      try { returned = await this.options.step(structuredClone(state), commands.context); }
      catch (error) { failures.push(error); }
      failures.push(...await commands.finish());
      if (signal.aborted) failures.push(signal.reason);
      const uniqueFailures = [...new Set(failures)];
      if (uniqueFailures.length === 1) throw uniqueFailures[0];
      if (uniqueFailures.length > 1) throw new AggregateError(uniqueFailures, `Agent step and commands failed: ${uniqueFailures.map(String).join('; ')}`);
      result = returned!;
      if (!['ready', 'completed'].includes(result.status)) throw new Error('Invalid agent step status');
      result = { status: result.status, checkpoint: data(result.checkpoint),
        causalHeads: this.normalizeCausalHeads(result.causalHeads) };
    } catch (error) {
      this.record({ ...this.require(id), status: 'interrupted', pauseRequested: false,
        reason: signal.aborted ? 'interrupt_requested' : 'step_failed', error: String(error),
      }, 'interrupted');
      this.reconcileScopes();
      return;
    }
    state = this.require(id);
    const pause = result.status !== 'completed' && (state.pauseRequested || state.stepsUsed >= state.maxSteps);
    this.record({
      ...state, checkpoint: result.checkpoint, causalHeads: result.causalHeads, status: pause ? 'paused' : result.status === 'completed' && this.children(id).length > 0 ? 'waiting' : result.status, pauseRequested: false,
      reason: pause ? (state.pauseRequested ? 'requested' : 'budget_exhausted') : null,
    }, 'step_completed');
  }

  private async executeOwnedProcess(agent: AgentState, options: AgentCommandOptions): Promise<AgentCommandResult> {
    this.assertAccepting();
    if (typeof options.opId !== 'string' || options.opId.length === 0) throw new Error('Agent command opId must be a nonempty string');
    this.sync();
    const current = this.states.get(agent.id)?.state;
    if (current?.status !== 'running' || current.stepsUsed !== agent.stepsUsed) throw new Error('Agent command does not belong to the active quantum');
    this.assertScopeOpen(current);
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

  private children(id: string): AgentState[] {
    return [...(this.childrenByParent.get(id) ?? [])].map((child) => this.states.get(child)!.state);
  }

  private scope(id: string): AgentState[] {
    const scope = [this.states.get(id)!.state];
    for (let i = 0; i < scope.length; i++) scope.push(...this.children(scope[i].id));
    return scope;
  }

  private assertScopeOpen(state: AgentState, restoring = false): void {
    let current: AgentState | undefined = state;
    while (current) {
      if (this.interruptions.has(current.id)
        || (!(restoring && current.id === state.id) && (['completed', 'failed', 'interrupted'].includes(current.status) || current.reason === 'interrupt_requested'))) {
        throw new Error(`Agent scope "${current.id}" is closed`);
      }
      current = current.parentId ? this.require(current.parentId) : undefined;
    }
    if (restoring && this.scope(state.id).some((member) => this.quanta.has(member.id) || this.recoveries.has(member.id))) {
      throw new Error(`Agent scope "${state.id}" has unsettled work`);
    }
  }

  private cancelScope(id: string): Promise<unknown>[] {
    this.sync();
    const scope = this.scope(id);
    const pending: Promise<unknown>[] = [];
    // All descendants are fenced durably before any synchronous abort listener runs.
    this.domain.getStore().transaction(() => {
      for (const state of scope) {
        if (['completed', 'failed', 'interrupted'].includes(state.status) || state.reason === 'interrupt_requested') continue;
        const active = (['checking', 'running'].includes(state.status) && this.quanta.has(state.id))
          || (state.status === 'recovering' && this.recoveries.has(state.id));
        this.append({ ...state, status: active ? state.status : 'interrupted', pauseRequested: false, reason: 'interrupt_requested' }, active ? 'interrupt_requested' : 'interrupted');
      }
    });
    this.sync();
    for (const state of scope) {
      const quantum = this.quanta.get(state.id);
      if (quantum) {
        pending.push(quantum.settled);
        quantum.controller.abort(new Error('Agent interruption requested'));
      }
      const recovery = this.recoveries.get(state.id);
      if (recovery) pending.push(recovery);
    }
    return pending;
  }

  private reconcileScopes(): void {
    this.sync();
    // The journal marks only changed roots dirty; historical cancelled trees do
    // not need another traversal on every unrelated scheduling boundary.
    while (this.dirtyScopes.size > 0) {
      const id = this.dirtyScopes.values().next().value!;
      this.dirtyScopes.delete(id);
      try {
        const scope = this.scope(id);
        if (scope.some((state) => ['interrupted', 'failed'].includes(state.status) || state.reason === 'interrupt_requested')) {
          this.cancelScope(id);
          continue;
        }
        for (const state of scope.reverse()) {
          if (state.status === 'waiting' && this.children(state.id).every((child) => child.status === 'completed')) {
            this.record({ ...state, status: 'completed', reason: null }, 'scope_completed');
          }
        }
      } catch (error) {
        this.dirtyScopes.add(id);
        throw error;
      }
    }
  }

  private readWorkspaceVersion(state: AgentState): string | null {
    if (!this.options.workspaceVersion) return null;
    const version = this.options.workspaceVersion(structuredClone(state));
    if (typeof version !== 'string' || version.length === 0) throw new Error('workspaceVersion must return a nonempty string');
    return version;
  }

  private ensureRunBudget(runId: string): AgentRunUsage {
    this.sync();
    if (!this.budgetedRuns.has(runId)) {
      this.domain.getStore().transaction(() => this.domain.getStore().recordJournalEvent({
        domainId: this.domain.domainId, runId, type: 'AGENT_RUN_BUDGET',
        payload: { version: 1, budget: this.defaultRunBudget }, timestamp: new Date().toISOString(),
      }));
      this.sync();
    }
    return this.runs.get(runId)!;
  }

  private reserveCommand(agent: AgentState): () => void {
    this.assertAccepting();
    this.assertScopeOpen(this.require(agent.id));
    const usage = this.ensureRunBudget(agent.runId);
    if (usage.pendingCommands >= usage.budget.maxPendingCommands) throw new Error('Run pending command limit exceeded');
    usage.pendingCommands++;
    return () => { usage.pendingCommands--; };
  }

  private record(state: AgentState, transition: string, checkpointRef?: number): AgentState {
    this.assertOpen();
    this.domain.getStore().transaction(() => this.append(state, transition, checkpointRef));
    this.sync();
    return structuredClone(state);
  }

  private append(state: AgentState, transition: string, checkpointRef?: number): void {
    const { input, checkpoint, ...metadata } = state;
    const contents = transition === 'created' ? { input, checkpoint }
      : transition === 'step_completed' ? { checkpoint }
      : transition === 'restored' ? { checkpointRef }
      : {};
    this.domain.getStore().recordJournalEvent({
      domainId: this.domain.domainId, runId: state.runId, type: 'AGENT_STATE',
      payload: { version: 2, transition, state: metadata, ...contents }, timestamp: new Date().toISOString(),
    });
  }

  private readonly budgetedRuns = new Set<string>();

  private sync(): void {
    for (const event of this.domain.getStore().getJournalEvents(this.domain.domainId, this.cursor)) {
      if (event.type === 'AGENT_RUN_BUDGET') {
        if (event.payload.version !== 1 || !event.runId || this.budgetedRuns.has(event.runId)) throw new Error('Invalid or duplicate agent Run budget event');
        const budget = validateRunBudget(event.payload.budget as AgentRunBudget);
        const usage = this.runs.get(event.runId);
        if (usage) usage.budget = budget;
        else this.runs.set(event.runId, { budget, stepsUsed: 0, agentsCreated: 0, pendingCommands: 0 });
        this.budgetedRuns.add(event.runId);
      }
      if (event.type === 'AGENT_OPERATION_REQUESTED') {
        const agentId = event.payload.agentId;
        if (!event.operationId || typeof agentId !== 'string') throw new Error('Invalid agent operation ownership event');
        const owner = this.operationOwners.get(event.operationId);
        if (owner && owner !== agentId) throw new Error('Conflicting agent operation ownership');
        this.operationOwners.set(event.operationId, agentId);
      }
      if (event.type !== 'AGENT_STATE') { this.cursor = event.seq + 1; continue; }
      const id = (event.payload.state as AgentState).id;
      const previous = this.states.get(id)?.state;
      const state = projectAgentEvent(event, previous, (seq, agentId) => this.readCheckpoint(seq, agentId));
      let usage = this.runs.get(state.runId);
      if (!usage) {
        usage = { budget: { ...this.defaultRunBudget }, stepsUsed: 0, agentsCreated: 0, pendingCommands: 0 };
        this.runs.set(state.runId, usage);
      }
      usage.stepsUsed += state.stepsUsed - (previous?.stepsUsed ?? 0);
      if (!previous) usage.agentsCreated++;
      this.states.set(state.id, { seq: event.seq, state });
      if (!previous && state.parentId) {
        let children = this.childrenByParent.get(state.parentId);
        if (!children) this.childrenByParent.set(state.parentId, children = new Set());
        children.add(state.id);
      }
      let root = state;
      while (root.parentId) root = this.states.get(root.parentId)!.state;
      this.dirtyScopes.add(root.id);
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

  private assertAccepting(): void {
    this.assertOpen();
    if (this.stopping) throw new Error('AgentRuntime is shutting down');
  }
}
