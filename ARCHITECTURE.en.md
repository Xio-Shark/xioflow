# xioflow Kernel & xiocode Distribution Architecture and Protocol Specification

> **Document Status**: Authoritative Protocol Specification for the xioflow kernel repository. Sections 0, 3, and 7 define the core kernel protocol and conformance guarantees. For phased roadmap and current implementation status, see [`ROADMAP.md`](./ROADMAP.md). Chinese version: [`ARCHITECTURE.md`](./ARCHITECTURE.md).  
> **Status**: Target-state protocol specification (v2 planning: Rust core + snapshot rollback + dual deployment topology). Sections marked "Target State" are in the roadmap for upcoming milestones; refer to `ROADMAP.md` for current implementation alignment.  
> **Core Positioning**:  
> - **xioflow**: A supervised execution kernel for AI agent framework authors. Provides execution primitives only: execution domain lifecycle, supervised processes, resource arbitration, verified stops, workspace snapshots and rollbacks, SQLite transactional persistence, and crash recovery. Zero UI bindings; agnostic to agent loops, languages, or file formats.  
> - **xiocode**: The reference programming distribution assembled on top of xioflow. Provides model routing, coding tools, default three-piece workflow (PRD / Todo / Verification), safety policies, and CLI/TUI.  
> **Repository Division**: xioflow is developed as an independent shared kernel repository; distributions like xiocode consume the kernel strictly through public protocols and thin language bindings.

---

## 0. Core Positioning & Design Decisions

### 0.0 Product Goal (North Star)

> xioflow is the **"Operating System Kernel" for AI Agent execution**: framework authors use it to execute local processes and modify workspaces, obtaining a set of **provable, honest execution facts**. Higher-level products (xiocode and third-party frameworks) assemble their distinct agent products on top of the same primitives and ABI, much like Linux distributions build upon the Linux kernel.

| Dimension | Decision |
|---|---|
| **Target Users** | Agent framework authors (not end-users of agents). Primary audience: **local-first** agent frameworks and coding agents executing commands directly on host machines. |
| **Non-Target Users** | Frameworks executing entirely inside disposable remote containers or microVMs (where tearing down the container resets the world, minimizing kernel demand). |
| **Kernel Form** | Rust core; the same core provides two deployment modes: "embedded mode" and "daemon mode" (§0.2 Decision 3, §5). |
| **Integration** | Thin bindings in host languages (initial wave: TypeScript, Python) + language-agnostic protocol; bindings and protocol share the identical conformance suite. |
| **Governance Scope** | Local process lifecycles + workspace filesystem mutations (snapshot / rollback); strictly excludes LLM calls and agent scheduling. |
| **Controller Boundary** | Exclusively provides execution primitives (`spawn` / `stop` / `lease` / `snapshot` / `rollback` / `recover` / `adjudicate` / `journal`), analogous to syscalls; provides no component models or schedulers. |
| **Success Criteria** | Adoption by third-party agent frameworks and passing the conformance suite; xiocode is merely the reference distribution. |
| **Moat** | Not in isolated primitives (snapshots, sandboxes, and durable execution all have existing implementations), but in the unique combination of **"transactional fact model + three-state honest semantics + portable conformance suite"**, backed by a long-term ABI stability commitment (§0.2 Decision 5). |

### 0.1 Linux Paradigm and Boundary Demarcation

| Concern | xioflow Kernel Responsibility | Distribution (xiocode / Third-Party) Responsibility |
|---|---|---|
| **Governance Scope** | Execution Domain lifecycle, single active domain owner | Deciding domain binding strategy (per workspace, per project, or per session) |
| **Task Execution** | Run execution attempts, operation tracking, managed operation attribution | Decomposing tasks, business workflows, PRD/spec artifacts |
| **Concurrency Orchestration** | Resource quota arbitration, wait dependencies, cancellation scopes | Scheduling algorithms (serial queues, DAG topologies, best-of-N parallel candidates) |
| **Process Management** | Platform driver abstraction, supervision protocol, verified stops, audit trails | Selecting tools, composing shell commands, passing flags |
| **Workspace Mutations** | Snapshot / rollback primitives, honest coverage declaration, restoration verification | Deciding when to snapshot, rollback target selection, user prompts |
| **Security & Authorization** | Recording authorization decision facts submitted by distributions (who, when, what approved); no auth policy enforcement or isolation | Security policies, interactive human confirmations, risk tiering |
| **Verification & Adjudication**| Storing trustworthy execution facts (status, output evidence, artifact references) | Asserting what test output constitutes business acceptance |
| **Crash Recovery** | Pre-execution state reconstruction, conflict resource containment, journal recovery | Policy on which failures permit auto-fix, retry, or re-planning |
| **Model Context** | Completely ignores model context, natural language, prompts | Prompt assembly, rule/spec injection, context pruning |
| **UI & Artifacts** | Zero UI dependencies; agnostic to markdown / document formats | CLI, TUI, markdown task three-piece sets, IDE plugins |

