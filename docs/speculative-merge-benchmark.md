# 多 agent 合并冲突基准

运行 `pnpm benchmark:merge [trials] [branches] [hashRounds]`，比较同基线投机执行发生冲突后，完整重跑与因果局部修复的成本。无需模型 API、网络或新增依赖。实现位于 `src/testing/speculative-merge-benchmark.ts`，作为可运行的宿主接入示例和仓库评测入口，不是公共运行时 API。

```sh
pnpm benchmark:merge 3 4 1000
# 构建后输出纯 JSON：
node scripts/benchmarks/speculative-merge.mjs 3 4 1000 > report.json
```

## 场景与公平对照

每轮在全新的 Git 仓库与 SQLite domain 中创建多个输入文件。`speculateWorkspace` 从同一个快照 fork 两个策略并执行，使用 `commitPolicy: 'all_valid'` 按声明顺序提交：

1. `update` 修改第 `trial % branches` 个输入。
2. `transform` 对每个输入执行读取 → 多轮 SHA-256 派生 → 原位写回三个工具，显式记录各分支的因果链。

`transform` 在旧快照上执行，写入与已提交的 `update` 重叠，因此必然触发真实 OCC 写冲突，不依赖底层 atime 是否可用。两种恢复方式均通过已有 `repair` 回调和普通 OCC 提交：

- `full-rerun` 将全部源读取作为重算种子，重新执行整个 transform 图，不复用工具结果。与局部修复共用执行器和工具实现。
- `incremental-repair` 在当前世界重读全部源观测，只将变化的观测作为种子；校验独立输入及原候选 fork 中的输出，然后把独立输出复制到新的修复 fork，重算失效闭包。

每轮两个模式具有相同初始内容、扰动、工具和提交顺序，并轮换模式运行次序。结果 oracle 独立计算全部文件的期望内容，检查的是 `transform(update(inputs))`。只有所有文件正确且两个策略都已提交才算成功；CLI 还要求每个样本确实发生过冲突，否则非零退出。单分支测试确保全部失效时不虚报复用收益。

## 计量口径

| 字段 | 含义 |
| --- | --- |
| `initialToolCalls` | update 的一次写入，加上首次 transform 的全部真实工具调用，包含随后冲突的执行成本 |
| `recoveryToolCalls` | 冲突后实际调用 read / derive / write 的次数 |
| `executionToolCalls` | 上面两项之和；没有扣掉失败的投机成本 |
| `changeDetectionReads` | 为定位变化而读取当前源文件的次数 |
| `reuseValidationReads` | 验证独立输入及原候选输出的文件读取次数 |
| `materializationWrites` | 将可复用输出复制到新 fork 的文件写入次数，单独计费 |
| `reusedNodes` | 保留的因果节点数，不等于 token 或总操作节省 |
| `elapsedMs` | 从投机入口前开始，到所有提交及 fork / snapshot 清理完成；含图查询、验证、复制与 journal，不含初始化和 oracle |
| `outputHashes` / `correctOutputs` | 所有最终文件的哈希与正确数量，包括独立分支 |
| `commitValidation` | 最终修复事务的真实 OCC 校验等级 |

工具次数不包括内核的 Git、SQLite、快照及读集检测操作；这些开销计入墙钟时间。数据文件也包含原始样本、配置和 Node / Git / 平台信息。确定性的是输入、输出和调用次数，耗时不保证一致；测试不设置加速阈值。

## 实测样本（2026-10-08）

[完整 JSON](benchmarks/speculative-merge.sample.json) 在 Linux arm64、Node v22.23.3、Git 2.47.3 上独立运行，未与测试或构建并行。参数为 3 轮、4 分支、1000 次哈希迭代。

| 恢复方式 | 全部正确 | 首次 + 恢复工具/轮 | 检测读 + 校验读 + 复制写/轮 | 端到端中位数 |
| --- | --- | --- | --- | --- |
| 完整重跑 | 3/3 | 13 + 12 = 25 | 0 + 0 + 0 | 241.28 ms |
| 局部修复 | 3/3 | 13 + 3 = 16 | 4 + 6 + 3 | 216.21 ms |

全部最终哈希一致，每轮均检测到冲突并提交两个策略，校验等级均为 `files`。恢复工具调用减少 75%，**包含首次投机的工具调用只减少 36%**；额外验证和复制仍有成本，不能把这个比例当成总操作、耗时或 token 节省。

## 边界与后续

这是固定、确定性的两策略文件任务，模拟指定顺序下的并行候选合并；没有 LLM、外部服务或后台写入，`modelTokens` 明确为 `null`。所有输入同时是写入目标，写冲突可直接由 OCC 检测；此结果不代表纯读取依赖或任意共享工作区的正确性。复用成立依赖固定适配器的完整因果声明与确定性工具。

本基准与[已有因果修复基准](causal-repair-benchmark.md)互补：后者包含不校验复用的负对照，本基准衡量真实投机失败及合并恢复成本。下一步可加入仅观测失效的冲突、多个更新者和真实模型 token 计量。
