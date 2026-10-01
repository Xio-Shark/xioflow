# Observation-aware recovery: first mechanism experiment

## Question

After another agent changes a workspace, can a suspended agent reuse the part
of its history whose observations still hold, rather than restart its task?

The proposed contribution is automatic selection of a valid recovery boundary
from changed execution evidence. Agent lifecycle management, checkpointing,
forking, scheduling and incremental computation are not new contributions.

## Prior art checked on 2026-10-01

- [AIOS](https://github.com/agiresearch/AIOS): its README explicitly describes
  an agent kernel, SDK, scheduled syscalls, context, memory, storage and tools.
  A Linux-inspired agent architecture alone is not a differentiator.
- [LangGraph time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel):
  replay and fork from checkpoints, reusing earlier state and reexecuting later
  nodes. Reuse this checkpoint model rather than invent a second persistence
  framework. External-workspace observation validation is the hypothesis to test,
  not a claim that LangGraph cannot be extended to do it.
- [Build systems a la carte](https://www.microsoft.com/en-us/research/publication/build-systems-la-carte/):
  a framework for comparing and recombining existing build-system components.
  Dependency validation and rebuilding have extensive prior art; applying them
  to agent histories needs evidence beyond a new name.
- [AutoGen](https://github.com/microsoft/autogen): multi-agent applications are
  established; its current README directs new users to Microsoft Agent Framework.
  Model clients and generic orchestration are not where this experiment should
  spend implementation effort.

These are primary-source spot checks, not an exhaustive novelty survey or a
benchmark against those systems. No third-party source was copied or dependency
added. The experiment reuses xioflow's existing transaction replay implementation.

## Reproduce

```sh
pnpm build
node audit/observation/e4.mjs
pnpm exec vitest run tests/workspace/observation-replay.test.ts tests/workspace/observation-validation.test.ts tests/workspace/transactions.test.ts
```

E4 uses real temporary files and a scripted three-decision agent. Each decision
reads one input and writes an output depending on every input seen so far.
Another actor's changes are applied before recovery. Both arms see identical
current inputs. The baseline reruns all decisions; the recovery arm validates
the old trace, selects the last complete decision checkpoint before divergence,
reconstructs that prefix, then recomputes the suffix. Every case asserts exact
final-tree equivalence and preservation of the other actor's changes.

Checkpoints include the recorded context. Old context after the selected
checkpoint is not passed to the resumed policy. Validation runs in a disposable
fork: a failing mutation can already have modified it. A fully matched fork can
be reused, but a divergent fork is not treated as a filesystem checkpoint.

The implementation shares `replayObservationLog` with transaction commit
validation. This helper remains internal; the experiment does not add a public
agent runtime API or change transaction conflict policy.

## What to measure

JSON output separates scripted decisions, validation tool calls, reconstruction
tool calls and resumed tool calls. Initial execution is excluded from both
recovery arms. There are no model calls, token estimates or timing claims.

Coarse checkpoints are included: when the first two tool observations hold but
there is no checkpoint there, those steps cannot save a decision. A divergence
index is not automatically a resumable model boundary.

The experiment can establish reconstruction correctness for these fixtures. It
cannot establish production correctness, novelty, real-model quality or savings.
Revalidation can cost more tool work than restarting. Full-trace validation must
eventually be compared with file-based invalidation and dependency-indexed
validation, not only whole-task restart.

## Next evidence needed

1. E5 integrates an existing runner; E6 puts lifecycle and checkpoint ownership
   in the kernel; E7 now reconstructs edit histories in workspace transactions.
   Deterministic prefix reuse now reduces repeated candidate work; larger
   workloads remain next. E8 now has a small real-model cost pilot (linked below).
2. Compare whole-task restart, checkpoint recovery without observation validation,
   and observation-aware recovery on fixed coding workloads. Count wrong merged
   results, model tokens, tool work and wall time, including validation costs.
3. Add scheduling only after the same checkpoint boundary can pause, resume and
   recover an agent after host restart. Keep the initial target one host and
   isolated coding workspaces, not arbitrary external side effects.

The current fixture is serial recovery after a concurrent actor's completed
change, not a concurrent scheduler. It assumes closed-world tools, deterministic
outputs and a fixed input snapshot during validation and reconstruction.

## E5: an existing runner across process restart

```sh
node audit/observation/e5.mjs
```

Requires the local xiocode checkout (default `~/code/xiocode`, override with
`XIOCODE_ROOT`) with `AgentLoopOptions.resumeFrom`. No dependency is downloaded.
The runner previously appended a new user message whenever `priorMessages` was
provided. `resumeFrom` instead loads an `awaiting_provider` checkpoint verbatim,
rejects incomplete tool batches, and leaves the stored snapshot unchanged.
Budgets and usage remain per invocation; the caller restores workspace/tool
state. This is a conversation resume entry, not restoration of every host hook,
provider connection or repeat-tool guard.

E5 uses the existing `runAgentLoop`, `ExtensionHost`, built-in read/write tools,
and observation adapter. The only fake component is a deterministic provider
that computes from the messages delivered by that runner. It cannot read files.
The recorder pauses after reading two inputs, saves context and observation
offsets to disk, and exits. Each recovery arm runs in a new process. The script
asserts that the recorded and recovering process IDs differ.

| Scenario | Whole restart requests | Validated resume requests | Restored observations | Blind resume correct | Validated correct |
| --- | ---: | ---: | ---: | --- | --- |
| unchanged | 4 | 2 | 2 | yes | yes |
| second observation changed | 4 | 3 | 1 | no | yes |
| first observation changed | 4 | 4 | 0 | no | yes |

All requests above target the deterministic provider: real model calls are zero.
The JSON also counts validation and tool-state reconstruction. In the middle
case validation adds two reads and reconstruction adds one read; the lower
request count does not establish lower end-to-end cost.

This fixture pauses before any mutation and serializes a completed checkpoint.
It does not exercise abrupt host death during a checkpoint write or interrupted
external side effects. E4 covers replayed mutations in disposable workspaces.
Tool-state reconstruction uses the same tool instances as the resumed runner;
restoring conversation alone would lose read-before-edit state.

## E6: kernel-owned agents

```sh
pnpm build
node audit/observation/e6.mjs
```

Two agents use `AgentRuntime` with the existing xiocode loop as a one-quantum
adapter. A pauses after two reads while B completes. After reopening the domain,
changing A's second input makes the evidence gate pause A without a provider
request. The kernel selects the latest valid saved boundary; A resumes from
that boundary, writes the correct result, and retains the cost of prior work.
The fixture reports A completed in 5 charged steps and B in 4. The final run
can report success only after both agents become terminal.

E6 shares E5's deterministic provider. It uses a read-only input set and a
write-only output; its validator is not suitable for arbitrary edit histories.
Each quantum rebuilds host/tool instances, so this experiment does not validate
restoration of arbitrary extension state or repeat-tool guards. See the
[runtime contract](../../spec/agent-runtime.md) for the current boundaries.

## E7: code edits and competing commits

```sh
pnpm build
node audit/observation/e7.mjs
```

A renames an exported function and its caller using the real xiocode `read/edit`
tools, then pauses. B adds a comment in the caller and commits its independent
transaction. A's local edits have not reached the main workspace. A separate
baseline agent reruns the rename from B's committed workspace.

`recoverAgentWorkspace` tries saved A checkpoints in fresh transactions, replaying
both observations and mutations. It discards each failed fork and atomically
binds the selected context to the surviving transaction. A then resumes, commits,
and the script compares its source files byte-for-byte with the baseline, executes
the caller with Node, and checks that B's comment remains.

Initial observed result: 1 reused observation, 4 candidate transactions, 7 replayed tool
calls; 4 resumed provider requests versus 5 for whole-task restart. A retains all
8 charged steps (4 before pause and 4 after recovery). The first divergent step
is the edit, not the later explicit read: the edit's return value includes
reference information that B's change invalidates. Ignoring mutation results
would incorrectly claim a longer reusable prefix.

These counts use a deterministic provider, not a real model. Candidate-fork,
snapshot and replay costs are additional; fewer provider requests alone do not
prove a speed or cost improvement. The initial implementation deliberately uses
fresh candidate forks rather than reusing a fork already changed by a divergent
mutation. Runtime tests additionally cover rejected-candidate cleanup, no valid
checkpoint, binding persistence and a new write racing after reconstruction.

### Pinned baseline and divergent-prefix reuse

```sh
node audit/observation/e7.mjs recheck
node audit/observation/e7.mjs deterministic
```

Both arms now share one immutable baseline across candidates. The deterministic
arm additionally skips checkpoints containing an identical already-disproved
prefix, including its recorded result hashes. Independent branches still run.
Execution exceptions do not become cached mismatch evidence.

| Policy | Snapshots captured | Candidate forks | Replayed tools | Skipped checkpoints | Resumed requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| recheck | 1 | 4 | 7 | 0 | 4 |
| deterministic | 1 | 2 | 3 | 2 | 4 |

Both runs reused one observation, matched whole-task restart source exactly,
preserved B's commit and passed the executable caller assertion. These are
mechanism counts, not wall-time or real-model cost estimates. Deterministic
replay is opt-in because hidden callback state can invalidate prefix reuse.

## E8: real-model pilot

[Method, approved budget and results](REAL-MODEL.md): three paired runs with
OpenCode Go / DeepSeek V4.1 Flash passed both output checks. Post-change requests
fell from 27 to 20 and peak-rate token estimates fell 18.7%; timings did not show
a speed improvement. A later nine-file semantic-change trial retained zero
history but also showed a request-count gap between two fresh runs. Therefore
the earlier cost gap cannot yet be attributed to recovery rather than model
variation. Only generated fixture code was sent. Results are separated by
scenario, with the earlier adapter failure retained; they establish neither
general task performance nor novelty.