### 0.2 Nine Core Architectural Decisions

#### 1. Management Scope: Workspace-Level Execution Domain, No Machine-Wide Central Scheduler
- **Execution Domain Definition**: An execution domain owns a single persistent SQLite database (`domain.db`), one Active Kernel Owner, a resource registration and budget quota table, and an ordered transactional journal of events.
- **Single-Owner with Three-Lock Architecture**:
  | Lock Type | Lifecycle | Implementation & Guarantee |
  |---|---|---|
  | **Ownership Lock** | Entire kernel process lifecycle | OS-level exclusive file lock + `owners` table (`owner_id`, `epoch`, `heartbeat_at`, `expires_at`). |
  | **Transaction Lock** | Milliseconds within SQLite transactions | SQLite WAL mode native single-writer mutual exclusion. |
  | **Resource Lease** | Single Operation lifecycle | Persistent `resource_leases` table (storing resource keys and `budget`). |
- **Epoch Fencing**:
  - When a kernel instance takes over an expired or abandoned ownership lease, it strictly executes `epoch = epoch + 1`.
  - All subsequent state writes must include `WHERE epoch = :current_epoch`.
  - If a stale owner experiences a split-brain resurrection (e.g., lingering after GC pauses or network stalls), its write transactions are rejected by the epoch fence, eliminating state corruption.
- **Read-Only Observer Mode**:
  - Supports contention-free, read-only observer connections (e.g., CLI `xio status`, `xio inspect`).
  - Opens the database in read-only transaction mode without competing for exclusive ownership, avoiding service disruption during inspections.
- **Domain Boundaries**:
  - Sequence numbers are monotonic within a domain; no machine-wide coordination is required.
  - Multiple Git worktrees belonging to the same repository must identify shared `.git` metadata to prevent index corruption.
  - Domain resource registries cannot govern external unmanaged processes (if an external program occupies a port, the OS error is surfaced directly; the kernel never fabricates artificial isolation guarantees).

#### 2. Blast Radius: Freeze Conflicting Resources, Allow Proven Independent Runs to Proceed
The kernel strictly differentiates between **"Outcome is indeterminate"** and **"Process might still be running"**:
- **Executor might still be running**: Strictly quarantine its allocated conflicting resources, barring new operations from claiming them.
- **Process confirmed stopped, but side-effect outcome is unknown**: Block blind retries; preserve the execution scene for recovery verification.
- **Other runs proven free of resource or artifact dependencies**: Allowed to continue executing without global halting.
- **When blast radius cannot be determined**: Conservatively pause admission of new operations across the entire execution domain.
- **Distribution Policy**: Distributions may adopt more conservative global pauses according to product preference, but can never relax the kernel's mandatory isolation.

#### 3. Deployment Topology: One Core, Embedded and Daemon Modes, Unified Protocol
"Single domain owner" and "every framework process embeds its own library" cannot coexist: a second embedded library accessing the same workspace receives `DomainLockedError`, while separate domains sacrifice cross-agent resource arbitration. Since kernel semantics require **one arbiter per workspace**:
- **Embedded Mode**: The kernel runs inside the host process as an in-process library; the host is the domain owner. Suitable for single-agent, single-process CLI scenarios with zero operational overhead.
- **Daemon Mode**: The kernel runs as a persistent workspace daemon holding domain ownership. Multiple clients (different frameworks, languages, or agents) connect via the §5 protocol; the daemon arbitrates resource leases centrally.
- **Identical Contract**: Both modes enforce identical protocol semantics and conformance suites. The embedded language binding is simply an in-process transport implementation.
- **Upgrade Path**: When an embedded caller detects the domain is already held by a daemon, it must attach as a protocol client; it must never attempt to steal locks or spawn shadow domains.

#### 4. Rollback Honesty: Pluggable Snapshot Drivers, Coverage Must Be Honestly Declared
The kernel is not a security sandbox (§8) and cannot observe arbitrary writes by unmanaged child processes. Rollback assurance is governed by two orthogonal capabilities:
- **Snapshot Driver (`SnapshotDriver`)**: Governs *what can be restored* — Git shadow references, APFS clonefile, btrfs/ZFS snapshots, overlayfs, etc. The kernel defines the driver contract (§3.5, §4.1).
- **Confinement Driver (`ConfinementDriver`, optional)**: Governs *whether writes were verified not to leak outside* — using bubblewrap, `sandbox-exec`, Anthropic `srt`, or container primitives to restrict writes to snapshot roots. Serves **rollback correctness**, not security promises.
- **Honest Coverage Declaration**: Every rollback result must report `coverage`: `complete` (writes were confined and snapshot covered all roots), `declared_roots` (guaranteed within declared roots only; outside side-effects unknown), or `none`.
- **No False Claims**: Without write confinement during execution, rollback results must never claim `complete`.

