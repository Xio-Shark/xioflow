# ISA adapter preview

Task: bounded progress on AD-01, AD-02 and AD-03. These work packages are not
declared fully complete.

## Implemented boundary

- `src/adapters/isa.ts` is the shared transport adapter. It does not acquire an
  ExecutionDomain, sign capabilities, create a Task/Run, or rewrite Program IDs.
- MCP advertises `execute` with an exact `{ program: object }` argument envelope.
  The core owns full Program validation. Legacy tools and validation stay intact.
- `KernelMcpServerOptions.isa` accepts host-owned planning settings and an explicit
  `bindKernel` callback. These cannot be supplied by the model's tool arguments.
- `isaOnly: true` exposes only `execute` and skips domain acquisition/recovery.
  This mode can plan without creating a domain directory, database or lock.
  In the default compatibility server, existing domain acquisition remains part
  of server startup; the plan request itself does not create execution state.
- Standalone CLI `plan --input <path|->` and `execute --input <path|->` print the
  original core result as JSON. Rejected/unsupported execution returns exit 1.
  The standalone CLI never invents a kernel binding.
- `src/isa/public.ts` is a deliberately enumerated preview SDK surface. It
  exports `execute` and necessary request/result/binding types, without wildcard
  store, driver or compatibility runtime exports.
- ISA requests register an AbortController in the existing MCP request map.
  Cancellation is forwarded to the host binding callback and core pipeline;
  the adapter checks abort before and after awaiting a host binding. The kernel
  remains the sole execution-state authority. An already dispatched snapshot
  waits for its actual result; cancellation prevents pending/later dispatch and
  does not claim that the snapshot was stopped.

An unconfigured transport performs structural planning with
`capability: "not_requested"`. This is not capability approval or execution
authority. The host may supply explicit plan precheck settings; actual bound
pipeline execution relies on the core's persisted capability admission.

## Verification

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm exec vitest run tests/mcp/isa-execute.test.ts` | 0 | Six ISA tests pass, including three cancellation cases |
| `pnpm exec vitest run tests/mcp tests/cli/isa-execute.test.ts` | 0 | Five files, 25 tests pass; includes existing official MCP SDK client cancellation coverage |
| `pnpm typecheck` | 0 | PASS |
| `git diff --check -- src/adapters/isa.ts src/isa/public.ts src/mcp/server.ts src/mcp/tools.ts src/cli.ts tests/mcp/isa-execute.test.ts tests/mcp/server.test.ts tests/cli/isa-execute.test.ts` | 0 | Adapter-owned changes have no whitespace errors |

Tests verify that planning does not call `bindKernel` or create a database; an
unbound pipeline remains unsupported; additional transport authority fields are
rejected; and the exact same control.health Program returns equal structured
results through SDK and MCP using an explicit host-owned domain. The adapter does
not create additional Runs or operations. CLI tests run built JavaScript in an
empty temporary directory and verify zero execution files/locks.

Cancellation regression reproduces a host binding blocked on a barrier: sending
`notifications/cancelled` before releasing it creates no operation, binding event
or snapshot. A pre-aborted signal never calls the binding. A real snapshot
dispatched before cancellation still returns its genuine success while a later
instruction is cancelled and the Program returns `partial`.

The combined command's final global `git diff --check` returned exit 2 because
`src/driver/reaper-driver.ts:583` had an extra blank line at EOF outside this
adapter workstream. The root agent was notified; this run does not claim a clean
global worktree.

## Remaining gates

- The core binding currently supports only its explicitly implemented opcodes;
  this adapter does not add missing filesystem/process/transaction execution.
- Legacy tools have not all been compiled to ISA Programs. The root package API
  has not been narrowed. A preview SDK subpath does not complete I-09 or AD-03.
- CLI status/resolve/artifact/inspect commands and authenticated cross-process
  binding are outside this increment.
- ISA-specific MCP progress and complete cross-entry golden corpus coverage are
  not claimed. Existing run_command cancellation remains covered by the
  compatibility suite; ISA cancellation uses the core's cooperative semantics,
  not preemption of an already executing snapshot.
- Package export, clean package verification, migration documentation and plan
  reconciliation are coordinated by the root agent.

## Documentation synchronization

The README, unreleased changelog, Chinese/English architecture and roadmap now
describe these preview entry points and their binding/cancellation limits. They
also distinguish Linux `unreapedPids` stop facts from actual parent reaping, and
record the separate Vitest/native Node test command. This is a bounded update,
not completion of Q-08's full registry/schema/conformance/release-document sync.
No runtime code or long-run test source was changed by this documentation pass.

Rollback: remove the additive adapter/preview surface and CLI/tool branches;
restore the prior tool-list expectation. No database migration or existing
operation state is changed by this increment.
