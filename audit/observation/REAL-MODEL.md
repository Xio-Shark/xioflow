# Real-model recovery pilot

## Authorization and scope

User approved `opencodego` / `deepseek-flash` with a cumulative USD 10 cap on
2026-10-01. The configured model resolves to `deepseek-v4.1-flash`; successful
responses reported that same model id. The experiment sends generated fixture
code and generic tool schemas, not xioflow/xiocode repository source or personal
instructions. File tools are rooted in temporary synthetic repositories.

The xiocode-stored Go credential returned HTTP 401. The Go credential stored by
OpenCode was different and succeeded. `--opencode-auth` explicitly selects that
source; no credential was copied into the repository or global config changed.
No other provider was tried.

## Reproduce

```sh
node --test audit/test/go-budget.check.mjs
node audit/observation/e8.mjs --probe --opencode-auth
node audit/observation/e8.mjs --opencode-auth
node audit/observation/e8.mjs --opencode-auth --resume-first
node audit/observation/e8.mjs --opencode-auth --scenario new-caller --resume-first
node audit/observation/summarize-e8.mjs
```

The probe and experiment commands can make paid requests; the summary cannot. The
budget ledger under `audit/results/real-model/` persists across invocations.
Do not remove it to rerun experiments under the same authorization.

## Budget enforcement

[OpenCode Go pricing](https://opencode.ai/docs/go/) checked on 2026-10-01 lists
peak DeepSeek V4.1 Flash rates of USD 0.30 input / 1.20 output per million tokens.
The ledger reserves USD 0.05 before each HTTP request, covering 128k input and
8192 output tokens without cache discounts. It permits only the approved Go
endpoint/model, non-stream responses and bounded request/output sizes. The
client requests at most 4096 output tokens and disables automatic retries.

Reservations never reset on process restart or failed requests. The SQL
transaction rejects the next request before network access when reservations
would exceed USD 10. Missing usage remains unknown, not zero cost. Reported usage
also produces a peak-rate estimate; this is not an account invoice or an exact
subscription-quota charge. Unit tests cover persistent caps, lost responses,
invalid endpoints and missing usage.

## Workload and measurement

The model renames `foo` to `bar` across a generated three-file ES module project.
It pauses after its first mutation. The experiment then adds a comment to a
caller in the main workspace, representing a competing edit. Both strategies
receive this changed workspace: one starts a new agent; the other reconstructs
and resumes a validated prefix. They share the sunk initial work.

The existing xiocode agent loop and file tools execute real model tool calls.
The prompt asks for one call per response but the model is not forced into a
scripted tool sequence (one trial returned multiple calls). Node executes the
resulting modules and checks the renamed export, absent old export, behavior on
three inputs, caller output, preserved comment and absence of extra files.
Children receive a minimal environment, not provider credentials.

Reports contain usage and checks, not raw credentials or model transcripts.
All three paired trials are retained, including the resumed-first ordering.

## First three paired trials

| Trial | Order | Baseline requests | Resumed requests | Reused observations | Baseline peak USD | Resumed peak USD | Both checks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| e8-37474b21 | baseline first | 9 | 7 | 2 | 0.0047628 | 0.0039048 | pass |
| e8-f6462808 | resumed first | 9 | 7 | 2 | 0.0046506 | 0.0039801 | pass |
| e8-557c6d3a | baseline first | 9 | 6 | 3 | 0.0046977 | 0.0035832 | pass |

Post-change totals: 27 versus 20 requests; peak-rate estimates USD 0.0141111
versus 0.0114681 (18.7% lower observed in resumed work). All three held-out checks passed
in both arms. This is evidence of a working mechanism on this fixture, not
proof of superiority across coding tasks or of research novelty.

There is no speed win in these observations: baseline model/tool execution
totaled 48.937 seconds; reconstruction plus resumed execution totaled 55.629
seconds. The first three baseline timings excluded fork creation, so that is
not an exact end-to-end comparison. Later runner versions record baseline
preparation separately. Provider latency varies; larger counterbalanced samples
and more workloads are needed before making speed claims.

Including initial work and successful probe: 62 accounted requests had a
peak-rate estimate of USD 0.0312699. One additional HTTP 401 request supplied no
usage. Total conservative reservations for all 63 requests were USD 3.15.
These are the pilot's recorded values; the live ledger is authoritative for
remaining authorization if more experiments run.

## Semantic change: a new caller

`--scenario new-caller` starts with eight files. After the first mutation it adds
a ninth module that still imports `foo`, creating a new rename obligation. The
hidden checker imports the added module, verifies its behavior, and checks its
preserved marker and the exact expected file set. Local negative tests prove
that missing this caller, changing its behavior or deleting competing work fails.

The first attempt (`e8-fe42bae1`) stopped with an adapter assertion on a tool
error; it is retained as an experiment error, not a passing pair. The adapter
had assumed every tool call succeeded. Removing that assertion preserves the
tool error in both model context and the observation log, matching the existing
agent loop. A local test exercises edit-before-read rejection, then a model
response that reads and successfully edits. The next real trial did not itself
produce tool errors, so it is not a replay of the exact failed trajectory.

The corrected trial (`e8-4b97d09f`) passed both arms. Its first `glob` observation
changed, so recovery retained **zero observations** and restarted from the
initial checkpoint. One tool replay disproved nine later boundaries, with two
physical candidate forks. The model updated and executed the new caller.

| Quantity | Whole restart | Recovery from initial checkpoint |
| --- | ---: | ---: |
| Requests | 21 | 14 |
| Peak-rate estimate USD | 0.0166098 | 0.0142428 |
| Execution milliseconds | 37926.817 | 40087.140 |
| Preparation/reconstruction milliseconds | 145.841 | 265.369 |

**The request/cost gap cannot be attributed to history reuse: there was none.**
Both arms started from the same task and changed workspace, but the model chose
different tool sequences. This negative control weakens a causal interpretation
of the earlier 18.7% gap. Those three small pairs are descriptive results, not
proof of savings caused by the kernel. Summaries now separate scenarios and
retain aborted trials instead of pooling unlike tasks into an improvement rate.

After these trials the ledger had 123 requests, USD 6.15 in conservative
reservations, USD 0.0738282 in accounted peak estimates and one unaccounted HTTP
401. These remain below the original USD 10 cap. No additional model calls were
made merely to obtain a more favorable result.

## Next evidence

Control model-run variation before attributing cost differences to recovery. Compare
initial work, reconstruction cost and post-change inference separately; report
failed trials rather than selecting successful samples. Do not spend the
remaining authorization merely to repeat the same tiny favorable fixture.