#### 5. ABI Stability: Protocol and Conformance Contracts are the Product; Implementations are Reference
The Linux distribution ecosystem relies upon long-term stability of the syscall ABI. xioflow's equivalents are:
- **Three Core ABI Pillars**: Protocol message schemas (§5), `domain.db` schema with `user_version` migrations (§1), and the Conformance Suite (§7).
- **Versioning Strategy**: Protocol and schema versioning are decoupled from language package versions, evolving under SemVer; breaking changes require major version bumps with explicit migrations.
- **Implementation Status**: The Rust core is the normative reference implementation; TypeScript 0.1.x is the historical reference implementation. Conformance tier compliance is the sole criterion for compatibility.

#### 6. Operation Idempotency: Kernel as the Side-Effect Layer (At-Most-Once Execution)
- xioflow is not a workflow engine; it acts as the **side-effect layer** beneath durable workflow engines (Temporal, Restate, LangGraph, DBOS, Inngest). The workflow engine manages replays; the kernel guarantees that "side effects for the same `opId` occur at most once, or an honest error is returned."
- `opId` is globally unique within an execution domain and persists across Runs (D17). A Run remains a single execution attempt: resuming a task after crash requires a new Run; replayed operations return previously recorded facts from the prior Run.
- **Idempotency Adjudication Table** (see §3.7):
  - Missing → Normal execution;
  - Exists with different fingerprint → `OperationIdConflictError`;
  - In-flight in current memory → Join shared result promise;
  - Already terminal (succeeded / failed / cancelled) → Return recorded result with `replayed: true` and original `runId`;
  - `indeterminate` → Return unchanged, never blindly retry, preserve leases;
  - Non-terminal in DB but absent from memory (unrecovered crash) → `RecoveryRequiredError`.
- Every replay writes an `OPERATION_REPLAYED` journal event, making non-execution provably auditable.
- Relaxing 0.2.0's `DuplicateOperationError` to idempotent replay in 0.3.0 is strictly monotonic and does not weaken any safety invariant.

#### 7. Supervised Long-Running Services: Instances as Process Operations
- Introduces `kind: 'service'`. A service consists of one or more **instances**; each instance is a standard process operation (`opId = <serviceId>#<instanceIndex>`), fully reusing spawn, stop, identity verification, and recovery pipelines without a duplicate state machine.
- **Instance stdio**:
  - `stdinMode: 'stream'`: Continuously writable standard input until host closes or stop sequence begins;
  - `stdout`: Passthrough stream consumed by callers without in-memory Head+Tail buffering (preventing unbounded memory growth); optional artifact spill; stderr retains bounded draining and spill.
- **Readiness Probing**: Declared as `readiness: 'spawned' | { stdoutLine: RegExp }`. Writes `SERVICE_READY` upon matching.
- **Restart Specification (D19)**: Minimal declarative policy `restart: 'never' | { policy: 'on-failure', maxRestarts, backoffMs }`. Each restart spawns a new instance op and writes `SERVICE_RESTARTED`. Exceeding limits transitions service to terminal `failed`.
- **Host Crash Cleanup**: Recovery engines verify and terminate service instances like ordinary operations; **the recovery engine never automatically restarts services**. Restart decisions belong exclusively to the new host.

#### 8. Snapshots Bound to Journal Seq, Supporting Materialize / Dematerialize Worktree Forks
- `SnapshotRef` records `journalSeq`: the global monotonic sequence number of the `SNAPSHOT_CAPTURED` event in the journal. Semantics: "Workspace state at journal sequence N". When distributions revert conversations to sequence N, they locate the corresponding snapshot (`journalSeq <= N`). The kernel never touches conversation state.
- `snapshot.materialize(snapshotId, newRoot)`: Spawns an isolated independent workspace at `newRoot` (initial driver uses `git worktree add --detach <newRoot> refs/xioflow/snapshots/<snapshotId>`), registered as exclusive resource `workspace:write:<newRoot>`.
- `snapshot.dematerialize(newRoot)`: Teardown and cleanup via `git worktree remove --force <newRoot>`, releasing the resource lease. Enables safe best-of-N parallel candidate generation without corrupting source trees.

