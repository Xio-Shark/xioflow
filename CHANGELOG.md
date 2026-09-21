# Changelog

All notable changes to `@xioflow/kernel`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

> Release note: 0.1.0 – 0.1.4 were uploaded from a local npm bypass-2FA token. From the next tag-based release on, `.github/workflows/release.yml` publishes through npm Trusted Publishing (OIDC) with a provenance attestation, so the published artifact is verifiable back to this repository.

## [Unreleased]

Changes accumulate here while the npm upload is paused. Tag pushes still verify the build and produce a GitHub Release; the registry catches up when `NPM_TRUSTED_PUBLISHING_ENABLED` is set to `true`.

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
