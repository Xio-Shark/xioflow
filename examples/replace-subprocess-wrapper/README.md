# Example: Replacing Naive `spawn + timeout` with `@xioflow/kernel`

This example demonstrates why typical agent runtimes or CLI tools fail when using naive `child_process.spawn()` with timeouts, and how `@xioflow/kernel` solves these issues out of the box with zero runtime dependencies.

## Prerequisites

- Node.js >= 22.13 and a built kernel checkout (`pnpm install && pnpm build` at the repository root).
- `npm install` (or `pnpm install --ignore-workspace`) in this directory to link `@xioflow/kernel` from the repository root (`file:../../`).
- Verified 2026-11-14 on macOS (Apple Silicon), Node 26.12.0, `@xioflow/kernel` 0.8.0 (`KernelMedium.exec`).

## Key Differences

| Problem in Naive Wrapper | Solution in `@xioflow/kernel` |
|---|---|
| **Orphan Process Leaks**: Calling `child.kill('SIGTERM')` only signals the immediate parent process. Grandchildren and background forks escape as orphans (PPID becomes 1) and remain running forever in the OS. | **Process Group Termination**: The kernel tracks the whole POSIX process group (`ReaperPlatformDriver` / process groups) and terminates all descendants, verifying that the process group is truly empty. |
| **Truncation Loses the Tail**: Naive string buffering truncates the end of the log (`stdout.slice(0, max)`), discarding stack traces, final errors, and exit messages. | **Head + Tail Retention**: In-memory output preserves both the prefix (for context) and the suffix (for failure reasons), with explicit `blob:` spill markers. |
| **Silent Data Loss**: When output exceeds memory caps, naive wrappers drop excess bytes without saving them. | **Blob Spilling**: The kernel spills full stdout/stderr to content-addressed blobs (`<domain>/blobs/<sha24>.blob`) with sha256 digests and paged `blob` inspection. |

## What this demonstrates (kernel contracts)

ARCHITECTURE §7.2 contracts **#1** (a failed spawn is an explicit failure, never a fake running), **#3** (Head + Tail retention on UTF-8 boundaries), **#8** (whole-group termination converges) and **#11** (a timeout with an escaped descendant settles within bounded time, honestly).

## Running the Comparison

```bash
cd examples/replace-subprocess-wrapper
node run-comparison.mjs
```

### Expected Output

```text
================================================================
Subprocess Wrapper Comparison: Naive spawn() vs @xioflow/kernel
================================================================

1. Running Naive Wrapper (spawn + setTimeout + child.kill)...
   - Naive finished: status=SIGTERM
   - Output Tail Preserved: false
   - Orphan processes left alive in OS: 1

2. Running @xioflow/kernel (KernelMedium.exec with bounded drain + group kill)...
   - Kernel finished: status=failed (signal: SIGINT)
   - Output Head Preserved: true
   - Output Tail Preserved: true
   - Full output spilled to disk: YES (.../.xioflow-kernel/blobs/<sha24>.blob)
   - Orphan processes left alive in OS: 0
```

The exact stop signal depends on where in the SIGINT -> SIGTERM -> SIGKILL
escalation the process dies; `SIGINT` is what the verified run recorded. The
comparison summary table at the end states the measured difference per aspect.
