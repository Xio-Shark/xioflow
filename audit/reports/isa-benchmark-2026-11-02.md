# XIO-ISA D-06 可重复 benchmark — 2026-11-02

**任务：** D-06  
**原始结果：** [audit/results/isa-benchmark.json](../results/isa-benchmark.json)  
**运行命令：** `pnpm benchmark:isa`  
**采样参数：** 默认 `XIOFLOW_BENCH_ITERATIONS=10`；大输出、四路并发和 replay 场景各采样 5 次（避免把并发放大倍数误算成单次延迟）。

## 运行环境与边界

| 字段 | 值 |
| --- | --- |
| Node.js | `v26.12.0` |
| 平台 | `darwin arm64` |
| CPU | `10` |
| 驱动 | ISA `plan`/`pipeline` adapter + 本地 filesystem benchmark executor |
| 小工作区 | `8` 个文件 |
| 大工作区 | `128` 个约 1 KiB 文件 |
| 大输出 | `1 MiB` `artifact.put` |
| 冷启动 | 每个样本启动一个新的 Node 进程 |
| 持久化 | 本基准不启用 SQLite journal/WAL |

该报告测量的是公开 `execute`、`executePipeline`、`PipelineDomainCoordinator` 边界和一个可重复的本地执行器；它不代表真实进程 driver、SQLite/WAL、IPC、网络或跨平台性能。工作区 fixture 在计时前创建，样本完成后删除。

`failureRate` 表示异常或返回状态与该场景 `expectedStatus` 不一致的比例；`nonSuccessRate` 用来显示故意覆盖的 `failed`/`indeterminate` 场景，不把预期的失败状态误报成 benchmark harness 失败。

## 结果

| 场景 | 次数 | p50 ms | p95 ms | p99 ms | failureRate | nonSuccessRate | 状态 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `plan.cold-start` | 10 | 83.697 | 85.516 | 85.516 | 0 | 0 | `admitted=10` |
| `plan.hot-small` | 10 | 0.063 | 1.303 | 1.303 | 0 | 0 | `admitted=10` |
| `plan.hot-big` | 10 | 0.375 | 0.778 | 0.778 | 0 | 0 | `admitted=10` |
| `pipeline.single-instruction` | 10 | 0.067 | 0.720 | 0.720 | 0 | 0 | `succeeded=10` |
| `pipeline.multi-instruction` | 10 | 0.531 | 1.404 | 1.404 | 0 | 0 | `succeeded=10` |
| `pipeline.big-workspace` | 10 | 2.985 | 3.572 | 3.572 | 0 | 0 | `succeeded=10` |
| `pipeline.big-output` | 5 | 0.617 | 0.884 | 0.884 | 0 | 0 | `succeeded=5` |
| `pipeline.concurrent-four` | 5 | 0.430 | 0.569 | 0.569 | 0 | 0 | `succeeded=5` |
| `pipeline.replay-join` | 5 | 0.110 | 0.331 | 0.331 | 0 | 0 | `succeeded=5` |
| `pipeline.failure` | 10 | 0.009 | 0.035 | 0.035 | 0 | 1 | `failed=10` |
| `pipeline.indeterminate` | 10 | 0.008 | 0.016 | 0.016 | 0 | 1 | `indeterminate=10` |

## 证据判读

- plan 冷启动和热路径均返回 `admitted`，小/大工作区路径没有异常样本。
- 单指令、多指令、大工作区、大输出、四路并发和 in-flight replay join 均返回 `succeeded`，对应 `failureRate=0`。
- failure fixture 每次返回 `failed`，indeterminate fixture 每次返回 `indeterminate`；两者的 `nonSuccessRate=1` 是预期状态覆盖，不是 harness 异常。
- 所有场景的 `failureRate` 均为 `0`。报告中的延迟是本机单次运行证据，不外推为 Linux、WSL2、Windows 或真实 supervisor/driver 的 SLA。

## 复现

```bash
pnpm benchmark:isa
XIOFLOW_BENCH_ITERATIONS=20 pnpm build && node scripts/isa-benchmark.mjs
XIOFLOW_BENCH_OUTPUT=/tmp/isa-benchmark.json pnpm build && node scripts/isa-benchmark.mjs
```

`XIOFLOW_BENCH_ITERATIONS` 接受 `3..100` 的整数；脚本会把临时 fixture 和最终 JSON 写入参数指定的位置，默认写入 `audit/results/isa-benchmark.json`。
