# @xioflow/kernel

[![CI](https://github.com/Xio-Shark/xioflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xioflow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xioflow/kernel.svg)](https://www.npmjs.com/package/@xioflow/kernel)
[![Node](https://img.shields.io/badge/Node.js-22.5%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/spec-ARCHITECTURE.md-informational.svg)](./ARCHITECTURE.md)

A supervised execution kernel for AI agent runtimes. Zero runtime dependencies.

Agent runtimes usually call `spawn()` (or `exec()`) and hope for the best. When the host crashes mid-tool-call, or a cancel cannot be confirmed, they are left with orphan processes, double-applied side effects, and no honest record of what actually happened. This kernel makes those states first-class instead of silent.

[xiocode](https://github.com/Xio-Shark/xiocode), the reference distribution, runs its supervised commands on this kernel by default on Node 22.5+ — the equivalence suite below is what made that switch safe to make.

## Guarantees

| Guarantee | Mechanism |
| --- | --- |
| No fake running | Admission check, then the operation intent is persisted to SQLite, then the process is spawned. A spawn that fails is recorded as `failed` (exit code 127); it never appears as `running`. |
| No blind replay | An operation whose outcome cannot be determined is recorded as `indeterminate`, keeps its exclusive leases, and is never auto-retried on restart. |
| No premature release | Exclusive resource leases are released only after the platform driver confirms the process is gone. An unconfirmed stop keeps the lease and escalates to `indeterminate`. |
| No silent output loss | In-memory output is capped by `maxOutputBytes` (default 10 MiB); each stream is spilled to `<domain>/artifacts/<opId>-stdout.log` / `-stderr.log`, `fsync`ed, and hashed. Truncation is reported per stream (`stdoutTruncated` / `stderrTruncated`) with `stdoutRef` / `stderrRef`, `stdoutBytes` / `stderrBytes` and `stdoutHash` / `stderrHash`; `isTruncated` / `outputRef` / `outputHash` remain as aggregate compatibility fields. |
| No implicit environment | `envWhiteList` is exact: whatever you pass is what the child gets, with no injected `PATH`. Without a whitelist the child inherits `process.env`, unless you pass `inheritEnv: false` to get an empty environment. |
| No orphan leak | Termination escalates SIGINT to SIGTERM to SIGKILL across the process group, then re-enumerates descendants. Escaped (`setsid`) survivors are reported honestly as `{ stopped: false, residualPids: [...] }` instead of a fake success. |
| No split brain | A domain has one active owner, held by an exclusive lock file plus a heartbeat lease. Stale owners are fenced by an epoch counter; their writes are rejected. |

## Requirements

- Node.js >= 22.5 (`node:sqlite`). Verified on Node v24.14.0. `node:sqlite` is still marked experimental upstream, so Node prints an `ExperimentalWarning`; that is expected.
- Linux and macOS. Descendant enumeration and group termination use `ps(1)` and POSIX process groups.
- Windows is not supported in 0.1. There the driver reports `processGroupKill: false` and `descendantEnumeration: 'none'` rather than pretending it can contain processes.

## Install

```bash
npm install @xioflow/kernel
```

## Quickstart

```js
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } from '@xioflow/kernel';

// The domain directory will hold domain.db, domain.lock and artifacts/.
const domain = ExecutionDomain.acquire('/path/to/workspace/.xioflow/kernel', 'my-domain');
const supervisor = new ProcessSupervisor(domain, new NodePlatformDriver());

// Every operation belongs to a Run, and every Run to a Task. Register them first:
const store = domain.getStore();
store.saveTask({
  id: 'task-1',
  domainId: domain.domainId,
  name: 'fix failing tests',
  createdAt: new Date().toISOString(),
});
store.saveRun({
  id: 'run-1',
  taskId: 'task-1',
  domainId: domain.domainId,
  owner: 'my-agent-session',
  status: 'running',
  startedAt: new Date().toISOString(),
});

const result = await supervisor.executeProcess({
  runId: 'run-1',
  opId: 'op-1',
  name: 'npm test',
  command: { execPath: 'npm', args: ['test'], cwd: '/path/to/workspace' },
  requiredResources: ['workspace:write:/path/to/workspace'],
  timeoutMs: 120_000,
});

console.log(result.status, result.exitCode, result.isTruncated, result.outputRef);

domain.close(); // releases the owner lease and the domain lock
```

`requiredResources` are arbitrary exclusive lease IDs. Two operations requesting the same ID never run concurrently: the second one waits up to `waitTimeoutMs`, or fails with a `ResourceConflictError` naming the current holder.

`StructuredCommand` fields decide the child's I/O and environment explicitly:

| Field | Behavior |
| --- | --- |
| `args` | argv, never wrapped in a shell |
| `stdin` | `string \| Uint8Array`, written to a one-shot stdin pipe that is closed right after; a child that exits without reading it is an ordinary exit, not a spawn failure |
| `envWhiteList` | exact environment, nothing injected (no implicit `PATH`) |
| `inheritEnv` | only when no whitelist is given; `false` yields an empty environment |

To cancel, call `await supervisor.cancelOperation('op-1', graceMs)`. It returns `{ stopped, scope, residualPids? }`. The pending `executeProcess` promise then resolves with `status: 'cancelled'`, or with `status: 'indeterminate'` when the driver cannot confirm that the process actually stopped, in which case its leases stay locked.

## Crash recovery

After a restart, reacquire the domain and run the recovery engine:

```js
import { ExecutionDomain, NodePlatformDriver, RecoveryEngine } from '@xioflow/kernel';

const domain = ExecutionDomain.acquire('/path/to/workspace/.xioflow/kernel', 'my-domain');
const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
```

For every unfinished operation, recovery verifies the recorded process identity against the OS:

| Observed state | Action | Leases |
| --- | --- | --- |
| Intent persisted, never spawned | cleaned up as failed | released |
| Process confirmed dead | marked dead as failed | released |
| Process alive and identity confirmed | stopped through the stop pipeline | released |
| Identity cannot be determined | left `indeterminate` | retained, manual decision required |

The kernel records execution facts (state, output evidence, artifact references) and refuses to guess. Whether a failed test that was later fixed counts as business success is the distribution's decision, not the kernel's.

## Design notes

### Verify your own runtime

The package ships the same 18-item contract suite that the kernel itself is tested against, so an embedding runtime can prove its consumer honors these guarantees:

```js
import { defineContractTestSuite } from '@xioflow/kernel/testing';

defineContractTestSuite('My Agent Runtime', async () => ({
  domain,
  driver,
  supervisor,
  tempDir,
  workflowType: 'memory', // or 'headless' | 'three_piece'
  cleanup: async () => domain.close(),
}));
```

`vitest` is an optional peer dependency, and the subpath is only loaded if you import it.

- Persistence is SQLite with WAL and `synchronous = FULL`, so committed facts survive power loss.
- One execution domain is one workspace-scoped store plus one active owner. Isolation is rebuilt from the store before any new operation is admitted.
- When the root process exits while a descendant still holds its pipes, the supervisor reaps the process group and reports the root's real exit facts with `residualProcessesReaped: true`, instead of blocking the operation until its timeout.
- A spawn failure is reported both as `status: 'failed'`/`exitCode: 127` and as `spawnFailure` with the underlying error message, so embedders can tell "the binary could not start" apart from "the child exited 127".
- `onStreamChunk(stream, chunk)` forwards raw stdout/stderr chunks while the process runs, so a caller can render live output. A throwing callback never aborts the drain; the first error is recorded as `streamCallbackError`.
- Hard resource requests (`maxMemoryBytes`, `maxPids`, `maxCpuTimeMs` with `enforcement: 'hard'`) are rejected at admission with `UnsupportedCapabilityError` on platforms that cannot enforce them, instead of degrading silently. The remaining capability flags are reported truthfully for callers to inspect, but are not enforced by admission in 0.1.
- Protocol specification: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (Chinese). It describes the target design; the phased plan and the spec-vs-implementation gap table live in [`ROADMAP.md`](./ROADMAP.md).

## Status

0.1.5, pre-1.0: the API may change. Not implemented yet: Linux cgroup v2 backend (hard memory/CPU/PID enforcement), enforced domain-wide memory budgets, artifact retrieval helpers. Known correctness gaps in 0.1.x and the plan toward a Rust core with snapshot/rollback and a daemon mode are tracked in [`ROADMAP.md`](./ROADMAP.md).

## Releasing

Releases are tag-driven. A tag always produces a GitHub Release; the npm upload is switched on separately, so a tag can never ship an artifact that is not traceable to this repository:

1. Bump `version` in `package.json`, commit, and push to `main`.
2. Push the matching tag, e.g. `git tag v0.1.5 && git push origin v0.1.5`.
3. `.github/workflows/release.yml` re-runs typecheck, tests and the pack smoke test, refuses a tag that does not match `package.json`, creates the GitHub Release with the packed tarball, `SHA256SUMS` and a build provenance attestation attached, and — only when the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED` is `true` — publishes with `npm publish --provenance` and verifies the attestation.

One-time setup, in this order: (1) npmjs.com → package settings → Trusted Publisher → GitHub Actions: organization `Xio-Shark`, repository `xioflow`, workflow filename `release.yml`, environment left empty; (2) set the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`. Until both exist the publish job is skipped and the reason is printed in the `verify` job's log. npm's registry index can lag several minutes behind an upload, so the verification step polls and may need a job re-run.

To attach assets to an existing tag without publishing to npm, run the workflow manually: `gh workflow run release.yml -f tag=v0.1.5`. An asset that is already attached is kept if identical and fails the run if it differs; published assets are never overwritten.

### Verifying a release

```bash
gh release download v0.1.5 --repo Xio-Shark/xioflow
shasum -a 256 -c SHA256SUMS
gh attestation verify xioflow-kernel-0.1.5.tgz --repo Xio-Shark/xioflow
npm audit signatures   # inside a project that installed @xioflow/kernel from npm
```

## License

MIT
