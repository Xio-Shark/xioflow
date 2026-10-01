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
The runtime reconstructs complete public `AgentState`/`AgentCheckpoint` values;
callers of those APIs do not need to understand the encoding. Raw journal readers
must check the version. Missing, forward or cross-agent references fail visibly,
and a failed projection does not advance past the bad event on the next read.

The full journal remains authoritative and referenced events must be retained.
This removes lifecycle-event duplication, not the repeated prefixes inside each
full checkpoint. Local E9 measurements and limitations are recorded in
[the persistence experiment](../audit/observation/JOURNAL.md).

- `create`: register an agent in an existing nonterminal Run; optional parent
  must belong to the same Run. Input/checkpoints are JSON data.
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
  does not automatically finish its Run or cancel its children.

One live runtime owns a domain. `close` requires `drain` and active recovery
promises to have settled. The
domain's existing owner/epoch mechanism protects persistent writes across host
restart. The runtime does not introduce a daemon or a cross-host scheduler.

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
barrier. Provider calls, arbitrary file tools, command priority/preemption and
parent-child cancellation remain outside this increment.

## Verified scope

- Unit tests cover round-robin ordering, parallel bounds, child creation,
  independent pauses, evidence gates, checkpoint selection and budget retention.
- A separate worker dies with SIGKILL after budget reservation. Recovery keeps
  it interrupted without redispatching; explicit restoration retains the charge.
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
