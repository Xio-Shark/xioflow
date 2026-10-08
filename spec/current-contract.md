# Current implementation contract

Use this page to separate implemented behavior from the target architecture.
The package remains pre-1.0; documented guarantees are not a frozen cross-language ABI.
See `CHANGELOG.md` for the boundary between releases and unreleased local changes.

| Layer | Current implementation | Boundary |
| --- | --- | --- |
| Execution core | Embedded TypeScript/Node.js, SQLite journal, domain ownership/epoch fencing, intent-first operations, idempotent operation IDs, supervised stop/recovery | Unknown outcomes retain leases and require adjudication; no automatic side-effect replay |
| Platform drivers | Node process groups; native reaper; Linux delegated cgroup v2 | Capabilities differ by driver; only claim containment/limits the selected driver proves |
| Workspace transactions | Git-backed forks, read/write conflict detection, optional observation replay and reconstruction | External writers and unobserved reads limit guarantees; transactions are not a universal filesystem lock |
| Experimental AgentRuntime | Cooperative quanta, task-tree cancellation and joins, persistent checkpoints, shared Run budgets, bounded outstanding managed commands, shutdown barrier | No forced JavaScript preemption, provider/token/cost implementation, detached-work ownership or cross-host scheduling |
| Evidence-gated dispatch | Optional validator; optional host revision sampled around validation and journaled with dispatch | The host supplies a trustworthy revision and isolation; a dispatch check does not cover subsequent awaits or command resource queues |
| Distribution | Models, prompts, tools, authorization policy, task decomposition and acceptance | Host adapters consume kernel facts and decide business success |

`AgentRuntime` and the supervisor can be used independently. A host that bypasses
the managed Agent command context also bypasses its scope and Run admission limits.
Configure domain concurrency and process resource budgets for those paths.

## Crash recovery and launch evidence

Process and service supervisors persist `Operation.spawnGated` with the intent,
before calling the driver. `true` records the driver's promise that the command
cannot execute before identity registration and gate release, including when the
owner dies. Drivers are trusted to uphold that promise.

| Durable record after a crash | Recovery |
| --- | --- |
| `intent_registered`, no identity, `spawnGated: true` | The command was not released. Record `failed`, release leases, report `cleaned_unspawned`. A gate wrapper may have existed; this is not a claim that no OS process was created. |
| No identity, `spawnGated: false` or absent | Record `indeterminate`, retain leases. The command may have completed before the owner lost its identity record. |
| `active` or `stopping`, no identity | Record `indeterminate`, retain leases even if the intent recorded a gate. |
| Identity exists | Inspect the recorded process identity and containment; gate capability alone does not establish the outcome. |

Recovery uses the original intent, not the capabilities of a replacement driver.
Opening an older database adds a nullable column; existing records do not acquire
gated-spawn evidence retroactively. This changes recovery of unfinished legacy
intents without identity from `failed` to `indeterminate`. Recorded terminal results
are not rewritten.

Only `kind: 'service'` identifies service instances. Service IDs can contain `#`;
the final `#<instance>` suffix identifies the attempt. Backoff lease cleanup must
retain isolation for unadjudicated instances, including ones a previous recovery
already marked `indeterminate`.

Resubmitting the same operation ID returns its recorded result; recovery does not
re-execute even a proven unstarted command. An absent process is not proof that no
side effect occurred. `exit_unobserved` and manual resource adjudication do not
establish application success, undo external effects, or authorize a blind retry.

Regressions: `tests/supervisor/recovery-evidence.test.ts` and
`tests/fault/spawn-evidence.test.ts` (real SIGKILL before identity registration,
including a completed file side effect).

## Experimental API changes in this worktree

- `parentId` now defines a fail-fast task scope. Parent completion joins children
  through `waiting`; cancellation of a member cancels and joins its whole root.
- Run defaults are 10,000 steps, 1,024 lifetime agents and 64 outstanding commands.
  Persisted limits and spent budgets survive reopening and restoration.
- `workspaceVersion` can bind validation to a host-supplied revision at dispatch.
- Shutdown closes admission before settlement. A non-cooperative callback can
  keep shutdown pending; an indeterminate process does not become a confirmed stop.
- Workspace checkpoint recovery requires nonempty result hashes for every logged
  step, including edits. Missing mutation evidence rejects rather than treating
  an applicable edit as proof that its agent-visible result is unchanged.

See [Agent runtime](agent-runtime.md) for API semantics, migration notes and tests.

## Planned, not implemented

The architecture documents retain design material for a Rust core, Python bindings,
daemon/multi-client mode, a frozen language-neutral protocol and Windows support.
Those sections do not describe the current package. Linux is an analogy for the
kernel/distribution boundary, not an equivalence claim about capabilities.

No journal compaction or domain-wide lifetime memory bound is implemented.
The [soak harness](../scripts/agent-soak.mjs) measures growth and fault behavior;
its finite-duration runs are not evidence of indefinite stability.