#### 9. Capability as Structured Authorization Bearer: Unifying Leases, Writable Roots, and Snapshots
- Capabilities are issued by distribution security policies (the kernel does not decide who deserves permissions). The kernel performs structural admission validation: presence, unexpired, matches current epoch, and verifies that requested resources and mutation roots are contained within the capability (resolving symlinks with `realpath` before inclusion checks).
- A single capability unifies resource leases, `ConfinementDriver` writable roots, and snapshot roots into a single coherent truth source.
- Rollback `coverage` is derived directly from whether execution was verifiably confined by capability: confined ⇒ eligible for `complete`; unconfined ⇒ capped at `declared_roots`.
- Not a substitute for OS security boundaries (§8); unauthenticated in embedded mode (D18).

---

## 3. Core Execution Protocols

### 3.1 Intent-First Spawn Protocol (Gated Spawn)

Eliminates the crash blind spot where a process is launched but no record exists. The normative implementation uses **two-phase gated spawn (Gated Spawn)**: child processes are blocked before `exec` until their identity is safely recorded in SQLite:

```text
1. [Transaction Commit] Write Operation intent, input fingerprint, and resource leases to SQLite (status: intent_registered)
   └── If snapshotBefore = true, capture pre-snapshot per §3.5 and record SnapshotRef in same transaction
2. [Driver Preparation] PlatformDriver.spawn(command, { gated: true })
   ├── POSIX: child blocks on pre-exec gate pipe after fork; Windows: CREATE_SUSPENDED
   └── Retrieve ProcessIdentity (pid, pgid / job handle, OS start time, command fingerprint)
3. [Transaction Commit] Record execution identity and advance operation status to 'active'
4. [Unblock Gate] Driver releases gate (writes gate pipe / calls ResumeThread); child executes target program
   └── If host crashes before step 3: gate pipe closes with EOF; child process exits immediately without executing target program
       ⇒ "No identity ⇔ Never executed" is guaranteed by construction
5. [Active Supervision] Attach bounded stdio drain pumps, register timeout guards and exit listeners
6. [Driver Termination] Process exits or stop triggered; driver produces preliminary result
7. [Transaction Commit] Atomically write OperationResult and release associated resource leases
```

**Drivers incapable of gated spawn** (such as standard Node.js `child_process`) must declare `capabilities.gatedSpawn = false`. During recovery, an operation with status `intent_registered` and no recorded identity **must not** be assumed unstarted: unless the driver proves no process in the OS process table matches the command fingerprint and working directory, it must be escalated to `indeterminate` with leases retained.

### 3.2 Resource Recovery Protocol: Isolation Before Execution

When launching the kernel, incoming operations are strictly prohibited until the scene of prior crashes has been reconstructed and quarantined:

```text
1. [Acquire Ownership] Attempt exclusive lock on domain SQLite database; throw DomainLockedError on failure
2. [Load Non-Terminal State] Load all Runs and Operations with status 'active', 'stopping', or 'intent_registered'
3. [Rebuild Isolation Barrier] Immediately load requiredResources of all un-cleared operations into in-memory barrier, blocking new claims
4. [Driver Scene Verification]:
   ├── Verify process identity (verifyIdentity):
   │   ├── is_original_process: Dispatch termination pipeline, drive to verified terminal state
   │   ├── not_original_process: Process already dead; verify disk artifacts and clear resource leases
   │   └── cannot_determine: Mark as indeterminate, retain isolation barrier, forbid allocation
   ├── Leader dead but process group / job has surviving descendants: Target cleanup by group; confirm group empty before clearing leases; escalate to indeterminate if unkillable
   └── Verify managed file mutation post-conditions (§3.4; verify fingerprint against pre-snapshot per §3.5)
5. [Run State Convergence] After operation adjudication, for each affected Run:
   ├── Any unadjudicated indeterminate operations exist ⇒ Run status becomes indeterminate
   └── Otherwise ⇒ Run status becomes failed (terminationReason = 'crash_detected'); Runs never stay 'running'
6. [Open Safe Operations] Open execution admission only for independent runs with no resource conflicts
```

### 3.3 Run Completion Protocol

In real-world programming, the cycle `test failure -> edit code -> test success` is standard. The kernel does not kill a Run simply because an intermediate operation failed, nor does it hide errors by considering only the final step.

#### Kernel Run Termination Condition Table

| Check Item | Mandatory Kernel Condition | Failure Action |
|---|---|---|
| **Operation Finality** | All operations under this Run have reached terminal states (no `active` / `stopping`). | Block Run completion, await underlying teardown. |
| **Resource Clearance** | All temporary exclusive resources claimed by this Run are safely released. | Keep Run active; trigger resource cleanup. |
| **No Hanging Uncertainty**| No critical operations remain in unadjudicated `indeterminate` state. | Mark Run as `indeterminate` and alert. |
| **Business Verdict** | Distribution explicitly submits `reportRunSucceeded()`, `reportRunFailed()`, or `reportRunCancelled()`. | Kernel verifies fact consistency; never guesses business logic. |

