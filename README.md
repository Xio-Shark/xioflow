# @xioflow/kernel

[![CI](https://github.com/Xio-Shark/xioflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xioflow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xioflow/kernel.svg)](https://www.npmjs.com/package/@xioflow/kernel)
[![Node](https://img.shields.io/badge/Node.js-22.13%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Docs (EN)](https://img.shields.io/badge/spec-ARCHITECTURE.en.md-informational.svg)](./ARCHITECTURE.en.md)
[![Docs (ZH)](https://img.shields.io/badge/spec-ARCHITECTURE.md-informational.svg)](./ARCHITECTURE.md)

A world-state and execution kernel for AI agents, evolving toward a causally verifiable operating system for shared workspaces. Zero runtime dependencies. See the [vision and staged roadmap](docs/VISION.md) and [Architecture & Protocol Specification (EN)](./ARCHITECTURE.en.md) / [中文规范](./ARCHITECTURE.md).

The experimental `WorkspaceCausalGraph` persists tool-result provenance across agents and workspace transactions, traces dependencies, and plans which dependent steps need recomputation when evidence changes. It builds on existing snapshots, OCC and observation replay. See the [causal graph API and example](docs/causal-graph.md). The experimental [`prepareWorkspaceRepair`](docs/causal-repair.md) executes affected subgraphs in a fresh transaction, remaps causal dependencies, and leaves the result ready for OCC commit; hosts validate reusable evidence and provide tool adapters. The experimental [`speculateWorkspace`](docs/speculative-workspaces.md) runs strategies concurrently in forks of one snapshot, selects the first OCC-valid candidate in priority order, and reclaims the other forks.

For integration, start with the [current implementation contract](spec/current-contract.md).
It separates implemented guarantees, experimental APIs and planned Rust/daemon work.

Agent runtimes usually call `spawn()` (or `exec()`) and hope for the best. When the host crashes mid-tool-call, or a cancel cannot be confirmed, they are left with orphan processes, double-applied side effects, and no honest record of what actually happened. This kernel makes those states first-class instead of silent.

[xiocode](https://github.com/Xio-Shark/xiocode), the reference distribution, runs its supervised commands on this kernel by default — the equivalence suite below is what made that switch safe to make.

Besides one-shot commands, the kernel supervises long-running services (MCP stdio servers, dev servers), makes operations idempotent by `opId` for durable engines (Temporal, LangGraph), and snapshots, rolls back and forks the workspace so an agent's file changes can be undone per step.

The package also includes an **experimental `AgentRuntime`**: kernel-owned agent lifecycle, cooperative scheduling, evidence-gated dispatch and persistent checkpoint/step budgets. Adapters can submit commands through a per-step context; the kernel tracks their ownership and waits for the batch before checkpointing. It accepts existing runner adapters rather than replacing their models or tools. See the [runtime contract](spec/agent-runtime.md) and [recovery experiments](audit/observation/RECOVERY.md). It is experimental: its API may change in any release.

`parentId` defines a fail-fast task scope. Parent completion waits for children without occupying a dispatch slot. `await agents.interrupt(id)` cancels and joins the member's whole root task, including managed commands and reconstruction. It preserves completed checkpoints and spent budgets. Adapter cancellation is cooperative; an adapter that ignores the signal keeps the call pending. See [task scopes](spec/agent-runtime.md#task-scopes).

`runBudget` limits shared steps, lifetime agent creation and outstanding commands. Defaults are 10,000 / 1,024 / 64; limits and spent steps persist across reopening. `getRunUsage(runId)` reports usage. Optional `workspaceVersion(agent)` binds validation to a host-supplied revision at dispatch, but does not lock the workspace during subsequent execution. See [Run budgets](spec/agent-runtime.md#shared-run-admission-budgets) and [version checks](spec/agent-runtime.md#validation-and-workspace-versions).

For host shutdown, use `await agents.shutdown()` before closing the domain. It rejects new work immediately, pauses queued agents, interrupts active quanta, and waits for their commands and active workspace reconstruction before releasing runtime ownership. It does not close the domain or force a non-cooperative adapter to stop. See the [shutdown contract](spec/agent-runtime.md#shutdown-contract).

## Guarantees

Experimental workspace checkpoint recovery requires a nonempty `resultHash` for
every logged step, including edits: an edit that applies can still return changed
information to the agent. Legacy logs missing mutation results are rejected.
See the [recovery contract](spec/agent-runtime.md#recovery-of-edit-histories).

| Guarantee | Mechanism |
| --- | --- |
| No fake running | Admission check, then the operation intent is persisted to SQLite, then the process is spawned. A spawn that fails is recorded as `failed` (exit code 127); it never appears as `running`. |
| No blind replay | An operation whose outcome cannot be determined is recorded as `indeterminate`, keeps its exclusive leases, and is never auto-retried on restart. |
| No premature release | Exclusive resource leases are released only after the platform driver confirms the process is gone. An unconfirmed stop keeps the lease and escalates to `indeterminate`. |
| No silent output loss | In-memory output is capped by `maxOutputBytes` (default 10 MiB); each stream is spilled to `<domain>/artifacts/<opId>-stdout.log` / `-stderr.log`, `fsync`ed, and hashed. Truncation is reported per stream (`stdoutTruncated` / `stderrTruncated`) with `stdoutRef` / `stderrRef`, `stdoutBytes` / `stderrBytes` and `stdoutHash` / `stderrHash`; `isTruncated` / `outputRef` / `outputHash` remain as aggregate compatibility fields. |
| No implicit environment | `envWhiteList` is exact: whatever you pass is what the child gets, with no injected `PATH`. Without a whitelist the child inherits `process.env`, unless you pass `inheritEnv: false` to get an empty environment. |
| No orphan leak | Termination escalates SIGINT to SIGTERM to SIGKILL across the process group, then re-enumerates descendants. Escaped (`setsid`) survivors are reported honestly as `{ stopped: 'cannot_determine', residualPids: [...] }` instead of a fake success. If the group is confirmed empty but the output pipes are still held by a process the driver never saw, the operation is `indeterminate`, not `succeeded`. Drained pipes are not taken as an empty tree either: after the root exits, survivors the driver knows about (including daemonized ones with closed stdio) are reaped, and `treeSettlement` says whether emptiness was proven (`empty`), enforced (`reaped`) or is beyond what the driver can see (`unverified`). |
| No blind retry | Resubmitting an `opId` with the same input fingerprint joins the in-flight execution or replays the recorded result (`replayed: true`); an `indeterminate` result is returned as-is and never re-executed. A different fingerprint throws `OperationIdConflictError`. |
| No out-of-scope rollback | A rollback only rewrites and deletes files inside the snapshot's declared roots, never touches ignored files unless they were captured, and is verified by fingerprint. `coverage: 'complete'` is claimed only when every operation since the snapshot ran under a confinement driver and ignored files are accounted for: they were in the snapshot, or a manifest proves they are unchanged. Otherwise the result says `non_ignored` or `declared_roots`, with the reasons in `coverageBasis`. |
| No split brain | A domain has one active owner, held by an exclusive lock file plus a heartbeat lease. Stale owners are fenced by an epoch counter; their writes are rejected. |

Recovery needs durable launch evidence: a missing process identity proves the
command was not released only when its `intent_registered` record includes
`spawnGated: true`. Non-gated launches and legacy records without that evidence
remain `indeterminate` with leases retained, even if the replacement driver supports
gating. Same-ID submission replays the recorded result; it does not execute again.
See [recovery boundaries and migration](spec/current-contract.md#crash-recovery-and-launch-evidence).

## Requirements

- Node.js >= 22.13 (`node:sqlite` without a flag). CI covers Node 22.13 and 24 on Ubuntu and macOS. `node:sqlite` is still marked experimental upstream, so Node prints an `ExperimentalWarning`; that is expected.
- Linux and macOS. The default driver enumerates descendants with `ps(1)` and terminates POSIX process groups; the optional native reaper holds the whole tree instead, and on Linux the cgroup v2 driver contains it and enforces hard memory and process limits (see [Holding the process tree](#holding-the-process-tree)).
- Snapshots need `git` on `PATH` and a git working tree. Confinement is optional and uses `sandbox-exec` (macOS), `bubblewrap` (Linux) or `srt` when available.
- Windows is not supported. There the driver reports `processGroupKill: false` and `descendantEnumeration: 'none'` rather than pretending it can contain processes.

## Install

```bash
npm install @xioflow/kernel
```

## Quickstart

### 1. Simplest Usage (`quickRun`)

For standard tool calls and durable activity execution, `quickRun` automatically manages domain acquisition, Task and Run records, and lock lifecycles:

```js
import { quickRun } from '@xioflow/kernel';

// 1. One-line supervised execution
const result = await quickRun({
  execPath: 'npm',
  args: ['test'],
  cwd: '/path/to/workspace',
});

console.log(result.status, result.exitCode, result.stdout);

// 2. Idempotent execution (safe retry for Temporal / LangGraph / durable workflows)
const idemResult = await quickRun(
  { execPath: 'git', args: ['commit', '-m', 'chore: update'], cwd: '/path/to/workspace' },
  { opId: 'workflow-step-42' } // Passing opId guarantees at-most-once execution across retries
);
if (idemResult.replayed) {
  console.log('Result retrieved from journal without re-executing process');
}
```

### 2. Full Architecture & Fine-Grained Supervision

When you need granular control over Tasks, Runs, resource locks, streaming output, or multi-phase workflows:

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

> **Note on In-Flight Join and Cancellation**:
> When an in-flight operation with the same `opId` and fingerprint is joined concurrently, passing an `abortSignal` to the secondary caller only cancels the secondary caller's own wait promise—it never aborts the underlying process or the primary caller's execution. To deliberately terminate the underlying process, explicitly call `supervisor.cancelOperation(opId)`.

## Holding the process tree

`NodePlatformDriver` observes a process tree from the outside, so a descendant that calls `setsid()` and loses its parent can outlive a stop; the kernel then reports `indeterminate` instead of lying. `ReaperPlatformDriver` runs each operation under a small native helper (`xioflow-reaper`, shipped prebuilt in the package) that holds the tree:

```js
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '@xioflow/kernel';

const supervisor = new ProcessSupervisor(domain, new ReaperPlatformDriver());
```

| | Linux | macOS |
| --- | --- | --- |
| How the tree is held | child subreaper: orphans are reparented to the helper | kqueue `NOTE_FORK`, session membership, µs start times |
| Stop signals | `pidfd_send_signal` after re-checking the start time | `kill` after re-checking the start time |
| `confirmed_stopped` means | `waitpid` returned `ECHILD` (`scope: 'subreaper_tree'`) | every tracked process is gone (`scope: 'tracked_tree'`) |
| Supervisor process dies | helper stops the whole tree | helper stops the whole tree |

`ReaperPlatformDriver.isAvailable()` tells whether this platform's helper is present; the constructor throws rather than falling back to another driver. Build one from source with `node scripts/build-native.mjs`, or point `XIOFLOW_REAPER_PATH` at a binary.

On Linux, `CgroupPlatformDriver` puts each operation in its own cgroup v2 while the process is still blocked at the spawn gate, so nothing it forks can leave:

```js
import { CgroupPlatformDriver, ProcessSupervisor } from '@xioflow/kernel';

// run the host under: systemd-run --user --scope -p Delegate=yes node host.js
const supervisor = new ProcessSupervisor(domain, new CgroupPlatformDriver());
await supervisor.executeProcess({ /* ... */, resourceBudget: { enforcement: 'hard', maxMemoryBytes: 512 * 2 ** 20, maxPids: 256 } });
```

- `confirmed_stopped` means `cgroup.events` reports `populated 0` (`scope: 'containment_cgroup'`); stops end with `cgroup.kill`.
- `hard` budgets become `memory.max` (no swap; an OOM kill takes the whole tree and ends as `memory_exceeded`) and `pids.max` (a hit stops the tree with `pids_exceeded`).
- The cgroup path is stored with the process identity before the process runs. After a host crash, recovery reaps whatever is left in it, escapees included, before it releases the leases.
- It needs a cgroup delegated to the host; otherwise the constructor throws `CgroupUnavailableError` with the reason (`CgroupPlatformDriver.unavailableReason()` checks without side effects). It moves the processes of that cgroup into a `xioflow-host` leaf, because cgroup v2 only lets a cgroup without processes hand controllers to its children.

## Use it from any agent: MCP server

The package ships a `xioflow` command that serves the kernel over MCP (stdio), so an agent that speaks MCP can run commands under supervision without writing an integration:

```json
{
  "mcpServers": {
    "xioflow": { "command": "npx", "args": ["-y", "@xioflow/kernel", "mcp", "--domain", "/path/to/repo/.xioflow-kernel"] }
  }
}
```

The server acquires the domain and runs crash recovery before it answers anything. It then offers these tools:

- `run_command`: supervised execution; reusing an `opId` replays the recorded result instead of running again.
- `operation_status` and `cancel_operation`.
- `snapshot_workspace` and `rollback_workspace`.
- `begin_transaction`, `commit_transaction` and `abort_transaction`.

Client features map onto kernel semantics:

- A request with a `progressToken` streams stdout/stderr as progress notifications.
- `notifications/cancelled` stops the operation through the stop pipeline.
- A result that is `indeterminate` is presented as "stop and ask a human".

Adjudication is intentionally not exposed to the model. `--driver auto` (the default) uses the native reaper when its helper is present and says which driver it chose in the server instructions and in every result.

## OpenTelemetry

The journal exports as OTLP/HTTP JSON traces, with no dependencies:

- One trace per Run.
- One span per settled operation, with status transitions, replays, capability use and adjudication as span events.
- One span per workspace transaction.
- `indeterminate` and `failed` are `ERROR`.

Ids are derived deterministically, so exporting the same journal twice produces the same spans.

```bash
xioflow mcp --otlp-endpoint http://localhost:4318            # export every 5s while serving
xioflow otel-export --otlp-endpoint http://localhost:4318     # one-shot, read-only, works next to a running server
```

From code: `exportJournalToOtlp(domain, { endpoint, fromSeq })` returns the cursor for the next incremental export; `journalToOtlpTraces(...)` builds the payload without sending it.

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
| Process confirmed dead, exit never observed | `failed` with `terminationReason: 'exit_unobserved'`: the outcome is unknown, so do not retry under a new `opId` | released |
| Process alive and identity confirmed | stopped through the stop pipeline | released |
| Identity cannot be determined | left `indeterminate` | retained, manual decision required |

The kernel records execution facts (state, output evidence, artifact references) and refuses to guess. Whether a failed test that was later fixed counts as business success is the distribution's decision, not the kernel's.

An `indeterminate` operation leaves the kernel only through `domain.adjudicate(opId, verdict, actor, note)`, which re-scans for residual processes, refuses `confirmed_stopped` while any are alive (or while the scan itself fails), and journals the decision before releasing leases.

## Long-running services

MCP stdio servers, dev servers and watchers are supervised as services. Each instance is a kernel operation (`<serviceId>#<n>`), so a host crash leaves a record that recovery can act on:

```js
const service = await supervisor.startService({
  serviceId: 'mcp-fs',
  runId: 'run-1',
  command: { execPath: 'node', args: ['server.mjs'], cwd: '/path/to/workspace' },
  readiness: { stdoutLine: /listening/, timeoutMs: 5000 }, // or 'spawned'
  restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 500 },
  requiredResources: ['port:3000'],
});
await service.ready;          // rejects if the readiness line never appears; the instance is then stopped
service.stdin.write('...');   // stdin stays open (stdinMode: 'stream'); stdout is passed through
await service.stop(2000);
```

Leases are held by the service across restart backoff. A stop the driver cannot confirm records the instance as `indeterminate`, journals `SERVICE_FAILED { reason: 'stop_unconfirmed' }` and keeps the leases. After a host crash, `recover()` stops surviving instances and never restarts them automatically. See [`examples/mcp-stdio-transport`](./examples/mcp-stdio-transport) for an MCP SDK `Transport` on top of this.

## Snapshots, rollback and forks

The git-shadow driver snapshots declared roots without touching the user's index, HEAD or branch, and pins each snapshot under `refs/xioflow/snapshots/<id>`:

```js
const snap = await supervisor.captureSnapshot({ runId: 'run-1', opId: 'snap-1', roots: ['/path/to/workspace/src'] });

// ... the agent edits files ...

const rb = await supervisor.rollback({ runId: 'run-1', opId: 'rb-1', snapshotId: snap.snapshot.id });
console.log(rb.status, rb.coverage, rb.outOfScopeEffects); // e.g. 'restored', 'declared_roots', 'possible'

// Fork the snapshot into an independent worktree for a parallel candidate:
await supervisor.materialize(snap.snapshot.id, '/tmp/candidate-a');
await supervisor.dematerialize('/tmp/candidate-a');
```

Rollback only rewrites and deletes files inside the snapshot's roots and leaves ignored files alone unless the snapshot used `includeIgnored: true`. It is verified by fingerprint against the snapshot tree. `coverage` says how much the rollback vouches for:

| `coverage` | Meaning |
|---|---|
| `complete` | Every operation since the snapshot ran confined, and ignored files inside the roots were restored (`includeIgnored: true`) or proven unchanged by a manifest. |
| `non_ignored` | Every operation ran confined, so nothing outside the roots changed, but ignored files (`.env`, `node_modules`, build output) were not in the snapshot and nothing proves they are unchanged. |
| `declared_roots` | The roots were restored; an unconfined operation may have written elsewhere (`outOfScopeEffects: 'possible'`), or some paths could not be restored (`status: 'partial'`). |
| `none` | Verification failed (`status: 'failed'`). |

`ignoredFiles` (`restored` / `unchanged_verified` / `not_captured` / `unverified`) states what the rollback knows about ignored files, and `coverageBasis` lists the facts behind the claim, for example `['all_ops_confined', 'ignored_not_captured']`.

A default snapshot can still reach `complete` without copying ignored files: `captureSnapshot({ ..., trackIgnored: 'manifest' })` records size, mtime, ctime and mode of every ignored file (about 0.2 s for 20,000 files and 0.45 s for 100,000 on an M-series Mac). At rollback the manifest is compared again; any added, removed or modified ignored file yields `non_ignored` and is listed in `ignoredChanges`. A file whose ctime alone changed is listed under `metadataOnly` and also prevents `complete`, because the kernel cannot prove its content is the same.

With `includeIgnored: true`, ignored files that appeared after the snapshot are kept and listed in `unrestoredPaths` with `status: 'partial'` (a wholly new directory is one entry). Pass `removeNewIgnored: true` to `rollback` to delete them.

To make `complete` reachable, bind operations to a capability and run them confined:

```js
const cap = domain.issueCapability(
  { write: ['/path/to/workspace/src'], exclusive: ['workspace:write:/path/to/workspace/src'] },
  'my-agent-policy',
  10 * 60_000,
);
await supervisor.executeProcess({
  runId: 'run-1',
  opId: 'op-edit',
  name: 'codegen',
  command: { execPath: 'node', args: ['../codegen.mjs'], cwd: '/path/to/workspace/src' },
  // mutation roots default to cwd; pass mutationRoots to declare others
  capabilityId: cap.id,  // out-of-scope resources or paths are rejected at admission
  confinement: true,     // sandbox-exec / bubblewrap / srt, whichever is available
});
```

A capability can be narrowed with `domain.attenuate`, and revoked with `domain.revokeCapability`. Confinement exists so the rollback coverage claim is true. It is not a security boundary.

## Parallel agents: workspace transactions

Locks make parallel agents wait for each other. Workspace transactions let them work at the same time and check for conflicts when they commit, the way optimistic concurrency control works in a database:

```js
const tx = await supervisor.beginWorkspaceTransaction({
  txId: 'agent-a-1',
  runId: 'run-a',
  root: '/path/to/repo',
  forkPath: '/tmp/forks/agent-a-1',
});
// the agent works in its own fork
await supervisor.executeProcess({ runId: 'run-a', opId: 'a-edit', name: 'edit', command: { execPath: 'node', args: ['edit.mjs'], cwd: tx.forkRoot } });

const res = await supervisor.commitWorkspaceTransaction('agent-a-1');
if (res.status === 'conflict') {
  // e.g. [{ path: 'config.json', kind: 'read_write', otherTxId: 'agent-b-7' }]
  await supervisor.abortWorkspaceTransaction('agent-a-1');
}
```

- **Write set**: the exact per-file diff between the base snapshot and the fork.
- **Read set**: observed without privileges through access times. Each entry in the fork gets an atime before its mtime; reads (file contents or directory listings) are detected when atime reaches or exceeds mtime, including equal timestamps within one Linux clock tick. The reset also supports macOS, where APFS only updates an atime that is older than mtime. A probe compares atime before and after an actual read; on a `noatime` filesystem the result says `readTracking: 'unobserved'` and `readSet: null`.
- **Validation**: a commit fails with `write_write` if a transaction committed since this one began wrote the same file, and with `read_write` if it changed something this one read. A listed directory only conflicts when entries were added to it or removed from it. A write that bypassed transactions and went straight to the workspace fails with `external_write`.
- **Apply**: only a validated transaction is applied to the workspace. `TX_COMMITTING` is journaled first, so a commit interrupted by a crash finishes when it is called again after restart.
- **Evidence**: a committed result says what "no conflict" rests on: `validation: 'files'` (read and write sets), `'write_only'` (reads could not be observed) or `'observations'` (below).

### Fewer false conflicts: validating what the agent saw

"It read this file" is coarser than what an agent relies on: usually a few lines, or the result of a search. When someone else changes another part of the same file, file-level validation still reports `read_write`. A host that logs the agent's steps can hand the log to the commit:

```js
const res = await supervisor.commitWorkspaceTransaction('agent-a-1', {
  observations: {
    // in order: { kind: 'observe', call, resultHash } for reads and searches, { kind: 'mutate', call } for edits
    // (a mutation whose return value also showed the agent other content carries a resultHash too)
    log,
    closedWorld: true, // the log is everything the agent saw of the fork
    // re-run one step in `root` and return its result hash; throw if a mutation cannot be applied
    replay: async (entry, root) => myTools.run(entry.call, root),
  },
});
// committed: res.validation === 'observations' when the log was what cleared the conflict
// conflict:  res.observation says where the replay first differed, or why it was not tried
```

The kernel uses the log only after file-level validation has reported a conflict. It forks the current workspace, asks the host to replay the steps in order, and commits from that fork when every observation returns the recorded hash and every change still applies. If the workspace was changed again while the replay ran, nothing is applied (`observation.reason: 'workspace_changed'`). It does not try when both sides wrote the same file, and it does not trust `closedWorld` when a process ran inside the fork (`TX_VALIDATION_DOWNGRADED`): a process can read what the log does not show. Whether the log is complete and the hashes are reproducible is the host's responsibility; like file-level validation, this checks that the agent's inputs are unchanged, not that the merged code is correct.

## Evidence with dependencies: is this test result still true?

"Tests passed" is a statement about the files the test run depended on. A host that reuses an earlier result needs to know whether those files are still the same. `trackReads` records what a command read, and `evidenceStatus` answers later:

```js
const res = await supervisor.executeProcess({
  runId, opId: 'verify-1', name: 'pytest',
  command: { execPath: 'pytest', args: ['-q'], cwd: repo },
  trackReads: { roots: [repo] },
});
// ...the agent keeps working...
supervisor.evidenceStatus('verify-1');
// { status: 'fresh', basis: 'tree_unchanged' }        nothing under the roots changed
// { status: 'stale', changed: ['/repo/fixtures/case3.json'], truncated: false }
// { status: 'unknown', reason: 'changed_outside_read_set', changedOutside: ['/repo/src/util.py'], truncated: false }
```

- **What is recorded**: every file under the roots whose content the command read (content hash) and every directory it listed (hash of its entry names), observed through access times as in workspace transactions, plus size and mtime of every file under the roots when the command finished. It works for any command, in any language, without instrumenting it, and it includes non-source inputs (fixtures, JSON, templates) that import-graph tools do not see.
- **`stale`** lists the read files whose content changed and the listed directories whose entries changed.
- **`fresh`** means one of two things, and says which. `tree_unchanged`: nothing under the roots changed at all. `reads_unchanged`: files changed, but none the command read, and the caller declared `trackReads: { roots, statCaches: 'ruled_out' }`.
- **`unknown`** is the answer when files outside the read set changed and stat-validated caches were not ruled out. This is the default, and it matters: a command that finds a valid cache entry only `stat`s the source and never reads it, so the source is not in the read set. Python's bytecode cache is the common case; with it in place, read-set selection missed almost every source change in our measurements, and caught all of them once the cache was pointed at an empty directory (`PYTHONPYCACHEPREFIX`). Only a caller that knows the command runs without such caches should declare `ruled_out`.
- **Not covered**: dependencies outside the roots, environment variables, files read on the command's behalf by a long-running helper process, and writes by someone else while the command was running. `unobserved` filesystems (`noatime`) and a second tracked command on the same root while one is running have no read set; they can still answer `fresh / tree_unchanged`, and `unknown` otherwise.
- **Cost**: the roots are walked once before the command and once after, and read files are hashed. Pass narrow roots for large trees. Resetting access times changes ctime of files that were read since the previous reset, which an ignored-file manifest (`trackIgnored: 'manifest'`) reports as metadata-only changes.

## Design notes

### Verify your own runtime

The package ships the same 53-item contract suite that the kernel itself is tested against, so an embedding runtime can prove its consumer honors these guarantees:

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

Beyond the contracts, the repository kills its own supervisor at every durable step (before and after each store commit, and while the process runs), recovers in a fresh process and checks the invariants again (`tests/fault/crash-matrix.test.ts`), and model-checks the same invariants for every interleaving of launch, stop, crash and recovery with TLA+ (`spec/tla/`, `pnpm check:tla`).

- Persistence is SQLite with WAL and `synchronous = FULL`, so committed facts survive power loss.
- One execution domain is one workspace-scoped store plus one active owner. Isolation is rebuilt from the store before any new operation is admitted.
- When the root process exits while a descendant still holds its pipes, the supervisor reaps the process group and reports the root's real exit facts with `residualProcessesReaped: true`, instead of blocking the operation until its timeout.
- A spawn failure is reported both as `status: 'failed'`/`exitCode: 127` and as `spawnFailure` with the underlying error message, so embedders can tell "the binary could not start" apart from "the child exited 127".
- `onStreamChunk(stream, chunk)` forwards raw stdout/stderr chunks while the process runs, so a caller can render live output. A throwing callback never aborts the drain; the first error is recorded as `streamCallbackError`.
- Hard resource requests (`maxMemoryBytes`, `maxPids`, `maxCpuTimeMs` with `enforcement: 'hard'`) are rejected at admission with `UnsupportedCapabilityError` on platforms that cannot enforce them, instead of degrading silently. The remaining capability flags are reported truthfully for callers to inspect, but are not enforced by admission yet.
- Protocol specification: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (Chinese, complete) and [`ARCHITECTURE.en.md`](./ARCHITECTURE.en.md) (English, §0, §3 and §7). They describe the target design; the phased plan and the spec-vs-implementation gap table live in [`ROADMAP.md`](./ROADMAP.md).

## Status

0.7.0 on npm (Linux cgroup v2 driver with hard memory and process limits, tree settlement after root exit, native tree-holding reaper, workspace transactions validated by file sets or replayed observations, read evidence for results, honest rollback coverage for ignored files, experimental AgentRuntime, MCP server, OpenTelemetry export, crash-point matrix and TLA+ model; see [`CHANGELOG.md`](./CHANGELOG.md)), pre-1.0: the API may change. Not implemented yet: hard CPU limits, enforced domain-wide memory budgets, artifact retrieval helpers, daemon mode and non-TypeScript bindings. Remaining gaps are tracked in [`ROADMAP.md`](./ROADMAP.md).

## Releasing

Releases are tag-driven. A tag always produces a GitHub Release; the npm upload is switched on separately, so a tag can never ship an artifact that is not traceable to this repository:

1. Bump `version` in `package.json`, commit, and push to `main`.
2. Push the matching tag, e.g. `git tag v0.3.0 && git push origin v0.3.0`.
3. `.github/workflows/release.yml` re-runs typecheck, tests and the pack smoke test, refuses a tag that does not match `package.json`, creates the GitHub Release with the packed tarball, `SHA256SUMS` and a build provenance attestation attached, and — only when the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED` is `true` — publishes with `npm publish --provenance` and verifies the attestation.

One-time setup, in this order: (1) npmjs.com → package settings → Trusted Publisher → GitHub Actions: organization `Xio-Shark`, repository `xioflow`, workflow filename `release.yml`, environment left empty; (2) set the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`. Until both exist the publish job is skipped and the reason is printed in the `verify` job's log. npm's registry index can lag several minutes behind an upload, so the verification step polls and may need a job re-run.

To attach assets to an existing tag without publishing to npm, run the workflow manually: `gh workflow run release.yml -f tag=v0.3.0`. An asset that is already attached is kept if identical and fails the run if it differs; published assets are never overwritten.

### Verifying a release

```bash
gh release download v0.3.0 --repo Xio-Shark/xioflow
shasum -a 256 -c SHA256SUMS
gh attestation verify xioflow-kernel-0.3.0.tgz --repo Xio-Shark/xioflow
npm audit signatures   # inside a project that installed @xioflow/kernel from npm
```

## License

MIT
