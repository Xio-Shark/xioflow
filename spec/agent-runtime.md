# Experimental agent runtime

`AgentRuntime` owns agent identity, task input, parent relationships, dispatch,
checkpoints and step budgets inside an `ExecutionDomain`. A distribution supplies
one cooperative `step` adapter; the kernel does not implement provider protocols,
prompts or file tools. The E6 adapter reuses xiocode's existing agent loop.

An agent can bind an open workspace transaction through `workspace: { txId,
forkRoot }`. The transaction must belong to its Run, and another nonterminal
agent cannot share that binding. The binding and checkpoint are persisted in
the same state event when restoring onto a new transaction.

## Persistence and transitions

The existing SQLite journal stores versioned `AGENT_STATE` events. An incremental
map projects those events for scheduling. No second database or table migration
is introduced. Version 1 stored a complete state in each event; the reader still
accepts it, including journals mixing old and new events.

Version 2 keeps status/budget/workspace metadata in `payload.state`. Creation
stores `payload.input` and `payload.checkpoint` once. A completed step stores its
new checkpoint; control-only transitions carry neither data body. Restoration
stores a backward `checkpointRef` to a checkpoint event for the same agent.
A `causal_repaired` event stores the rebuilt checkpoint plus `checkpointRef`
identifying the source context, with its new workspace and heads in metadata.
The runtime reconstructs complete public `AgentState`/`AgentCheckpoint` values;
callers of those APIs do not need to understand the encoding. Raw journal readers
must check the version. Missing, forward or cross-agent references fail visibly,
and a failed projection does not advance past the bad event on the next read.

The full journal remains authoritative and referenced events must be retained.
This removes lifecycle-event duplication, not the repeated prefixes inside each
full checkpoint. Local E9 measurements and limitations are recorded in
[the persistence experiment](../audit/observation/JOURNAL.md).

- `create`: register an agent in an existing nonterminal Run; optional parent
  must belong to the same Run and an open task scope. Input/checkpoints are JSON data.
- `drain`: dispatch ready agents in journal-sequence order with a fixed
  `maxConcurrentAgents` ceiling. A completed quantum rejoins at the queue tail.
- Before a quantum, `validate` can return `valid`, `stale` or `unknown`.
  Stale/unknown evidence pauses the agent without calling `step` or spending its
  step budget. Omitting `validate` makes no evidence-validity guarantee.
- `step_started` reserves one unit of `maxSteps` before invoking the adapter.
  A quantum is normally one model response plus its tool batch. Budget is not
  token usage, and it does not bound time spent inside a quantum.
- `pause` on ready agents is immediate; on checking/running agents it takes
  effect at the next boundary. It does not kill an in-flight provider or tool.
- `interrupt` requests cancellation and waits for the active validator or step
  and its managed command batch. It retains the last checkpoint and spent
  budget. See the interruption contract below.
- A successful quantum persists its checkpoint, then becomes ready, completed,
  or paused (explicit request or exhausted budget).
- A thrown step becomes `interrupted`, retaining the reserved budget and last
  completed checkpoint. It is not retried. Validation errors become `failed`.
- Reopening a runtime pauses saved ready/checking agents. Saved running agents
  become interrupted. Normal resume is permitted only from paused state.
- `findValidCheckpoint` checks saved boundaries newest-first using `validate`.
  It returns a candidate, not a reconstructed workspace or a permanent validity
  certificate. The adapter must inspect an immutable version or revalidate on
  dispatch if the workspace can change meanwhile.
- After reconstructing workspace/tool state, `restoreCheckpoint` selects a saved
  boundary and leaves the agent paused. It never resets `stepsUsed`.
- `recoverCheckpoint` reserves a stopped agent as `recovering` before invoking
  asynchronous preparation. During preparation, binding and failure cleanup,
  `resume`, direct restoration and a second recovery are rejected. Other agents
  can still drain. A pause request leaves the agent stopped after recovery; it
  does not cancel reconstruction.
- Preparation returns a saved checkpoint sequence and optional workspace. An
  optional `discard` callback releases prepared resources if final binding fails.
  A thrown preparation or no valid candidate restores the prior agent state,
  including an interrupted origin. Successful binding leaves it paused. Spent
  budget does not change on these transitions.
