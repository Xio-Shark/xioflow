# Current implementation contract

Use this page to separate implemented behavior from the target architecture.
The package remains pre-1.0; documented guarantees are not a frozen cross-language ABI.
See `CHANGELOG.md` for the boundary between releases and unreleased local changes.

## XIO-ISA v1 scope (Gate 0)

The v1 target is a local execution kernel for Node.js coding-agent workloads on
POSIX hosts. The reference implementation is the embedded TypeScript package
running in one host process, with Node.js `>=22.13` on Linux or macOS as the
supported baseline. WSL2 reports the capabilities of its Linux driver. Windows,
remote execution, and cross-process arbitration of one workspace are outside the
v1 critical path; historical designs for those directions remain explicitly
deferred in the [RFC queue](rfc/README.md).

The detailed Core/stdlib/adapter/research boundary table and routing rules are
in [XIO-ISA v1 scope](isa-v1/scope.md). Core owns execution facts, capabilities,
leases, journal, recovery, and result semantics. Stdlib only builds Programs;
adapters only translate transports and render results; research code cannot
change stable ISA or journal meaning without an accepted RFC.

The four independent version domains and the `xio/1`/`xio/1.x` compatibility
rules are frozen in [XIO-ISA v1 versioning](isa-v1/versioning.md). The current
package is `0.8.0`; that package version is not an ISA or schema version.

| Layer | Current implementation | Boundary |
| --- | --- | --- |
| Execution core | Embedded TypeScript/Node.js, SQLite journal, domain ownership/epoch fencing, intent-first operations, idempotent operation IDs, supervised stop/recovery | Unknown outcomes retain leases and require adjudication; no automatic side-effect replay |
| Platform drivers | Node process groups; native reaper; Linux delegated cgroup v2 | Capabilities differ by driver; only claim containment/limits the selected driver proves; the fixed observation/stop/rollback/crash boundary is in [the driver contract](isa-v1/driver-contract.md) |
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

Execution-phase operation events and final result events require a prior durable
`OPERATION_INTENT_REGISTERED` fact. The store rejects a second
`OPERATION_RESULT_RECORDED` for the same operation; the only explicit exception
is a pre-intent cancellation, which is marked `preIntentCancelled` and has no
execution effect. Resource release emits one `RESOURCES_RELEASED` journal fact
with the owner, released resource list and `releaseReason`. Journal writes use
the event envelope and redact prompt, credential, environment and stream-content
keys before persistence.

The ISA control plane exposes `control.status`, `control.cancel`,
`control.resolve`, `control.resume` and `control.health` through
`IsaControlPlane`. Status and health read durable journal state, including
recovery evidence and retained leases. Cancel requests an existing instruction
or lease and does not re-execute terminal operations. Resolve records a durable
adjudication with actor, reason, decision and evidence before releasing retained
resources. Resume is journal-only: it returns replay guidance and never repeats
an external side effect.

Capability v1 records `opcodes`, `workspaces`, realpath-normalized `paths`,
`SecretRef` scope, `policyVersion`, `reason`, epoch and bounded CPU/memory/output/
concurrency/process limits. Admission checks the opcode, workspace, path,
secret, policy and budget before intent registration; attenuation can only
remove scope or lower limits. The 0.x `issueCapability(scope, actor, ttlMs)`
form remains as a compatibility issuer with the v1 fields populated from
conservative defaults.

`LocalIpcServer` is the authenticated local transport: it creates a random
session key, derives a capability-and-epoch-bound nonce, requires the current
capability epoch on every request, and creates an owner-only Unix socket. The
transport has no HTTP listener; HTTP integrations remain adapters outside the
kernel boundary.

Process launch is default-deny for host environment inheritance. A
`StructuredCommand` receives ordinary values only from its explicit
`envWhiteList`; `inheritEnv` must be `true` to copy the host environment.
`secretEnv` values are `SecretRef` identifiers, never plaintext. A platform
driver resolves them inside its spawn boundary, rejects requests without a
resolver, and redacts resolved values from stdout/stderr before exposing the
streams to the supervisor. Resolver failures are normalized without copying
the resolver's error text, and fingerprints retain only SecretRef identifiers.

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
checks file identity. Migration v5 persists one ownership row per created
artifact: owner operation, creating instruction, absolute path, device/inode/
birthtime identity, SHA-256, byte size, creation time, optional expiry, sensitivity,
encryption state, and deletion state. Stream spill, read evidence, and ignored
snapshot manifests register their facts at the writer boundary; a normal stream
finalization fills hash and size before the operation result is committed.
`pruneArtifacts` removes only unreferenced files whose durable ownership points to
a settled non-indeterminate operation and whose TTL/age policy allows deletion.
Deletion is identity-checked and then recorded as `deleted`; unknown-owner files,
unknown deletion state, active/indeterminate owners, invalid expiry values, and
legacy orphan files are retained. Snapshot manifests are protected during capture
and owned by the persisted snapshot after commit; snapshot pruning marks the
manifest row deleted after the identity-checked unlink.

