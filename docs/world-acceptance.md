# M2：统一世界句柄验收

运行 `pnpm vitest run tests/world/acceptance.test.ts`。六类场景各 10 次，每次使用独立 Git 工作区和持久状态目录，输入随轮次变化。执行、刷新、解释、严格提交与关闭重开均通过内部 `openWorld` 句柄；尚未增加包公开入口。

| 场景 | 预期刷新 | 实际发布 |
| --- | --- | --- |
| 无变化 | 复用，不重新生成 | 两份输出匹配 oracle |
| 局部变化 | 仅重算一个读写分支，失效节点数为 2 | 两份输出匹配 oracle |
| 全部失效 | 两个读写分支均重算，失效节点数为 4 | 两份输出匹配 oracle |
| 依赖未跟踪 | `unknown`，不重放 | `unknown`，保留原文件 |
| 工具异常 | `failed`，无失效计划、不调用 agent 重算 | `validation_failed`，保留原文件 |
| 刷新后再次改文件 | 先成功准备，再注入变化 | `conflict`，保留原文件 |

任务将两个独立整数输入各加倍。agent 和工具用 Number 加法生成文件；独立 oracle 从扰动后的主目录读取输入，用 BigInt 乘法计算预期正文，不调用刷新或重放逻辑。宿主业务验收和发布后的逐字节核对均使用该结果。输入限定为可精确表示的小整数。

刷新结果显式返回 `ref`：发布前通过 `world.explain(refreshed.ref)` 核对失效计划、输入 → 输出的变化路径及实际刷新策略，发布后再通过发布身份核对。`refreshed.candidate.atSeq` 保留候选准备时刻；直接解释候选只包含该截止点的证据，不隐式扩展到刷新完成时刻。

每次检查刷新未写主目录、实际重算分支数、固定解释在关闭重开后不变，以及发布身份和终态 key 重试结果一致；历史解释不执行工具或 agent；每次解释前后直接比较原始及刷新候选 Run 的 `AgentRuntime.getRunUsage`（非零 stepsUsed/agentsCreated）、完整 journal 与全部覆盖文件正文，关闭重开还核对累计预算不变。工具异常是可重试状态，仅核对其固定历史，不将它当作终态。

这组测试是 M2 六场景的统一验收，不是 M3 报价 demo 或性能基准，没有真实模型和 token 收益声明。

## 第 3 节不变式证据索引

下表按北极星契约组织，测试名可用于 `pnpm vitest run <文件> -t '<测试名片段>'`。索引是源码断言审计，不将历史通过记录冒充本轮执行；本轮执行范围见交接摘要。保留专项测试与原始基准，尚不删除第 5 节样本。

| 契约 | 可定位证据（相对仓库根目录） | 核验结论与边界 |
| --- | --- | --- |
| 固定世界版本重开一致；缺失/损坏不可回退当前目录 | `tests/world/state.test.ts`：`reopens the same frozen identity`、`baseline damage without recapturing`、`inconsistent`、`missing covered`；`tests/world/baseline-integrity.test.ts` | 对比固定 state/journal，核对 Git 正文，分别删除元数据、ref、tree/blob，执行中基线消失也拒绝准备。 |
| 失效集合为所选祖先子图内后继闭包；排除兄弟与未来节点 | `tests/workspace/causal-graph.test.ts`：`diamond-shaped dependent subgraph`、`deterministic shortest witnesses`、`branch-scoped, historical, detached and read-only`、`inclusive branch ancestry` | 断言精确节点集合和最短路径，含多变化源、空 heads、历史截止点及重开。六场景测试另外核对实际刷新失效节点数与读→写路径。 |
| 同基线不同正文至多一个发布；同 key 不重复发布 | `tests/world/commit.test.ts`：`same-baseline candidates with different output`、`binds independent keys once`、`rejects all ten stale` | 使用不同正文竞争；显式比较版本、提交前无输出、提交后仅胜者正文，并检查双方重试结果/journal 不变。 |
| 完整确定性前缀全部哈希匹配；首差/异常定位并阻止绑定 | `tests/workspace/observation-replay.test.ts`：`replays mutations in order`、`first changed observation`、`callback throws`、`changed return value`；`tests/agents/causal-checkpoints.test.ts`：`discards a divergent historical replay`、`replays the selected historical checkpoint`；`tests/world/commit.test.ts`：`failures ten times across reopen` | 覆盖读写顺序、首差即停、模型历史哈希防篡改、失败不生成恢复 agent；world 发布异常记录 `divergedAt`，十次重开重试不写主目录。底层 replay 用 diverged+error，world 必须映射为 validation_failed，不能据此当作 changed。 |
| 覆盖、输出完整性、业务验收分别阻止发布 | `tests/world/commit.test.ts`：`blocks %s before publication`；`tests/world/output-coverage.test.ts`；`tests/world/validation.test.ts`：`rejects candidate output tampering` | 分别注入 unknown、输出篡改、accept=false、验收期间写入和工具异常；检查状态与主目录无输出。覆盖不足不能被 OCC 通过替代。 |
| 解释/历史只读、固定截止点重开一致 | `tests/world/commit.test.ts`：`explains publication and refresh evidence read-only`；`tests/world/acceptance.test.ts`；`tests/agents/causal-checkpoints.test.ts`：`explains checkpoint recovery with all relevant causes` | 六场景每次经统一句柄解释前后比较 `getRunUsage`、完整 journal、全部覆盖文件和 agent/工具计数，含准备、刷新失败、发布及固定截止点重开；预算基线明确非零。commit 专项另覆盖伪造身份与未决发布历史。 |
| 修复/历史分叉不回退累计预算 | `tests/agents/causal-checkpoints.test.ts`：`shares recomputation while binding isolated contexts`、`repairs a batch with real causal recomputation`、`forks an old checkpoint from its historical baseline` | 修复比较 Run usage 不变；历史分叉保留 stepsUsed 且 agentsCreated 增一。不能把恢复历史 checkpoint 当作预算恢复。 |
| null 与 [] 区分；模型响应保存，失效后重新推理 | `tests/agents/causal-checkpoints.test.ts`：`clears omitted evidence`；`tests/world/step.test.ts`；`tests/world/refresh.test.ts`；`tests/world/acceptance.test.ts` | 六场景对未跟踪依赖返回 unknown 且不重放，稳定复用不生成、局部/全部变化分别生成受影响分支；只承诺适配器显式声明的依赖完整性。 |

M2 **已通过上述有界文件世界的验收**（2026-10-09）：索引涉及的 11 个测试文件一次运行，294/294 通过（103.43s），包含六场景各 10 次；`pnpm typecheck` 通过。本轮未运行全量测试，不将专项通过等同于全仓回归通过。复核命令：

```sh
pnpm vitest run tests/world/acceptance.test.ts tests/world/state.test.ts tests/world/baseline-integrity.test.ts tests/workspace/causal-graph.test.ts tests/world/commit.test.ts tests/workspace/observation-replay.test.ts tests/agents/causal-checkpoints.test.ts tests/world/output-coverage.test.ts tests/world/validation.test.ts tests/world/step.test.ts tests/world/refresh.test.ts
```

下一里程碑是 M3 报价 demo。内部入口尚未作为包 API 导出，真实模型成本和进程终止恢复分别留在 M3/M4；本次验收不扩大适配器显式声明的依赖与文件覆盖边界。
