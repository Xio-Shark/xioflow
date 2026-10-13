# Integration examples

Four runnable integrations. Each example is its own package and links the kernel
with `"@xioflow/kernel": "file:../../"`, so every example tests the checked-out
source — not the npm release.

| Example | You are building | Demonstrates | Contracts | Verified |
|---|---|---|---|---|
| [`replace-subprocess-wrapper`](./replace-subprocess-wrapper) | A coding agent replacing its `child_process.spawn` wrapper | Naive `spawn + timeout` vs `quickRun`, measured side by side: orphan leaks, lost output tails, spill | #1, #3, #8, #11 | 2026-10-13, Linux, Node 22.23.3, kernel 0.7.0 — pass |
| [`temporal-activity`](./temporal-activity) | A Temporal worker with OS side-effecting activities | At-most-once activities across worker crash and retry; `workflowId:activityId` as `opId` | #45–#49 | 2026-10-13, Linux, Node 22.23.3, kernel 0.7.0 — pass |
| [`langgraph-node`](./langgraph-node) | A LangGraph.js graph whose nodes run commands | Checkpoint resume without re-executing a command node | #45, #47 | 2026-10-13, Linux, Node 22.23.3, kernel 0.7.0 — pass |
| [`mcp-stdio-transport`](./mcp-stdio-transport) | An MCP client that supervises stdio servers | `startService` with a `Transport` implementation over the kernel | #50–#52 | 2026-10-13, Linux, Node 22.23.3, kernel 0.7.0, MCP SDK 1.32.1 — pass |

Contract numbers refer to ARCHITECTURE §7.2.

## Prerequisites (all examples)

- Node.js >= 22.13 (`node:sqlite` runs without a flag).
- A built kernel checkout: `pnpm install && pnpm build` at the repository root.
- Linux or macOS. Windows is not supported; there the driver reports
  `processGroupKill: false` and `descendantEnumeration: 'none'` instead of
  pretending it can contain processes.

Then, inside the example directory: `pnpm install && node <entry>`.

## Onboarding acceptance

Target: a non-xiocode host replaces its subprocess wrapper and runs its first
supervised command within one day. Measured 2026-10-13 on Linux (Node 22.23.3,
kernel 0.7.0, already-built checkout):

| Step | replace-subprocess-wrapper | mcp-stdio-transport |
|---|---|---|
| `pnpm install` (example dir) | 0.4 s | 19.5 s |
| First run | 4.2 s | 1.4 s |
| Result | pass — 0 leaked orphans vs 1 for naive, Head + Tail kept, spill written | pass — `initialize`, `tools/list`, `tools/call`, 0 leaked processes |

A fresh clone additionally needs the root `pnpm install` and `pnpm build`; the
`tsc` build is incremental and was sub-second warm in this measurement (a cold
number was not recorded). The full path is minutes — well inside the one-day
target. The drill scripts in `temporal-activity` and `langgraph-node` each run
in about 2–3 s and self-verify (exactly-once side effect, `replayed: true`).

## Adding an example

- Keep it runnable: `pnpm install && node <entry>` from a built checkout, and
  self-verify the claim it demonstrates.
- Map what it demonstrates to ARCHITECTURE §7.2 contract numbers.
- State the verified platform / Node / peer-SDK versions in its README.