> **Crucial Rule**: `Run.status = 'succeeded'` strictly signifies that "this execution attempt terminated completely and legally under kernel-managed protocols"; **it does NOT assert that all business requirements were logically met** (business acceptance is asserted by distributions).
> 
> **Only Three Sources for Run Status**:
> 1. Explicit submission by distribution via `reportRunSucceeded`, `reportRunFailed`, or `reportRunCancelled`;
> 2. Convergence during recovery (§3.2 Step 5);
> 3. Escalation to `indeterminate` upon unconfirmed stop. Individual operation failures do not overwrite Run status; terminated Runs reject new operations.

### 3.4 Recovery Protocol: Post-Condition Association

When recovering from crashes, the kernel forbids guessing success merely because "the output file exists" or "git has a commit":

```text
Recovery Verification Pipeline:
[Operation Record] ──> [Input & Config Fingerprint] ──> [Execution Tokens (Transaction ID / Log Signatures)] ──> [Driver Post-condition Check]
                                                                                                                │
                                                                       ┌────────────────────────────────────────┴────────────────────────────────────────┐
                                                                       ▼ All Match                                                                       ▼ Missing or Suspicious
                                                                 Commit 'succeeded'                                                                Commit 'indeterminate'
```

### 3.5 Snapshot & Rollback Protocol (Target State)

Snapshots and rollbacks are themselves managed operations (`kind: 'snapshot' | 'rollback'`), governed by the same intent registration, leasing, and recovery pipeline:

```text
Snapshot (snapshot):
1. [Intent Registration] Claim exclusive workspace write lease for mutationRoots (mutually exclusive with concurrent writes)
2. [Driver Capture] SnapshotDriver.capture(roots) -> SnapshotRef (including coverage and treeFingerprint)
3. [Transaction Commit] Record SnapshotRef in snapshots table; driver must fsync git objects or clone before returning

Rollback (rollback):
1. [Precondition] Target roots have no active / stopping / unadjudicated indeterminate operations; otherwise reject with holder diagnostics
2. [Intent Registration] Claim exclusive root write lease, record target snapshotId
3. [Driver Restore] SnapshotDriver.restore(snapshot)
4. [Verification] Compare SnapshotDriver.fingerprint(roots) with snapshot.treeFingerprint
   ├── Matches -> status: restored
   ├── Partial paths unrecoverable -> status: partial + unrestoredPaths
   └── Driver failure -> status: failed
5. [Coverage Declaration] Calculate coverage and outOfScopeEffects per §0.2 Decision 4:
   If any operation ran without write confinement since snapshot ⇒ outOfScopeEffects = 'possible', coverage <= declared_roots
6. [Transaction Commit] Write RollbackOperationResult, release leases
```

- **Retention and Pruning**: The kernel provides `pruneSnapshots(filter)`, and strictly refuses to prune snapshots referenced by non-terminal or unadjudicated operations.
- **Reference Driver**: `git-shadow` uses a temporary `GIT_INDEX_FILE` to perform `add -A` + `write-tree` + `commit-tree` to private ref `refs/xioflow/snapshots/<id>`, without touching user index or branches; declares `coverage: 'worktree_non_ignored'`.
- **Journal Sequence Binding**: Snapshot transactions write `SNAPSHOT_CAPTURED` and record the global sequence number into `SnapshotRef.journalSeq`. Enables distributions to revert conversation state to sequence N and locate the corresponding workspace snapshot (`journalSeq <= N`).
- **Workspace Forking (`materialize` / `dematerialize`)**:
  - `snapshot.materialize(snapshotId, newRoot)`: Creates an independent detached worktree (`git worktree add --detach <newRoot> refs/xioflow/snapshots/<snapshotId>`), registered as exclusive resource `workspace:write:<newRoot>`.
  - `snapshot.dematerialize(newRoot)`: Teardown via `git worktree remove --force <newRoot>`, releasing leases.

### 3.6 Human Adjudication Protocol (Target State)

Retaining leases on `indeterminate` operations is necessary, but there must be a single, audited exit path to prevent permanent resource starvation:

```text
adjudicate(opId, verdict, actor, note?)
1. [Precondition] Target operation result must currently be 'indeterminate'; reject otherwise
2. [Fact Refresh] Driver executes fresh identity and descendant check, attaching findings to adjudication record
3. [Transaction Commit] Write AdjudicationRecord (with epoch fence check) and journal event OPERATION_ADJUDICATED
   ├── confirmed_stopped: Release resource leases; if live processes found in step 2, verdict is rejected (must use abandon_with_residuals)
   └── abandon_with_residuals: Release leases, but residualPids remain permanently recorded; Run outcome cannot be succeeded
```

