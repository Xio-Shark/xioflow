# Conformance entry

The conformance suite is the black-box contract harness of
[ARCHITECTURE §7](../ARCHITECTURE.md). It answers one question: does an
implementation's *stated* execution behavior match what *actually happens* to
processes, files and journals? It is part of the ABI (§0.2 Decision 5).

This document is the external entry point: how to run the suite against your own
implementation, and how to declare the result.

## What the suite covers

The suite drives a consumer context (`ExecutionDomain` + `PlatformDriver` +
`ProcessSupervisor`) through 67 numbered contracts (the authoritative list is
[ARCHITECTURE §7.2](../ARCHITECTURE.md#72-契约清单) /
[EN](../ARCHITECTURE.en.md#72-conformance-contract-inventory)). Assertions are
made only on returned facts and journal events — never on implementation
internals. Process behavior comes from the tagged fixtures used inside the
tests, so every implementation faces the same process behaviors.

Internal levels L1–L4/H and their pass criteria are defined in §7.1.

## Running it

### 1. Plain node (recommended for third parties — no vitest)

`@xioflow/kernel/testing/plain` ships a dependency-free runner that implements
the minimal vitest API the suite uses and prints a machine-readable JSON report.
Your entry file:

```js
// conformance.mjs — no test framework required
import { installPlainEnvironment, runPlainSuite } from '@xioflow/kernel/testing/plain';

installPlainEnvironment();
// dynamic import: the suite resolves its test API from the environment at call time
const { defineContractTestSuite } = await import('@xioflow/kernel/testing');

defineContractTestSuite('my-framework', async () => {
  // Build your consumer context here. The suite calls this before every test.
  const { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } = await import('@xioflow/kernel');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-conformance-'));
  const domain = ExecutionDomain.acquire(tempDir, 'my-domain');
  const driver = new NodePlatformDriver();
  const supervisor = new ProcessSupervisor(domain, driver);
  return {
    domain, driver, supervisor, tempDir,
    workflowType: 'headless',
    cleanup: async () => {
      domain.close();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    },
  };
});

const report = await runPlainSuite({ consumerName: 'my-framework' });
process.exit(report.failed > 0 || report.errors.length > 0 ? 1 : 0);
```

```bash
node conformance.mjs            # JSON report on stdout; exit 1 on any failure
```

Set `XIOFLOW_EXPECT_READ_TRACKING=atime` when the workspace-transaction and
read-evidence contracts are in scope and the filesystem advances atime
(relatime on Linux, default APFS on macOS). The runner reports failures, not
skips, when an expectation is declared but not met.

The report shape is stable:

```json
{
  "consumer": "my-framework",
  "startedAt": "2026-10-13T12:00:00.000Z",
  "finishedAt": "2026-10-13T12:03:12.000Z",
  "passed": 57, "failed": 0, "skipped": 0,
  "failures": [], "errors": []
}
```

### 2. Vitest (repositories already using it)

Enable globals and define the suite inside a test file:

```ts
// vitest.config.ts
export default defineConfig({ test: { globals: true } });
```

```ts
// tests/conformance.test.ts
import { defineContractTestSuite } from '@xioflow/kernel/testing';
defineContractTestSuite('my-framework', async () => ({ /* your ConsumerContext */ }));
```

### 3. This repository's own runs

- `pnpm test` — the full vitest suite, including the contract suite on three
  consumer shapes (headless API, three-piece workflow, memory workflow) and two
  drivers (node, reaper), plus fault injection and the crash-point matrix.
- `pnpm conformance` — the plain-node path above, self-checked against this
  repository's own build on `NodePlatformDriver`.

## Compliance tiers

Compliance is a **tier declaration**, not a certification. You run the suite,
obtain a green/red result, and declare the tier you reached, with the suite
version and date. The tiers (defined in §7.1):

| Tier | Requirement | Meaning |
|---|---|---|
| `core` | L1 + L2 fully pass | Honest execution facts: spawn, stop, output, quotas, crash recovery, identity, epoch, adjudication |
| `workspace` | core + L3 transaction/coverage contracts (#56–#61, #65) | Parallel-agent workspace transactions and read-set evidence |
| `experimental` | workspace + AgentRuntime behavior | Experimental increment; may change with minor releases; never stands alone |

Reference format for a claim:

> xioflow-compatible/core — @xioflow/kernel 0.7.x conformance suite, run 2026-10-13, NodePlatformDriver, Linux.

Rules for an honest claim:

- capability-gated entries (H level, or anything your driver declares
  unsupported) are reported `unsupported` — never counted as passed, never
  silently skipped;
- name the driver and platform in the claim; a green run on `NodePlatformDriver`
  says nothing about cgroup hard limits;
- state the suite version you ran against; contracts are added per minor, and
  an old run does not cover new contracts.

## Known boundaries of the suite

- The suite validates facts and journal events. It does not measure performance,
  and it is not a benchmark of anything.
- Workspace-transaction contracts depend on unprivileged atime observation. On
  filesystems that do not advance atime (`noatime`), those contracts report
  `readTracking: 'unobserved'` and the corresponding behaviors degrade honestly;
  declare this when claiming the `workspace` tier.
- H-level entries require the platform capability (e.g. a delegated cgroup v2).
  Without it they are gated off, not failed.
- The kernel's own CI runs the suite on ubuntu-latest and macos-latest
  (Node 22.13 / 24). Results from other platforms are your own evidence to
  gather.
