# 自动因果刷新的验证成本基准

运行 `pnpm benchmark:refresh [trials] [branches] [hashRounds] [changedBranches]`，默认 `3 4 1000 1`。JSON 包含环境版本、逐轮原始数据和均值 / 中位数。构建后可用 `node scripts/benchmarks/causal-refresh.mjs 3 4 1000 1 > report.json` 保存纯 JSON。三种模式各自创建全新 Git 工作区，轮换运行次序；初始化和最终正确性检查不计入耗时。

每个独立分支有两个真实工具：读取输入、读取同一输入并经指定轮数 SHA-256 计算后写入输出。读取节点是写入节点的因果上游。每轮改变指定数量的输入，位置随 trial 轮换。工具在所在工作区重新读取文件，无跨分叉缓存或模拟延时。

| 模式 | 流程 | 提交保证 |
| --- | --- | --- |
| `full-rerun` | 新事务完整执行所有分支 | `observationPolicy: 'always'` 完整重放 |
| `causal-refresh` | 调用 `refreshWorkspaceCausalBranches`，自动发现变化、重算、提交 | 同样完整重放，包括复用祖先 |
| `unchecked-reuse` | 保留旧输出 | 不验证、不提交 |

计数按实际回调调用分别记录：`executionToolCalls`（生成 / 重算）、`probeToolCalls`（探测）、`reuseToolCalls`（新修复基线上的复用验证）、`commitReplayToolCalls`（提交重放）。`totalToolCalls` 包含四者。复用验证会按拓扑重放完整的独立未变分支并检查哈希，也会重现写入效果。`transactionsStarted`、`snapshotsCaptured` 来自计时区间的真实 journal 事件；快照内部 Git 操作不算工具调用，但计入端到端 `elapsedMs`。`commitValidation` 用于核查发布确实经过观测验证。

对于 B 个分支、C 个变化输入（0 < C ≤ B），完整重跑执行 2B 次、提交重放 2B 次，总计 4B。刷新执行 2C 次，探测 2B−C 次，复用验证 2(B−C) 次，提交重放 2B 次，总计 6B−C。**减少生成工具调用不等于减少总工具调用或耗时**；此确定性工具负载刻意暴露重复验证成本，为后续验证复用优化提供基线。C=0 时刷新只探测 2B 次，返回 `unchanged`，无需修复与提交。

正确性逐个比较输出与独立计算的当前输入期望值，同时保存输出哈希。任一受验证模式结果错误或发布失败时 CLI 非零退出。未校验模式在有变化时有 C 个错误输出，无变化时正确；它只是直接复用对照，不代表完整的无监督 agent。基准没有模型、外部副作用、并发写入或共享祖先，`modelTokens: null`，不据此声称 token 节省或模型任务成功率。

快速覆盖：`pnpm benchmark:refresh 1 4 1000 0`（无变化）、`pnpm benchmark:refresh 1 4 1000 1`（局部变化）、`pnpm benchmark:refresh 1 4 1000 4`（全部变化）。实际重放 / 提交语义见 [因果验证](causal-validation.md)。

[完整原始 JSON](benchmarks/causal-refresh.sample.json)：2026-10-08 本地默认配置（3 轮、4 分支、1000 次哈希、1 个变化输入）：完整重跑 / 刷新均 3/3 正确，直接复用 0/3；生成调用 8→2，总调用 16→23，中位耗时约 188→296 ms。耗时随机器和负载变化，不设性能阈值。