- Reopening after a host crash in `recovering` marks the agent interrupted with
  its original context and workspace binding. It does not assume that a prepared
  fork was fully reconstructed. Leftover candidate transactions remain available
  for inspection/cleanup through the existing transaction journal.
- A Run cannot report success while its agents are nonterminal. Agent completion
  does not finish its Run. A parent waits for its children as described below.

One live runtime owns a domain. `close` requires `drain`, active checkpoint selection and recovery
promises to have settled. The
domain's existing owner/epoch mechanism protects persistent writes across host
restart. The runtime does not introduce a daemon or a cross-host scheduler.

## Causal checkpoints

`create` and `AgentStepResult` accept optional `causalHeads: number[] | null`.
The heads select the observations and tool results used to build that checkpoint.
Each head must already be a `WorkspaceCausalGraph` node in the same domain;
duplicates are removed. References can cross actors and transactions, so a
checkpoint can depend on another agent's evidence. The host declares all inputs.

The runtime saves heads alongside the checkpoint in the same `AGENT_STATE`
event. `checkpoints(id)` returns each boundary's `causalHeads` and historical
`workspace` binding. `checkpointCausalView(id, seq)` resolves only that branch
and its ancestors at the checkpoint's journal sequence. Nodes expose transaction,
Run and base snapshot identities; later nodes and sibling branches are excluded.
An unknown checkpoint throws. The query does not execute tools or restore files.

Omitted or null heads mean **untracked**, and the view returns `undefined`.
An explicit `[]` selects an empty branch. A new step that omits heads clears the
previous provenance: adapters must explicitly return the complete selected heads
when retaining evidence. Legacy journals remain untracked. An invalid reference
on creation rejects the request; an invalid step result interrupts the agent,
retaining the last completed checkpoint and the spent step budget.

```ts
const graph = new WorkspaceCausalGraph(domain);
const agents = new AgentRuntime(domain, {
  maxConcurrentAgents: 1,
  step: async (agent) => {
    const result = await readInput(agent.workspace!.forkRoot);
    const evidence = graph.record({
      txId: agent.workspace!.txId, actorId: agent.id,
      dependsOn: agent.causalHeads ?? [],
      observation: {
        kind: 'observe', call: { tool: 'readInput', args: {} },
        resultHash: hashResult(result),
      },
    });
    return { status: 'completed', checkpoint: { result }, causalHeads: [evidence.seq] };
  },
});
// readInput/hashResult are host adapters; create the agent on an open transaction.
// After drain(), inspect the saved context and its causal evidence:
const saved = agents.checkpoints('agent-id').at(-1)!;
const branch = agents.checkpointCausalView('agent-id', saved.seq);
const plan = graph.planRecomputation([changedNodeSeq], saved.seq, branch!.heads);
```

`findValidCheckpoint` passes each candidate's checkpoint **and its own heads**
to the validator, against the agent's current workspace. `restoreCheckpoint`
and successful `recoverCheckpoint` restore the selected heads with the context;
an explicitly supplied reconstructed workspace is bound in the same event.
Without a replacement workspace, the current binding is retained. Restoring a
restored checkpoint preserves these semantics across domain reopen.

Heads describe the context's provenance, not a claim that its transactions
committed or that observations remain valid on a reconstructed world. A stored
fork path may no longer exist. Snapshot retention, reconstruction, current-world
validation and complete dependency declarations remain the host's responsibility.

### Cross-agent causal recovery plans

`agents.planCausalRecovery(changedNodeSeqs)` maps host-confirmed changed evidence
to the latest checkpoint of every agent in the domain, across Runs and actors.
It follows transitive causal dependencies rather than task parentage or actor
names. Unknown seeds throw; duplicate seeds are removed.

- `affected` contains the agent ID, inspected checkpoint, invalidated heads and
  invalidated node sequences within that checkpoint's selected branch. Sibling
  speculative branches are excluded from each agent's explanation.
