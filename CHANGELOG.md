# Changelog

All notable changes to `@xioflow/kernel`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

> Release note: 0.1.0 – 0.1.4 were uploaded from a local npm bypass-2FA token. From the next tag-based release on, `.github/workflows/release.yml` publishes through npm Trusted Publishing (OIDC) with a provenance attestation, so the published artifact is verifiable back to this repository.

## [Unreleased]

### Added
- **`ReaperPlatformDriver` and the native `xioflow-reaper` helper** (Linux, macOS; ARCHITECTURE §4.2.1). The helper holds the supervised process tree instead of observing it through `ps(1)` polls:
  - Linux: the helper is a child subreaper (`PR_SET_CHILD_SUBREAPER`), so `setsid` and double-fork escapees are reparented to it. Signals go through `pidfd` after re-checking the start time, and `waitpid` returning `ECHILD` proves the tree is empty (`scope: 'subreaper_tree'`).
  - macOS: descendants are tracked through kqueue `NOTE_FORK`, the helper's session and microsecond start times (`scope: 'tracked_tree'`); a process that leaves the session and loses its parent chain before it is seen can still escape, which the pipe-holder check keeps catching.
  - When the supervising process dies (control socket EOF) or the helper is signalled, the helper stops the whole tree before exiting.
  - The gate replaces the `/bin/sh` springboard. Recovery-time facts (identity, group evidence, metrics) are the same OS facts `NodePlatformDriver` records, so the two drivers can adjudicate each other's identities.
  - Opt-in for now: `new ProcessSupervisor(domain, new ReaperPlatformDriver())`. `ReaperPlatformDriver.isAvailable()` reports whether this platform's binary ships in the package; the constructor throws instead of silently using another driver. The package carries prebuilt helpers for linux-x64, linux-arm64 (static) and darwin-arm64, darwin-x64; `node scripts/build-native.mjs` builds one locally and `XIOFLOW_REAPER_PATH` overrides the location.
- **MCP server** (`xioflow mcp`, `KernelMcpServer`). The kernel is served over stdio JSON-RPC with zero dependencies and interoperates with the official MCP SDK client (protocol 2025-11-25 down to 2024-11-05). The server recovers the domain before serving.
  - Tools: `run_command`, `operation_status`, `cancel_operation`, `snapshot_workspace`, `rollback_workspace`, `begin_transaction`, `commit_transaction` and `abort_transaction`.
  - Each tool call is its own Run, so one indeterminate call does not end the session.
  - Progress tokens stream output, and `notifications/cancelled` runs the stop pipeline.
