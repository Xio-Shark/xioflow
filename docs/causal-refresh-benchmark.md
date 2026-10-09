# 自动因果刷新的验证成本基准

运行 `pnpm benchmark:refresh [trials] [branches] [hashRounds] [changedBranches] [reusePasses] [estimatedReusePasses]`，默认 `3 4 1000 1 1 1`。JSON 包含环境版本、逐轮原始数据和均值 / 中位数。构建后可用 `node scripts/benchmarks/causal-refresh.mjs 3 4 1000 1 > report.json` 保存纯 JSON。五种模式各自创建全新 Git 工作区，轮换运行次序；初始化和最终正确性检查不计入耗时。

默认每个独立分支有两个真实工具：读取输入、读取同一输入并经指定轮数 SHA-256 计算后写入输出。读取节点是写入节点的因果上游。每轮改变指定数量的输入，位置随 trial 轮换。工具在所在工作区重新读取文件，无跨分叉缓存或模拟延时。

| 模式 | 流程 | 提交保证 |
| --- | --- | --- |
| `full-rerun` | 新事务完整执行所有分支 | `observationPolicy: 'always'` 完整重放 |
| `causal-refresh` | 调用 `refreshWorkspaceCausalBranches`，自动发现变化、重算、提交 | 同样完整重放，包括复用祖先 |
| `causal-refresh-reuse` | 同上，启用 `replayReuse: 'baseline_observations'` | 同样完整重放，缓存只用于探测 |
| `causal-refresh-adaptive` | 观测复用刷新加成本模型，选择增量或完整选中子图重算 | 同样完整重放，成本估算不能授权复用 |
| `unchecked-reuse` | 保留旧输出 | 不验证、不提交 |

计数按实际回调调用分别记录：`executionToolCalls`（生成 / 重算）、`probeToolCalls`（探测）、`reuseToolCalls`（新修复基线上的复用验证）、`commitReplayToolCalls`（提交重放）。`totalToolCalls` 包含四者；`reusedProbeSteps` 单列实际跳过的探测回调，不计为工具调用。复用验证会按拓扑重放完整的独立未变分支并检查哈希，也会重现写入效果。`transactionsStarted`、`snapshotsCaptured` 来自计时区间的真实 journal 事件；快照内部 Git 操作不算工具调用，但计入端到端 `elapsedMs`。`commitValidation` 用于核查发布确实经过观测验证。

默认 reusePasses=1 时，对于 B 个分支、C 个变化输入（0 < C ≤ B），完整重跑执行 2B 次、提交重放 2B 次，总计 4B。刷新执行 2C 次，探测 2B−C 次，复用验证 2(B−C) 次，提交重放 2B 次，总计 6B−C。**减少生成工具调用不等于减少总工具调用或耗时**；此确定性工具负载刻意暴露重复验证成本，为后续验证复用优化提供基线。C=0 时刷新只探测 2B 次，返回 `unchanged`，无需修复与提交。

正确性逐个比较输出与独立计算的当前输入期望值，同时保存输出哈希。任一受验证模式结果错误或发布失败时 CLI 非零退出。未校验模式在有变化时有 C 个错误输出，无变化时正确；它只是直接复用对照，不代表完整的无监督 agent。基准没有模型、外部副作用、并发写入，`modelTokens: null`，不据此声称 token 节省或模型任务成功率。

默认独立分支不共享节点，启用观测复用不会减少调用，作为缓存对照。

快速覆盖：`pnpm benchmark:refresh 1 4 1000 0`（无变化）、`pnpm benchmark:refresh 1 4 1000 1`（局部变化）、`pnpm benchmark:refresh 1 4 1000 4`（全部变化）。实际重放 / 提交语义见 [因果验证](causal-validation.md)。

[完整原始 JSON](benchmarks/causal-refresh.sample.json)：2026-10-08 本地默认配置（3 轮、4 分支、1000 次哈希、1 个变化输入）：完整重跑 / 刷新均 3/3 正确，直接复用 0/3；生成调用 8→2，总调用 16→23，中位耗时约 188→296 ms。耗时随机器和负载变化，不设性能阈值。


## 共享祖先的端到端对照

加 `--shared` 创建一个所有分支依赖的 `shared.txt` 纯观测节点；每个分支随后读取自己的输入，写入工具计算 `shared + "\n" + input` 的哈希。加 `--change-shared` 改变共享输入（要求同时指定 `--shared`），使所有下游节点失效。每轮独立输入变化仍由 `changedBranches` 控制。工具自身没有缓存，内核只在同一探测基线内按共享节点身份复用观测。

```sh
pnpm benchmark:refresh 3 4 1000 0 --shared                 # 无变化
pnpm benchmark:refresh 3 4 1000 1 --shared                 # 局部独立输入变化
pnpm benchmark:refresh 3 4 1000 4 --shared                 # 全部独立输入变化
pnpm benchmark:refresh 3 4 1000 0 --shared --change-shared  # 共享输入失效
```

