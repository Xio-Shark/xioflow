# `xio-reaper/1` Cross-Language Control Protocol

`xioflow-reaper` is a zero-dependency C11 process-tree holder for Unix hosts (Rust, Python, Go, Node.js). It eliminates leaked grandchild processes, race-prone PID signalling, and startup gate races across crashes.

## Capability Discovery CLI

```sh
xioflow-reaper --protocol-info
```

Outputs a single line of strict JSON to `stdout` and exits `0`:

```json
{"protocol":"xio-reaper/1","platform":"linux","treeScope":"subreaper_tree","landlockAbi":3,"features":["gate","stop_ladder","rusage","signal","subreaper","landlock"]}
```

- `treeScope`:
  - `subreaper_tree` (Linux): `PR_SET_CHILD_SUBREAPER` + `pidfd_open`/`pidfd_send_signal` + `waitpid(-1) == ECHILD` mathematical emptiness proof.
  - `tracked_tree` (macOS): `kqueue(EVFILT_PROC, NOTE_FORK | NOTE_EXIT)` + `(pid, start_usec)` session tracking.

## Spawn & Bidirectional Control Channel (`fd 3`)

Spawn `xioflow-reaper <execPath> [args...]` in a new session (`setsid` / `detached: true`) with file descriptor `3` bound to a bidirectional stream `socketpair`.

The target child is forked into its own process group (`pgid == root_pid`) and **blocked on an internal gate pipe before `execvp`** until the host persists its `(pid, osStartTime)` identity and sends `go\n`.

### Host -> Helper Commands (ASCII line-delimited `\n` on `fd 3`)

| Frame | Semantics |
|---|---|
| `version` | Replies with `protocol xio-reaper/1 <treeScope>` |
| `go` | Opens the startup gate (`execvp` proceeds, applying `XIOFLOW_LANDLOCK_WRITE_ROOTS` on Linux if set) |
| `abort` | Closes the startup gate without executing the target (`_exit(125)`) |
| `signal <signo>` | Sends `<signo>` to `root_pid` only while `root_pid` remains unreaped |
| `stop <graceMs>` | Runs deterministic stop ladder across the entire held tree (`SIGINT` -> `<graceMs>` -> `SIGTERM` -> `1000ms` -> `SIGKILL` -> `2000ms`) |
| `<EOF>` | Host crash/disconnect: helper immediately stops the entire tree before exiting |

### Helper -> Host Events (ASCII line-delimited `\n` on `fd 3`)

| Frame | Semantics |
|---|---|
| `spawned <rootPid>` | Emitted once when `rootPid` is forked and blocked on the startup gate |
| `protocol xio-reaper/1 <treeScope>` | Response to `version` |
| `rusage <maxRssBytes> <cpuTimeMs>` | Monotonic high-water RSS (bytes) and cumulative user+sys CPU time (ms) |
| `exit <code\|-> <signo\|->` | Root process reaped (`exit 0 -` or `exit - 9`) |
| `empty` | Root has exited and the held descendant tree is provably empty |
| `stopped` | Reply to `stop <graceMs>`: entire held tree confirmed stopped |
| `residual <pid1,pid2,...>` | Reply to `stop <graceMs>`: unkillable processes remain (e.g. `D`-state I/O) |
| `error <message>` | Fatal setup or protocol error |