- **OpenTelemetry export** (`journalToOtlpTraces`, `exportJournalToOtlp`, `xioflow otel-export`, `xioflow mcp --otlp-endpoint`). Settled operations and workspace transactions become OTLP/HTTP JSON spans with deterministic ids, exported incrementally from a journal cursor. A failed export throws and leaves the cursor in place.
- **Workspace transactions for parallel agents** (`supervisor.beginWorkspaceTransaction` / `inspectWorkspaceTransaction` / `commitWorkspaceTransaction` / `abortWorkspaceTransaction`, ARCHITECTURE §3.9). Each agent works in its own fork of a base snapshot. At commit, the transaction's write set (per-file tree diff) and read set are validated against transactions that committed since it began and against writes that bypassed transactions. It is applied to the workspace only if there is no `write_write`, `read_write` or `external_write` conflict. The read set is observed without privileges through access times, and the result reports `readTracking: 'unobserved'` on `noatime` filesystems. Commits journal `TX_COMMITTING` before applying, so an interrupted commit finishes when retried after a restart. `GitShadowSnapshotDriver.diffTrees()` is public.
- **Crash-point fault injection and a TLA+ model of the recovery protocol** (ARCHITECTURE §7.3). `tests/fault/crash-matrix.test.ts` SIGKILLs the supervising process before and after every store commit and while the process runs, then recovers in a fresh process and checks six invariants plus replay-without-re-execution, for both drivers. `spec/tla/OperationRecovery.tla` is model-checked in CI (`pnpm check:tla`). Crashpoints are compiled in but inert unless `XIOFLOW_TEST_CRASHPOINT` or `XIOFLOW_TEST_CRASHPOINT_TRACE` is set; never set them outside tests, since reaching the named point kills the process.
### Changed
- `StopProcessResult.scope` adds `'subreaper_tree' | 'tracked_tree'`, and `PlatformCapabilities.descendantEnumeration` adds `'subreaper'`. Exhaustive `switch` statements over these unions need the new members.
- Contract suite items 10 and 19 (ARCHITECTURE §7.2 #9, #11) check that a stop verdict matches the facts instead of assuming an escaped `setsid` process can never be stopped: `confirmed_stopped` now also requires the escapee to be gone, and `cannot_determine` still requires it in `residualPids` with the lease kept. Drivers that already passed keep passing.

## [0.4.0] - 2026-09-29

### Added
- **`supervisor.pruneSnapshots(ids)`**: removes a snapshot's private ref and store record and journals `SNAPSHOT_PRUNED`, so hosts can apply a retention policy (for example keep only the session baseline and the current turn) instead of accumulating `refs/xioflow/snapshots/*` forever. Unknown ids are skipped; a driver failure throws and keeps the record for a retry.
- **Long-Running Service Supervision (`supervisor.startService`, ARCHITECTURE §3.8, Contracts #50–#52)**:
  - Added `ServiceSupervisor` managing long-running service processes (e.g. MCP stdio servers, dev servers).
  - Each service instance is a managed kernel operation (`opId = <serviceId>#<instanceIndex>`) registered in SQLite store with `kind: 'service'`.
  - Passthrough stdout: caller directly consumes streaming output without accumulating unbounded Head+Tail in kernel memory.
  - Bounded stderr drain & spill (B3): retains Head+Tail in memory, and spills complete stderr to disk (`artifacts/<opId>.stderr.log`) when `artifactsDir` is provided.
  - Readiness probe: supports `'spawned'` (ready on spawn) and `{ stdoutLine: RegExp, timeoutMs }` (matches pattern, unhooks listener upon readiness).
  - Declarative restart policy: supports `'never'` and `{ policy: 'on-failure', maxRestarts, backoffMs }`.
  - Service-level resource lease retention: during restart backoff intervals, leases remain locked under `service:<serviceId>` to prevent concurrent preemption.
- **Continuous Bidirectional stdio Streaming (`stdinMode: 'stream'`)**:
  - `StructuredCommand.stdinMode` supports `'stream'`, keeping the `stdin` pipe open for continuous interactive writing instead of closing on first write.
- **Service Lifecycle Journal Events**:
  - Emits `SERVICE_STARTED`, `SERVICE_READY`, `SERVICE_RESTARTED`, `SERVICE_STOPPED`, and `SERVICE_FAILED` events into journal under epoch fencing.
- **Crash Recovery Service Dimension Aggregation**:
  - `RecoveryEngine.recover()` aggregates affected services into `report.recoveredServices`, cleans up surviving processes, releases `service:<serviceId>` leases, and strictly prevents automatic restarts after host crashes.
- **Model Context Protocol (MCP) Stdio Transport Example (`examples/mcp-stdio-transport`)**:
  - Demonstrates `KernelStdioTransport` implementing official `@modelcontextprotocol/sdk` `Transport` interface on top of `@xioflow/kernel`.
  - End-to-end verified with official MCP Client and Server: runs `initialize`, `tools/list`, and `tools/call`, closing with verified 0 orphan processes leaked in OS.
- **Workspace Snapshot, Rollback and Fork (`GitShadowSnapshotDriver`, ARCHITECTURE §3.5, Contracts #28–#32, #53, #54)**:
  - `supervisor.captureSnapshot({ runId, opId, roots })` records a snapshot as a managed operation. The driver writes the tree through a private `GIT_INDEX_FILE` and pins it under `refs/xioflow/snapshots/<id>`, so the user's index, HEAD and branch are untouched and `git gc` cannot collect it. `SnapshotRef.journalSeq` ties each snapshot to its journal position.
  - `supervisor.rollback({ runId, opId, snapshotId })` restores the declared roots, verifies the result by fingerprint and reports `restored | partial | failed` together with `coverage` and `outOfScopeEffects`. Ignored files (`.env`, `node_modules`) are never touched unless the snapshot was taken with `includeIgnored: true`. A crash mid-rollback is adjudicated by fingerprint on recovery.
  - `supervisor.materialize(snapshotId, newRoot)` / `dematerialize(newRoot)` fork a snapshot into an independent `git worktree` for parallel candidates.
- **Capabilities (`domain.issueCapability` / `attenuate` / `revokeCapability`, Contract #55)**:
  - A capability binds writable roots and exclusive resources to an issuer, an expiry and the domain epoch. Attenuation can only narrow the scope; revocation, expiry or an epoch change cascade to children. Admission rejects out-of-scope resources and paths with `CapabilityViolationError` and journals `CAPABILITY_REJECTED` / `CAPABILITY_USED`.
- **Write Confinement Drivers (`confinement` option, Contract #56)**:
  - `sandbox-exec` (macOS), `bubblewrap` (Linux) and `srt` wrap a command so it can only write inside its capability's roots. Results carry `confined` / `confinementDriver`; rollback reports `coverage: 'complete'` only when every operation since the snapshot ran confined. Confinement exists for rollback correctness and is not a security boundary.
- **Shared Contract Suite Expansion (32 -> 44 items)**:
  - Promoted contracts #50–#52 (services) and #28–#32, #53–#56 (snapshot, rollback, fork, capability, confinement) into `@xioflow/kernel/testing`.
### Changed
- `GitShadowSnapshotDriver.restore` only rewrites paths that differ from the snapshot. It used to `checkout-index -f` every file under the roots, so rolling back a repository root rewrote the whole tree and bumped every mtime (file watchers and incremental builds treated it as a full change).
- `DuplicateOperationError` stays exported as the base class of `OperationIdConflictError` for one more minor; its removal moves to 0.5.0.
- `SnapshotDriver.fingerprint(roots, { against })`: rollback verification now fingerprints the roots on top of the snapshot's own tree and with the snapshot's coverage, so HEAD moving or files changing outside the roots no longer make a correct rollback report `failed`, and `full_tree` snapshots can verify at all.
- `SnapshotDriver.prune(ids, { repoRoot })` is part of the interface; the git-shadow driver throws when it cannot locate the repository instead of silently keeping the ref.
- `quickRun` no longer swallows errors from converging the Run it created (for example when the owner was fenced); the error reaches the caller instead of leaving the Run stuck at `running`.
### Fixed
- **An unrelated waiter blocked every non-waiting request.** `allocateResourcesWithWait` refused any request with `maxWaitMs <= 0` while the wait queue was non-empty, even one that asked for no resources or for resources nobody was waiting on, and reported it as `domain:resource` held by `unknown`. FIFO fairness now applies only to requests that overlap a queued waiter's resources (the rule `processWaitQueue` already used), and a conflict with a queued waiter names that waiter.
- **Recovery isolated a crashed owner's operation as indeterminate when its leader exited during verification.** `verifyIdentity` saw the pid alive, then could not read its creation time because the process had been reaped in between, and answered `cannot_determine`; the operation kept its lease until a human adjudicated it. An unreadable creation time now re-checks liveness first: a process that is gone is `not_original_process`, and recovery continues with the process-group evidence checks.
- **`SERVICE_STARTED` wrote the service's env values, argument values and stdin into the journal** (credential exposure on disk). MCP servers commonly receive tokens that way. The journal now records only `execPath`, `cwd`, the argument count, the env key names and whether stdin was set; `inputFingerprint` still identifies the exact command.
- **Rollback overwrote uncommitted work outside the snapshot roots** (data loss). `GitShadowSnapshotDriver.restore` ran `checkout-index -a`, which rewrote every file in the repository to its HEAD version while reporting `unrestoredPaths: []`. Restore, deletion and fingerprinting are now limited to the declared roots, and paths are read with `-z` so non-ASCII file names are handled.
- **False `succeeded` when an unobserved escaped process kept the output pipes open**. If the driver confirmed the process group stopped but stdout/stderr never closed, the result was `succeeded` with `residualProcessesReaped: true`. It is now `indeterminate` and the leases are kept. This was the macOS / Node 22.13 CI failure.
- **Service readiness timeout leaked the process**: the service was marked `failed` before calling the stop pipeline, which then returned early, so the process kept running and `stop()` never resolved. The timeout now stops the instance and journals `SERVICE_FAILED { reason: 'readiness_timeout' }`.
- **Service stop released leases without a confirmed stop**: a driver `terminate` error was swallowed and leases were released once the root exited. Stops that cannot be confirmed now record the instance as `indeterminate`, journal `SERVICE_FAILED { reason: 'stop_unconfirmed' }` and keep the service leases. Instance results no longer hard-code `durationMs: 0` and `identityVerification: 'is_original_process'`, and an instance stopped through `stop()` is recorded as `cancelled` (`terminationReason: 'user_cancelled'`) instead of `failed`.
- **Adjudication could confirm a stop while the process was alive**: `kill(pid, 0)` failing with `EPERM` was treated as "dead", and a failed group-evidence scan was ignored. `EPERM` now counts as alive and a failed scan rejects `confirmed_stopped`.
- `GitShadowSnapshotDriver` works after a host restart: `dematerialize` locates the repository from the worktree itself instead of assuming the parent directory is the repository.
- `maxTreeSizeBytes` is no longer skipped silently when the tree size cannot be measured.
- Schema migrations only add missing columns and no longer swallow unrelated `ALTER TABLE` failures.
- A failed snapshot whose failure record could not be persisted now reports both errors.
- **Cross-restart identity accepted an unrelated process with the same executable** (ARCHITECTURE §4.1.1). `verifyIdentity` treated "command line contains `execPath`" plus a host-clock `spawnTime` within ±3 s as proof, so a reused PID running another `node` could be reported `is_original_process` and stopped by recovery. The driver now reads the OS creation time at spawn and records it as `ProcessIdentity.osStartTime`; cross-restart verification compares only that value (exact match ⇒ original, mismatch ⇒ not original, missing or unreadable ⇒ `cannot_determine`). `spawnTime` is display-only, and recovery's PGID-reuse check uses `osStartTime` as its lower bound when present.
- `commandFingerprint` is now `sha256(JSON.stringify([execPath, ...args]))` instead of a readable `execPath:args` string, and is an audit fact only (shebang scripts change the OS-visible argv, so it cannot prove or disprove identity).
- The driver no longer fabricates `exitCode: 1` when the child emits `'error'` after spawn. That event does not mean the process exited; exit facts now come only from the real `exit` / `close`.

## [0.3.0] - 2026-09-26

### Added
- **Operation Idempotency Protocol & Adjudication Table (ARCHITECTURE §3.7, Contracts #45–#49)**:
  - `supervisor.executeProcess` now implements the canonical §3.7 idempotency matrix:
    - **In-flight join (`mode: 'joined'`)**: Concurrent submissions with identical `opId` and fingerprint share the active execution promise and receive subsequent stream chunks without spawning a second child process.
    - **Cancellation isolation**: In-flight joining callers can abort their own waiting `AbortSignal` without affecting the underlying process or the original caller.
    - **Terminal recorded replay (`mode: 'recorded'`)**: Completed operations return existing facts with `replayed: true` and the original `runId`.
    - **Indeterminate replay prevention (`mode: 'indeterminate'`)**: Indeterminate operations return `IndeterminateResult` as-is, never auto-retrying and preserving resource leases.
    - **Fingerprint conflict**: Differing input fingerprints for the same `opId` throw `OperationIdConflictError`, leaving existing facts intact.
    - **Crash guard**: Unfinalized operations in database absent from memory throw `RecoveryRequiredError`, requiring recovery before replay.
    - **Domain-wide across Runs (D17)**: `opId` is unique across the entire execution domain, allowing durable engines to resume across new Runs while referencing original facts.
- **`OPERATION_REPLAYED` Journal Event**:
  - Written under epoch fencing upon every idempotency hit, recording `opId`, `runId`, `originalRunId`, and `mode` for tamper-proof audit trails.
- **`quickRun(command, opts)` One-Line Supervised Execution Entrypoint**:
  - Automatically manages execution domain lifecycle, assigns Task and Run, and runs commands under kernel supervision in a single function call.
  - Supports optional `opts.opId` for out-of-the-box idempotency.
- **`domain.status` & `domain.getStatus()` State Observability**:
  - Exposes runtime snapshot of the domain: owner, epoch, tasks, runs, active operations, held leases, and unadjudicated indeterminate operations without raw database access.
- **New Error Types & Backward Compatibility**:
  - Added `OperationIdConflictError` and `RecoveryRequiredError`.
  - Deprecated `DuplicateOperationError`: retained as a backwards-compatible alias (subclassed by `OperationIdConflictError`) until 0.4.0.
- **Adoption Kit & Production Examples (`examples/`)**:
  - `examples/replace-subprocess-wrapper`: Demonstrates 0 orphan leaks, bounded Head+Tail output preservation, and disk spill versus native `spawn + timeout`.
  - `examples/temporal-activity`: Integration with Temporal TypeScript SDK simulating worker crashes (`kill -9`) and proving activity retries execute side effects at most once.
  - `examples/langgraph-node`: Integration with LangGraph checkpoint persistence proving resumed graph nodes replay from journal without duplicate tool side effects.
- **Shared Contract Suite Expansion (27 -> 32 items)**:
  - Promoted contracts #45, #46, #47, #48, and #49 into `@xioflow/kernel/testing`.
- **English Specification**:
  - Added `ARCHITECTURE.en.md` covering §0 (North Star & Decisions 1–9), §3 (Core Execution Protocols §3.1–§3.8), and §7 (Conformance Suite & Contracts #1–#56).

### Changed
- `package.json` files field strictly encapsulates distribution bundle (`files: ["dist", "README.md", "LICENSE"]`), preventing example projects or dev assets from leaking into published tarballs.

## [0.2.0] - 2026-09-26

### Added
- **Output spill honesty & `spillError`** (Contract #4, #5, P0-9): `ProcessOperationResult` and journal events now carry `spillError`, `stdoutSpillError`, and `stderrSpillError`. Failures in artifact directory creation or file open/write/sync/close immediately stop the chain, omit `outputRef`/`outputHash`, and prevent false artifact claims. Output hashing is strictly co-chained with successful disk writes.
- **Head + Tail bounded memory & UTF-8 safe boundary truncation** (Contract #3, P0-10): Memory output retains both Head (75%) and Tail ring buffer (25%) with safe UTF-8 character boundary trimming and explicit `[... truncated N bytes ...]` markers, preventing malformed UTF-8 codepoints.
- **Canonical `inputFingerprint` & zero plaintext command leak** (ARCHITECTURE §2, P0-12): `computeInputFingerprint()` computes SHA-256 over normalized JSON of `execPath`, `args`, `cwd`, sorted `envWhiteList`, `inheritEnv`, `sha256(stdin)`, sorted `requiredResources`, `timeoutMs`, and `resourceBudget`, eliminating command and environment value leaks in journal events.
- **Artifact lifecycle & `domain.pruneArtifacts`** (Contract #44, N7): Non-truncated, unreferenced spill logs are automatically cleaned upon operation finalization. `domain.pruneArtifacts()` collects unreferenced artifacts belonging exclusively to completed (`done`) operations, strictly rejecting artifacts belonging to in-flight or `indeterminate` operations.
- **`DuplicateOperationError`** (Contract #40, N8): `supervisor.executeProcess` now explicitly rejects in-flight or finalized duplicate `opId` submissions, preserving original lease ownership, conflict diagnostic integrity, and cancellability.
- **Process fact verification & safe group cleanup** (Contract #42, N2, N5): Added `readBootId()` and `readStartTime(pid)` in `process-facts.ts`. Recovery verifies system boot ID and group process start times before termination; ESRCH during group signal delivery treats group as empty without falling back to single PID kills.
- **Orphan window protection** (N4): Traps errors occurring between driver spawn and active state registration; automatically terminates spawned processes with bounded grace period and honest final status recording (`failed` or `indeterminate`), retaining leases if unconfirmed.
- **Independent concurrency accounting & FIFO wait queue** (P0-5, P0-13): `domainBudget.maxConcurrentOps` is strictly decoupled from resource leases; waiting requesters are queued in FIFO order with direct wakeups and timeout diagnostics.
- **Run status convergence on crash recovery** (P0-6): Recovery engine converges Runs with no remaining active operations to `failed` (`crash_detected`) or `indeterminate` and emits `RUN_STATUS_TRANSITION` events.
- **`domain.reportRunCancelled()`** (Contract #43, D22): Embedders can explicitly cancel running runs under epoch fencing, recording `RUN_STATUS_TRANSITION` events in the journal and rejecting registrations on finalized runs.
- **Adjudication protocol & audited resource release** (P0-7, N6): Removed public `releaseResources` from `ExecutionDomain`; all releases require epoch fencing and write `RESOURCES_RELEASED` journal events. Added `domain.adjudicate()` as the audited single exit point for `indeterminate` operations with live process verification.
- **`OperationNotActiveError`** (Contract #12, P0-4): `supervisor.cancelOperation` now explicitly rejects attempts to cancel operations that do not exist (`not_found`), have already completed (`already_completed`), or belong to an already closed `ExecutionDomain` (`domain_closed`).
- **`evidence` field** (N1 / PRD Decision 2): `ProcessOperationResult.evidence` (`'observed' | 'unobserved'`) indicates whether exit facts were directly observed via process streams or reconstructed post-mortem.
- **Run immutability guards** (N3): `SqliteStore` now strictly guards finalized Runs (`succeeded`, `failed`, `cancelled`, `indeterminate`), rejecting illegal status transitions and preventing new operation intent registrations on finished runs.

- **Gated spawn via file descriptor pipe (Contract #24, P0-3)**: POSIX environments use controlled springboard launch via `/bin/sh` and FD 3 (`gatedSpawn: true`), preventing child processes from executing payloads until intent is active. Abort before release destroys the gate pipe and terminates the child with exit code 125 with zero payload execution.
- **ProcessSampler asynchronous polling & zero synchronous process calls on hot paths (P0-8)**: Replaced per-operation synchronous `ps -A` calls with domain-level asynchronous ticker (`ProcessSampler`). All process tree walks, zombie detection, identity checks, and descendant scans read from periodic asynchronously updated snapshots, driving hot-path synchronous sub-process executions down to strictly 0.
- **Accurate OS start time and boot ID identity verification (Contract #23, P0-1)**: Replaced superficial `execPath` string matching with OS process start times and kernel `bootId` checks (`readBootId`, `readStartTime`), preventing cross-reboot PID reuse and false killings of unrelated node processes. Capability field `startTimeSource` reflects exact platform timing provider.
- **Internal `fence()` generation check & lock rollback (P0-11)**: SQLite store now enforces internal `fence()` generations on state transitions without relying on test helpers. `ExecutionDomain.acquire` immediately rolls back file descriptors and lock files if initialization fails, and lock contention checks incorporate owner lease expiry timestamps (`expires_at`).
- **Tri-state process stop results (ARCHITECTURE §4.1)**: Converged `StopProcessResult.stopped` from a naive boolean to explicit `StopProcessStatus = 'confirmed_stopped' | 'not_stopped' | 'cannot_determine'`. Indeterminate stops preserve locks and transition operations cleanly to `indeterminate`.
- **Expanded shared contract suite (18 items -> 27 items)**: Promoted contracts #11 (bounded timeout with pipe escape), #12 (`OperationNotActiveError`), #22 (zombie leader + orphan recovery, P0-14), #40 (`DuplicateOperationError`), #25 (run convergence), #26 (audited adjudication), #3 (Head+Tail memory buffer), #5 (`spillError` visibility), and #44 (untruncated spill cleanup) into `@xioflow/kernel/testing`.

### Changed
- **`PlatformCapabilities`**: Replaced `accurateStartTime: boolean` with `startTimeSource: 'procfs' | 'libproc' | 'ps_lstart' | 'none'`, and added `gatedSpawn: boolean`.
- **`StopProcessResult`**: `stopped` field changed from `boolean` to `status: StopProcessStatus` (`'confirmed_stopped' | 'not_stopped' | 'cannot_determine'`).
- **Resource release privatization (N6)**: Leases can no longer be released arbitrarily from the public API; only internal kernel components (supervisor finalize, recovery, adjudication) may trigger releases, all protected by epoch fencing.
- **Single Writer for operation completion (N1)**: `executeProcess` is now the single writer for operation results and journal events (`OPERATION_RESULT_RECORDED` occurs exactly once per operation). Intermediate stops no longer write coarse/fabricated `SIGKILL` or `137` results to the journal.
- **Run status decoupling (N3)**: A single operation timeout or cancellation no longer marks the parent Run as `failed` or `cancelled`. The parent Run remains `running` until explicitly concluded by the embedder or marked `indeterminate` upon unconfirmed stop.
- **Bounded timeout under pipe-holding descendants (Contract #11, P0-2)**: Timeout branches now await root process termination facts (`onRootExit`) bounded by an upper limit, ensuring deterministic return times within `timeoutMs + graceMs + drainTimeoutMs` rather than hanging indefinitely on escaped descendants.
- `ARCHITECTURE.md` now describes the target design (Rust core, embedded and daemon modes, snapshot/rollback, adjudication, a 39-item conformance list). Sections that 0.1.x does not implement yet are marked as target state.
- `ROADMAP.md` added: the phased plan, the known 0.1.x correctness gaps (P0-1 … P0-14) and a spec-vs-implementation table.

### Fixed
- **Crash recovery no longer mistakes a zombie leader for a live process.** After a SIGKILLed owner, the leader sits in the process table as a zombie whose command reads `<defunct>`. Identity verification treated that as "alive", then failed the command-line fingerprint check and reported `cannot_determine` — so a determined crash was parked as `isolated_indeterminate`, the resource lease stayed held, and the Run stayed `running` forever while the owner's descendants kept running.
- **Orphaned process groups are reaped during recovery.** "The leader is dead" is not "the group is empty": descendants the crashed owner had forked can still be running with no owner left. Recovery now calls the driver's new `terminateGroup(pgid, graceMs)` and only reports `marked_dead` once the group is confirmed empty; if it cannot confirm, it still isolates honestly with the residual PIDs.

### Added
- `PlatformDriver.terminateGroup?(pgid, graceMs)` for targeted cleanup of a group whose owner is gone. Platforms without process-group semantics may omit it, in which case recovery isolates instead of claiming a clean kill.
- `pgid` and `commandFingerprint` are persisted with the process identity, so recovery has the group id it needs after a restart.
- Kernel test suite: adds the zombie-leader-with-orphan recovery case. The shared contract suite at `@xioflow/kernel/testing` stays at 18 items; promoting this case into it is tracked in `ROADMAP.md` (P0-14).

## [0.1.4] - 2026-09-20

### Added
- `onStreamChunk(stream, chunk)` on `executeProcess` forwards raw stdout/stderr chunks while the process runs, so an embedding runtime can render live output.
- `streamCallbackError` records the first error thrown by that callback. A throwing consumer callback never aborts the drain or loses captured output.

### Changed
- Shared contract suite: 18 items. Embedder smoke checks: 11.

## [0.1.3] - 2026-09-20

### Added
- `spawnFailure` carries the underlying error message when the executable could not be started, so "the binary never ran" is distinguishable from "the child exited 127".

## [0.1.2] - 2026-09-20

### Fixed
- A root process that exits while a descendant still holds its pipes no longer blocks the operation until its timeout. The supervisor reaps the process group and reports the root's real exit facts with `residualProcessesReaped: true`.
- Self-triggered stops (timeout, memory/CPU/PID/output budget) now record the real exit code, output and duration instead of the coarse pipeline record. An unconfirmable stop still stays `indeterminate` and keeps its leases.

### Added
- `ManagedProcessHandle.onRootExit` exposes the root process's real exit independent of pipe closure.

## [0.1.1] - 2026-09-20

### Added
- `StructuredCommand.stdin` (`string | Uint8Array`) writes a one-shot stdin pipe and closes it after the write. A child that exits without reading it is an ordinary exit, not a spawn failure.

## [0.1.0] - 2026-09-20

### Added
- First public release: `ExecutionDomain` ownership (lock file + heartbeat lease + epoch fencing), SQLite store with WAL and `synchronous = FULL`, intent-first spawn protocol, confirmed stop pipeline, bounded output with per-stream truncation and spill artifacts, `RecoveryEngine`, and the shared contract suite at `@xioflow/kernel/testing`.
- Exact environment semantics: `envWhiteList` is used verbatim (no injected `PATH`); `inheritEnv: false` yields an empty environment.
