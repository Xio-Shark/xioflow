# Audit bench

Fault-injection bench for the execution layer of coding-agent harnesses. It answers one question per scenario: when something goes wrong underneath a tool call, does what the harness *says* match what *happened*?

No real model is involved. A local HTTP endpoint impersonates the model service and replays a tape of tool calls, so the harness under test executes exactly the commands the scenario wants, every time, at no API cost. The commands are fault fixtures. The bench then looks at the machine from outside (process table, side-effect ledger, file tree) and compares that with the harness's own account (the tool results it sent back to the "model", its output, its exit code).

This directory is not part of the npm package and is not compiled; it is plain `.mjs` on Node ≥ 22.13 with no dependencies.

## Run

```bash
node audit/run.mjs --scenario baseline --harness xio,codex,opencode,gemini,claude --trials 5
node audit/run.mjs --scenario pipe-hold --harness codex --trials 5
node audit/run.mjs --scenario baseline --harness xio:node      # a variant: same harness, different execution layer
node audit/run.mjs --self-test                                 # drives one harness, then asserts nothing is left behind
node audit/matrix.mjs audit/results/<date> > matrix.md         # harness x scenario table from a results directory
node audit/repro/generate.mjs audit/results/<date>             # one reproduction script per stably violated cell
sh audit/repro/<harness>-<scenario>.sh                        # exit 0 if the violation reproduces 3 times out of 3
node audit/check-isolation.mjs                                 # spot check: real config dirs untouched, no non-local peers
node --test audit/test/endpoint.check.mjs                      # endpoint behaviour: helpers, retries, tape end, barriers
```

Flags: `--trials N`, `--keep` (leave the sandbox for inspection), `--out <dir>` (default `audit/results/<date>/`).

Each trial writes `audit/results/<date>/<scenario>/<harness>/trial-<n>/verdict.json` and `transcript.jsonl`. **`audit/results/` is git-ignored: transcripts contain the harness's full system prompt and local paths. Redact before quoting any of it.**

A verdict is one of:

| verdict | meaning |
|---|---|
| `holds` | the property held |
| `violated` | the property did not hold; `evidence.violations` names how |
| `not_applicable` | the harness lacks the capability (no resume command, no shell tool the endpoint recognises) |
| `inconclusive` | not enough was observed (the command never ran, the harness never reported back) |
| `bench_error` | the bench's own fault: endpoint error, runner exception, or a process left after cleanup |

Only `k/5` with `k ≥ 4` counts as stable.

## Scenarios

| scenario | what the tape makes the harness do, and the fault | property |
|---|---|---|
| `baseline` | run one command | it runs exactly once and its output reaches the model (bench sanity check) |
| `pipe-hold` | a command whose root exits at once while a child keeps the output pipe open for 20 s | the call returns within a bound; nothing is left running after the session |
| `orphan-at-exit` | a command that starts a process in its own session | nothing the command started is still running 3 s after the session, unless the harness said so |
| `unconfirmed-stop` | a command that ignores SIGINT/SIGTERM, called with the tool's own time limit | a result that says "stopped" means the process is gone; nothing is left after the session |
| `kill-mid-tool` | a command that performs a side effect and keeps running; the harness is SIGKILLed mid-call, then resumed | the effect is not repeated; the resumed history still contains the call; the leftover process is gone or mentioned |
| `kill-before-report` | a command completes; the harness is SIGKILLed while reporting the result, then resumed | the effect is not repeated; the resumed history still contains the call and its result |
| `output-flood` | a command prints 50 MB ending in a marker | truncation is announced; if the harness stopped the command, the result says so |
| `cancel-tree` | a command starts a chain of three processes; SIGINT to the harness's process group | no process of the chain survives the harness |
| `mcp-orphan-exit`, `mcp-orphan-kill` | a stdio MCP server is registered; the session ends normally, or the harness is SIGKILLed | the server is not left running |
| `spawn-failure` | a missing binary, then `sh -c 'exit 127'` | the two results can be told apart |

## How a trial works

