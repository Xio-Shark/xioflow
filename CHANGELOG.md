# Changelog

All notable changes to `@xioflow/kernel`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

> Release note: 0.1.0 – 0.1.4 were uploaded from a local npm bypass-2FA token. From the next tag-based release on, `.github/workflows/release.yml` publishes through npm Trusted Publishing (OIDC) with a provenance attestation, so the published artifact is verifiable back to this repository.

## [Unreleased]

## [0.1.5] - 2026-09-23

First release published by `release.yml` through npm Trusted Publishing (OIDC) with a provenance attestation; no long-lived npm token is involved.

### Changed
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
