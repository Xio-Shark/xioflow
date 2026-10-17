# Six-harness execution-layer audit — method and results

Status: **method, scenario definitions and one recorded round of results.**
The results below were recorded on **2026-09-30** (darwin arm64, Node v26.9.0) and
are published from `audit/results/2026-09-30/` on 2026-10-13; no new runs were made
for this report. `audit/results/` is git-ignored (transcripts contain harness system
prompts and local paths), so nothing here quotes a transcript: the numbers are
verdict counts and the structured fields of `verdict.json`, with local paths
normalized.

**Findings about third-party harnesses are not yet reportable findings.** Per the
discipline below, a tape-replayed violation must be reproduced once with a real
model before it is reported, and publishing this document is an external action
that requires the repository owner's explicit sign-off. The real-model
reproduction status of each cell is tracked under
[Real-model reproduction status](#real-model-reproduction-status).

This document is the stable part of the deliverable: what is measured, how a
verdict is reached, what a finding is allowed to claim, and what the recorded
round actually observed.

## The question

When something goes wrong underneath a tool call, does what the harness
*says* match what *happened*? The bench impersonates the model service with a
local HTTP endpoint that replays a tape of tool calls, drives each harness
headless in a sandbox, injects faults, and then judges the machine from
outside (process table, side-effect ledger, file tree) against the harness's
own account (the tool results it sent back to the "model").

## Harnesses in scope

`xio` (line REPL; variants `xio:reaper`, `xio:node`, `xio:builtin` change only
the execution layer), `codex`, `opencode`, `gemini`, `claude`, `qwen`.
Headless default configurations plus the minimum needed to let a shell command
run; sandbox/hardening options that change an outcome must be named in a
finding. A fake endpoint is not a real model: every violation found here must
be reproduced once with a real model before it is reported. macOS arm64 only
so far.

## Scenarios and the property each checks

| Scenario | Fault | Property |
|---|---|---|
| `baseline` | none | runs exactly once; output reaches the model |
| `pipe-hold` | root exits, child holds the pipe 20 s | bounded return; nothing left after the session |
| `orphan-at-exit` | command starts a process in its own session | nothing it started survives, unless the harness said so |
| `unconfirmed-stop` | command ignores SIGINT/SIGTERM under the tool's time limit | "stopped" means gone; nothing left after the session |
| `kill-mid-tool` | harness SIGKILLed mid-call, then resumed | effect not repeated; resumed history keeps the call; leftover gone or mentioned |
| `kill-before-report` | SIGKILLed while reporting a completed command's result | effect not repeated; resumed history keeps call and result |
| `output-flood` | 50 MB output ending in a marker | truncation announced; stop reported if the command was stopped |
| `cancel-tree` | three-process chain, SIGINT to the harness's group | no chain process survives the harness |
| `mcp-orphan-exit` / `mcp-orphan-kill` | stdio MCP server, session ends / harness killed | server not left running |
| `spawn-failure` | missing binary, then `exit 127` | the two results can be told apart |

## Verdict discipline

A trial verdict is `holds`, `violated`, `not_applicable` (capability missing),
`inconclusive`, or `bench_error`. Only k/5 with k ≥ 4 counts as stable.
`audit/repro/` generates one reproduction script per stably violated cell
(exit 0 if the violation reproduces 3/3). Wording rules live in
`audit/behavior/wording.json`: findings describe observed behavior, name
whether a hardening option exists, and do not editorialize.

## Recorded round: 2026-09-30

Recorded on darwin arm64 27.0.0, Node v26.9.0, 442 trials across 11 scenarios
and 9 harness configurations (5 trials per cell unless noted). Matrix
regenerated with `node audit/matrix.mjs audit/results/2026-09-30`.

| harness | version |
|---|---|
| `gemini` | 0.46.0 |
| `codex` | codex-cli 0.157.1 |
| `opencode` | opencode v2.0.16 |
| `claude` | 2.1.284 (Claude Code) |
| `xio:reaper` | XioCode 1.6.0 |
| `xio:node` | XioCode 1.6.0 |
| `xio:builtin` | XioCode 1.6.0 |
| `qwen` | 0.24.7 |
| `xio` | XioCode 1.6.0 |

| scenario | `gemini` | `codex` | `opencode` | `claude` | `xio-reaper` | `xio-node` | `xio-builtin` | `qwen` | `xio` |
|---|---|---|---|---|---|---|---|---|---|
| baseline | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 1/1 |
| pipe-hold | VIOLATED 5/5 | holds 5/5 | holds 5/5 | VIOLATED 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | VIOLATED 5/5 | holds 1/1 |
| orphan-at-exit | VIOLATED 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | holds 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | — |
| unconfirmed-stop | n/a 5/5 | holds 5/5 | holds 5/5 | VIOLATED 5/5 | n/a 5/5 | n/a 5/5 | n/a 5/5 | holds 5/5 | — |
| kill-mid-tool | VIOLATED 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | VIOLATED 5/5 | — |
| kill-before-report | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | — |
| output-flood | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | — |
| cancel-tree | VIOLATED 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | — |
| mcp-orphan-exit | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | VIOLATED 5/5 | — |
| mcp-orphan-kill | VIOLATED 5/5 | holds 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | holds 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | VIOLATED 5/5 | — |
| spawn-failure | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | — |

`—` = the cell was not run in this round. Plain `xio` ran baseline and
pipe-hold only (1 trial each): after this round the harness build landed the
2026-09-30 UI batch, whose interactive mode requires a TTY and whose one-shot
mode never auto-allows complex shell, so the pipe-driven adapter could no
longer start it. See [xio re-measurement](#xio-re-measurement).

### Stable violations, by property

| scenario | violation property | harnesses (trials) |
|---|---|---|
| pipe-hold | `tool_call_waited_for_pipe_holder` | `gemini` (5/5) |
| pipe-hold | `process_left_running_after_session` | `claude` (5/5), `qwen` (5/5) |
| orphan-at-exit | `process_left_running_after_session` | `gemini` (5/5), `codex` (5/5), `opencode` (5/5), `claude` (5/5), `xio-node` (5/5), `xio-builtin` (5/5), `qwen` (5/5) |
| unconfirmed-stop | `process_left_running_after_session` | `claude` (5/5) |
| kill-mid-tool | `effect_not_in_resumed_history` | `gemini` (5/5) |
| kill-mid-tool | `orphan_unaccounted_after_resume` | `gemini` (5/5), `codex` (5/5), `opencode` (5/5), `claude` (5/5), `qwen` (5/5) |
| cancel-tree | `tree_survived_cancel` | `gemini` (5/5) |
| mcp-orphan-exit | `mcp_server_left_running` | `qwen` (5/5) |
| mcp-orphan-kill | `mcp_server_left_running` | `gemini` (5/5), `opencode` (5/5), `claude` (5/5), `xio-node` (5/5), `xio-builtin` (5/5), `qwen` (5/5) |

### What the recorded round observed, per scenario

**baseline.** Every harness that ran it executed the fixture command exactly
once and its output reached the model (5/5 holds; plain `xio` 1/1). This is the
bench sanity check: a violation elsewhere is not an artifact of a harness that
cannot run at all.

**pipe-hold** (root exits, a child holds the output pipe for 20 s). `gemini`
waited for the pipe holder inside the tool call (`tool_call_waited_for_pipe_holder`,
5/5). `claude` and `qwen` returned from the call but left the pipe-holding
process running after the session without saying so
(`process_left_running_after_session`, 5/5 each). `codex`, `opencode` and all
three `xio` variants returned within bounds and left nothing behind.

**orphan-at-exit** (the command starts a descendant in its own session via
`setsid` and returns). All five external harnesses left the escaped process
running 3 s after the session ended, without disclosing it
(`process_left_running_after_session`, 5/5 each). Among the `xio` variants,
only `xio:reaper` held (0 survivors); `xio:node` and `xio:builtin` violated
the same way. This cell measures the execution layer, not the agent loop: the
reaper driver enumerates and reaps descendants that left the process group,
the node driver and the built-in supervisor do not.

**unconfirmed-stop** (the command ignores SIGINT/SIGTERM under the tool's own
time limit). `claude` reported the command as stopped while a tagged process
survived the session (`process_left_running_after_session`, 5/5). `gemini` and
the three `xio` variants have no time-limit parameter on the shell tool
(`not_applicable`), so the property could not be tested on them.

**kill-mid-tool** (the command performs its side effect immediately and keeps
running; the harness is SIGKILLed mid-call, then resumed). The side effect was
**not repeated in any arm** (`effect_executions: 1` in all 5/5 cells): property
(a) held everywhere. What separated the harnesses was properties (b) and (c):

- `gemini`: the resumed session's history did not contain the call at all
  (`call_absent`; `effect_not_in_resumed_history`, 5/5), and 3 tagged processes
  survived the resumed session unmentioned.
- `codex`, `opencode`, `qwen`, `claude`: the resumed history kept the call but
  marked it interrupted/aborted (`result_marked_interrupted`), and 1–2 tagged
  processes survived the resumed session without the resumed session mentioning
  them (`orphan_unaccounted_after_resume`, 5/5 each).
- `xio:reaper`, `xio:node`: 0 survivors, and the resumed session's tool result
  stated the outcome was unknown and to inspect the workspace before acting
  ("tool interrupted: completion unknown for bash; inspect workspace…"). The
  kernel records the operation as indeterminate instead of asserting a result.

**kill-before-report**, **output-flood**, **spawn-failure.** All harnesses that
ran these cells held (5/5): a kill while reporting a completed command did not
repeat the effect and kept the call and its result in the resumed history;
50 MB of output was announced as truncated; a missing binary and `exit 127`
produced distinguishable results.

**cancel-tree** (three-process chain, SIGINT to the harness's process group).
`gemini` left chain processes alive after the interrupt
(`tree_survived_cancel`, 5/5). The others held.

**mcp-orphan-exit / mcp-orphan-kill** (a stdio MCP server registered by the
command's session). `qwen` left the MCP server running after a normal session
end (`mcp_server_left_running`, 5/5). On harness kill, `gemini`, `opencode`,
`claude`, `qwen` and the `xio:node` / `xio:builtin` execution layers left the
server running (5/5 each); `codex` and `xio:reaper` held. Note this is the same
execution-layer split as orphan-at-exit, now through the MCP transport.

### xio re-measurement

The 2026-09-30 round drove `xio` through the pipe-based line REPL that the
pre-UI-batch build fell back to without a TTY. The current build (XioCode
1.6.0 at HEAD, kernel 0.7.0 adopted) changed both relevant paths:

1. Interactive mode requires a TTY (`src/cli/entry.ts` throws
   "Interactive mode requires a TTY terminal" otherwise), and the Ink TUI
   cannot take input over a pipe (`useInput` calls `setRawMode`).
2. One-shot mode (`xio -p`) never auto-allows complex shell — quoted or
   piped commands require an interactive one-time approval that
   `--allow-high-risk` and full mode explicitly do not bypass
   (`src/runtime/command-risk.ts`, `src/runtime/tool-permission.ts`). The
   fixture command is quoted, so one-shot trials block at the permission gate
   (recorded 2026-10-13: `main_requests: 2`, tool result "command blocked
   (complex-shell)").

Re-measuring `xio` on current builds therefore needs a PTY-based adapter
(interactive mode plus the approval prompt the original adapter answered), or
a fixture invocation the proven-safe grammar accepts. Until then, the `xio`
rows above are a labelled historical measurement on the pre-gate build; the
`xio-node` / `xio-reaper` cells (5/5 on the scenarios that matter) are the
citable ones.

### Real-model reproduction status

The bench replays a tape: the harness under test executes exactly the
commands the scenario wants. That makes every cell deterministic and free,
but it also means a violation is, so far, a statement about the harness's
handling of a scripted tool call — not yet about its behavior with a model
choosing the calls. The discipline in this document requires one real-model
reproduction per violation before it is reported as a finding about the
harness.

Status: **not yet done for any cell.** The only real-model authorization on
record is the `opencodego` / `deepseek-v4.1-flash` pilot budget
(`audit/observation/REAL-MODEL.md`: USD 10 cap approved 2026-10-01, USD 6.15
in conservative reservations remaining). That authorization covers the
recovery experiments, and its own next-evidence note warns against spending
the remainder merely to repeat a small favorable fixture. A harness
reproduction (drive one harness with a real model through the fault, then
judge from outside) is a different workload and needs its own authorization
and budget decision before it runs.

### What these results do not establish

- They do not show any harness repeating a side effect: `effect_repeated` was
  never recorded. The kill-mid-tool findings are about unaccounted leftovers
  and missing history, not double execution.
- They do not rank the harnesses. Different harnesses violate different
  properties, and a cell that holds on one scenario says nothing about another.
- They do not measure model behavior: no real model chose a tool call here.
- They do not cover other platforms, newer harness versions, or sandbox and
  hardening options that were off in the recorded configuration.
- They do not establish that any violation is reachable in a user's ordinary
  session; the fixtures are deliberate faults underneath a tool call.

## Recorded round: 2026-10-18 (`xio wrap` dual-boundary cure verification)

Recorded on darwin arm64 27.0.0, Node v26.10.0 (`audit/results/2026-10-18`). All six harnesses (`claude:wrap`, `codex:wrap`, `gemini:wrap`, `opencode:wrap`, `qwen:wrap`, `xio:wrap`) were run through the `xio wrap` dual-boundary gateway (`audit/harnesses/wrap-bin.mjs`), which intercepts upstream LLM wire protocols (`src/gateway/wire-proxy.ts`) and routes tool subprocesses through `ProcessSupervisor` + `ReaperPlatformDriver` (`src/gateway/shell-shim.ts`). Every cell that violated in the 2026-09-30 raw round was verified across 5 trials (`holds 5/5`); see [`wrap-before-after.md`](./wrap-before-after.md) for full mechanism breakdown.

| scenario | `claude-wrap` | `codex-wrap` | `gemini-wrap` | `opencode-wrap` | `qwen-wrap` | `xio-wrap` |
|---|---|---|---|---|---|---|
| baseline | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 |
| pipe-hold | holds 5/5 | holds 1/1 | holds 5/5 | holds 1/1 | holds 5/5 | holds 1/1 |
| orphan-at-exit | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 |
| unconfirmed-stop | holds 5/5 | holds 1/1 | n/a 1/1 | holds 1/1 | holds 1/1 | n/a 1/1 |
| kill-mid-tool | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 | holds 1/1 |
| kill-before-report | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 |
| output-flood | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 |
| cancel-tree | holds 1/1 | holds 1/1 | holds 5/5 | holds 1/1 | holds 1/1 | holds 1/1 |
| mcp-orphan-exit | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 5/5 | holds 1/1 |
| mcp-orphan-kill | holds 5/5 | holds 1/1 | holds 5/5 | holds 5/5 | holds 5/5 | holds 5/5 |
| spawn-failure | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 | holds 1/1 |

## How the round was produced

```bash
node audit/run.mjs --scenario baseline --harness xio,codex,opencode,gemini,claude --trials 5
node audit/run.mjs --scenario pipe-hold --harness codex --trials 5
node audit/run.mjs --scenario orphan-at-exit --harness gemini:wrap,codex:wrap,opencode:wrap,claude:wrap,qwen:wrap,xio:wrap --trials 5
node audit/matrix.mjs audit/results/<date> > matrix.md
node audit/repro/generate.mjs audit/results/<date>
```

Redact transcripts before quoting any of them. Publishing the filled report
is an external action and requires the repository owner's explicit sign-off.
