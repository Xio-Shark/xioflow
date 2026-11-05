# XIO-ISA v1 scope and layer boundaries

**Status:** frozen for Gate 0 (A-01), 2026-11-02
**Authority:** this document is the detailed boundary record referenced by
[`spec/current-contract.md`](../current-contract.md), [`ROADMAP.md`](../../ROADMAP.md),
and [`docs/XIO-ISA-PLAN.md`](../../docs/XIO-ISA-PLAN.md).

## Scope

XIO-ISA v1 is a local execution kernel for Node.js coding-agent workloads on
POSIX hosts. The reference implementation is the embedded TypeScript package
running in one host process. A v1 request is admitted, validated, scheduled,
executed, recovered, and reported by that process and its declared drivers.

The supported baseline is Node.js `>=22.13` on Linux or macOS. WSL2 follows the
Linux driver capability report when the host exposes the required POSIX and
cgroup features; unsupported capabilities are reported as `unsupported` rather
than emulated. The package does not provide a v1 guarantee for Windows,
remote execution, or cross-process arbitration of one workspace.

The v1 kernel owns execution facts and recovery semantics. It does not own
model protocols, prompts, business acceptance, token or cost policy, or an
unbounded shell language. Any operation that needs those concerns must compile
to a declared ISA program or remain outside the kernel boundary.

## Layer boundaries

| Layer | Owns | May depend on | Must not own | Issue routing |
| --- | --- | --- | --- | --- |
| **Core** | ISA admission and execution, domain ownership, capabilities, leases, journal and migration, process/workspace/artifact drivers, recovery, result and evidence semantics | Node.js standard library and declared drivers | Model/provider protocols, business policy, transport-specific state, a second recovery state machine | `layer:core` plus an opcode or control operation |
| **stdlib** | Typed program builders, macros, compatibility compilers, and high-level workflows that expand to an auditable `Program` | Core types and public `execute` contract | Direct store or driver writes, hidden side effects, capability bypasses, independent success or recovery rules | `layer:stdlib` plus the expanded opcode set |
| **adapter** | SDK, MCP, CLI, wire and `xio wrap` translation, input/output encoding, rendering, and deprecation mapping | Stable core/stdlib contracts and transport libraries | Journal/lease ownership, business success decisions, result-state rewriting, transport-specific recovery | `layer:adapter` plus the target transport/opcode |
| **research** | Experimental AgentRuntime, trace/fork, cache, shadow/race, benchmark, and fault-injection work that tests future designs | Explicitly versioned core seams and test fixtures | Stable ISA guarantees, core data-model dependencies, release-blocking behavior without an RFC | `layer:research` plus an RFC ID |

The four layers share one execution truth. Only Core may create or settle a
lease, write an execution event, decide an instruction state, or perform crash
recovery. A stdlib helper or adapter can only construct or submit a Program;
it cannot call a store or driver behind that Program. Research code may use
experimental seams, but it must remain removable without changing a stable
result union or journal meaning.

## v1 boundary rules

1. A new stable behavior must map to an existing opcode, a new opcode contract,
   or a control operation recorded in the registry and schema.
2. A request that changes more than one layer, adds an external side effect, or
   changes result/recovery meaning requires an RFC before implementation.
3. Rust, daemon, remote, Windows, and other cross-host directions are historical
   or deferred material. They are not v1 critical-path dependencies.
4. Compatibility features may translate into v1 programs, but they cannot
   define a second source of truth or weaken capability, journal, or evidence
   checks.
5. If the driver cannot prove a fact, the v1 result remains `unknown`,
   `unsupported`, or `indeterminate` according to the result contract; an
   adapter must not promote it to success.

## RFC queue

Requests that cannot be assigned to one layer or one existing opcode are
recorded in [`spec/rfc/README.md`](../rfc/README.md). The queue is the only
place where deferred scope is reconsidered. Each entry must state the affected
layer/opcode, atomicity, observation, rollback, external side effects,
capability and privacy impact, migration, driver evidence, fault matrix,
performance budget, and exit strategy.

The v1 opcode catalog is the machine-readable
[`registry.json`](registry.json). Schema, type, transport, CLI, documentation,
and conformance generation must consume that catalog rather than maintain a
second opcode list.