1. **Sandbox.** A temp directory with `work/` (a git repo: one committed file, one untracked file, `*.tmp` ignored), `home/` (a throwaway `HOME`) and `run/` (fixture markers and the side-effect ledger).
2. **Endpoint.** `endpoint/server.mjs` listens on a random local port and speaks four wire protocols on it: OpenAI Chat Completions, OpenAI Responses, Gemini and Anthropic Messages, all streaming.
3. **Harness.** Started headless in its own process group with a whitelisted environment (`PATH HOME USER LOGNAME SHELL TMPDIR LANG TERM NO_COLOR`) plus the harness's own variables. Nothing from the caller's environment is inherited, so no real token can reach the endpoint or the transcript.
   `HTTP(S)_PROXY` points at a proxy that refuses everything and records what was asked (`observed.outboundAttempts`), so update checks, telemetry and catalog downloads that honour proxy variables stay on the machine.
4. **Scenario.** `drive(ctx)` may wait for fixture markers or endpoint events and inject faults; timing is aligned on those events, never on sleeps.
5. **Observe and judge.** `judge(observed)` returns the verdict and its evidence.
6. **Cleanup.** Harness process groups are killed, then every process carrying the run's tag or referencing the sandbox path. If anything is still there afterwards, the trial is `bench_error`. The sandbox is deleted.

### The endpoint

