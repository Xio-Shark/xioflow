# XIO-ISA baseline — 2026-11-02

**Task:** A-03
**Scope:** current TypeScript/Node.js implementation before ISA registry work
**Source revision:** `3ce020a9e50cb8e5ff92a50f5792a3b9ecb7e2e3`
**Working tree:** documentation changes for A-01/A-02 are present; no runtime
source was changed for this baseline.

## Environment and driver

| Field | Value |
| --- | --- |
| Node.js | `v26.12.0` |
| pnpm | `10.32.1` |
| Platform | macOS Darwin `27.0.0`, `arm64` |
| Host | `tengyanxideMacBook-Air.local` |
| Default process driver | `NodePlatformDriver` |
| Conformance driver | `NodePlatformDriver` (the plain self-check names this explicitly) |
| Optional drivers | `ReaperPlatformDriver` is covered by its consumer suite; cgroup tests are capability-gated and report a skip when no delegated hierarchy is available. |

The results are evidence for this host and driver. They do not turn an
unsupported capability into a cross-platform guarantee.

## Commands and results

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm typecheck` | `0` | TypeScript `--noEmit` completed without diagnostics. |
| `pnpm conformance` | `0` | Plain-node self-check: `57` passed, `0` failed, `0` skipped, `0` errors. The suite runs against `NodePlatformDriver`. |
| `pnpm test` | `0` | `59` test files passed, `1` skipped; `729` tests passed, `7` skipped (`736` total). |
| `git diff --check` | `0` | No whitespace errors in tracked changes. |

The full Vitest run started at `01:24:36` local time and completed in
`168.90s`. The conformance self-check completed with the report timestamps
`2026-11-01T17:42:36.488Z` to `2026-11-01T17:42:49.708Z` (local 2026-11-02).

## Test and evidence classification

The tags below are evidence categories, not mutually exclusive ownership. A
test can carry more than one tag when its assertion proves more than one
boundary. The repository currently has `60` `tests/**/*.test.ts` files.

| Category | Current evidence | Status / gap |
| --- | --- | --- |
| **schema** | `tests/store/sqlite.test.ts`; `tests/agents/journal.test.ts`; `tests/supervisor/input-validation.test.ts`; `tests/mcp/input-validation.test.ts` | Existing SQLite/event and input-shape checks; no ISA JSON Schema exists yet. |
| **unit** | `tests/capability/`; `tests/confinement/`; `tests/driver/`; `tests/snapshot/`; `tests/supervisor/execution-result.test.ts`; `tests/supervisor/output-honesty.test.ts`; `tests/workspace/read-tracking.test.ts` | Present and included in `pnpm test`. |
| **property** | No property-based test directory or runner found under `tests/` or `scripts/`. | **Gap:** program/DAG/capability property tests are planned in Q-02. |
| **fault** | `tests/fault/crash-matrix.test.ts`; `tests/fault/spawn-evidence.test.ts`; `tests/driver/identity-evidence.test.ts`; `tests/driver/observation-failure.test.ts`; `tests/supervisor/recovery-evidence.test.ts`; `tests/agents/runtime-crash.test.ts` | Crash and observation failures are runnable; ISA-specific fault matrix is not yet present. |
| **model** | `spec/tla/OperationRecovery.tla`; `spec/tla/OperationRecovery_node.cfg`; `spec/tla/OperationRecovery_reaper.cfg`; `scripts/check-tla.mjs` | Model artifacts exist; `pnpm check:tla` was not part of the A-03 baseline command set and is a later Gate 2 check. |
| **integration** | `tests/contract/`; `tests/supervisor/contract.test.ts`; supervisor coordination/service suites; `tests/workspace/`; `tests/agents/` | Shared contract and cross-component suites are included in `pnpm test`; no ISA pipeline exists yet. |
| **adapter** | `tests/gateway/`; `tests/mcp/`; `tests/otel/`; `tests/supervisor/quick-run.test.ts`; `conformance/plain-selfcheck.mjs` | Existing adapters are tested independently; cross-adapter Program equivalence is not yet available. |
| **soak** | `scripts/agent-soak.mjs`; `audit/observation/workloads.mjs`; `audit/observation/e10.mjs`; `audit/observation/wrap-cure-benchmark.mjs` | Harnesses exist but no 24-hour or 7-day run was performed for this baseline. |
| **security** | `tests/capability/`; `tests/confinement/`; `tests/supervisor/artifact-safety.test.ts`; `tests/supervisor/stop-safety.test.ts`; input-validation suites; `audit/lib/secret-scan.mjs` | Local path, artifact, confinement, and input checks exist; authenticated IPC and SecretRef are not implemented. |

## Reproduction

From a clean checkout with Node.js `>=22.13` and dependencies installed:

```text
pnpm typecheck
pnpm conformance
pnpm test
```

The conformance command expects the built `dist/` tree, so a clean consumer
should run `pnpm build` first. Capability-gated entries must be reported as
`unsupported` or skipped according to the selected driver; they must not be
counted as successful hard-limit evidence.

## Known limits and next gate

- This is a single macOS host snapshot at Node `v26.12.0`; it is not Linux,
  WSL2, or Windows evidence.
- No ISA registry, Program schema, unified `execute`, property suite, or
  authenticated local control plane exists at this baseline.
- The report is a Gate 0 artifact. A-04 must freeze version terminology and
  A-05 must align the RFC template before Gate 0 can close.

