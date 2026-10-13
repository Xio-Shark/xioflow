# xioflow Kernel & xiocode Distribution Architecture and Protocol Specification

> **Start here for integration:** [Current implementation contract](spec/current-contract.md) separates the embedded TypeScript execution core, experimental AgentRuntime, and the abandoned (2026-10-13) Rust/daemon/Python direction. `CHANGELOG.md` distinguishes released behavior from worktree changes.

> **Direction ruling (2026-10-13, evening; supersedes the morning entry):** The Rust core, language bindings and daemon/multi-client direction is **abandoned** (reasons and revival conditions in the roadmap appendix). Decisions 3, 5 and 6 below are amended accordingly: arbitration is bounded by the host process, the TypeScript embedded core is the reference implementation, and `AgentRuntime` grows along a scheduling-versus-policy line. §5 daemon material remains a historical design record; its message shapes remain the transport baseline for black-box conformance.

> **Kernel foundation (2026-10-13, unreleased):** An acquired domain coordinates all supervisor entry points, including in-flight execution, service ownership, read tracking and transaction commits. Artifact creation and reclamation require explicit ownership evidence. Symbolic-link assumptions remain conservative path dependencies. Contracts 63–65 cover these boundaries; the [current contract](spec/current-contract.md#domain-coordination-and-artifact-ownership) defines compatibility and limits.

> **Experimental extension (2026-10-01, shipped in 0.7.0):** [AgentRuntime](spec/agent-runtime.md) adds kernel-owned agent lifecycle, cooperative dispatch, evidence gates and persisted checkpoints/step budgets. Existing model/tool adapters remain in distributions. The extension supersedes the execution-primitives-only positioning below for this experimental scope; it is not a complete multi-agent runtime.

The [interruption contract](spec/agent-runtime.md#interruption-contract) distinguishes requesting cancellation from settlement: record intent, notify the adapter, cancel managed commands, then await the batch without changing its checkpoint or spent budget. It does not force-kill JavaScript adapters or turn unconfirmed process stops into success.

The [shutdown contract](spec/agent-runtime.md#shutdown-contract) closes admission before draining owned work. Runtime ownership remains held through active quanta, command settlement and workspace reconstruction; closing the runtime does not close its domain or release indeterminate leases.

> **Document Status**: Authoritative Protocol Specification for the xioflow kernel repository. Sections 0, 3, and 7 define the core kernel protocol and conformance guarantees. For phased roadmap and current implementation status, see [`ROADMAP.md`](./ROADMAP.md). Chinese version: [`ARCHITECTURE.md`](./ARCHITECTURE.md).  
> **Status**: Amended 2026-10-13 — the embedded TypeScript core is the product; the Rust core / daemon / language-binding direction is abandoned (roadmap appendix). All sections (0–8) are mirrored in English as of this amendment; the Chinese edition remains authoritative on any discrepancy. Sections marked "Target State" are historical design material, not roadmap commitments.  
> **Core Positioning**:  
> - **xioflow**: A supervised execution kernel for AI agent framework authors. The execution core provides domain lifecycle, supervised processes, resource arbitration, verified stops, workspace transactions, SQLite persistence and recovery. Experimental AgentRuntime adds cooperative dispatch, task scopes and shared budgets. Distributions supply model protocols, prompts and business tools.
> - **xiocode**: The reference distribution assembled on top of xioflow: a complete local coding agent (model routing, coding tools, permission policy, CLI/TUI) that showcases what the kernel does. How it is assembled is documented in xiocode's own ARCHITECTURE.md.  
> **Repository Division**: xioflow is developed as an independent shared kernel repository; distributions like xiocode consume the kernel strictly through public protocols and thin language bindings.

---

## 0. Core Positioning & Design Decisions

### 0.0 Product Goal (North Star)

> xioflow is the **"Operating System Kernel" for AI Agent execution**: framework authors use it to execute local processes and modify workspaces, obtaining a set of **provable, honest execution facts**. Higher-level products (xiocode and third-party frameworks) assemble their distinct agent products on top of the same primitives and ABI, much like Linux distributions build upon the Linux kernel.

| Dimension | Decision |
|---|---|
| **Target Users** | Agent framework authors (not end-users of agents). Primary audience: **local-first** agent frameworks and coding agents executing commands directly on host machines. |
| **Non-Target Users** | Frameworks executing entirely inside disposable remote containers or microVMs (where tearing down the container resets the world, minimizing kernel demand). |
| **Kernel Form** | Embedded TypeScript/Node.js single implementation is the product; the Rust core and daemon mode were abandoned on 2026-10-13 (§0.2 Decision 3, §5; revival conditions in the roadmap appendix). |
| **Integration** | Node.js package and TypeScript types; language-neutral contract artifacts (JSON Schema, black-box conformance) are mainline work (P1a); other language bindings were abandoned (2026-10-13). |
| **Governance Scope** | Local processes and workspace transactions; experimental agent lifecycle, task scopes, shared Run budgets and evidence-gated dispatch. Model protocols remain in distributions. |
| **Controller Boundary** | Execution primitives and cooperative AgentRuntime; no forced preemption, plugin component model or business orchestration policy. |
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

#### 3. Deployment Topology: Embedded Single Implementation; Arbitration Bounded by the Host Process (Amended 2026-10-13)
"Single domain owner" and "every framework process embeds its own library" cannot coexist: a second embedded library accessing the same workspace receives `DomainLockedError`, while separate domains sacrifice cross-agent resource arbitration. The original design delivered cross-process "one arbiter per workspace" through a daemon; **after the 2026-10-13 direction ruling abandoned the daemon, the promised boundary is narrowed honestly**:
- **Arbitration scope = within one host process**: an acquired domain arbitrates in-flight execution, service ownership, read tracking and transaction commits for all supervisor entry points in that process (Contracts #64, #65);
- **No cross-process arbitration**: a second framework process attempting to acquire the same workspace domain fails explicitly (`DomainLockedError`); serializing or splitting domains is the host's decision, not the kernel's guess;
- **Reference domain-splitting pattern**: concurrent agents each run on their own git worktree with their own domain, sharing no `.git` writes; xiocode's worktree sandbox is the product-grade implementation of this pattern (distribution side);
- **Original daemon design (cross-client lease arbitration, observer connections, `client_lost`)**: archived as abandoned design; §5 keeps the material as a historical record and revival reference (revival conditions in the roadmap appendix).

#### 4. Rollback Honesty: Pluggable Snapshot Drivers, Coverage Must Be Honestly Declared
The kernel is not a security sandbox (§8) and cannot observe arbitrary writes by unmanaged child processes. Rollback assurance is governed by two orthogonal capabilities:
- **Snapshot Driver (`SnapshotDriver`)**: Governs *what can be restored* — Git shadow references, APFS clonefile, btrfs/ZFS snapshots, overlayfs, etc. The kernel defines the driver contract (§3.5, §4.1).
- **Confinement Driver (`ConfinementDriver`, optional)**: Governs *whether writes were verified not to leak outside* — using bubblewrap, `sandbox-exec`, Anthropic `srt`, or container primitives to restrict writes to snapshot roots. Serves **rollback correctness**, not security promises.
- **Honest Coverage Declaration**: Every rollback result must report `coverage`: `complete` (writes were confined, and ignored files inside the roots were either restored from the snapshot or proven unchanged by a manifest), `non_ignored` (writes were confined, but ignored files were not in the snapshot and nothing proves they are unchanged), `declared_roots` (guaranteed within declared roots only; outside side-effects unknown), or `none`. It also carries `ignoredFiles` and `coverageBasis` (the list of facts the claim rests on).
- **No False Claims**: Without write confinement during execution, rollback results must never claim `complete`. The same holds when the snapshot excludes ignored files and there is no evidence that they are unchanged.

#### 5. ABI Stability: Protocol and Conformance Contracts are the Product; Implementations are Reference
The Linux distribution ecosystem relies upon long-term stability of the syscall ABI. xioflow's equivalents are:
- **Three Core ABI Pillars**: Protocol message schemas (§5), `domain.db` schema with `user_version` migrations (§1), and the Conformance Suite (§7).
- **Versioning Strategy**: Protocol and schema versioning are decoupled from language package versions, evolving under SemVer; breaking changes require major version bumps with explicit migrations.
- **Implementation Status (amended 2026-10-13)**: The TypeScript embedded core is the reference implementation and currently the only implementation; conformance tier compliance — not code lineage — remains the sole criterion for compatibility. The planned Rust reference implementation was abandoned with the 2026-10-13 direction ruling (revival conditions in the roadmap appendix); the remaining commitments of this decision (three ABI pillars, SemVer evolution, breaking changes require a major bump with migration) are unchanged.

#### 6. Operation Idempotency and the Scheduling Boundary: When/Whether Belongs to the Kernel; What/Success Belongs to the Host (Amended 2026-10-13)
- xioflow is not a workflow engine; it acts as the **side-effect layer** beneath durable workflow engines (Temporal, Restate, LangGraph, DBOS, Inngest). The workflow engine manages replays; the kernel guarantees that "side effects for the same `opId` occur at most once, or an honest error is returned."
- **Scheduling-versus-policy line**: the kernel governs **when and whether** work executes in the execution lifecycle — admission, budgets, cancellation, lifecycle, checkpoints, evidence gates and task-tree joins (`AgentRuntime` is the experimental carrier of these primitives and may grow into a lightweight scheduler per the 2026-10-13 ruling); it never governs **what** the work is or **what counts as success** — model protocols, prompts, task decomposition, acceptance policy, business orchestration (DAG/workflow engines) and token/cost accounting stay with the host (§8 items 3–4). One-sentence criterion: **deciding when/whether to execute belongs to the kernel; deciding what to do and what counts as success belongs to the host.** Scheduling decisions are driven by evidence and budgets, never by the business graph.
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
- Rollback `coverage` is derived directly from whether execution was verifiably confined by capability: confined ⇒ eligible for `non_ignored`, and for `complete` once ignored files are accounted for (Decision 4); unconfined ⇒ capped at `declared_roots`.
- Not a substitute for OS security boundaries (§8); unauthenticated in embedded mode (D18).

---

## 1. Persistence Architecture & Power-Loss Guarantees (SQLite Transactional Store)

To achieve power-loss-grade crash recovery, the kernel abandons fragile bespoke plain-text appends for control state and uniformly adopts an **embedded SQLite transactional store**.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   Execution Domain storage boundary                    │
│                                                                        │
│   SQLite Database (domain.db)                                          │
│   ├── tasks / runs / operations (state tables)                         │
│   ├── resource_leases (persistent resource occupancy)                  │
│   ├── snapshots (snapshot refs, coverage, fingerprints — target state) │
│   └── journal_events (monotonic sequence-numbered event log)           │
│   PRAGMA user_version = schema version (ABI; migrations must explicit) │
│                                                                        │
│   WAL mode + PRAGMA synchronous = FULL / macOS F_FULLFSYNC             │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Explicit Boundaries of Three Persistence Guarantees

1. **Control-fact persistence**: committed Run states, Operation spawn intents, authorization decisions and results are flushed with `FULL` semantics after transaction commit and are 100% recoverable after power loss;
2. **Managed-artifact persistence**: before the kernel reports "artifact saved", the artifact driver must call `fsync` for a physical flush rather than merely returning a path; flush or write failures must be reported as facts (e.g. `spillError`), and no artifact reference pointing at an incomplete file may be returned;
3. **External side-effect state**: external shell commands and remote API calls cannot join local DB transactions. The kernel brackets every external call with a **pre-intent registration** and a **post-result verification** window; uncertain scenes are forced into the recovery pipeline.

> **Power-loss guarantee boundary**: on declared-supported local filesystems (e.g. APFS, ext4) and storage hardware that honors synchronization semantics correctly, committed kernel facts and managed artifacts are recoverable; physical hardware damage or devices that falsely report completed flushes are not covered.

### 1.2 Schema Versioning & Migration (ABI)

- The `domain.db` table structure is part of the ABI (§0.2 Decision 5): versioned by `PRAGMA user_version`; every implementation must verify the version before opening a database;
- Version older than own: perform explicit, replayable migration inside the ownership lock; the migration itself is written to `journal_events`; version newer than own: refuse to open and report `SchemaTooNewError`; downgrade writes are forbidden;
- Purpose: any implementation conforming to this specification (including cross-language ones) can take over an existing domain (including a crash scene) verbatim and adjudicate it.

---

## 2. Core Domain Model & Entity Contracts (TypeScript Notation)

> The types below use TypeScript notation to describe **protocol shapes**; they do not imply an implementation language. Any implementation conforming to this specification uses them as the serialization contract.

```typescript
/**
 * Logical unit of work
 */
export interface Task {
  id: string;                      // unique task identifier
  domainId: string;                // owning execution domain
  name: string;
  createdAt: string;               // ISO8601
  meta?: Record<string, unknown>;  // distribution metadata
}

/**
 * A single execution attempt
 */
export interface Run {
  id: string;
  taskId: string;
  domainId: string;
  owner: string;                   // execution owner (session-id / agent-runner)
  status: KernelRunStatus;
  terminationReason?: TerminationReason;
  startedAt: string;
  endedAt?: string;
  configSnapshotWhiteList?: Record<string, unknown>; // allow-listed safe config snapshot
}

export type KernelRunStatus =
  | 'queued'        // queued
  | 'starting'      // start-up preparation in progress
  | 'running'       // executing normally
  | 'stopping'      // stopping, awaiting driver confirmation
  | 'succeeded'     // succeeded (all operations settled)
  | 'failed'        // explicit execution failure
  | 'cancelled'     // confirmed stopped
  | 'indeterminate';// outcome unknown (cannot confirm stop, or side effects unclear)

export type TerminationReason =
  | 'completed'
  | 'user_cancelled'
  | 'timed_out'
  | 'resource_preempted'
  | 'crash_detected'
  | 'memory_exceeded'              // physical / process-tree memory limit exceeded
  | 'cpu_exceeded'                 // CPU time limit exceeded
  | 'pids_exceeded'                // descendant process count exceeded (fork-bomb guard)
  | 'output_exceeded'              // output byte hard truncation
  | 'client_lost';                 // target state: originating client disconnected in daemon mode (§5.3)

/**
 * Resource governance budget contract
 */
export interface ResourceBudget {
  maxMemoryBytes?: number;         // process-tree total memory (RSS/cgroup memory)
  maxPids?: number;                // total descendant processes (cgroup pids.max)
  maxCpuTimeMs?: number;           // CPU time (a different dimension from wall-clock timeoutMs)
  maxOutputBytes?: number;         // stdout+stderr on-disk cap (spill ceiling)
  enforcement: 'observe' | 'soft' | 'hard';
}

/**
 * Supervised atomic operation
 */
export interface Operation {
  id: string;
  runId: string;
  kind: 'process' | 'service' | 'snapshot' | 'rollback' | 'filesystem' | 'gate' | 'custom';
  name: string;
  inputFingerprint: string;        // content hash (sha256) of input and config; not a readable concatenation
  requiredResources: string[];     // resources claimed (e.g. ["workspace:write:root"])
  timeoutMs?: number;              // wall-clock run timeout
  resourceBudget?: ResourceBudget; // explicitly declared resource governance budget
  mutationRoots?: string[];        // target state: workspace roots this operation may modify (snapshot / rollback / write-confinement scope)
  snapshotBefore?: boolean;        // target state: capture a pre-snapshot at intent registration (§3.5)
  capabilityId?: string;           // target state: associated authorization capability id (§0.2 Decision 9)
  status: 'pending' | 'intent_registered' | 'active' | 'stopping' | 'done';
}

/**
 * Polymorphic execution result
 */
export type OperationResult =
  | ProcessOperationResult
  | SnapshotOperationResult
  | RollbackOperationResult
  | FilesystemOperationResult
  | GenericOperationResult
  | IndeterminateResult;

export interface BaseResult {
  durationMs: number;
  completedAt: string;
  replayed?: true;                 // target state: result returned by idempotent replay (§3.7)
}

export interface ProcessOperationResult extends BaseResult {
  kind: 'process';
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: string | null;           // POSIX signal name (e.g. 'SIGKILL'); null on Windows
  stdout: string;                  // in-memory retained Head + Tail (§4.3) or full output
  stderr: string;
  isTruncated: boolean;            // aggregate flag: any stream hit the bounded cap and was truncated
  stdoutTruncated: boolean;        // per-stream truncation fact
  stderrTruncated: boolean;
  stdoutRef?: string;              // artifact reference of the per-stream full spill; present only after a successful flush
  stderrRef?: string;
  stdoutHash?: string;             // sha256 over the spilled on-disk content
  stderrHash?: string;
  spillError?: string;             // spill failure fact; when present the corresponding *Ref must be absent
  spawnFailure?: string;           // executable could not start (distinct from the child itself exiting 127)
  peakMemoryBytes?: number;        // sampled process-tree memory peak
  cpuTimeMs?: number;              // CPU time consumed
  identityVerification: IdentityVerificationResult;
  stopVerification?: StopProcessResult; // stop confirmation credential
}

/**
 * Target state: workspace snapshot (§3.5)
 */
export interface SnapshotRef {
  id: string;
  driver: string;                  // 'git-shadow' | 'apfs-clonefile' | 'btrfs' | 'overlay' | third-party
  roots: string[];                 // roots actually covered
  coverage: 'worktree_non_ignored' | 'full_tree';  // a git-shadow reference excludes ignored files; must be declared honestly
  treeFingerprint: string;         // snapshot content fingerprint, used to verify after rollback
  journalSeq: number;              // global monotonic journal sequence of the transaction at capture time (§0.2 Decision 8)
  createdAt: string;
}

export interface SnapshotOperationResult extends BaseResult {
  kind: 'snapshot';
  status: 'succeeded' | 'failed';
  snapshot?: SnapshotRef;
  errorMessage?: string;
}

export interface RollbackOperationResult extends BaseResult {
  kind: 'rollback';
  status: 'restored' | 'partial' | 'failed';
  snapshotId: string;
  // §0.2 Decision 4: without a confinement driver, coverage may not be 'complete';
  // ignored files neither in the snapshot nor proven unchanged cap coverage at 'non_ignored'
  coverage: 'complete' | 'non_ignored' | 'declared_roots' | 'none';
  verifiedFingerprint: boolean;    // whether the post-rollback workspace fingerprint matches the snapshot
  unrestoredPaths?: string[];      // paths that could not be restored on partial (including intentionally kept ignored files that appeared after a full_tree snapshot)
  outOfScopeEffects: 'none_possible' | 'possible';      // whether managed operations could have written outside the roots
  // What rollback can say about ignored files: in snapshot & restored / not in snapshot but proven unchanged by a manifest / not in snapshot and unproven / in snapshot but verification failed
  ignoredFiles: 'restored' | 'unchanged_verified' | 'not_captured' | 'unverified';
  ignoredChanges?: {               // with a manifest: changes of ignored files relative to it; max 50 entries per category, counts holds totals
    added: string[]; removed: string[]; modified: string[];
    metadataOnly: string[];        // only ctime changed: cannot prove unchanged, does not assert changed either
    truncated: boolean;
    counts: { added: number; removed: number; modified: number; metadataOnly: number };
  };
  coverageBasis: string[];         // basis, e.g. all_ops_confined、snapshot_full_tree、ignored_manifest_unchanged、ignored_not_captured
}

/**
 * Target state: human adjudication record (§3.6)
 */
export interface AdjudicationRecord {
  operationId: string;
  verdict: 'confirmed_stopped' | 'abandon_with_residuals';
  actor: string;                   // adjudicator identity submitted by the distribution (user / policy name)
  note?: string;
  residualPids?: number[];         // residual process facts retained honestly on abandon
  decidedAt: string;
}

/**
 * Target state: authorization Capability (§0.2 Decision 9)
 */
export interface Capability {
  id: string;
  scope: {
    write: string[];                 // allowed workspace path roots for writes (realpath first, then inclusion check)
    exclusive: string[];             // managed resources allowed for exclusive claims
  };
  issuedBy: string;                  // issuer identity (distribution policy name / user)
  expiresAt: string;                 // ISO8601 expiry
  parentId?: string;                 // deriving parent capability id (narrowing derivation)
  epoch: number;                     // domain epoch at issuance; invalid across generations
}

/**
 * Error type definitions (target state / 0.3.0)
 */
export class OperationIdConflictError extends Error {
  constructor(public opId: string, public existingFingerprint: string, public incomingFingerprint: string) {
    super(`Operation ID '${opId}' already exists with a different input fingerprint`);
    this.name = 'OperationIdConflictError';
  }
}

export class RecoveryRequiredError extends Error {
  constructor(public opId: string, public existingStatus: string) {
    super(`Operation '${opId}' is recorded as '${existingStatus}' but not active in memory; recovery must be performed before replay`);
    this.name = 'RecoveryRequiredError';
  }
}

export interface FilesystemOperationResult extends BaseResult {
  kind: 'filesystem';
  status: 'succeeded' | 'failed';
  targetPath: string;
  action: 'create' | 'modify' | 'delete';
  bytesWritten?: number;
  errorMessage?: string;
}

export interface GenericOperationResult extends BaseResult {
  kind: 'generic';
  status: 'succeeded' | 'failed' | 'cancelled';
  outputRef?: string;              // immutable artifact reference
  errorMessage?: string;
}

export interface IndeterminateResult extends BaseResult {
  kind: 'indeterminate';
  status: 'indeterminate';
  reason: string;                  // unknown cause
  recoveryGuidance: string;        // manual recovery or on-site triage guidance
}

export type IdentityVerificationResult =
  | 'is_original_process'          // confirmed the originally spawned process
  | 'not_original_process'         // definitively no longer the original process
  | 'cannot_determine';            // cannot reliably determine
```

---

## 3. Core Execution Protocols

### 3.1 Intent-First Spawn Protocol (Gated Spawn)

Eliminates the crash blind spot where a process is launched but no record exists. The normative implementation uses **two-phase gated spawn (Gated Spawn)**: child processes are blocked before `exec` until their identity is safely recorded in SQLite:

```text
1. [Transaction Commit] Write Operation intent, input fingerprint, spawnGated evidence, and resource leases to SQLite (status: intent_registered)
   └── If snapshotBefore = true, capture pre-snapshot per §3.5 and record SnapshotRef in same transaction
2. [Driver Preparation] PlatformDriver.spawn(command, { gated: true })
   ├── POSIX: child blocks on pre-exec gate pipe after fork; Windows: CREATE_SUSPENDED
   └── Retrieve ProcessIdentity (pid, pgid / job handle, OS start time, command fingerprint)
3. [Transaction Commit] Record execution identity and advance operation status to 'active'
4. [Unblock Gate] Driver releases gate (writes gate pipe / calls ResumeThread); child executes target program
   └── If host crashes before step 3: gate pipe closes with EOF; child process exits immediately without executing target program
       ⇒ "No identity implies command not released" holds for an intent with recorded gated-spawn evidence
5. [Active Supervision] Attach bounded stdio drain pumps, register timeout guards and exit listeners
6. [Driver Termination] Process exits or stop triggered; driver produces preliminary result
7. [Transaction Commit] Atomically write OperationResult and release associated resource leases
```

**Drivers incapable of gated spawn** must declare `capabilities.gatedSpawn = false`. The supervisors persist this capability as `Operation.spawnGated` in the intent transaction. Recovery uses that original record, not the current driver's capabilities. An intent without identity and without `spawnGated: true` becomes `indeterminate` with leases retained. This includes legacy records: migration does not invent evidence. An empty process table cannot prove non-execution; the command may already have completed its side effects. See the [current recovery contract](spec/current-contract.md#crash-recovery-and-launch-evidence).

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
   ├── Partial paths unrecoverable, or ignored files that appeared after a full_tree snapshot were kept -> status: partial + unrestoredPaths
   │   (kept new files are left out of the fingerprint comparison; removeNewIgnored: true deletes them and can reach restored)
   └── Anything else differs from the snapshot -> status: failed
5. [Coverage Declaration] One pure function (deriveRollbackCoverage) derives coverage / outOfScopeEffects / ignoredFiles / coverageBasis per §0.2 Decision 4:
   If any operation ran without write confinement since snapshot ⇒ outOfScopeEffects = 'possible', coverage <= declared_roots
   All confined, full_tree snapshot ⇒ complete (ignoredFiles: restored)
   All confined, default snapshot, manifest unchanged ⇒ complete (ignoredFiles: unchanged_verified)
   All confined, default snapshot, no manifest / manifest changed / only ctime changed / manifest unreadable ⇒ non_ignored (ignoredFiles: not_captured)
6. [Transaction Commit] Write RollbackOperationResult, release leases
```

- **Retention and Pruning**: The kernel provides `pruneSnapshots(filter)`, and strictly refuses to prune snapshots referenced by non-terminal or unadjudicated operations.
- **Reference Driver**: `git-shadow` uses a temporary `GIT_INDEX_FILE` to perform `add -A` + `write-tree` + `commit-tree` to private ref `refs/xioflow/snapshots/<id>`, without touching user index or branches; declares `coverage: 'worktree_non_ignored'` (`full_tree` with `includeIgnored: true`; rollback still never deletes ignored files that appeared after the snapshot unless the caller passes `removeNewIgnored`).
- **Ignored-file manifest (optional)**: `captureSnapshot({ trackIgnored: 'manifest' })` copies no content. It records `size / mtime / ctime / mode` for every ignored file inside the roots in `artifacts/<snapshotId>-ignored.manifest`, stores the sha256 in `SnapshotRef.ignoredManifestDigest`, and journals only the digest and entry count. Rollback collects the same facts again and compares: all four equal means unchanged (rewriting content always advances ctime, and an unprivileged process cannot move it back). An entry whose ctime alone changed (`utimes`, a `chmod` round trip, the kernel's own read-set normalisation) is reported as `metadataOnly`, meaning "cannot be proven". The manifest is deleted by `pruneSnapshots`.
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
   - Recorded `spawnGated: true` on `intent_registered` with no OS identity proves the command was not released; recovery records `failed` and reports `cleaned_unspawned`.
   - `spawnGated: false` or absent cannot prove non-execution; recovery records `indeterminate` with leases retained (Contract #49). Both outcomes replay as recorded on same-ID submission, without re-execution.

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

### 3.9 Workspace Transaction Protocol: Optimistic Concurrency for Parallel Agents

When multiple agents modify the same workspace concurrently, locks (the `workspace:write` lease of §3.1) can only serialize them; workspace transactions let them **work in parallel and validate at commit**, moving database OCC (optimistic concurrency control, backward validation) onto the filesystem:

- **begin**: capture a baseline snapshot of the transaction roots (§3.5) and materialize an isolated fork; the fork's exclusive lease transfers to the transaction, the agent executes arbitrary operations inside the fork, mutual exclusion via each one's declared `workspace:write:<fork>`. Write `TX_BEGUN`; its journal seq is the transaction's start point.
- **Read set** (unprivileged observation): after the fork is created, set each entry's atime before its mtime (2-second margin); subsequent reads (file content, directory listings) are judged by `atime >= mtime`, including timestamp equality within the same Linux clock tick. Linux relatime updates atime when atime ≤ mtime; macOS APFS updates only when atime is strictly earlier than mtime (atime == mtime does not update on read — measured). Transactions and command evidence share the nanosecond-precision judgement and normalization logic. stat alone does not change atime, so collection itself does not pollute evidence, and it must complete before any git reads. The probe directly compares atime before and after the read; filesystems mounted `noatime` honestly declare `readTracking: 'unobserved'`, `readSet: null` — no pretending to know.
- **Write set**: per-file diff from the baseline snapshot tree to the fork's current tree (`A / M / D / T`), same caliber as the snapshot — exact and independent of observation method.
- **Backward validation** (at commit):
  - The write set of every transaction committed since this transaction began, intersected with this transaction's write set ⇒ `write_write`; intersected with the read set ⇒ `read_write` (content this transaction relied on is stale);
  - Directories in the read set (`dir/`) conflict only with direct entry additions or removals inside that directory — a listing sees the entry set; content modification does not change it;
  - Changes to the main workspace since the baseline not explained by committed transactions (direct writes bypassing transactions) participate in validation too ⇒ `external_write`;
  - A domain has a single owner; validation and application are serialized in-process, guaranteeing atomicity relative to other commits.
- **Apply**: hold the main workspace's `workspace:write` lease, first write `TX_COMMITTING` (with the write set, intent first), then land the write set verbatim onto the main workspace (preserving executable bits and symlinks, refusing writes through symlink parent directories out of the transaction root), finally write `TX_COMMITTED` and reclaim the fork. Crash mid-apply: the fork is the redo log; after restart the transaction is rebuilt from the journal and application is idempotently replayed, without re-validating.
- **Observation-level validation** (optional, `commit(txId, { observations })`): a file-level read set says "this file was read", while an agent usually relied on only a segment of it, or the result of one search. When someone else changed a different part of the same file, file-level validation still reports `read_write` — a false conflict. The host may hand over the transaction's observation log (ordered steps: read-only observations carry result hashes; a change's return value likewise carries a result hash when it exposed other content to the agent) and a replay function. The kernel uses it **only when file-level validation has already reported a conflict**:
  1. The conflict contains `write_write`, or the conflicting paths are in this transaction's write set ⇒ no attempt, conflict stands (`observation: { attempted: false, reason: 'write_conflict' }`). The kernel does not interpret tool calls and cannot distinguish ranged edits from whole-file overwrites; files written by both sides are never released on observation evidence;
  2. A process or service ran in the fork since the transaction began (judged by declared write roots and leases) ⇒ no attempt, write `TX_VALIDATION_DOWNGRADED` (`reason: 'not_closed_world'`). A process can read things beyond the log, so the host's `closedWorld` declaration does not hold here;
  3. Otherwise first write `TX_REPLAY_STARTED` (recording the replay fork and snapshot so a crash can abort and reclaim accordingly), snapshot the main workspace's current state, materialize a replay fork, and have the host replay each step in order: an observation's result hash differing from the record, or a change that cannot be applied ⇒ conflict stands, reporting the first difference (`observation: { attempted: true, divergedAt, reason }`);
  4. All identical ⇒ the write set becomes the diff from "current state → replay fork". After acquiring the main workspace write lease, verify once more that the main workspace is still in the snapshotted state: changed during replay (direct writes bypassing transactions) ⇒ the conclusion is void, conflict stands (`observation: { attempted: true, reason: 'workspace_changed' }`), nothing applied; otherwise commit from the replay fork. `TX_COMMITTING` records the source directory and `validation`; a post-crash retry still applies from the replay fork.
  The commit result carries `validation`, stating what "no conflict" rests on: `observations` (replayed observations), `files` (file-level read/write sets), `write_only` (reads unobserved; only the write set was validated). The correctness of observation-level validation depends on the host's log being complete and normalized results being reproducible; the only thing the kernel can verify is rule 2 above. It does not guarantee the merged code is semantically correct (two individually valid changes merged may still be invalid) — same as file-level validation.
- **Conflict is terminal**: failed validation writes `TX_CONFLICTED` (with `observation` if observation validation was attempted), the main workspace is unchanged, the fork is retained for inspection; the host can only abort and restart from the current workspace (continuing from the fork point, rebasing — host policy, not in the kernel).
- **Boundaries**: only reads inside the fork are observed; the fork is checked out from the snapshot tree and excludes ignored files (e.g. `node_modules`).

### 3.10 Read-Set Evidence: Validation Results Carry Their Dependencies

A validation command's conclusion (tests pass, typecheck passes) holds only for the files it depends on. `executeProcess({ trackReads: { roots } })` uses the same observation as §3.9 (access time, unprivileged) to record the files the command read and the directories it listed inside roots; the result carries a `readEvidence` summary, with details written to `artifacts/<opId>-reads.json.gz`:

- **Recording**: before start, normalize roots once (only files read since the last normalization; directories every time); after the process exits, collect the read set, hash the content of files read and the entry sets of directories listed, and record every file's size / mtime inside roots. `scope` is always `content_reads`: dependencies that only stat without reading content are not in the read set.
- **`evidenceStatus(opId)`**: content of a read file changed or entries of a listed directory changed ⇒ `stale` (naming them); nothing inside roots changed ⇒ `fresh` (`basis: 'tree_unchanged'`); only files outside the read set changed ⇒ `fresh` (`basis: 'reads_unchanged'`) when the caller declared `statCaches: 'ruled_out'`, otherwise `unknown` (`changed_outside_read_set`).
- **Why the default is `unknown`**: a command that hits a valid cache only stats source files without reading them (Python bytecode caches, incremental compilers), so source files are not in the read set. Measured: with the default configuration, selecting tests by read set achieves only 0.015 recall against source mutations; pointing the bytecode cache at an empty directory yields 1.000. The kernel cannot know whether a command has such caches, so it only releases by read set after the caller rules them out.
- **When unobservable**: the filesystem does not advance atime (`no_atime`), or another observed command is running on the same root (`roots_busy`; the later one does not normalize and the earlier one's evidence is unaffected) ⇒ `tracking: 'unobserved'`, able to answer `fresh` only via "nothing changed", otherwise `unknown`. Evidence collection itself failing ⇒ `tracking: 'failed'`; the command result is still persisted, status `unknown`.
- **Boundaries**: dependencies outside roots, environment variables, files read by resident processes on behalf of the command, and others' writes during the run are all outside the evidence; evidence is not a hermeticity guarantee. Normalization changes read files' ctime; §3.5's ignored-file manifest records it as a metadata-only change.

---

### 3.10 Experimental Agent Lifecycle & Evidence-Aware Scheduling

`AgentRuntime` places agent identity, input, parent relationships, checkpoints, step budgets and cooperative scheduling inside the execution domain, reusing the SQLite journal. Distributions still provide the model, tools and single-step execution adapter. Pre-dispatch observation validation, valid checkpoint selection, pause and resume protocols are in the [experimental runtime specification](spec/agent-runtime.md); validation is in `tests/agents/` and E6. This is an experimental increment shipped with the package since 0.7.0; it does not mean the full multi-agent kernel is complete. Per the 2026-10-13 direction ruling, AgentRuntime's growth boundary is Decision 6's "scheduling vs policy" line: scheduling, budgets, cancellation and lifecycle primitives may keep growing; model protocols, prompts, task decomposition and acceptance policy never enter the kernel. "Supervisor and AgentRuntime can be used independently" is unchanged (see the current implementation contract).

`interrupt`'s protocol distinguishes cancellation requests from settlement: record the request first, then notify the adapter and cancel managed commands, wait for the current batch to finish while preserving old checkpoints and spent budgets. It does not force-kill the JavaScript adapter and does not rewrite unconfirmed process stops as success; full boundaries are in the [interruption contract](spec/agent-runtime.md#interruption-contract).

`shutdown` first closes admission of new work, then waits for active quanta, managed commands and workspace reconstruction to settle, and finally releases runtime ownership. It does not close the domain and does not release leases of operations with undetermined outcomes; full boundaries are in the [shutdown contract](spec/agent-runtime.md#shutdown-contract).

## 4. Platform Driver Contracts & Stop-Confirmation Pipeline

### 4.1 Platform Driver Capabilities & the Containment Abstraction

In industrial-grade kernels, `spawn`'s responsibility is never "launch and get a PID", but **"launch and immediately place into a container that can be terminated as a whole group and resource-isolated (Containment)"**:

- On POSIX, establish an independent process group (PGID) via `detached: true`, becoming Group Leader;
- On Linux, prefer placement into a systemd user scope or a delegated cgroup v2 subtree;
- On Windows, use `CREATE_NEW_PROCESS_GROUP` and associate a Job Object handle;
- Any spawn that cannot establish container-level identity must expose the capability gap explicitly at the driver layer; silent degradation to unreliable single-PID management is forbidden.

```typescript
export interface PlatformDriver {
  name: string;
  capabilities: PlatformCapabilities;
  /**
   * Launch a managed command and place it in an isolation container
   */
  spawn(
    command: StructuredCommand,
    options?: { containment?: ContainmentSpec; gated?: boolean } // gated: §3.1 two-phase gated spawn
  ): Promise<ManagedProcessHandle>;
  /**
   * Multi-dimensional process identity verification based on OS process start time and fingerprint (prevents PID wraparound reuse)
   */
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  /**
   * Execute the termination pipeline with group-level confirmation and escape scanning
   */
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
  /**
   * Crash recovery only: when the leader is dead, target-clean by pgid / job and confirm the group is empty
   */
  terminateGroup?(group: { pgid?: number; jobId?: string; cgroupPath?: string }, graceMs: number): Promise<StopProcessResult>;
  /**
   * Periodically sample process-tree resource metrics (for observe/soft governance); implementations must be non-blocking (§4.4.5)
   */
  sampleMetrics?(identity: ProcessIdentity): Promise<ProcessTreeMetrics>;
}

export interface PlatformCapabilities {
  processGroupKill: boolean;         // whole-group termination (-pgid / TerminateJobObject / cgroup.kill)
  startTimeSource: 'os' | 'none';    // 'os': can read kernel-recorded process creation time (survives host restart); 'none': PID liveness only
  gatedSpawn: boolean;               // §3.1 two-phase gated spawn support
  memoryHardLimit: boolean;          // OS-level hard memory limit (Linux cgroup v2 memory.max)
  pidsLimit: boolean;                // total descendant process limit (cgroup pids.max)
  cpuLimit: boolean;                 // CPU time hard limit (cgroup cpu.max)
  descendantEnumeration: 'full' | 'cgroup' | 'job' | 'none'; // descendant enumeration and escape detection capability
}

/**
 * Target state: snapshot driver (§0.2 Decisions 4, §3.5)
 */
export interface SnapshotDriver {
  name: string;
  coverage: 'worktree_non_ignored' | 'full_tree';
  capture(roots: string[]): Promise<SnapshotRef>;
  restore(snapshot: SnapshotRef): Promise<{ unrestoredPaths: string[] }>;
  fingerprint(roots: string[]): Promise<string>;
  prune(snapshotIds: string[]): Promise<void>;
}

/**
 * Target state: write-confinement driver (optional; serves rollback correctness, not a security boundary)
 * Note: the source of writableRoots is the associated Capability (§0.2 Decision 9), no longer scattered config.
 */
export interface ConfinementDriver {
  name: string;                      // 'bubblewrap' | 'sandbox-exec' | 'srt' | third-party
  /** Wrap the command into "can only write writableRoots" form; must throw when it cannot be honored — returning an unrestricted command is forbidden */
  wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand;
}

export interface ContainmentSpec {
  pgidLeader: boolean;               // POSIX detached: true group creation
  jobObject?: boolean;               // Windows Job Object association
  cgroupScope?: {                    // Linux cgroup v2 isolation zone
    scopeName: string;
    budget?: ResourceBudget;
  };
}

export interface StructuredCommand {
  execPath: string;
  args: string[];                    // argv, never shell-wrapped
  cwd: string;
  stdin?: string | Uint8Array;       // one-shot stdin pipe, written then closed (compatible with stdinMode: 'once')
  stdinMode?: 'once' | 'stream';     // target state: input mode, default 'once'; service instances may use 'stream' (§3.8)
  envWhiteList?: Record<string, string>; // exact environment: exactly what is given, no PATH injection, never persists full env
  inheritEnv?: boolean;              // only effective without a white list; false yields an empty environment
}

export interface ProcessIdentity {
  pid: number;
  pgid?: number;                     // POSIX process group id — created at spawn
  jobId?: string;                    // Windows Job Object identifier
  cgroupPath?: string;               // Linux cgroup v2 path
  osStartTime?: string;              // kernel-recorded process creation time (see identity verification rules below)
  bootId?: string;                   // host boot identifier (Linux /proc/sys/kernel/random/boot_id etc.), compared across restarts; recorded at spawn registration since 0.2.0
  spawnTime: string;                 // ISO8601 (host record, display only, not identity evidence)
  commandFingerprint: string;        // sha256(JSON.stringify([execPath, ...args])), audit fact, not part of identity determination
}

export interface StopProcessResult {
  stopped: 'confirmed_stopped' | 'not_stopped' | 'cannot_determine'; // three-state stop convergence
  scope: 'direct_child' | 'process_group' | 'containment_cgroup' | 'job_object' | 'unknown';
  residualPids?: number[];           // escaped descendants or suspect residual PIDs
  errorDetails?: string;
}

export interface ProcessTreeMetrics {
  rssBytes: number;                  // process-tree physical memory (Resident Set Size)
  pidsCount: number;                 // surviving descendant process count
  cpuTimeMs: number;                 // user + system CPU time
}
```

#### 4.1.1 Process Identity Verification Rules (Preventing PID Reuse)

- **The only trusted evidence is the OS-recorded process creation time**: Linux reads field 22 `starttime` of `/proc/<pid>/stat` combined with `boot_id`; macOS reads `pbi_start_tvsec/pbi_start_tvusec` of `proc_pidinfo(PROC_PIDTBSDINFO)`; Windows reads the creation time from `GetProcessTimes`;
- Decision table:

  | Observation | Conclusion |
  |---|---|
  | PID does not exist, or is a zombie (exited, awaiting reaping) | `not_original_process` |
  | `bootId` differs from the current host | `not_original_process` (the original process necessarily no longer exists after restart) |
  | OS creation time matches the record | `is_original_process` |
  | OS creation time differs from the record | `not_original_process` |
  | Driver cannot read OS creation time (`startTimeSource = 'none'`) | `cannot_determine` |
- **Forbidden** as cross-restart identity evidence: "command line contains execPath" or "a monotonic clock in the host process" — the former misjudges an unrelated same-named process that reused the PID (e.g. another `node`) as the original, which the recovery pipeline would then kill by mistake;
- `osStartTime` must be read from the OS and recorded at spawn (under gated spawn the child blocks on the gate; `exec` does not change creation time); not recorded or currently unreadable ⇒ `cannot_determine`; readings from the same source are compared by original value, with no tolerance;
- `commandFingerprint` is an audit fact only, used neither to confirm nor to deny: shebang scripts (`npm`, `pnpm`, Python scripts) have their OS-visible argv rewritten by the kernel into "interpreter + script path + arguments", and programs that rewrite `argv` likewise; denying with it would misjudge a genuine original process as a stranger and wrongly enter the group-cleanup path.

### 4.2 Stop-Confirmation Pipeline (Stopping Pipeline)

Treating "a signal was sent to the PID" as "the process has stopped" is strictly forbidden:

1. **Group-level delivery with graceful escalation**:
   - Prefer sending `SIGINT` to `-pgid` (or via `cgroup.kill` / `TerminateJobObject`);
   - After the grace period `graceMs` (default 3000ms), escalate to `SIGTERM`, then `SIGKILL`;
2. **Group-empty polling verification (Wait for ESRCH)**:
   - After sending `SIGKILL` to `-pgid`, the driver periodically polls `kill(-pgid, 0)` until it returns `ESRCH` (confirming no surviving process in the group);
3. **Escaped-descendant explicit scan (Escaped Descendants Audit)**:
   - Grandchildren may call `setsid()` to leave the original PGID. After the group is empty, the driver performs one descendant-tree scan (Linux walks the `/proc` parent chain, or verifies cgroup membership);
   - If escaped residual processes are found, record them honestly in `residualPids` and set the stop verdict to `'cannot_determine'` or `'not_stopped'` — **never hastily conclude full stop merely because the group is empty**;
4. **Decision branching & isolation release**:
   - `stopped === 'confirmed_stopped'`: confirmed fully terminated; advance to `cancelled` or `timed_out`, atomically release related resource leases;
   - `stopped !== 'confirmed_stopped'`: retain the on-site resource isolation barrier, advance to `indeterminate`, record a warning event and prevent the resources from being reused by new operations;
5. **All waits must be bounded**: timeouts / cancellation paths wait for the **root process exit fact**, not stdio pipe closure; when escaped descendants hold pipes, the operation must still return within `timeoutMs + stop pipeline grace + drain timeout` (conclusion `indeterminate`), never hanging until the escapee exits on its own;
6. **Stop requests must have a real object**: stopping a non-existent, already-terminal, or domain-closed operation must return an explicit error (e.g. `OperationNotActiveError`); returning `confirmed_stopped` is forbidden.

```text
Cancel / timeout / resource limit triggered
 └──> Run status enters 'stopping' (locks conflicting resources, rejects new child op claims)
       └──> Send graceful interrupt (SIGINT) to the process group (-pgid) or cgroup
             └──> Start controlled grace-period timer graceMs (e.g. 3000ms)
                   └──> Still not exited? Escalate SIGTERM -> SIGKILL (-pgid)
                         └──> Poll kill(-pgid, 0) until ESRCH (no processes in group)
                               └──> Trigger escaped-descendant scan (/proc chain or cgroup enumeration)
                                     ├── Escapes present or unverifiable -> stopped: 'cannot_determine' -> keep resource isolation, mark indeterminate
                                     └── Group empty and no escaped residuals -> stopped: 'confirmed_stopped' -> advance to terminal state and release leases
```

### 4.2.1 Native Holder: reaper helper (`ReaperPlatformDriver`)

The pipeline above can only be **honest** (escape ⇒ `cannot_determine`) on drivers that "observe the process tree from outside", not **complete**. `ReaperPlatformDriver` turns observation into holding: every operation is launched and held throughout by a native helper (`native/reaper/xioflow-reaper.c`, zero-dependency C, shipped as prebuilt binaries per platform).

- **Process layout**: host → helper (new session; `PR_SET_CHILD_SUBREAPER` on Linux) → root (independent process group, blocked on the gate until the host registers identity). The gate is implemented via the helper's pipe, replacing the `/bin/sh` trampoline; after `spawned <pid>` the host reads the OS creation time and records it, then sends `go`.
- **Tree definition and stopping**:
  - Linux: orphans necessarily return under the helper, so a `/proc` parent-chain scan enumerates the whole tree; signals are delivered via `pidfd_open` + start-time re-verification with `pidfd_send_signal`, eliminating PID-reuse misfires; **`waitpid` returning `ECHILD` proves the tree is empty** (`scope: 'subreaper_tree'`, `descendantEnumeration: 'subreaper'`).
  - macOS: no child subreaper. The helper triggers scans via kqueue `NOTE_FORK`; tree = parent-chain descendants ∪ tracked processes ∪ helper session members (a double fork still stays in the session), identity is (pid, microsecond start time). "All tracked processes have disappeared" is weaker than proof, so scope is recorded as `tracked_tree`; an escape that calls `setsid` first, loses the parent chain, and completes before being seen can still be missed, caught by §4.3's pipe-hold detection falling back to `indeterminate`.
  - The stop ladder is the same as §4.2 (SIGINT → grace → SIGTERM → SIGKILL), but the target is the whole tree rather than the process group; tree not cleared ⇒ `residual <pids>` → `cannot_determine`.
- **Supervisor death**: on control-channel EOF (host crash) or the helper receiving SIGTERM/SIGINT/SIGHUP, the helper stops the whole tree before exiting — no unsupervised process outlives its supervisor. After root exit the host drops its ref on the helper; remaining descendants do not block host exit, and host exit triggers cleanup.
- **Relation to recovery**: cross-crash verification, group cleanup and metric sampling reuse the same OS facts as `NodePlatformDriver` (procfs / `ps lstart`); identities registered by the two drivers can adjudicate each other. After the helper is lost (e.g. SIGKILLed), the driver falls back to OS facts and does not fabricate exit codes: root's exit fact is recorded as `{ exitCode: null, signal: null }`.
- **Selection & distribution**: currently explicitly opted into (construction throws when the helper is not found; no silent driver swap); `ReaperPlatformDriver.isAvailable()` lets hosts decide. Release artifacts include linux-x64 / linux-arm64 (statically linked) and darwin-arm64 / darwin-x64, with CI building all targets on every push.
- **Not done**: cgroup v2 delegated subtree (`cgroup.kill`, `memory.max`, `pids.max`) remains §4.4's target state; subreaper solves "tree completeness", cgroup solves "hard limits" — the two are orthogonal.

### 4.3 Bounded Output Draining & Spill-to-Artifacts Mechanism

Large-output handling follows "memory ceiling, streaming to disk, preventing pipe deadlock":

1. **In-memory buffer ceiling**: the default per-operation in-memory retention cap is 10MB (computed per stream). Beyond it, the corresponding stream's `*Truncated = true` is set, in-memory accumulation stops, but **Head (leading overview) + Tail (latest exceptions)** are retained in memory — test failure messages usually appear at the tail; keeping Head alone does not satisfy this rule; truncation points must land on UTF-8 character boundaries;
2. **Overflow spill to artifacts**: each stream is appended from the first byte to a managed artifacts file; `fsync` must complete before the operation finishes; on truncation, register the per-stream `*Ref` and the `*Hash` **computed over the spilled on-disk content**. This honors the memory ceiling while preserving 50MB+ of diagnostic evidence intact; untruncated spill files may be deleted at settlement;
   - **Spill failures must be visible**: failure at open, write or flush records `spillError`, and the corresponding `*Ref` must not be returned;
   - **Artifact reclamation**: the kernel provides the `pruneArtifacts(filter)` primitive, which refuses to reap artifacts still referenced by non-terminal / unadjudicated operations; retention policy is the distribution's decision;
3. **Kernel pipe deadlock-prevention drain pump**: even under truncation or disk write, **the implementation must keep listening and consuming `stream.on('data')` at the bottom**, strictly preventing the OS kernel pipe buffer (commonly 64KB) from filling and permanently hanging the child;
4. **Drain timeout guard**: waiting for stdio closure has a bounded timeout (default 2000ms); on timeout, force truncate and settle, preventing zombie processes holding stdout/stderr handles from making the main process's event loop wait forever;
5. **Domain-level total buffer guard**: the sum of in-memory buffers of all active operations in an execution domain has a cap (default 200MB). When the whole domain's accumulated buffer reaches the threshold, new operations queue at admission, preventing a burst of concurrent operations from each taking 10MB and breaking through the host Node process.

### 4.4 Resource Governance System & Platform Adaptation Matrix (Resource Governance & Platform Containment)

Resource governance is elevated to a first-class citizen on par with process supervision: a three-layer defense of "operation budget + domain quota + platform driver isolation".

#### 4.4.1 Three-Tier Enforcement Semantics

| Governance level | Core semantics | Underlying enforcement and execution path |
|---|---|---|
| **`observe`** | Sampling only, no execution intervention | Driver periodically samples process-tree RSS / CPU into result metadata; overruns do not interrupt |
| **`soft`** | Detecting an overrun triggers the graceful stop pipeline | The monitoring loop checks the budget; on overrun, status turns `stopping`, entering the standard stop pipeline, termination reason being the corresponding `_exceeded` |
| **`hard`** | OS-kernel-level physical prevention of overruns | Relies on OS kernel mechanisms (Linux cgroup v2 / Windows Job Object) for caps; **if the driver does not support hard, admission is rejected outright** |

#### 4.4.2 Pre-admission Capability Check

- The check happens before the `intent_registered` transaction commits;
- If an operation declares `enforcement: 'hard'` (e.g. a hard memory budget) but the current platform driver declares `capabilities.memoryHardLimit === false`, the kernel **must throw `UnsupportedCapabilityError` and refuse**;
- **Silent downgrade is forbidden**: quietly degrading `hard` to `observe` or `soft` to pretend support for the sake of apparent success is never allowed.

#### 4.4.3 Domain Budget & Admission Queue

Per-operation limits cannot prevent whole-machine OOM (e.g. 10 operations each wanting 1GB). The execution domain maintains a domain-level resource water level in SQLite:

```text
domainBudget = {
  maxTotalMemoryBytes: 4096 * 1024 * 1024, // 4GB domain memory budget
  maxConcurrentOps: 8,                      // max concurrent managed processes
  maxTotalOutputBytes: 500 * 1024 * 1024    // 500MB domain-wide output on-disk cap
}

Admission check:
  activeOpsBudgetSum + newOp.resourceBudget <= domainBudget
  ├── satisfied -> register as intent_registered, allocate quota
  └── exceeded -> new operation stays pending, queued in the execution domain's wait queue until existing leases settle
```

- **Counting caliber**: every non-terminal Operation counts toward `maxConcurrentOps`, regardless of whether it claims resources (operations claiming no resources must not bypass the concurrency cap);
- **Queueing semantics**: the wait queue admits in registration order FIFO, giving each waiter holder and elapsed-wait diagnostics; deciding order by polling races is forbidden;
- **Quota persistence**: the domain budget itself is written to `domain.db` (not just host memory); per-operation occupancy is recorded in the `budget` column of `resource_leases`;
- On power loss or restart, the recovery engine restores the occupied domain quota water level when loading non-terminal operations, with no additional recovery mechanism needed.

#### 4.4.4 Platform Practices for the Three Major Operating Systems

> **Core principle: declare honestly, never promise capabilities the underlying platform cannot deliver.**

| OS platform | hard memory/CPU/PIDs limits | Group termination & escape protection | v1 landing & delivery strategy |
|---|---|---|---|
| **Linux** | **cgroup v2 unified governance**:<br>• `memory.max` (hard-limit OOM kill)<br>• `memory.high` (soft throttling)<br>• `pids.max` (fork-bomb guard)<br>• `cpu.max` (CPU quota) | **`cgroup.kill`**:<br>kernel-level atomic whole-group termination; member enumeration is naturally complete, eliminating escaped descendants at the root | **Implemented (TS, `CgroupPlatformDriver`)**:<br>1. The host runs in a cgroup delegated to it (`systemd-run --user --scope -p Delegate=yes`, or a container with a private cgroup namespace); the driver reads and writes cgroupfs directly;<br>2. Processes are placed into a dedicated cgroup while stopped at the startup gate; `hard` budgets land on `memory.max` / `pids.max` (`cpu.max` not implemented);<br>3. When preconditions are unmet, construction throws `CgroupUnavailableError` explicitly, with no fallback to another driver; controller enablement failure leaves `memoryHardLimit` / `pidsLimit` honestly `false` |
| **macOS** | **No native process-tree hard limit**:<br>`setrlimit` is single-process only and cannot constrain the derived child tree | **PGID process-group termination**:<br>relies on `kill(-pgid, signal)` broadcast | **Honest declaration**:<br>• supports `observe` + `soft` + PGID kill;<br>• `memoryHardLimit` explicitly declared `false`;<br>• optional file/network policy constraints via `sandbox-exec`, but never packaged as a fake hard memory limit |
| **Windows** | **Job Object container (design material)**:<br>• `JOB_OBJECT_LIMIT_JOB_MEMORY`<br>• `ACTIVE_PROCESS`<br>• `KILL_ON_JOB_CLOSE` | **`TerminateJobObject` (design material)**:<br>all processes associated with the handle exit atomically as a group | **Not supported (archived 2026-10-13)**:<br>• Job Object containment is an abandoned direction; revival conditions in the ROADMAP appendix;<br>• the current TypeScript implementation does not support Windows, honestly declaring `processGroupKill: false` |

#### 4.4.5 Kernel Self-Preservation Engineering Rules

1. **Distribution host explosion protection**: when the embedded host is Node, CLI startup scripts and distribution deployments explicitly configure `--max-old-space-size=4096` by default;
2. **Event batching into the store**: high-frequency streaming output and progress events are aggregated into batch transactions into SQLite, avoiding a filesystem fsync per character written;
3. **Zero unbounded string concatenation**: internal transport uses fixed-length Buffers and streaming pipelines throughout; massive string `+` operations in the main event loop are forbidden;
4. **Do not block the host**: process-tree scanning, resource sampling and disk spill must not execute synchronously on the host event loop / calling thread; one sampler is shared domain-wide (one read-only pass over the process table per sampling period for all active operations); per-operation high-frequency full process-table pulls are forbidden.

---

## 5. Deployment Topology, Protocol & ABI (Target State)

> **2026-10-13 ruling**: daemon mode (the right column of 5.1, 5.3 client/disconnect/Observer semantics, contracts #33–#36) is archived as an abandoned design, retained as historical design material and a revival reference; 5.2's message shapes remain the transport contract baseline for P1a black-box conformance. Embedded mode is the current and product form (Decision 3).

### 5.1 Two Deployment Modes

| Dimension | Embedded mode | Daemon mode |
|---|---|---|
| Domain owner | Host process | Workspace-level resident `xioflowd` process |
| Transport | In-process calls (language bindings: napi-rs / PyO3) | Unix domain socket (`<domain>/kernel.sock`) / Windows named pipe |
| Client count | 1 | Multiple (different frameworks, languages, multiple agents) |
| Crash recovery | Explicit `recovery.run` call after host restart | Automatic at daemon startup; results queryable via `recovery.lastReport` |
| Suitable for | Single-agent CLI, testing, single-task CI | Multiple agents in parallel on one workspace, multiple frameworks coexisting |

Both modes use the same set of message shapes and the same conformance contract; embedded bindings are merely "in-process transport".

### 5.2 Protocol

- **Encoding**: JSON-RPC 2.0; request and result field shapes are the types defined in §2 / §4;
- **Handshake**: `kernel.hello { protocolVersion, client: { name, version }, observer?: boolean }` → returns kernel version, protocol version, schema version, driver capabilities (`PlatformCapabilities`, snapshot / confinement driver lists) and conformance level;
- **Methods (v1 draft)**:

  | Method | Semantics | Observer available |
  |---|---|---|
  | `domain.status` | Domain owner, epoch, active operations, leases, unadjudicated indeterminate | Yes |
  | `task.save` / `run.open` | Register Task and Run | No |
  | `run.reportSucceeded` / `run.reportFailed` / `run.reportCancelled` | §3.3 Run completion protocol | No |
  | `op.execProcess` | §3.1 spawn protocol; params include `mutationRoots`, `snapshotBefore`, `confine` | No |
  | `op.cancel` | §4.2 stop pipeline | No |
  | `op.adjudicate` | §3.6 human adjudication | No |
  | `snapshot.capture` / `snapshot.rollback` / `snapshot.prune` / `snapshot.materialize` / `snapshot.dematerialize` | §3.5 snapshots & forks | No |
  | `artifacts.read` / `artifacts.prune` | Segmented reads of spill artifacts by reference / reclamation | Read: yes |
  | `recovery.run` / `recovery.lastReport` | §3.2 recovery protocol | Report read: yes |
  | `journal.read` / `journal.subscribe` | Read / subscribe to events by sequence | Yes |

- **Notifications**: `op.chunk` (real-time output projection), `op.result`, `journal.event`. `op.chunk` is a best-effort projection, droppable under backpressure, and must report the drop count; **facts come only from `op.result` and the journal**; full output is the spill artifact, and dropped projections never lose facts.

### 5.3 Clients, Ownership & Disconnect

- Each connection's `client.name` is recorded as the `owner` of its Runs; lease arbitration applies across clients;
- **Client disconnect**: operations initiated by that client and still running enter the stop pipeline with `terminationReason: 'client_lost'` after `clientGraceMs`; except operations registered as `detached: true` (their results are retained for later query);
- **Observer connections**: read-only transactions, hold no leases, write no state, satisfying §0.2 Decision 1's read-only observer requirement;
- **Local boundary**: socket file permissions `0600`, with peer credentials (`SO_PEERCRED` / `getpeereid` / named pipe client SID) verifying the same user; no network ports are listened on (§8).

### 5.4 Versioning & Compatibility

- `protocolVersion`, `domain.db`'s `user_version` and the conformance level each evolve by SemVer, decoupled from language package versions;
- A daemon supports at least the current and the previous protocol major versions simultaneously, negotiated at client handshake; negotiation failure returns an explicit error rather than degrading to run;
- Language bindings' public APIs may use language-idiomatic forms, but semantics must map one-to-one onto protocol methods and pass the same conformance suite.

---

## 6. Distribution Assembly

The kernel repository does not describe any distribution's internal structure. Components, workflows, edit policy and interaction form are the responsibility of the distribution's own documentation; this section only defines the boundary between distribution and kernel.

- **Reference distribution xiocode**: a complete local coding agent, used to demonstrate kernel capabilities under real load (session ↔ execution domain, turn ↔ Run, MCP server ↔ service, checkpoint ↔ snapshot, `indeterminate` ↔ adjudication exit). How it assembles on the kernel has its sole source in the xiocode repository's [`ARCHITECTURE.md`](https://github.com/Xio-Shark/xiocode/blob/main/ARCHITECTURE.md).
- **Constraints applied equally to all distributions** (all are existing rules in this document, indexed here only):
  1. Consume the kernel only through the public protocol / language bindings (see "repository division of labor" at the top);
  2. Run status is reported only via `reportRunSucceeded` / `reportRunFailed` / `reportRunCancelled`; distributions must not write Run status directly (§3.3);
  3. May be more conservative than the kernel, but must not relax the kernel's isolation (§0.2 Decision 2).

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
- **External compliance tiers** (for third-party implementations and hosts, added 2026-10-13): L1–H above are the suite's internal levels; external compatibility claims use the three tiers below. How to run: [conformance entry](spec/conformance.md):
  | Tier | Requirement | Semantics |
  |---|---|---|
  | **core** | All of L1 + L2 pass (entries for declared capabilities in H must not be `unsupported`) | The minimum line of "xioflow-compatible/core": complete honesty of execution facts (spawn, stop, output, recovery, ownership) |
  | **workspace** | core + transaction and coverage-declaration entries in L3 (#56–#61, #65) | Parallel-agent workspace transactions and read-set evidence usable |
  | **experimental** | workspace + AgentRuntime behavior (spec/agent-runtime.md) | Experimental increment, may change with minor versions, must not stand alone as a compatibility claim |
  - L4 (multi-client daemon) is archived and does not enter the compatibility tiers; H entries are declared separately by platform capability gating and do not count toward the tiers.
  - Compliance is a **tier declaration**, not a certification: the implementer self-tests and declares; the suite provides a reproducible green/red conclusion. Reference format: `xioflow-compatible/core (@xioflow/kernel 0.7.x suite, YYYY-MM-DD)`.

### 7.2 Conformance Contract Inventory

Status column: `S<n>` indicates implementation as test #n in the shared conformance suite (`@xioflow/kernel/testing`); `R` indicates internal implementation in repository tests pending suite promotion; `Planned` indicates upcoming roadmap milestone; `Archived` indicates the owning direction was abandoned (2026-10-13 ruling, revival conditions in the roadmap appendix).

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
| 9 | L1 | Escaped descendants reported honestly: a `setsid` process that survives the stop yields `cannot_determine` with `residualPids`, never `confirmed_stopped`; a driver that claims `confirmed_stopped` must have actually removed it. | S10 |
| 10 | L1 | Descendants holding stdio pipes after group leader exit are reaped; genuine exit codes preserved. | S17 |
| 11 | L1 | Timeout combined with escaped descendants: the operation settles within bounded time without hanging; `indeterminate` with the lease kept unless the driver confirmed the escapee is gone. | S19 |
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
| 33 | L4 | Multi-client mutual exclusion: conflicting resource claims provide clear diagnostics pointing to competing client. | Archived (daemon) |
| 34 | L4 | Embedded instances attach as clients when domain is held by daemon; lock contention or shadow domains forbidden. | Archived (daemon) |
| 35 | L4 | Observer connections are read-only: hold no leases and never interrupt domain owners. | Archived (daemon) |
| 36 | L4 | Client disconnect: in-flight operations enter stop pipeline with `terminationReason: 'client_lost'` after grace period. | Archived (daemon) |
| 37 | H | Hard memory limit (Linux cgroup `memory.max` / Windows Job) triggers termination with `memory_exceeded`. | S37 (Linux cgroup v2; Windows abandoned) |
| 38 | H | Process count limit (`pids.max` / Job `ACTIVE_PROCESS`) blocks fork bombs without impacting host. | S38 (Linux cgroup v2; Windows abandoned) |
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
| 49 | L2 | Intent without identity: persisted `spawnGated=true` proves non-release; false/absent becomes `indeterminate`. Same-ID submission replays either result. | S49 |
| 50 | L1 | Service instance bidirectional stdio via `stdinMode: 'stream'`; passthrough stdout; standard stop pipeline. | S50 |
| 51 | L1 | Service restarts on-failure with exponential backoff up to limit; each restart is a new instance op logging to journal. | S51 |
| 52 | L2 | Host crash cleans up and terminates service instances; recovery engine never automatically restarts services. | S52 |
| 53 | L3 | `SnapshotRef.journalSeq` matches event seq; enables querying nearest snapshot not exceeding given sequence number. | Planned |
| 54 | L3 | Workspaces materialized from snapshots are isolated; source worktree, index, HEAD, and branch unaffected; dematerialize leaves no residue. | Planned |
| 55 | L3 | Capability validation failure (expired / stale epoch / path out of bounds / resource out of bounds) rejected at admission. | Planned |
| 56 | L3 | Rollback without `ConfinementDriver` cannot claim `complete`. When every operation ran confined there are no out-of-scope effects (`outOfScopeEffects: 'none_possible'`); `complete` additionally requires ignored files to be in the snapshot (`full_tree`) or proven unchanged by a manifest, otherwise the result is `non_ignored`. | S56 |
| 57 | L3 | Ignored files that appear after a `full_tree` snapshot: rollback does not delete them on its own, lists them in `unrestoredPaths` (`partial`), and does not report `failed`. | S57 |
| 58 | L3 | A file the transaction read was changed by a concurrent commit, but every observation replayed on the current workspace is unchanged: the commit succeeds with `validation: 'observations'` and both sides' changes are kept. | S58 |
| 59 | L3 | A replayed observation differs from the record, or a replayed change cannot be applied: the conflict stands, the first difference (index and reason) is reported, and the workspace is unchanged. | S59 |
| 60 | L3 | A transaction in whose fork a process ran does not use observation validation: the file-level conflict stands and `TX_VALIDATION_DOWNGRADED` is journaled. | S60 |
| 61 | L3 | Read evidence never answers `fresh` after a dependency changed: a changed file the command read gives `stale` and names it; a change only outside the read set without stat caches ruled out, or unobserved reads, gives `unknown`. | S61 |
| 62 | L1 | Root exit with drained pipes is not an empty tree: a detached descendant with closed stdio is reaped (`treeSettlement: 'reaped'`) or the result says `unverified`, never `empty`; drivers declaring `cgroup` / `subreaper` enumeration must reap it. | S62 |
| 63 | L1 | Operation IDs are opaque keys: artifact creation, cleanup and reclamation stay within the artifact namespace and preserve pre-existing user files. Unknown ownership is retained. | S63 |
| 64 | L1 | Supervisor entry points on one domain share in-flight execution and leases. Same-ID joins execute once; conflicts preserve the original operation, and cancellation uses its originating driver. | S64 |
| 65 | L3 | Supervisor entry points on one domain share workspace commit coordination: concurrent conflicting transactions cannot both commit. | S65 |
| 66 | L1 | Failed process/resource observation is neither an empty tree nor zero usage. Losing observation required by a soft limit requests stop; unconfirmed stops retain leases, and observe-only failures remain explicit. | S66 |
| 67 | L1 | Cross-kind operation ID conflicts are rejected before effects. Failure cleanup preserves existing operations and leases; queued operations and internal allocations reserve their identities. | S67 |

### 7.3 Crash-Point Matrix & Formal Specification

Contracts prove "normal and foreseeable exceptional paths"; the following two prove the protocol still holds "when the supervisor dies at any step", and both check the same set of invariants.

- **Crash-point matrix** (`tests/fault/crash-matrix.test.ts`): the kernel has crash points (`src/fault/crashpoint.ts`, active only when the test environment variable is present, SIGKILLing itself on hit) before/after each store-layer transaction commit, and at "process released, result not yet persisted". The matrix first runs the scenario fault-free, recording every crash point passed, then kills the supervisor process at each point, recovers in a new process and verifies:
  1. no operation stopped mid-state; 2. leases belong only to `indeterminate` operations; 3. the process has either disappeared or the operation is isolated; 4. side effects happen at most once; 5. `succeeded` implies real execution and a zero exit code; 6. result facts recorded at most once; plus same-`opId` resubmission in the new process replays only, never re-runs. The matrix runs once each for `NodePlatformDriver` and `ReaperPlatformDriver`, for completion and cancellation scenarios.
- **TLA+ specification** (`spec/tla/OperationRecovery.tla`, `pnpm check:tla`): a single operation's gated spawn, stop pipeline, crash at any moment (bounded times, including crashing again mid-recovery) and recovery. TLC exhausts all interleavings of the two drivers, checking `NoFakeRunning`, `NoPrematureRelease`, `AtMostOnce`, `NoFakeSuccess`, `IndeterminateHoldsLease`, `GateBeforeEffect`, `DoneHasResult`, and liveness `EventuallySettled`, `NoOrphanAtRest`.
- **A gap both found and fixed**: a crash before the result is persisted while the process has already exited — recovery only knew "the process is gone" and once recorded an ordinary `failed` as `marked_dead` — even when the process had completed its side effects and exited 0 (TLC falsified `NoFalseFailure` with Effect → Exit → Crash → Recover; the matrix observed the same on the real implementation). That conclusion now carries `terminationReason: 'exit_unobserved'`: the status is still `failed` to mean "no longer occupying resources, lease releasable", but the outcome is unknown and the host must not retry with a new opId on this basis. In the specification it is a distinct conclusion `exited_unknown`; `NoFalseFailure` enters CI checks; the matrix and shared contracts assert `marked_dead` must carry that reason.

---

## 8. Explicit Non-Goals

To guard against speculative abstraction and unbounded scope creep, the following design boundaries are explicitly retained:

1. **No security sandbox (Firecracker / microVM / adversarial isolation)**: xioflow trusts development tools launched by managed components and user authorization, focusing on process governance and runaway containment, and does not undertake defense against malicious escapes. §0.2 Decision 4's confinement driver and Decision 9's capability serve only rollback correctness and authorization-fact integrity; no documentation or API may present them as security boundaries;
2. **No IO frequency limiting, network access policy or GPU quota**: the core pain points are memory blowups, orphan processes and runaway infinite loops; without real business drivers, complex network and GPU orchestrators are not introduced in advance;