### 3.7 Idempotent Replay Protocol & Adjudication Table (Normative in 0.3.0)

xioflow is not a workflow engine; it is the side-effect layer beneath durable workflow engines (Temporal, Restate, LangGraph, DBOS). When durable engines replay nodes or activities, the kernel relies on `opId` and `inputFingerprint` to guarantee at-most-once execution:

```text
executeProcess(op) Admission & Idempotency Adjudication Table:
┌───────────────────────────────────┬──────────────────────────┬────────────────────────────────────────────────────────┐
│ Database & Active Memory State     │ inputFingerprint Match   │ Kernel Action & Return Value                           │
├───────────────────────────────────┼──────────────────────────┼────────────────────────────────────────────────────────┤
│ No record exists                  │ -                        │ Normal execution; register intent and spawn process    │
│ Record exists                     │ Mismatch                 │ Throw OperationIdConflictError; existing facts intact  │
│ Record exists & active in memory  │ Match                    │ Join in-flight operation: attach to promise, join stdio│
│ Record exists & terminal in DB    │ Match                    │ Return recorded result with replayed: true & runId     │
│ Record exists & indeterminate     │ Match                    │ Return IndeterminateResult as-is; NEVER retry; lease kept│
│ Record exists & non-terminal in DB│ Match                    │ Unrecovered crash: throw RecoveryRequiredError; reject │
│ (absent from memory)              │                          │                                                        │
└───────────────────────────────────┴──────────────────────────┴────────────────────────────────────────────────────────┘
```

