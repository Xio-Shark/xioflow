# Example: Model Context Protocol (MCP) Stdio Transport with `@xioflow/kernel`

This example demonstrates how to integrate the official [Model Context Protocol (MCP) TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) with `@xioflow/kernel` to supervise long-running MCP stdio servers.

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

## Running the Demo

```bash
cd examples/mcp-stdio-transport
npm install
node run-mcp-demo.mjs
```
