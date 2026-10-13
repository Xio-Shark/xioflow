# Example: Model Context Protocol (MCP) Stdio Transport with `@xioflow/kernel`

This example demonstrates how to integrate the official [Model Context Protocol (MCP) TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) with `@xioflow/kernel` to supervise long-running MCP stdio servers.

## Prerequisites

- Node.js >= 22.13 and a built kernel checkout (`pnpm install && pnpm build` at the repository root).
- `pnpm install` in this directory (pulls the MCP SDK and links the kernel via `file:../../`).
- Last verified 2026-10-13 on Linux, Node 22.23.3, kernel 0.7.0, MCP SDK 1.32.1.

## MCP SDK compatibility

This example declares `@modelcontextprotocol/sdk: ^1.6.0`. The kernel
repository itself tests against the SDK pinned in its root `package.json`
devDependencies (1.30.1 when this note was written), so the example can resolve
a newer SDK than the kernel's own tests. Verified working combination:
**SDK 1.32.1** with kernel 0.7.0. If a future SDK minor breaks the
`Transport` interface, update the verified line above in the same change.

## Why Supervise MCP Servers with `@xioflow/kernel`?

Typical AI agents or extensions launch MCP servers using raw `child_process.spawn()`. In production environments, this leads to common failure modes:
1. **Orphan Process Leaks**: When the host or agent crashes, or during abnormal exit, background MCP processes continue running as orphaned processes indefinitely.
2. **Ungraceful Termination**: Many MCP servers do not clean up temporary sockets, child processes, or file locks when killed with a naive signal.
3. **No Lifecycle Observability**: Lack of crash detection, restart policies, and durable execution facts in persistent stores.

With `@xioflow/kernel`'s `startService` and `KernelStdioTransport`:
- **Managed Process Lifecycle**: MCP server instances are tracked as kernel operations (`<serviceId>#<n>`) with intent registration in SQLite.
- **Continuous Bidirectional Streaming (`stdinMode: 'stream'`)**: Stdio JSON-RPC messages flow without pipeline truncation.
- **Confirmed Stop Pipeline**: Clean graceful shutdown (SIGTERM -> SIGKILL -> verified process group exit) ensures 0 residual processes.
- **Crash Recovery**: If the host crashes, `domain.recover()` detects and cleans up surviving server processes and releases allocated resource leases.
- **Declarative Restart**: Configurable `on-failure` restart policy with backoff and retry caps.

## Structure

- `server.mjs`: A standard Model Context Protocol server exposing an `add` tool.
- `kernel-transport.mjs`: Implementation of the MCP SDK `Transport` interface wrapping `@xioflow/kernel`'s `startService`.
- `run-mcp-demo.mjs`: Demonstration script connecting an official MCP `Client` to the server, performing `initialize`, `tools/list`, and `tools/call`, closing, and verifying 0 process leaks via the OS process table.

## What this demonstrates (kernel contracts)

ARCHITECTURE §7.2 contracts **#50** (service instances with `stdinMode: 'stream'` and passthrough stdout, stopped through the standard pipeline — what the demo exercises), **#51** (`on-failure` restart with backoff and caps) and **#52** (host-crash cleanup without automatic restart).

## Running the Demo

```bash
cd examples/mcp-stdio-transport
npm install
node run-mcp-demo.mjs
```

### Expected Output (verified 2026-10-13, SDK 1.32.1)

```text
3. Calling tools/list...
   - Tools discovered: [ 'add' ]

4. Executing tool call: add(15, 27)...
   - Tool output: Result: 42

5. Closing MCP Client and stopping supervised service...
   - Client closed.

6. Verifying clean process termination in the OS...
   - Server PID 2727 alive in OS: false
   - Verified 0 orphan processes leaked: YES

PASS: MCP Stdio Transport ran cleanly with 0 process leaks!
```