默认 reusePasses=1 时，共享图有 N=2B+1 个节点，完整重跑包含执行 N 次和提交重放 N 次。共享输入未变、C 个独立输入改变时，普通探测调用 3B−C 次，缓存探测调用 2B−C+1 次；C>0 时两种刷新都重算 2C 次、复用验证 N−2C 次、提交重放 N 次。C=0 时只有探测，返回 `unchanged`。共享输入改变时，普通 / 缓存探测分别调用 B / 1 次，两者都重算并提交重放 N 次。缓存因此节省 B−1 次真实工具调用，**不会削减新修复基线的复用验证或完整提交重放**。

[共享场景原始 JSON](benchmarks/causal-refresh-shared.sample.json) 包含四组配置各三轮、四种模式的环境、输出哈希、正确性、分阶段工具次数和端到端耗时。可依次运行上面的命令重现各组；构建后用 `node scripts/benchmarks/causal-refresh.mjs ...` 输出纯 JSON。耗时包含隔离分支和快照管理，缓存命中不保证速度提升。没有真实模型调用，token 仍为 `null`。


2026-10-09 本地四分支结果（每组 3 轮）：三种受验证模式全部 36/36 正确。下表总调用包含所有验证，耗时是普通刷新→观测复用刷新的中位数。

| 输入变化 | 完整重跑总调用 | 普通刷新总调用 | 观测复用刷新总调用 | 刷新耗时 ms |
| --- | ---: | ---: | ---: | ---: |
| 无变化 | 18 | 12 | 9 | 95.92→95.79 |
| 一个独立输入 | 18 | 29 | 26 | 306.65→310.38 |
| 全部独立输入 | 18 | 26 | 23 | 318.22→315.78 |
| 共享输入 | 18 | 22 | 19 | 311.39→316.80 |

直接复用仅无变化组正确；有变化的三组均失败。此轻量负载下，缓存稳定减少 3 次工具调用，但未呈现稳定的端到端耗时收益；有变化时总调用仍多于完整重跑。下一步优化应针对完整成本，而不能将探测缓存命中当作执行加速结论。

## 自适应策略与估算误差

新增末尾参数 `reusePasses`（正整数，默认 1）和 `estimatedReusePasses`（有限非负数，默认前者）。所有增量模式按 `reusePasses` 对未失效节点进行多轮完整拓扑校验，每次都真实调用工具并检查哈希。它是**显式增加校验负载的敏感性实验**，不代表生产工作负载天然需要重复校验；现有读取与覆盖写工具可确定性重复执行。

自适应模式的每节点成本为 execute=1、replay=1、reuse=estimatedReusePasses，单位仅为工具调用。默认相等保留增量；估算复用比执行昂贵时选择完整重算。完整重算仍先付出探测成本，不能因此宣称优于直接 `full-rerun`。无变化时没有决策或提交。

JSON schemaVersion 升为 2：逐样本新增 `decision`（两种策略的成本分解）和 `costPrediction`；后者包含预测 / 实际决策后工具调用以及 `errorToolCalls = actual − estimated`，非决策样本均为 null。探测已发生，单独计入 `probeToolCalls` 和总调用，不混入预测误差。summary 新增策略选择次数与平均绝对成本误差；没有决策时误差为 null。毫秒仍是实测端到端耗时，不由工具调用估算换算。

```sh
pnpm benchmark:refresh 3 4 1000 0 3 --shared    # 无变化，不作决策
pnpm benchmark:refresh 3 4 1000 1 1 --shared    # 成本持平，保留增量
pnpm benchmark:refresh 3 4 1000 1 3 --shared    # 复用较贵，选择完整重算
pnpm benchmark:refresh 3 4 1000 1 3 1 --shared  # 低估复用成本，暴露预测误差
```

[原始样本](benchmarks/causal-refresh-adaptive.sample.json) 按上述顺序保存四组完整报告，每组五种模式各三轮。旧样本保留其四模式 schemaVersion=1，不能直接按数组下标与新报告配对，应使用 mode 名称。

2026-10-09 本地结果：受验证模式 48/48 正确；下表比较固定观测复用刷新与自适应刷新，总调用包含探测和提交。

| 场景 | 自适应策略 | 固定→自适应总调用 | 决策后绝对预测误差 | 固定→自适应中位耗时 ms |
| --- | --- | ---: | ---: | ---: |
| 无变化、三轮校验 | 无决策 | 9→9 | 不适用 | 131.78→118.00 |
| 局部变化、一轮校验 | incremental | 26→26 | 0 | 375.02→376.95 |
| 局部变化、三轮校验 | full | 40→26 | 0 | 405.81→381.61 |
| 三轮校验，估为一轮 | incremental | 40→40 | 14 | 387.85→380.76 |

直接完整重跑在各组均为 18 次调用；自适应完整重算额外包含 8 次探测。样本采集时同机也在运行测试，耗时仅供重现核查，不支持稳定加速结论。成本误估只影响效率，所有受验证模式仍核查当前输出并强制重放提交；没有模型 token 数据。
