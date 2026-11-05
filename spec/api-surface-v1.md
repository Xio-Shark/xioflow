# XIO-ISA v1 API surface inventory

**Status:** inventory for Gate 0 (A-02), 2026-11-02
**Machine-readable source:** [`api-surface-v1.json`](api-surface-v1.json)

This document records the public surface that the 0.x package currently
publishes. It classifies existing exports before the v1 root is narrowed; A-02
does not remove or rename a runtime export. The JSON file is the CI-readable
record and must be updated in the same change as an export change.

## Status meanings

| Status | Meaning in this inventory |
| --- | --- |
| `stable` | Covered by the current implementation contract and conformance evidence. The package is still pre-1.0, so a breaking change still needs a migration and release note. |
| `preview` | Public and supported for experimentation or compatibility, but its v1 shape is still being narrowed. |
| `experimental` | Explicitly outside the stable kernel contract; it may change or be removed after an RFC or research result. |
| `deprecated` | Kept only for 0.x compatibility. New callers must not add a dependency; removal requires a migration and a major release. |

## Package entrypoints

| Package path | Source | Kind | Status | Notes |
| --- | --- | --- | --- | --- |
| `@xioflow/kernel` | `src/index.ts` | library root | `preview` | The current root is intentionally wider than the future v1 root. The stable v1 target is `execute`, ISA types, capability types, and supported driver contracts once those exist. |
| `@xioflow/kernel/testing` | `src/testing/contract-suite.ts` | conformance helper | `stable` | Test-only contract surface; not a runtime execution API. |
| `@xioflow/kernel/isa` | `src/isa/public.ts` | bounded ISA SDK | `preview` | Explicit execute/types surface. Side effects require host bindings; unsupported opcodes and transaction mode remain explicit. |
| `@xioflow/kernel/testing/plain` | `src/testing/plain-runner.ts` | conformance runner | `stable` | Dependency-free runner for black-box verification. |
| `@xioflow/kernel/package.json` | `package.json` | metadata | `stable` | Package metadata only. |
| `xioflow` / `xio` | `src/cli.ts` | CLI adapter | `preview` | Parses and renders commands; state transitions must move through the kernel. `src/cli.ts` has no named library exports. |

## Root re-export inventory

The following modules are reachable through `src/index.ts`. The `source` and
`status` values are mirrored in `api-surface-v1.json` so CI can reject an
unreviewed surface change.

| Source module | Status | Layer | Boundary |
| --- | --- | --- | --- |
| `src/types.ts` | `stable` | core | Current result, identity, lease, capability, snapshot, and error facts. |
| `src/domain.ts` | `stable` | core | In-process domain ownership and resource arbitration. |
| `src/store/schema.ts` | `deprecated` | core | Compatibility export of SQLite DDL; schema migration work will replace direct consumers. |
| `src/store/sqlite.ts` | `deprecated` | core | Compatibility export of the low-level store; callers must not create a second state machine. |
| `src/driver/types.ts` | `stable` | core | Driver contract and observable capability facts. |
| `src/driver/contract.ts` | `stable` | core | Machine-readable observation, stop, rollback, and crash-recovery evidence contract for process, filesystem, workspace, and confinement drivers. |
| `src/driver/secret-env.ts` | `stable` | core | Driver-local SecretRef resolution errors and stream redaction boundary. |
| `src/driver/observation.ts` | `stable` | core | Driver observation error. |
| `src/driver/node-driver.ts` | `stable` | core | POSIX Node driver. |
| `src/driver/reaper-driver.ts` | `preview` | core | Optional native reaper capability. |
| `src/driver/cgroup-driver.ts` | `preview` | core | Linux cgroup capability; unsupported hosts fail closed. |
| `src/supervisor/supervisor.ts` | `stable` | core | Current process/workspace supervision API. |
| `src/recovery/engine.ts` | `stable` | core | Crash recovery and indeterminate-result evidence. |
| `src/isa/execute.ts` | `preview` | core | Unified ISA execute façade; plan mode is side-effect free and pipeline mode requires a host executor. |
| `src/isa/types.ts` | `preview` | core | Program, instruction, result, capability and evidence types for XIO-ISA v1. |
| `src/isa/control.ts` | `preview` | core | Durable status, cancellation, adjudication, journal-only resume and health control plane. |
| `src/store/migrations.ts` | `stable` | core | Numbered SQLite schema migrations with checksum and half-applied detection. |
| `src/store/event-envelope.ts` | `stable` | core | Journal envelope construction and sensitivity-key redaction at the persistence boundary. |
| `src/config/snapshot.ts` | `stable` | core | Immutable request configuration binding with schema, capability, driver, retention, redaction, and digest facts. |
| `src/config/overlay.ts` | `preview` | adapter | Private copy-on-write config overlays for gateway rewrites; source files remain untouched. |
| `src/ipc/local-socket.ts` | `preview` | core | Authenticated owner-only Unix socket transport with session key and capability-bound nonce; HTTP remains an adapter concern. |
| `src/quick-run.ts` | `preview` | stdlib | Compatibility helper that must compile to the v1 execution path. |
| `src/agents/*` | `experimental` | research | AgentRuntime and checkpoint scheduling; model and policy remain with the host. |
| `src/snapshot/git-shadow.ts` | `preview` | core | Current workspace snapshot driver. |
| `src/workspace/transactions.ts` | `preview` | core | Workspace transaction and conflict facts. |
| `src/workspace/observation-replay.ts` | `preview` | core | Optional observation evidence and cutoff helpers. |
| `src/workspace/read-tracking.ts` | `preview` | core | Host/filesystem observation helper. |
| `src/supervisor/read-evidence.ts` | `preview` | core | Read-evidence type and tracker seam. |
| `src/capability/*` | `preview` | core | Persisted capability v1, path checks and schema are implemented; complete ISA admission and cross-entry migration remain pending. |
| `src/confinement/*` | `preview` | core | Declared write-confinement drivers; not a hostile-code sandbox. |
| `src/otel/otlp.ts` | `preview` | adapter | Journal-to-OTel rendering; it cannot alter result facts. |
| `src/mcp/server.ts` | `preview` | adapter | MCP transport adapter. |
| `src/workspace/causal-graph.ts` | `experimental` | research | Causal graph experiments. |
| `src/gateway/wire-proxy.ts` | `preview` | adapter | Wire protocol translation for `xio wrap`. |
| `src/gateway/shell-shim.ts` | `preview` | adapter | Shell compatibility translation. |
| `src/gateway/http304-cache.ts` | `experimental` | research | Cache experiment; it does not own kernel recovery. |
| `src/gateway/virtual-workspace.ts` | `experimental` | research | Shadow/race experiment. |
| `src/gateway/time-fork.ts` | `experimental` | research | Trace/fork experiment. |

The inventory deliberately leaves the current wide root in place. A later
task may add deprecation warnings or a narrower export map, but that change
must preserve the current contract until an ISA v1 migration is available.

## Direct source exports required by A-02

- `src/types.ts`: the complete named-export list is in the JSON entry for this
  file; these are current contract facts and errors, not ISA v1 instructions.
- `src/quick-run.ts`: `QuickRunOptions`, `quickRun` (`preview`, stdlib).
- `src/cli.ts`: no named exports; `xioflow` and `xio` are package bin adapters.
- `src/index.ts`: root wildcard modules and explicit named re-exports are listed
  in the JSON record; no new export may be added without updating both files.