#### Supplemental Rules:
1. **Auditability**: Every replay hit appends an `OPERATION_REPLAYED` event in the journal, recording `opId`, calling `runId`, `originalRunId`, and `mode` (`'joined' | 'recorded' | 'indeterminate'`), providing immutable audit evidence that execution was not repeated.
2. **Relationship with Runs**: `opId` is globally unique within an execution domain and spans across Runs (D17). A Run always represents a single execution attempt. After a crash, higher-level runtimes open a new Run; submitting the same `opId` hits replay and returns facts recorded under the previous Run without changing original ownership. Calling Run must be non-terminal (N3 invariant).
3. **In-Flight Cancellation Isolation**: When a caller joins an in-flight operation (`mode: 'joined'`), aborting the second caller's `AbortSignal` only cancels its own waiting promise; it **never cancels the underlying process** or the original caller's execution. To cancel the underlying process, callers must explicitly invoke `cancelOperation(opId)`.
4. **Interaction with Gated Spawn**:
   - If `gatedSpawn: true`: An unrecovered intent with no OS identity is proven to have never opened the execution gate; it resolves as safely clean/unstarted.
   - If `gatedSpawn: false`: It cannot be proven whether the process spawned right before the crash; it must resolve to `indeterminate` with leases retained (Contract #49).

### 3.8 Service Lifecycle Protocol (Target State)

For long-running processes (e.g., MCP stdio servers, local test runners, dev watchers), the kernel provides the `kind: 'service'` primitive:
- **Instances are Process Operations**: Every service consists of lifecycle instances; each instance is fundamentally a standard process operation (`opId = <serviceId>#<instanceIndex>`). Startup, stop verification, identity checking, and crash recovery reuse identical pipelines without secondary state machines.
- **Bidirectional stdio Communication**:
  - `stdinMode: 'stream'`: Standard input remains open and writable by the host until closed or stopped;
  - Passthrough stdout: stdout chunks pass directly to consumers without Head+Tail in-memory buffering, preventing memory bloat; optional side-channel disk spill; bounded stderr draining and spill remain active.
- **Readiness Probing**: Declared as `readiness: 'spawned' | { stdoutLine: RegExp }`. Writes `SERVICE_READY` upon matching pattern.
- **Declarative Restart Specification (D19)**: Policy `restart: 'never' | { policy: 'on-failure', maxRestarts: number, backoffMs: number }`. When an unexpected exit matches policy, the kernel registers a new instance op, logs `SERVICE_RESTARTED`, and backs off; exceeding `maxRestarts` marks service status as `failed`.
- **Host Crash Teardown**: Upon host recovery, the recovery engine inspects and terminates all service instances alongside ordinary operations; **the recovery engine never automatically restarts services**. Restart decisions are explicitly made by the new host.

---

## 7. Cross-Implementation Conformance Suite

The conformance contract is part of the ABI (§0.2 Decision 5): it verifies **execution facts**, independent of any language or implementation internals.

### 7.1 Format and Levels

- **Black-Box Harness**: Drives implementations over the §5 protocol (or embedded stdio adapter), asserting solely on returned JSON facts and journal event records.
- **Deterministic Fixtures**: Driven by the `xf-fixture` binary (`spawn-tree`, `escape-setsid`, `flood-output`, `hold-pipe-after-exit`, `ignore-signals`, `write-files`) to ensure identical OS process behavior across all language implementations.
- **Conformance Levels**:
  | Level | Scope | Passing Criteria |
  |---|---|---|
  | **L1 Process Supervision** | Spawn, stop, output, quotas, idempotency admission | 100% Pass |
  | **L2 Recovery & Ownership** | Crash recovery, identity verification, epoch fences, adjudication, idempotency recovery | 100% Pass |
  | **L3 Snapshots & Rollbacks**| Workspace snapshots, rollback verification, coverage declarations | All tests pass for snapshot-enabled implementations |
  | **L4 Multi-Client Daemon** | Central daemon mode, multi-client lease arbitration | All tests pass for daemon-enabled implementations |
  | **H Platform Hard Limits** | OS-level hard resource limits (cgroup v2, Windows Job Object) | Gated by platform capability declaration |
- **Capability Gating**: Capabilities not declared by a driver must be reported as `unsupported` (specifying capability name); they must never be counted as passed, nor silently skipped.

### 7.2 Conformance Contract Inventory

Status column: `S<n>` indicates implementation as test #n in the shared conformance suite (`@xioflow/kernel/testing`); `R` indicates internal implementation in repository tests pending suite promotion; `Planned` indicates upcoming roadmap milestone.

| # | Level | Contract Description | Status |
|---|---|---|---|
| 1 | L1 | Erroneous command spawn fails immediately; never produces fake running; distinguishes `spawnFailure` from exit code 127. | S1 |
| 2 | L1 | Bounded large output draining: 50MB output exits smoothly; per-stream truncation flags set. | S2 |
| 3 | L1 | In-memory retention preserves Head + Tail; truncation boundaries land cleanly on UTF-8 character boundaries. | S25 |
| 4 | L1 | 50MB output full artifact spill: `fsync` verified; artifact reference and SHA-256 hash independently verifiable against disk contents. | S15 (on-disk hash validation: R) |
| 5 | L1 | Spill failures are visible: `spillError` present prevents returning invalid artifact references. | S26 |
| 6 | L1 | Unconfirmed stop retains lease: exclusive resources remain locked until termination is verified. | S3 |
| 7 | L1 | Resource conflicts provide diagnostic holder details; admissions queue in strict FIFO order. | S4 (FIFO ordering: R) |
| 8 | L1 | Group termination converges reliably: all child and grandchild processes terminate with the group. | S9 |
| 9 | L1 | Escaped descendants reported honestly: surviving `setsid` processes recorded in `residualPids`; `confirmed_stopped` is rejected. | S10 |
| 10 | L1 | Descendants holding stdio pipes after group leader exit are reaped; genuine exit codes preserved. | S17 |
| 11 | L1 | Timeout combined with escaped descendants: operation returns `indeterminate` within bounded time without hanging. | S19 |
| 12 | L1 | Stop requests for non-existent or already-terminal operations return explicit errors. | S20 |
| 13 | L1 | Domain concurrency limit: excess operations queue up and release in order; non-resource ops count towards `maxConcurrentOps`. | S14 (non-resource counting: R) |
| 14 | L1 | Single-shot stdin: fully forwarded and closed; EPIPE handled gracefully without marking spawn as failed. | S16 |
| 15 | L1 | Streaming projection: chunks forwarded per stream; subscriber errors or dropped chunks do not corrupt facts. | S18 |
| 16 | L1 | Missing platform capabilities and unsupported Hard requests are explicitly rejected at admission. | S7, S13 |
| 17 | L1 | Seamless workflow swapping: event sequencing and state transitions match across memory and markdown workflows. | S8 |
| 18 | L2 | Indeterminate side-effect replay prevention: operations in `indeterminate` status never auto-retry on recovery. | S5 |
| 19 | L2 | Reliable crash recovery: committed facts and epoch state faithfully restored upon host restart. | S6 |
| 20 | L2 | Epoch fencing: write attempts from stale or resurrected owners are strictly rejected. | S11 |
| 21 | L2 | Run completion protocol: incomplete or indeterminate operations block Run from reporting success. | S12 |
| 22 | L2 | Zombie leader with surviving descendants: recovery executes targeted group termination before releasing leases. | S21 |
| 23 | L2 | PID wrap-around protection: unrelated processes reusing original PIDs are never misidentified or killed. | R |
| 24 | L2 | Crash before identity registration: gated spawn guarantees non-execution; non-gated marks `indeterminate` if process found. | R |
| 25 | L2 | Run status convergence upon recovery: non-terminal runs transition to `failed` or `indeterminate`; never linger in `running`. | S23 |
| 26 | L2 | Human adjudication: single audited exit path, writes journal, enforced by epoch fence; live descendants reject `confirmed_stopped`. | S24 |
| 27 | L2 | Schema versioning: explicit migrations for older schemas; opens rejected with `SchemaTooNewError` for newer schemas. | Planned |
| 28 | L3 | Rollback fingerprint verification: faithfully differentiates `restored`, `partial`, and `failed`. | Planned |
| 29 | L3 | Unconfined execution caps rollback `coverage` at `declared_roots`; sets `outOfScopeEffects = 'possible'`. | Planned |
| 30 | L3 | Rollback is mutually exclusive with active or indeterminate operations on target root directories. | Planned |
| 31 | L3 | Crash mid-rollback: recovery evaluates disk fingerprint to determine `restored` or `indeterminate`. | Planned |
| 32 | L3 | `git-shadow` snapshots leave user index, HEAD, and branches untouched; declares `worktree_non_ignored`. | Planned |
| 33 | L4 | Multi-client mutual exclusion: conflicting resource claims provide clear diagnostics pointing to competing client. | Planned |
| 34 | L4 | Embedded instances attach as clients when domain is held by daemon; lock contention or shadow domains forbidden. | Planned |
| 35 | L4 | Observer connections are read-only: hold no leases and never interrupt domain owners. | Planned |
| 36 | L4 | Client disconnect: in-flight operations enter stop pipeline with `terminationReason: 'client_lost'` after grace period. | Planned |
| 37 | H | Hard memory limit (Linux cgroup `memory.max` / Windows Job) triggers termination with `memory_exceeded`. | Planned |
| 38 | H | Process count limit (`pids.max` / Job `ACTIVE_PROCESS`) blocks fork bombs without impacting host. | Planned |
| 39 | H | Domain total memory budget: admission queues when full; admits sequentially upon resource release. | Planned |
| 40 | L1 | Duplicate `opId` rejected explicitly (0.2.0: `DuplicateOperationError`); leases and cancellability of existing op untouched. | S22 |
| 41 | L1 | Exactly one `OPERATION_RESULT_RECORDED` event per op; unobserved fields are `null` (no default signals/exit codes). | R |
| 42 | L2 | Group termination requires matching `bootId` and descendant start times no earlier than op spawn; insufficient evidence ⇒ `indeterminate`. | R |
| 43 | L2 | Individual op failure does not alter Run status; terminated Runs reject new ops; distributions cancel Runs via `reportRunCancelled`. | R |
| 44 | L1 | Untruncated spill files deleted upon clearance; `pruneArtifacts` refuses to reap artifacts of non-terminal / unadjudicated ops. | S27 |
| 45 | L2 | Replay with identical `opId` and fingerprint returns recorded result, spawns no new process, logs `OPERATION_REPLAYED`. | S45 |
| 46 | L2 | Conflicting fingerprint with same `opId` throws `OperationIdConflictError`; existing operation facts remain unmodified. | S46 |
| 47 | L2 | Replay hitting in-flight operation joins same promise; exactly one underlying process spawned. | S47 |
| 48 | L2 | Replay hitting `indeterminate` operation returns indeterminate result as-is without re-running; preserves leases. | S48 |
| 49 | L2 | Crash recovery scene with intent but no identity: `gatedSpawn=true` verifies non-execution; `false` escalates to `indeterminate`. | S49 |
| 50 | L1 | Service instance bidirectional stdio via `stdinMode: 'stream'`; passthrough stdout; standard stop pipeline. | Planned |
| 51 | L1 | Service restarts on-failure with exponential backoff up to limit; each restart is a new instance op logging to journal. | Planned |
| 52 | L2 | Host crash cleans up and terminates service instances; recovery engine never automatically restarts services. | Planned |
| 53 | L3 | `SnapshotRef.journalSeq` matches event seq; enables querying nearest snapshot not exceeding given sequence number. | Planned |
| 54 | L3 | Workspaces materialized from snapshots are isolated; source worktree, index, HEAD, and branch unaffected; dematerialize leaves no residue. | Planned |
| 55 | L3 | Capability validation failure (expired / stale epoch / path out of bounds / resource out of bounds) rejected at admission. | Planned |
| 56 | L3 | Rollback without `ConfinementDriver` cannot claim `complete`; only verifiably confined runs can achieve `complete`. | Planned |