- A request that offers tools is a **main** request and consumes the next turn of the tape. A request without tools is a **helper** (opencode's title generation, gemini's routing classifier, Claude Code's `HEAD /api/hello`): it gets a fixed short answer, shaped to the requested JSON schema if there is one, and does not advance the tape.
- A retry of the same conversation replays the same turn. When the tape runs out, the harness gets a closing line and the result records `tape_exhausted`.
- The harness's shell tool is discovered from the `tools` it sends (`endpoint/tool-discovery.mjs`), so a tape only says `{ "type": "tool_call", "action": "shell", "command": "..." }`.
- The transcript is the harness's account: `toolResults` of the last main request is everything it told the model about its tool calls.

Tape format is `xio-agent-tape.v1` (the format of xiocode's scripted provider): `turns → steps`, with step types `delta`, `tool_call`, `usage`, `error`, `hang`, `barrier`, `done`. A `barrier` holds the response until the scenario calls `ctx.endpoint.release(id)`. Placeholders: `{{xf}}` (the fixture command line, tagged for this run), `{{work}}`, `{{run}}`, `{{tag}}`.

### The fixture

`node fixture/xf-fixture.mjs <subcommand> --xf-run=<dir> --xf-tag=<runId>`. Every process it starts carries the tag in its argv and exits on its own after `--xf-ttl` seconds (default 120).

| subcommand | behaviour | used to check |
|---|---|---|
| `effect <id>` | appends one line to `run/effects.log`, exits 0 | a side effect happens at most once |
| `slow-effect <id> <ms>` | performs the effect, exits only after `<ms>` | the "done but not yet reported" window |
| `hold-pipe-after-exit <secs> [--exit=N]` | root exits at once; a child in the same group keeps stdout/stderr open | does a tool call wait for the pipe holder |
| `spawn-tree <depth>` | a chain of sleeping children | does stop clear the whole tree |
| `escape-setsid` | starts a descendant in its own session | are escaped processes found |
| `ignore-signals` | ignores SIGINT / SIGTERM / SIGHUP | does stop escalate and confirm |
| `flood-output <bytes> --tail=<marker>` | prints that many bytes, then the marker | silent truncation, tail retention |
| `write-files` | edits a tracked file, deletes an untracked one, writes an ignored one | what undo covers |
| `mcp-server` | minimal stdio MCP server that does not exit on stdin EOF | MCP children left behind |

Each writes `run/<name>.started` (pid and time) so a scenario can align on it.

## Harnesses

| harness | launched as | pointed at the endpoint by | tools run without prompting because |
|---|---|---|---|
| `xio` | line REPL over a pipe (see below) | `XIO_CONFIG` with an `openai`-kind provider | `[trust] mode = "trust"`, `[permissions] allow_high_risk = true`, and the driver answers `y` to each one-time approval |
| `codex` | `codex exec --skip-git-repo-check -s workspace-write` | `-c model_providers.mock=… -c model_provider="mock"`, `CODEX_HOME` | `exec` never prompts |
| `opencode` | `opencode run --standalone --auto --format json` | `OPENCODE_CONFIG` with an `@ai-sdk/openai-compatible` provider, `XDG_*` | `--auto` |
| `gemini` | `gemini -p … --approval-mode yolo -o json --skip-trust` | `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, pinned auth type in `~/.gemini/settings.json` | `--approval-mode yolo` |
| `claude` | `claude -p … --output-format json --allowedTools Bash` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` | only `Bash` is pre-approved |
| `qwen` | `qwen -p … --approval-mode yolo`, binary from `XF_QWEN_BIN` (an isolated `npm install --prefix`) | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, auth type pinned in `~/.qwen/settings.json` | `--approval-mode yolo` |

`xio` has variants that change only the execution layer: `xio:reaper` (`XIOCODE_KERNEL_DRIVER=reaper`), `xio:node` (`XIOCODE_KERNEL_DRIVER=node`), `xio:builtin` (`XIOCODE_PROCESS_KERNEL=0`).

## Known limits

- **A fake endpoint is not a real model.** Timing, helper calls and retry paths can differ. Every violation found here should be reproduced once with a real model before it is reported.
- **These are headless default configurations**, plus the minimum needed to let a shell command run. Many harnesses have sandbox or hardening options that change the outcome; a finding has to say whether such an option exists.
- **macOS arm64 only so far.**
- **`xio -p` cannot be audited.** A non-interactive xio session runs only `pwd`, `true`, `false` and `ls` without approval and refuses every other command, with no flag to lift that. The driver uses the line REPL instead and answers its approval prompts.
- **The `xio` rows test a development build**: the `xio` on this machine is linked to the xiocode working tree, so its rows reflect that tree (including fixes made while this bench was built) and the kernel build installed there, not a published release. The results' `versions.json` records the resolved binary.
- **codex runs with `-s workspace-write`**, because `codex exec` defaults to a read-only sandbox in which the fixture cannot write its markers. The sandbox's temp dir is writable under that policy, which is where `run/` lives.
- **Interactive TUIs are not driven.** Scenarios that need an in-session command (undo, rewind) need a PTY driver or the harness's SDK.

## Add a harness

1. `harnesses/<name>.mjs`: export `{ name, bin, versionArgs, launch(ctx), resume?(ctx) }`. `launch` writes any config into `ctx.home` and returns `{ args, env }` (`ctx` has `home`, `work`, `baseUrl`, `prompt`). Return `interact` as well if the harness has to be driven through a line interface.
2. Register it in `harnesses/index.mjs`.
3. If it speaks a protocol the endpoint does not know, add `endpoint/wire/<protocol>.mjs` (`matches`, `parse`, `open`, `aux`) and list it in `endpoint/server.mjs`. Record a real request first and write the replies against that, not from memory.
4. `node audit/run.mjs --scenario baseline --harness <name> --trials 5` must be `holds 5/5` before any fault scenario on it counts.
5. Add its real config directories to `check-isolation.mjs` and run it.

## Add a scenario

1. `scenarios/<name>.mjs`: export `{ name, prompt, tape, timeoutMs, drive?(ctx), judge(observed) }`.
   - `ctx`: `start(kind = 'launch')` returns `{ pid, exited, exit }`; `waitForFile(marker)`, `waitForRequest(predicate)`, `kill(launch, signal)`, `tagged()`, `sleep(ms)`, `endpoint.release(barrierId)`, `notes` (free-form, ends up in `observed.notes`).
   - `observed`: `launches`, `effects`, `markers`, `survivors`, `requests`, `toolCalls`, `toolResults`, `endpoint`, `notes`, `timedOut`.
2. Register it in `scenarios/index.mjs`.
3. State the property in the file header, and put every number the verdict rests on into `evidence`.

## Other experiments in this directory

- `observation/` measures how many of xiocode's parallel-edit conflicts are false conflicts, by replaying a worker's recorded observations on the workspace as it is when its commit is refused.
- `behavior/` is the experiment on what a model does after a tool call with an unknown outcome. It gives a **real** model a shell, so every command runs inside a deny-by-default `sandbox-exec` profile (`sandboxProfile` in `behavior/environment.mjs`): no reads outside the run's own directories, no view of other processes, no network except the run's local service. `node audit/behavior/selftest.mjs` asserts each of those denials and must pass before any model is called.
- `freshness/` is the prototype and the experiments for evidence with observed dependencies.
