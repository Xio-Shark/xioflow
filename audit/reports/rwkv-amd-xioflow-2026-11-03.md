# RWKV on AMD and XIO-ISA continuation

Status: **PASS WITH CONCERNS** for deployment and the bounded ISA preview work.
The complete XIO-ISA plan is still in progress; this report does not declare v1
stability, a completed long soak, or external adoption.

Latest instruction (`2026-11-03 19:40:26 Asia/Shanghai`): the user cancelled
xioflow integration to focus on standalone RWKV. The owned long-run controller
and children have stopped, no active owned processes remain, and 7d never
started. The 24h target is incomplete. Code and all existing evidence remain
preserved; the model service is still independently healthy (HTTP 200).
Historical RUNNING observations below are superseded by
`../results/w7900d-rwkv-20261103/evidence/cancellation.json`. No automatic
integration or soak restart is authorized by this paused experiment.

## Deployed runtime

The authorized Linux container exposes one `gfx1100` GPU with 96 CUs and
51,522,830,336 VRAM bytes. Its reported name is `AMD Radeon Graphics`; the user's
W7900D description is not substituted for the observed device name. The cgroup
allocation is 16 CPU equivalents and 55 GiB RAM. Host-visible 128 CPUs/503 GiB
are not dedicated resources. The cgroup filesystem is read-only.

The active inference backend is llama.cpp HIP, commit
`740251a920abf92b7744d9c0518ca157db0db579`. Actual process mappings include
`libggml-hip`, `libamdhip64` and `librocblas`. This is AMD GPU execution, not a
silent CPU fallback. The service uses one slot, context 4096, FP16 weights,
batch/ubatch 128 and eight CPU threads.

- Loopback API: `http://127.0.0.1:8650/v1`
- Health: `GET /health`
- Model alias: `rwkv7-g1k-2.9b`
- Detached supervisor/server at verification: PID 29583 / 29584.
- Experiment root: `/root/code/experiments/xioflow-rwkv-20261103`.
- Node `v24.22.2`, pnpm `10.32.1`, and jq `1.8.2` are installed in the private
  experiment toolchain, without replacing system Node or GPU drivers.

The model service is supervised independently of SSH. Commands on the server:

```bash
python3 /root/code/experiments/xioflow-rwkv-20261103/model-service/service.py status
python3 /root/code/experiments/xioflow-rwkv-20261103/model-service/service.py stop
python3 /root/code/experiments/xioflow-rwkv-20261103/model-service/service.py detach
```

The controller verifies executable and process-start identity before stopping a
recorded PID. No public listener, global service or shared driver was added.

## Model identity

Source repository: `BlinkDL/rwkv7-g1`, revision
`11e3c50128e479898eee79c48831a95cf3e21d91`. The original checkpoint was downloaded
through a mirror and checked against its official LFS SHA256 before conversion.
The `.pth`, inactive Ai00 `.st`, and active GGUF are the same checkpoint.

```text
active file: models/rwkv7-g1k-2.9b-20260930-ctx25600-f16.gguf
bytes: 5932472192
sha256: f8248873498a72e8f4076e9fe9276d10271f2d34dc8cb83bf0eb6bd57232ecfb

original pth bytes: 5896273469
original pth sha256: d8f8ecd4af8d706f867ac8a74284f35c0e3b9f863e7b09bb4d4031480c8b28b2
```

Initial deployment files total approximately 19.48 GB, below the 25 GB initial
download/build gate. Million-token GGUF metadata is not exact-recall evidence;
the checkpoint name says ctx25600 and the service uses 4096.

## Real model-to-kernel smoke

`scripts/rwkv-xio-smoke.mjs` asks the real model to choose one of three actions
using schema-constrained JSON generation. The host constructs a bounded Program;
the model never supplies arbitrary shell commands or authority objects.

| Synthetic goal | Model action | Independent check | Result |
| --- | --- | --- | --- |
| Preserve the workspace before modification | snapshot | Real capture, fixture modification and rollback restore original bytes | PASS |
| Inspect kernel health only | health | Returned domain identity matches the host | PASS |
| Delete a system directory outside the permitted actions | unsupported | No operation is registered for the request | PASS |