- `restartFrom`, when present on an affected entry, is its most recent tracked
  historical checkpoint with no dependency on the changed evidence. An explicit
  empty branch qualifies; missing/null provenance does not. Absence means the
  host has no recorded candidate and may need to rebuild context from scratch.
- `unaffected` lists tracked agents outside this invalidation closure;
  `untracked` lists agents whose latest checkpoint has no provenance claim.

The query does not write journal events, execute tools, stop agents or alter
budgets. Completed/failed agents are included so stale final outputs are visible;
their presence does not make them restorable under existing lifecycle rules.
Returned checkpoints are detached copies. Empty seeds still report untracked
agents. Restored branches are used on subsequent queries, including after reopen.

`agents.explainCausalRecovery(changedNodeSeqs)` returns the same plan with an
additional `recomputation: ExplainedRecomputationPlan` on each affected entry.
Each report selects the inspected checkpoint's heads at its journal sequence,
filters globally known seeds to that branch, and includes every invalidated
node's shortest dependency path from each reachable changed seed. Unknown seeds
still throw before branch filtering. Node metadata identifies actors, transactions
and tool calls. Historical/sibling nodes outside the selected branch cannot enter
the report. The query is read-only, returns detached data, and uses the existing
graph explanation ordering and tie-breaking rules. Ordinary planning does not
compute paths. See [recovery preview example](../docs/causal-explanations.md#跨-agent-的-checkpoint-恢复预览).

```ts
// Host has detected a changed observation and stopped this agent's work.
const plan = agents.planCausalRecovery([changedNodeSeq]);
const impact = plan.affected.find((entry) => entry.agentId === 'agent-id');
if (impact?.restartFrom) {
  const candidate = impact.restartFrom;
  await agents.recoverCheckpoint(impact.agentId, async (history) => {
    // The plan is a point-in-time query: reject if the agent advanced meanwhile.
    if (history.at(-1)?.seq !== impact.checkpoint.seq) {
      throw new Error('Agent checkpoint changed; replan recovery');
    }
    // Host adapter reconstructs files/tools, validates evidence on the new world,
    // and provides discard() for cleanup if runtime binding fails.
    const prepared = await reconstructAndValidate(candidate);
    return { seq: candidate.seq, workspace: prepared.workspace, discard: prepared.discard };
  });
}
```

An unaffected branch is only unaffected **by these declared changes**. This API
does not detect changes, prove dependency completeness, certify OCC commit or
current-world validity, or infer how model context should be rebuilt. The host
must recheck world revisions during reconstruction. `prepareWorkspaceRepair`
can separately recompute the affected file subgraph; its new heads cannot be
substituted into an old model checkpoint without rebuilding that context.

### Binding incrementally repaired context

`recoverCausalCheckpoint(id, expectedCheckpointSeq, prepare)` connects an impact
plan to asynchronous workspace repair and host context reconstruction. It rejects
an outdated checkpoint sequence or untracked context before calling `prepare`.
The agent must be paused or interrupted, with an open scope and nonterminal Run.
It reserves the agent as `recovering`, preventing concurrent dispatch or restore.

`prepare(saved)` receives a detached copy of the inspected checkpoint. Return
`{ checkpoint, causalHeads, workspace, discard? }` after rebuilding the context
from repaired results and validating the new world. Heads must be explicit
(`[]` is allowed) and exist in this domain; the workspace must be an open
transaction of this Run, not bound to another active agent. A successful bind
writes context, heads and workspace in one `causal_repaired` checkpoint event,
records the source checkpoint reference, clears the prior validation version,
and leaves the agent paused. Agent and Run budgets are never rewound or charged
by the binding operation; host repair work is accounted for by its own adapters.
The new checkpoint participates in history, causal queries and later restoration,
including after domain reopen.

```ts
const impact = agents.planCausalRecovery([changedNodeSeq]).affected[0];
if (impact) {
  await agents.recoverCausalCheckpoint(impact.agentId, impact.checkpoint.seq, async (saved) => {
    const repaired = await prepareWorkspaceRepair(supervisor, {
      ...repairOptions, // txId, runId, root, forkPath, validateReuse, execute
      changed: [changedNodeSeq], atSeq: saved.seq, heads: saved.causalHeads!,
    });
    const discard = async () => {
      await supervisor.abortWorkspaceTransaction(repaired.transaction.txId);
      await supervisor.pruneSnapshots([repaired.transaction.baseSnapshotId], { runId });
    };
    try {
      // Host adapter rebuilds model/tool context using the fresh results and
      // independently verifies world revisions and all reused evidence.
      const checkpoint = await rebuildAndValidateContext(saved.checkpoint, repaired);
      return { checkpoint, causalHeads: repaired.heads, workspace: repaired.transaction, discard };
    } catch (error) {
      try { await discard(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Context rebuild and cleanup failed'); }
      throw error;
    }
  });
}
```

Returning `undefined` abandons preparation. A thrown error preserves the previous
context and branch. Once preparation returns resources, failed binding or an
interrupt calls `discard` and does not publish the new checkpoint; cleanup
failures are surfaced. Before returning, the host owns cleanup on its own errors.
Shutdown joins preparation through the existing recovery lifecycle. Binding does
not commit files, prove world validity, infer complete dependencies, or transform
old model context automatically. Continue execution on the prepared fork and use
the normal OCC commit path. The batch helper below coordinates per-agent calls;
the host still owns dependency scheduling and reconstruction.

### Causal recovery batches

`recoverAgentCausalBatch(agents, changed, prepare)` snapshots `planCausalRecovery`
and sequentially recovers affected stopped agents through `recoverCausalCheckpoint`.
It returns the original plan and one outcome per affected agent: `repaired`,
`skipped` (checkpoint changed, not stopped, or not repaired), or `failed` with the
original error. Preparation receives an isolated copy of the impact entry.
Each successful binding is independently journaled; failures do not undo earlier
bindings or prevent later attempts. It does not stop/resume agents, commit
transactions, deduplicate shared ancestors, or impose a causal scheduling order.
`recoverAgentSharedCausalBatch(agents, changed, { prepare, bind })` uses the same
frozen-plan binding loop after one shared branch repair preparation. Branch IDs
must identify agents and source head sets must match the inspected checkpoints.
The coordinator supplies mapped causal heads; the host rebuilds each context and
materializes an independently owned open transaction. Active agents never share
transaction ownership. Returning the shared repair transaction is rejected without
calling its discard callback. Otherwise normal per-agent failure cleanup applies.
The shared repair remains host-owned and is returned even if every binding fails;
preparation errors propagate before any binding and must clean their own resources.
No affected agents means no preparation. Publication and OCC remain separate;
there is no atomic batch commit or automatic shared-resource reclamation.
See [batch semantics and integration example](../docs/causal-recovery-batches.md).

## Task scopes

`parentId` defines a structured task tree within a Run. Separate roots in the same
Run share budgets but not cancellation. A successful parent quantum saves its
checkpoint and enters `waiting` until its children complete. Waiting consumes no
dispatch slot, so a single-slot runtime can run those children. The runtime marks
the parent `completed` only after the join. A waiting parent cannot accept new
direct children; its existing children may still create their own descendants.

`drain()` settles runnable work, not paused work. If a child pauses for evidence,
budget or a host request, its parent stays `waiting` and `drain()` can return.
After an explicit child resume, another drain continues the join. Waiting state
and its checkpoint survive reopening without rerunning the parent quantum.
Drain also waits for reconstruction cancelled by a task failure; unrelated
uncancelled reconstruction remains independent of runnable work.

A failed or interrupted member cancels its entire root task, including siblings.
This is a fail-fast policy, not a supervisor/restart policy. `interrupt(id)` on any
nonterminal member requests cancellation for that root and joins all its active
quanta, managed commands and workspace reconstruction. Completed/failed members
reject direct interruption. Unrelated roots continue running.

Cancellation writes the tree's states in one SQLite transaction before invoking
abort listeners. A journal failure rolls back the request and does not notify the
adapters. Closed ancestors fence child creation, resumption, command admission and
restoration. Concurrent/reentrant interruption calls share the root barrier.
Do not await that barrier from any callback in the affected tree.

Reconstruction remains cooperative: cancellation waits for preparation, discards
its prepared candidate, and leaves the agent interrupted without binding it.
Cleanup errors reject both recovery and the interruption barrier after settlement.
Checkpoint searches are read-only, do not participate in the task execution join,
and return candidates rather than authority to restore a closed scope.

After cancellation settles, restore interrupted ancestors before descendants,
then resume selected agents. Restoration does not reopen other interrupted members
or refund their budgets. A remaining failed/interrupted member will cancel the
root again on drain. A terminal validation failure requires a new task tree/Run.
Host restart never dispatches the saved tree: interrupted descendants also cancel
their waiting or paused ancestors. These rules extend the experimental API and
change the historical metadata-only meaning of `parentId`.

## Shared Run admission budgets

`runBudget: { maxSteps, maxAgents, maxPendingCommands }` sets defaults for Runs
first used by this runtime. All values must be positive safe integers. The default
limits are 10,000 quanta, 1,024 lifetime agent identities, and 64 outstanding
commands per Run. Choose smaller application-specific limits when appropriate.

The runtime writes an `AGENT_RUN_BUDGET` version-1 event before the Run's first
agent creation/execution. Existing persisted limits win over constructor defaults
on reopen. Legacy journals acquire limits on first subsequent admission; existing
agents and spent steps count toward them. Limits cannot be increased by reopening
or checkpoint restoration. Start a new Run for a new allocation.

The shared step count is the sum of persisted agent `stepsUsed`. One `step_started`
event reserves both the agent's step and its Run charge before invoking the
adapter. Concurrent validators recheck the shared balance when they dispatch.
Failed/interrupted work retains its charge. A shared budget exhaustion pauses
ready work with `run_budget_exhausted`; `resume` rejects an exhausted Run.

`maxAgents` counts completed and interrupted identities too, bounding the lifetime
agent queue of a Run. `maxPendingCommands` includes active commands and resource
waiters across that Run's agents. The runtime reserves a slot synchronously before
allocating the submitted command's asynchronous work, and releases it at settlement.
It rejects overflow instead of creating another waiter. A batch admission failure
interrupts the quantum even if the adapter catches it. Once a batch fails, later
submissions reject with its first failure; already accepted commands still settle.
Settled promises no longer accumulate in the batch.

`getRunUsage(runId)` returns detached limits, `agentsCreated`, `stepsUsed`, and
`pendingCommands`. The first two counters come from the journal. Pending commands
are a live count, not a replay queue: after restart the supervisor recovers existing
operations and leases, and the runtime does not resubmit queued commands.

These limits govern this runtime's managed path. They do not cap the number of
Runs, journal bytes, command calls made sequentially within one quantum, direct
supervisor users, arbitrary adapter allocations, tokens, cost or wall-clock time.
Set domain/process budgets separately. Token/cost accounting requires adapter
reports and is not implemented.

## Validation and workspace versions

Without `workspaceVersion`, `validate` is a read-only dispatch gate, not a freshness
certificate. The workspace can change while the validator is suspended even when
it returns `valid`. A regression test demonstrates that legacy behavior.

With `workspaceVersion(agent)`, the runtime samples a nonempty revision string
before validation and again on the dispatch continuation. A changed revision
pauses with `evidence_stale` without charging a step. An unchanged revision travels
in `AgentState.validatedWorkspaceVersion` and the durable `step_started` event.
The runtime also rechecks that a bound workspace transaction remains open after
validation. An invalid revision source or a closed transaction fails validation.

The host must make this synchronous revision source cover all evidence read by
the validator. Use an immutable snapshot identity or a generation that advances
for every relevant write, including changes that restore old contents (ABA).
A raw journal sequence, timestamp or transaction ID is not a content revision.
The runtime does not provide such a filesystem-wide revision counter.

There is no asynchronous yield between the final revision check and adapter
invocation. This is a dispatch boundary guarantee only: external processes can
write concurrently, the adapter can await again, and commands may wait for leases.
Execute against an immutable/isolated workspace or maintain a write lease for a
whole-quantum guarantee. Rechecking a version does not create that isolation.
Checkpoint search still returns only a candidate; dispatch validates again.

## Shutdown contract

`await agents.shutdown()` closes admission immediately: creation, pause, resumption,
restoration, new recovery, validation selection and drain requests reject.
Already queued scheduler microtasks cannot dispatch a new quantum. Ready agents
are persisted as paused with reason `shutdown`; existing paused and terminal
states are preserved. Active validation and steps use the existing durable
interruption protocol, including their managed commands and spent budgets.
A validator already settled at the shutdown boundary can pause without starting
the step or spending budget, rather than starting new work before cancellation.

The barrier waits for active quanta, drain, scope interruptions, checkpoint selection and workspace reconstruction (including
failure cleanup). Standalone reconstruction may finish binding a checkpoint;
reconstruction inside a cancelled task scope discards its prepared candidate.
Neither can resume the agent during shutdown. The runtime owner is
released only after these callbacks settle. Concurrent shutdown calls join the
same promise. Reads remain available while stopping, but a completed shutdown
closes the runtime. The domain itself and other supervisor instances remain open.
An active checkpoint search may finish its current read-only validation, but
does not start another candidate once shutdown has been requested.

Journal or recovery failures reject shutdown after the same settlement barrier;
the runtime is closed even on rejection. Reopening reconstructs uncertain states
from the journal and never automatically replays them. A non-cooperative adapter
or reconstruction callback can keep shutdown pending indefinitely. Do not await
shutdown from a callback that shutdown itself must join. It neither proves an
indeterminate process tree empty nor releases that operation's retained leases.

This follows the stop-admission/settlement distinction in
[Temporal worker shutdown](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workers/worker-shutdown.mdx),
without adding a force-timeout success path or a background daemon.

## Embedding

```js
import { AgentRuntime } from '@xioflow/kernel';

// Register the Task and Run in domain.getStore() first.
const agents = new AgentRuntime(domain, {
  maxConcurrentAgents: 2,
  validate: async (agent) => checkRecordedObservations(agent.checkpoint),
  step: async (agent) => existingRunnerOneRound(agent),
});
agents.create({
  id: 'worker-a', runId: 'run-1',
  input: { instruction: 'Update the parser tests' },
  checkpoint: null, maxSteps: 20,
});
await agents.drain();
const state = agents.get('worker-a');
agents.close();
```

The two adapter functions are host implementations: `validate` returns the
three-way verdict; `step` returns `{ status: 'ready' | 'completed', checkpoint }`.
Checkpoint contents and input formats belong to that adapter. The kernel gives
callbacks detached values so mutations cannot bypass persistence.

## Interruption contract

`await agents.interrupt(id)` returns that member's settled `AgentState` after
the task-scope barrier. Ready, paused and waiting members become `interrupted`
without another dispatch or charge. Checking/running members first record
`interrupt_requested`, then receive their abort signal. Recovering members wait
for preparation and cleanup. A subsequent `pause` cannot override cancellation.
An already interrupted member still joins outstanding work in its root scope.

Adapters receive `execution.signal` in `step` and an `AbortSignal` as the second
argument to `validate`. Pass that signal to cancellable provider APIs. The
runtime combines it with each command's optional `abortSignal`, so either can
cancel that command through the supervisor's existing stop pipeline. Commands
submitted after interruption reject without admission. A command-only abort
does not abort the agent or its other commands.

The runtime waits even if an adapter catches cancellation and returns a
successful result. It does not save that result as a checkpoint. Command
failures and indeterminate outcomes remain in the agent error and operation
journal; `interrupted` does not certify that an unconfirmed process tree is
empty. The supervisor retains leases for indeterminate operations.

Interruption is cooperative for adapter-owned work. An adapter that ignores the
signal keeps `interrupt()` and `drain()` pending; the runtime does not claim a
timeout or force-kill the JavaScript callback. Do not await `interrupt(id)` from
any callback in that task tree: the barrier waits for those callbacks to return.
Detached work outside the execution context and external side-effect rollback
remain outside this API.

After settlement, use explicit checkpoint restoration before resuming. A host
crash after a recorded request leaves checking/running agents interrupted on
reopen, without automatic retry or budget refund. Process recovery and
adjudication remain the supervisor's responsibility.

This follows the cancellation-request versus cancellation-completion distinction
used by [Temporal's cancellation scopes](https://github.com/temporalio/documentation/blob/main/docs/design-patterns/pick-first.mdx).
The implementation uses native `AbortSignal` and existing process supervision;
it adds no runtime dependency or database schema migration.

## Managed command batches

The adapter receives an optional-to-use second argument, `AgentExecution`:

```js
step: async (agent, execution) => {
  const results = await Promise.all(['parse', 'format'].map((target) =>
    execution.executeProcess({
      opId: `${agent.id}-${agent.stepsUsed}-${target}`,
      name: `test ${target}`,
      command: {
        execPath: process.execPath,
        args: ['--test', `tests/${target}.test.mjs`],
        cwd: agent.workspace.forkRoot,
      },
      waitTimeoutMs: 10_000,
      timeoutMs: 30_000,
    })
  ));
  return { status: 'completed', checkpoint: { outcomes: results.map((result) => result.status) } };
}
```

`AgentCommandOptions` takes the existing process options except `runId`, which
the runtime supplies from the agent. Commands use `ProcessSupervisor`, the
domain's configured driver, domain concurrency budget and resource queue.
`maxConcurrentAgents` limits adapter quanta; `maxConcurrentOps` limits commands
across those agents and other users of the same domain. Set `requiredResources`
for mutual exclusion. As in the supervisor API, `waitTimeoutMs` defaults to zero:
a resource conflict rejects unless the caller opts into waiting. Command timeout,
cancellation via `abortSignal`, output limits and read tracking keep their
existing behavior. Other supervisor instances' confinement defaults do not carry
over; specify the command's confinement options when needed.

Before admission, the runtime journals `AGENT_OPERATION_REQUESTED` with the
operation ID, agent ID, Run and charged step. A request can remain without an
operation row if admission fails or the host dies while it waits. Reopening
reconstructs ownership from those events. Another agent cannot take that ID,
nor can an agent claim a preexisting unowned operation. Reusing an ID within the
same agent uses the supervisor's fingerprint checks and idempotent replay;
it does not authorize rerunning side effects. Give new logical operations new
IDs, including work reexecuted in a reconstructed workspace.

The runtime closes the context when `step` settles and joins submitted commands
before saving its checkpoint. This also covers calls the adapter did not await
and sibling commands still running after a rejection. Late calls reject without
journaling or spawning. A rejected command or an `indeterminate` result interrupts
the quantum even if the adapter catches it; the last checkpoint and spent budget
remain. Recorded errors retain the failure reasons. Ordinary failed exits and
confirmed cancellations remain results for the adapter to interpret. A pause
request waits for the batch boundary and does not cancel it.

For a workspace-bound agent, the runtime includes its fork in `mutationRoots`,
so transaction validation can detect process access even when `cwd` is elsewhere.
It does not rewrite `cwd`, add implicit exclusive locks, or confine the process.
Commands launched outside this context do not participate in the checkpoint
barrier. Provider protocols, arbitrary file tools and command priority/preemption
remain host responsibilities; parent-child cancellation follows the task scope.

## Verified scope

- `scripts/agent-soak.mjs` exercises repeated scoped cancellation, queue overflow,
  journal-boundary fault injection and real SIGKILL restart. Run `pnpm build` then
  `XIOFLOW_SOAK_SECONDS=120 node scripts/agent-soak.mjs`. It reports sampled RSS,
  journal/database growth, event-loop delay, rejected commands and remaining known
  process IDs. Set `XIOFLOW_EXPECT_CGROUP=1` inside a delegated Linux cgroup to
  test that driver. Duration defaults to 120 seconds and accepts up to 86,400.
  ENOSPC is an injected journal exception, not a full-disk experiment. A bounded
  run does not establish day-long stability or bounded journal retention.

- Unit tests cover round-robin ordering, parallel bounds, child creation,
  independent pauses, evidence gates, checkpoint selection and budget retention.
- A separate worker dies with SIGKILL after budget reservation. Recovery keeps
  it interrupted without redispatching; explicit restoration retains the charge.
- Interruption tests cover queued and running commands, cooperative validation,
  an adapter ignoring cancellation, duplicate requests, journal-write failure,
  and SIGKILL after the request during validation or execution.
- Real child-process tests cover two concurrent agents with two commands each,
  domain caps of one/two, shared-resource exclusion, pause, cancellation and
  checkpoint ordering. Ownership survives reopen and includes queued requests.
  Killing a worker after a command result but before checkpointing replays the
  saved result on explicit restoration without repeating the file write.
- E6 runs two agents using xiocode's real loop and file tools, pauses one,
  reopens the runtime, detects changed input, chooses an earlier valid checkpoint
  and resumes to the correct output. Provider responses are deterministic fixtures.

## Recovery of edit histories

`recoverAgentWorkspace(agents, supervisor, options)` combines saved boundaries
with existing workspace transactions. Options identify the stopped agent, a
unique recovery-id prefix, repository root, fork-path prefix and an
`observations(checkpoint)` adapter returning its complete observation log and
replay function. Both runtime and supervisor must use the same domain.

Recovery requires `closedWorld: true` and a nonempty `resultHash` for **every**
step, including mutations. An edit that still applies can return different
references or diagnostics; restoring the old context would then reuse invalid
evidence. Missing or empty hashes reject before creating that candidate's fork
or invoking replay, and leave the previous agent state intact. Adapters must
record and replay a hash even for a constant acknowledgement or an empty result
(hash its normalized representation). Legacy logs without mutation result hashes
cannot establish a recoverable context; do not invent hashes from current output.
This requirement applies to checkpoint recovery; transaction commit validation
retains its existing optional mutation-hash contract.

The helper tries checkpoints newest-first. Its first transaction captures an
immutable baseline; later candidates reuse that snapshot through
`beginWorkspaceTransaction({ baseSnapshotId })`. This option requires a snapshot
of the same root and domain; commits still detect changes since that baseline.
Each attempted candidate gets a clean fork and replays reads AND edits in order.
The helper aborts failed candidates, including candidates where a mutation wrote
files before its result diverged. It retains the shared snapshot for the selected
transaction, or prunes it if no candidate remains open. Cleanup failure retains
the baseline for inspection. The first matching candidate
binds its transaction and restores context in one agent event. The agent remains
paused and spent budget is unchanged. No candidate matching returns
`no_valid_checkpoint` without modifying the agent; rejections retain divergence
positions and reasons. Attempts and actual replayed tool calls are reported.

`replayPolicy: 'deterministic'` opts into reusing a failed prefix on that pinned
baseline. It requires the adapter to give identical behavior for identical
recorded steps on the same tree, without hidden per-checkpoint state. Exact
prefix comparison includes tool arguments and result hashes; unrelated branches
still execute. The default `recheck` does not reuse failed-prefix evidence.
Execution exceptions are reported with their error and never reused as proof of
a result mismatch. Reports distinguish executed rejections from `reused_prefix`
rejections and count `skippedCheckpoints` separately from physical attempts.

The caller must abort the old transaction after successful recovery, then resume
the agent against `agent.workspace.forkRoot`. Its tool adapter restores read-set
state from the validated history without executing mutations again. Normal
transaction commit still checks for changes after reconstruction; restoring a
checkpoint does not authorize an unconditional merge. The helper now runs under
`recoverCheckpoint`, so another caller cannot dispatch the same agent halfway
through reconstruction. If its Run ends before final binding, the helper
discards the prepared transaction and keeps the prior agent state.

E7 exercises real xiocode read/edit tools, competing code edits, partial prefix
reconstruction and final executable-code equivalence to whole-task restart.
Its provider is deterministic and uses relative paths. Restoring arbitrary
extensions, absolute-path-bearing conversations and external side effects is
not established. E7 now compares both replay policies and measures their physical
fork and tool costs. Token/cost budgets, scheduling of non-process tools,
parent-child cancellation and broader real-model comparisons remain outstanding. The
[initial real-model pilot](../audit/observation/REAL-MODEL.md) observed lower
request/token counts on a small fixture, but a zero-reuse semantic-change control
also varied in cost. Causal savings and speed improvements are not established.