Process stdout/stderr are consumed continuously with a bounded head+tail memory
view. Full spill uses an asynchronous, bounded write queue; input pauses when
the queue reaches its cap, the stream hash advances only after the corresponding
write callback succeeds, and fsync/close/finalize failures become `spillError`
without returning a misleading artifact reference. A pipe `end`/`close` only
settles output writing; process tree settlement still comes from the selected
driver. If a root exits while an unseen descendant holds a pipe, the operation
remains `indeterminate` and keeps its lease.

Request execution also persists an immutable configuration binding. Migration
v6 adds `runs.config_binding` and `operations.config_snapshot`; the first
snapshot bound to a Run is retained, while every operation intent carries its
own schema- and digest-verified snapshot. The binding records the config schema,
capability id and policy version, selected driver and driver contract version,
driver capability facts,
retention version, redaction version, and a scrubbed request config. Secret-like
values are removed before hashing or persistence; the journal stores only the
binding summary and digest. Recovery validates the persisted schema and digest
before using an unfinished operation, and isolates an invalid binding as
indeterminate instead of reconstructing behavior from current host config.

Gateway config rewriting uses a private copy-on-write overlay. `OPENCODE_CONFIG`
and `XIO_CONFIG` source files remain unchanged; the child receives a temporary
rewritten path, and the overlay is removed during normal and failed cleanup.
Overlay creation or cleanup failures remain observable. Existing operations
without a v6 snapshot remain readable for compatibility and keep their prior
recovery evidence rules.

Symbolic links are conservative `pathDependencies`, separate from observed
`readSet` entries. Changing a link invalidates a transaction's path assumptions;
command evidence answers `unknown` for changed links even with stat caches ruled
out. Old transactions or evidence without this field make no completeness claim.
Workspace transaction evidence also carries a versioned `xio/workspace-index/1`
record. Its `readSet`, `writeSet`, `discoverySet`, `symbolSlice`,
`ignoredManifest`, and `pathDependencies` are independent fields with a digest;
repeated inspection merges read/discovery/path evidence while replacing the
current write diff. Missing observation sets remain `null` and derive
`coverage: 'unknown'`; an observed non-ignored tree is `non_ignored`, and a
digest-verified ignored manifest can raise it to `complete`. Host supplied
symbol-slice/discovery/ignored-manifest hints are additive evidence, never a
claim that an unobserved scan was complete.
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
the missing evidence. The Node process-table observer is a domain-wide singleton
cycle: all active tree watchers share one asynchronous `ps` read per cycle, and
watchers are released when their managed process closes. Empty or malformed
snapshots are unavailable evidence; an alive identity missing from a snapshot is
also `unknown`, never zero usage. In-flight sampling is joined before recording
the result.
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

New intents also persist `RecoveryEvidence` (`xio/recovery/1.0`) with the original
driver name and recovery-relevant capability snapshot. Identity, containment,
tree-settlement and pipe observations are stored as facts when available. Recovery
uses that original snapshot to choose cgroup/process-group semantics; a replacement
driver cannot upgrade a legacy or incomplete record into stronger evidence. Missing
facts remain `indeterminate` until an operator adjudicates them.

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

The ISA interface remains **preview**. `@xioflow/kernel/isa` exposes an explicit
SDK surface; its host-bound executor currently supports workspace snapshot,
workspace rollback, status and health using the existing durable kernel. It
rejects other opcodes, transactions and unsupported external preconditions
before executing a supported prefix. MCP `execute` and CLI `plan/execute` share
the same adapter. Structural planning without host policy reports
`capability: not_requested`; it grants no execution authority. The compatibility
root, older MCP tools and gateway have not all migrated to this interface.

On Linux, a stopped zombie can remain visible until its parent calls `waitpid`.
Confirmed stopping means no observed process can continue execution or hold a
pipe; it does not invent PID disappearance. Such entries are recorded as
`unreapedPids`. Live residuals and failed observation still prevent confirmation.
The native reaper is preferred for long-running container verification whose
PID 1 does not reap adopted children.

| Platform | Status | Evidence |
|---|---|---|
| Linux (Ubuntu, GitHub CI) | Full contract suite green; cgroup v2 jobs run in a delegated systemd scope and in a container with a private cgroup namespace | `ci.yml` (verify / cgroup jobs) |
| macOS (GitHub CI) | Full contract suite green; reaper driver builds for darwin | `ci.yml`, `native.yml` |
| WSL2 (Ubuntu-22.04) | Full contract suite green on the node driver (704 passed / 8 skipped, all cgroup-gated, 2026-10-13, Node 22.23.3); cgroup v2 is mounted but not delegated to the invoking user, so `CgroupPlatformDriver` reports `CgroupUnavailableError` instead of degrading | local run, 2026-10-13 |
| Windows | Not supported; capabilities reported honestly | driver capability flags |