The first smoke measured 396/313/345 ms for these requests, with shared-prefix
caching and a warm service. This is three synthetic cases, not a routing
accuracy benchmark, calibration result, cold-start measurement or validation of
general coding-agent capability. It is not the zero-generation rwkv-jev engine.

Raw evidence is under
[`../results/w7900d-rwkv-20261103`](../results/w7900d-rwkv-20261103), including
runtime/model manifests and the complete initial smoke response.

## Engineering changes

- Pipeline joins now bind opId to canonical input identity. Conflicting input is
  rejected; external preconditions require an explicit verifier and fail closed.
- A host-bound ISA executor reuses the existing domain, supervisor, capability,
  journal and snapshot/rollback implementation. Its supported set is snapshot,
  rollback, status and health. Unsupported Programs are rejected before a
  supported prefix can execute. Terminal Runs are not reopened for side effects.
- Snapshot IDs remain opaque: safe legacy refs retain their old names; unsafe
  IDs use an independent encoded Git namespace. Capture, retention and prune
  preserve outside files and artifact ownership.
- MCP and CLI share an ISA adapter; `isaOnly` structural planning creates no
  domain. Request cancellation reaches the binding barrier and pipeline without
  inventing cancellation of already completed effects. Control lookup resolves
  ISA instruction identity and prevents cross-Run lease disclosure.
- Linux stopping/recovery distinguish active processes from stopped zombies.
  Real `unreapedPids` are retained through stop, process results and recovery;
  missing observations remain unknown. The unknown exit status remains null.
- Test orchestration separates Vitest from seven native `node:test` research
  suites. Missing inventories and failed phases fail visibly; no paid model
  runner is invoked by these local research tests.
- Conformance reporting separates catalog declarations, runnable tests and
  unsupported capabilities, and records source/build identities. Clean-package
  checks include the ISA SDK subpath and CLI stdin planning.
- Soak checks retain failed journals/artifacts and provide progress plus explicit
  RSS/database stop gates. Unreaped PIDs prevent an unqualified passing result.

## Validation evidence

- macOS full run before the final recovery-only change: 899 Vitest tests passed,
  7 platform skips; all 60 native research tests passed, exit 0.
- Final local recovery/crash/stop/soak regression: 127 tests passed, exit 0.
- Final local stop/contract/gateway regression: 133 tests passed, exit 0.
- Clean package: 23 embedder checks, including SDK/CLI ISA preview, exit 0.
- TLA: 157 Node and 139 reaper distinct states checked without an error.
- Registry/schema/capability/doc checks pass; conformance's raw 57 passing tests
  are classified as 55 passed plus two unsupported hard-limit execution cases
  whose rejection checks passed.
- Both conformance JSON artifacts passed full Draft 2020-12 validation using
  jsonschema 4.25.1 in a temporary private environment.
- Linux full validation of the final frozen source is recorded separately below;
  earlier failed runs and independent before/after process probes are preserved.

The final source archive and per-file manifest identify uncommitted work without
pretending HEAD alone identifies it. No commit, push or publication was performed.

## Preserved failures and remaining gates

Ai00 v0.7.1 selected the AMD Vulkan device but lost the device context during
loading. Its failed logs remain on the server; that backend is disabled. Two
adopted zombie records remain under the container's Jupyter PID 1. They have no
active executable or model allocation and cannot be removed with another kill.
The host/container was not restarted. An idle GFX activity counter still reads
100%; it is not used as throughput or workload evidence.

The original plan is updated with partial completion, not checked off wholesale.
Full durable filesystem/process opcode execution, transaction mode, stable result
projection, legacy wrap/tool migration, complete four-adapter corpus equivalence,
and the remaining release/security work still require implementation. Actual
24h/7d runs, delegated cgroup/platform evidence, independent adoption and three
compatible minor releases cannot be replaced by this smoke or short preflight.

The current scope deliberately remains preview. There is no stable 1.0/LTS claim.

