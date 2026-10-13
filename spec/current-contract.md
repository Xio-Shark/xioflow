# Current implementation contract

Use this page to separate implemented behavior from the target architecture.
The package remains pre-1.0; documented guarantees are not a frozen cross-language ABI.
See `CHANGELOG.md` for the boundary between releases and unreleased local changes.

| Layer | Current implementation | Boundary |
| --- | --- | --- |
| Execution core | Embedded TypeScript/Node.js, SQLite journal, domain ownership/epoch fencing, intent-first operations, idempotent operation IDs, supervised stop/recovery | Unknown outcomes retain leases and require adjudication; no automatic side-effect replay |
| Platform drivers | Node process groups; native reaper; Linux delegated cgroup v2 | Capabilities differ by driver; only claim containment/limits the selected driver proves |
| Workspace transactions | Git-backed forks, read/write conflict detection, optional observation replay and reconstruction | External writers and unobserved reads limit guarantees; transactions are not a universal filesystem lock |
| Experimental AgentRuntime | Cooperative quanta, task-tree cancellation and joins, persistent checkpoints, shared Run budgets, bounded outstanding managed commands, shutdown barrier | No forced JavaScript preemption, provider/token/cost implementation, detached-work ownership or cross-host scheduling; scheduling-versus-policy line (2026-10-13, Decision 6): the kernel owns when/whether execution happens, never what the work is or what counts as acceptance |
| Evidence-gated dispatch | Optional validator; optional host revision sampled around validation and journaled with dispatch | The host supplies a trustworthy revision and isolation; a dispatch check does not cover subsequent awaits or command resource queues |
| Distribution | Models, prompts, tools, authorization policy, task decomposition and acceptance | Host adapters consume kernel facts and decide business success |

`AgentRuntime` and the supervisor can be used independently. A host that bypasses
the managed Agent command context also bypasses its scope and Run admission limits.
Configure domain concurrency and process resource budgets for those paths.

## Domain ownership across processes

