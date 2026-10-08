# 多分支共享因果修复基准

`pnpm benchmark:shared` 比较逐分支独立修复与共享祖先去重，使用真实 Git 工作区、SQLite 因果 journal、snapshot / fork 和 OCC 提交。参数为轮数、分支数、派生工具的 SHA-256 迭代次数：

```sh
pnpm benchmark:shared 3 4 1000
# 构建后可直接保存纯 JSON
node scripts/benchmarks/shared-repair.mjs 3 4 1000 > report.json
```

这是固定兼容分支的文件任务，代码位于 `src/testing/shared-repair-benchmark.ts`。它提供宿主分发适配器的可运行示例，不是通用输出分发 API，也不调用模型或 AgentRuntime 调度器。

## 任务与执行路径

初次执行公共输入读取 → 公共派生计算 → N 个分支各写一个带分支编号的输出，记录真实共享祖先并提交。随后将公共输入改为 `changed-${trial}`，所有选中节点失效；无独立节点可复用。每个策略使用全新仓库和 domain，各轮轮换策略顺序。

| 策略 | 扰动后执行 | 工具次数 |
| --- | --- | --- |
| `independent-repair` | 每分支调用 `prepareWorkspaceRepair`，分别重算公共祖先与自己的输出 | 3N |
| `shared-repair` | 调用一次 `prepareWorkspaceBranchRepair`，再把各分支输出分发到独立事务 | N + 2 |
| `unchecked-reuse` | 不校验、不重算，保留旧输出，作为负对照 | 0 |

两种修复都在全部独立事务准备完毕后逐项 OCC 提交，最终用当前输入独立计算 oracle，逐文件核验主工作区的全部输出。共享方案每个分发事务重新读取并验证唯一公共输入，以建立自己的读证据；复制文件不会自动转移原事务的读集。共享准备事务在分发完成后中止并回收基线，独立输出事务各自提交并回收基线。写入互不重叠，批次非原子。

## 计量范围

- `executionToolCalls` 由实际 read / derive / write 回调计数。独立模式相当于每个分支完整重跑其三个工具，不代表已有全局去重调度器的开销。
- `changeDetectionReads`：两种修复各读取一次公共输入发现变化；负对照为零。
- `distributionReads` / `distributionWrites` / `distributionBytes`：共享输出复制的实际文件读取、写入和字节数，不包括 snapshot / fork 内部 I/O。
- `distributionValidationReads`：分发时在每个独立事务内重新核验输入的读取次数。两种模式均无未失效节点，因此无复用校验读取。
- `transactionsStarted`：扰动后真实新建事务数；独立模式 N，共享模式 N + 1。`commitValidations` 保留每次 OCC 实际校验等级，可能为 `files` 或 `write_only`。
- `elapsedMs`：扰动后检测、图查询、重算、分发、验证、事务创建、journal、OCC 提交及快照回收的总时间。排除相同的初始化、扰动注入、oracle 和最终临时目录清理。
- `outputHashes`、`correctOutputs`、`success`：逐输出的 oracle 验证结果；`summary` 报告成功率、平均计数与耗时中位数。
- `modelTokens: null`：没有模型调用，不推断 token 节省。此固定任务没有修复期间的外部并发写入，不证明一般分发的并发一致性。

## 实测（2026-10-08）

[完整原始 JSON](benchmarks/shared-repair.sample.json)：3 轮、4 分支、1000 次哈希，未与测试或构建并行运行。

| 策略 | 全输出正确 | 工具/轮 | 分发读 / 写 / 验证读 | 事务/轮 | 中位耗时 |
| --- | --- | --- | --- | --- | --- |
| 独立修复 | 3/3 | 12 | 0 / 0 / 0 | 4 | 358.16 ms |
| 共享修复 | 3/3 | 6 | 4 / 4 / 4 | 5 | 384.95 ms |
| 不校验复用 | 0/3 | 0 | 0 / 0 / 0 | 0 | 0.0011 ms |

共享重算的工具次数减少 50%，但本次轻量任务端到端耗时更长；每轮还复制 264 字节并多建一个事务。工具数不能替代总操作数或速度结论。单分支测试明确验证无工具节省且仍有分发开销。更重的公共计算是否摊薄额外成本，可调整 `hashRounds` 在空闲机器上增加轮数测量。

相关协议：[独立子图增量修复](causal-repair-benchmark.md)、[投机合并冲突](speculative-merge-benchmark.md)、[共享上下文恢复](causal-recovery-batches.md)。