## Final Linux verification and running soak

Frozen source archive SHA256:
`d7db41251f5551f3a67c765f94cfee671d728ddb853c6be85dbada9c4c6af1cb`.
The 331-file archive is 967,519 bytes. Its copy and per-file manifest are in the
local evidence directory. Runtime code is also deployed at the experiment's
`xioflow/`; long verification uses the separate immutable-by-convention checkout
`checkouts/d7db41251f5551f3`.

`xioflow-final-verify-20261103.sh` completed with **exit 0**. Its individual logs
and receipts are in
[`../results/w7900d-rwkv-20261103/validation-d7db41251f5551f3`](../results/w7900d-rwkv-20261103/validation-d7db41251f5551f3).

| Check | Result |
| --- | --- |
| Build, native Linux helper/shim, typecheck | PASS |
| `pnpm test --maxWorkers=2` | 902 Vitest passed, 8 conditional skips; all 60 native research tests passed |
| Registry/schema/capability matrix/document heading checks | PASS |
| Conformance report | Raw 57 passed; 55 execution cases passed, 2 unsupported hard-limit cases rejected correctly |
| Clean-package SDK/CLI checks | 23 passed |
| Repeatable adapter benchmark | 11 scenarios, failureRate 0 including expected failure/indeterminate outcomes |
| 30-second reaper preflight | 271 cycles, 55 journal-fault injections, 13 host-process crash probes; zero active residuals, unreaped PIDs, lease leaks or ISA failures |

The benchmark uses the research adapter/filesystem harness. It does not prove
full durable ISA/SQLite/IPC throughput or model cost savings. The preflight is
explicitly `PASS_WITH_CONCERNS` and `completedTargetDuration=false`.

The final deployed source also passed the real model integration a second time:
snapshot, health and unsupported each passed; warm request latencies were
635/325/359 ms. The final JSON and a closed-domain journal/workspace archive are
preserved in the evidence directory. Both local and Linux conformance artifacts
passed complete JSON-Schema validation.

A detached long-run controller (PID 117060) started its real **24h** profile at
`2026-11-03 19:07:25 Asia/Shanghai`. Its source checkout is the frozen hash above.
The initiating SSH connection was explicitly closed, and a separate SSH
connection confirmed the same controller and increasing progress remained alive.

```text
remote validation directory:
/root/code/experiments/xioflow-rwkv-20261103/evidence/validation-d7db41251f5551f3

current stage: long-soak/current-stage.txt
progress: long-soak/24h.json.progress.json
terminal report: long-soak/24h.json
controller outcome: long-soak/controller.exit
```

The child uses the native reaper, a 512 MiB V8 old-space setting, a 2 GiB observed
RSS stop gate and a 2 GiB database/WAL/SHM stop gate. Failed runs retain their
journal and artifacts. Only an actual PASS with completed target duration and no
residual/lease failures permits the controller to start 7d; any nonzero command or
unqualified report stops the sequence. This does not automatically check off the
original plan or establish that memory growth is acceptable; the full measured
trajectory still needs review. At handoff, 24h is **RUNNING**, not completed.

The independent handoff observation at `2026-11-03 19:20:35 Asia/Shanghai`
confirmed HTTP 200 model health and the original controller/Node process
identities. Progress was 2,080 cycles, 778,516 ms, RSS 536,834,048 bytes,
database/WAL/SHM 61,026,144 bytes and zero active handles. These are a point in
the growing trajectory, not proof of a plateau. No terminal 24h report or
controller outcome existed. Raw observation: `evidence/handoff.json` in the
local evidence directory.

A follow-up confinement check addressed the fact that historical conditional
tests can return early without appearing as skips. On this same frozen Linux
checkout, the native helper reported `landlock-abi 4`; the selected real
Landlock outside-write/inside-write test then passed, exit 0 (the other 20
tests were intentionally filtered out). Its log is
`evidence/landlock-targeted.log`. This proves that specific Linux boundary on
this container; it does not supply delegated cgroup or cross-driver evidence.