Arbitration is bounded by the host process. One acquired `ExecutionDomain`
arbitrates all supervisor entry points in that process; a second, separate
process acquiring the same workspace domain fails with `DomainLockedError`.
Cross-process arbitration is not provided: the daemon direction was abandoned
on 2026-10-13 (revival conditions in the roadmap appendix). Hosts that need
concurrent agents on one repository should split domains per worktree
(xiocode's worktree isolation is the reference pattern) or serialize access.

`executeProcess` and `quickRun` return `ProcessExecutionResult`, the union of a
determinate process result and `IndeterminateResult`. TypeScript callers must
narrow `kind` or `status` before reading exit codes or output; unknown outcomes
have a reason and recovery guidance, without invented output or exit facts.
Execution input validation precedes admission and durable effects. Timer delays
must be finite and within Node's supported range; legitimate zero limits and
opaque operation IDs remain supported.

MCP tool arguments are checked against their advertised input schemas before
creating request Runs or binding operations. Invalid types, bounds, array items
and unknown fields return JSON-RPC `-32602` with `tool`, `path` and `keyword`.
Arguments are not coerced. Execution and operation-status replies preserve the
kernel's identity, evidence, truncation, spill and measurement facts; `mcpOutput`
describes the separate character limit applied by the transport. Indeterminate
execution and replay keep request Runs indeterminate instead of reporting success.

Operation IDs are domain-wide identities across operation kinds. Queued operations
and active internal allocations reserve their IDs. Conflicting registrations are
rejected before effects; failure cleanup cannot record a result for an intent it
did not register. Low-level hosts should submit fresh intents through the domain
rather than preallocating a duplicate operation identity.

## Domain coordination and artifact ownership

An acquired `ExecutionDomain` is the unit of in-process arbitration. Supervisors
on that domain share the in-flight operation table, read-tracking exclusions,
service registry and workspace transaction manager. A second entry point joins
an identical operation rather than allocating its resources again. Each running
operation and service keeps its original driver for cancellation. `quickRun`
with an existing domain inherits the domain's driver unless explicitly configured.

The transaction manager binds its snapshot driver on first use. Another entry
point with a different explicit snapshot driver is rejected. This serializes
transaction commits in the domain; it does not lock out unmanaged filesystem writers.
Commit and abort share a queue. Commit holds the declared source and target write
keys during file validation and application; inspection also holds its source key.
Observation replay releases temporary leases for snapshot capture, then protects
its redo source and rechecks the target revision before application. These are
locks for identical declared resource keys, not hierarchical directory locks.

`TX_COMMITTING` records `isolationVersion: 1`. After that fact, partial application
or result-recording failure retains source and target isolation. Domain startup
rebuilds these barriers from unfinished transaction journal facts before accepting
new execution. A durable `TX_COMMITTED` closes the transaction even if later lease
release or cleanup fails, so retry cannot apply its files again. Legacy unfinished
commits lack continuous-isolation evidence: they remain isolated and automatic
replay is refused, requiring manual examination and resolution. Completed legacy
transactions are unchanged; no historical isolation guarantee is inferred.

Worktree removal takes its own write lease before awaiting the driver, rejects
active foreign owners even with `force`, and releases only its own resources.
An internal materialization lease is handed back using a creation record consumed
once, not an operation-name prefix. Partial lease release keeps the owner identity
and budget reserved while other resources remain held.

These objects are shared by domain object identity, not by directory name. Reopening
a domain after shutdown creates a new coordinator and rebuilds durable facts.

Service instances use the same tree-settlement mechanism as one-shot processes.
Natural root exit reaps known descendants before release; an unconfirmed stop
records `indeterminate` and retains service leases. Startup failure rejects joined
observers, and natural exit or exhausted restarts settle the service's stop waiter.

Operation IDs are opaque keys. Unsafe or long filename components are encoded;
ordinary IDs retain their existing readable artifact names. Artifact creation
uses exclusive, no-follow opens and never replaces a pre-existing object. Cleanup
checks file identity, and `pruneArtifacts` removes only unreferenced files whose
creation was journaled for a settled operation. Unknown files and legacy orphan
files without ownership records are retained. Snapshot manifests are protected
during capture and owned by the persisted snapshot after commit.

Symbolic links are conservative `pathDependencies`, separate from observed
`readSet` entries. Changing a link invalidates a transaction's path assumptions;
command evidence answers `unknown` for changed links even with stat caches ruled
out. Old transactions or evidence without this field make no completeness claim.
Safe, digest-verified legacy manifest basenames remain readable; escaped legacy
evidence paths are rejected rather than followed.

Regressions and shared consumer contracts: `tests/supervisor/artifact-safety.test.ts`,
`tests/store/sqlite.test.ts`, `tests/supervisor/domain-coordination.test.ts`,
`tests/supervisor/service-coordination.test.ts`, `tests/workspace/domain-coordination.test.ts`,
and contracts 63–67 in `src/testing/contract-suite.ts`.

Process-table query failure is unavailable evidence, not an empty tree or a stale
snapshot. The Node driver returns `cannot_determine` for a stop it cannot verify;
it does not substitute a blind group or single-PID signal when the driver cannot
establish evidence. Recovery and adjudication retain isolation when group evidence
is unavailable. Hosts requiring containment should use an available holding driver
and its declared scope.

Missing resource measurements are not zero usage. Results report
`resourceSamplingError` and omit unknown memory/CPU peaks. A soft measured limit
requires an observer at admission; losing its measurements requests termination
with `observation_failed`. A confirmed stop releases leases; an unconfirmed stop
remains `indeterminate`. Observe-only failure keeps the command running and records
the missing evidence. In-flight sampling is joined before recording the result.
Contract 66 and `tests/driver/observation-failure.test.ts` /
`tests/supervisor/budget-observation.test.ts` cover these cases.

Completed reaper sessions release their helper/stream objects. A weak,
identity-bound terminal fact remains usable while the caller retains that original
identity; it cannot authorize a newer session that reused the same PID. Timed-out
tree waiters detach rather than accumulating in a live session. The retention
regression uses real cancelled processes and garbage collection, not a simulated
successful stop. This removes one lifetime retention source; journal and agent
history still require the planned lifetime bounds below.

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

See [Agent runtime](agent-runtime.md) for API semantics, migration notes and tests.

## Abandoned direction, not implemented

The architecture documents retain design material for a Rust core, Python
bindings, daemon/multi-client mode and a frozen language-neutral protocol.
That direction was **abandoned on 2026-10-13** (single-implementation focus;
revival conditions in the roadmap appendix); the material remains as a
historical design record and does not describe the current package. Windows
support remains unimplemented and is reported honestly (`processGroupKill:
false`, `descendantEnumeration: 'none'`). Language-neutral contract artifacts
(JSON Schema, black-box conformance) remain mainline work (P1a). Linux is an
analogy for the kernel/distribution boundary, not an equivalence claim about
capabilities.

No journal compaction or domain-wide lifetime memory bound is implemented.
The [soak harness](../scripts/agent-soak.mjs) measures growth and fault behavior;
its finite-duration runs are not evidence of indefinite stability. (Journal
compaction v2 landed after this note's original scope: see the E9 measurement
in `audit/observation/JOURNAL.md`; the soak exit criteria are in ROADMAP §12.)

## Verifying an implementation

The contract suite is framework-agnostic. Under vitest it resolves its API
from globals; with no test framework at all, the plain-node runner
(`@xioflow/kernel/testing/plain`) executes the same suite and prints a
machine-readable JSON report. Run instructions and the compliance tiers
(`core` / `workspace` / `experimental`) are in [spec/conformance.md](conformance.md).
A green run names the driver and platform: capability-gated entries (cgroup v2
hard limits) report `unsupported` rather than passing when the platform does
not provide them.

## Platform evidence

| Platform | Status | Evidence |
|---|---|---|
| Linux (Ubuntu, GitHub CI) | Full contract suite green; cgroup v2 jobs run in a delegated systemd scope and in a container with a private cgroup namespace | `ci.yml` (verify / cgroup jobs) |
| macOS (GitHub CI) | Full contract suite green; reaper driver builds for darwin | `ci.yml`, `native.yml` |
| WSL2 (Ubuntu-22.04) | Full contract suite green on the node driver (704 passed / 8 skipped, all cgroup-gated, 2026-10-13, Node 22.23.3); cgroup v2 is mounted but not delegated to the invoking user, so `CgroupPlatformDriver` reports `CgroupUnavailableError` instead of degrading | local run, 2026-10-13 |
| Windows | Not supported; capabilities reported honestly | driver capability flags |
