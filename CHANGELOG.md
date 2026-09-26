# Changelog

All notable changes to `@xioflow/kernel`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

> Release note: 0.1.0 – 0.1.4 were uploaded from a local npm bypass-2FA token. From the next tag-based release on, `.github/workflows/release.yml` publishes through npm Trusted Publishing (OIDC) with a provenance attestation, so the published artifact is verifiable back to this repository.

## [Unreleased]

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
