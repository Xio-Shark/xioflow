# 共享因果恢复的故障基准

`pnpm benchmark:recovery [trials=3] [branches=4] [hashRounds=1000]`
运行真实文件工作区、AgentRuntime 和 SQLite journal。每个模式使用新夹具，
同一 trial 使用相同输入扰动，逐 trial 交替模式顺序。`branches` 至少为 2。
结果为 JSON，任何样本恢复结果不正确时命令非零退出。

## 工作负载与对照

多个已暂停 agent 共享一个读取节点及一个派生文件节点。输入改变后，
`refreshAgentSharedCausalBatch` 探测并共享重算，再给各 agent 分配独立工作区。
最后一个 agent 在输出已经复制、checkpoint 尚未发布时发生一次注入故障：

- `binding-failure`：绑定回调抛错，失败结果正常写入 journal。
- `outcome-interruption`：同样抛错，并阻断失败结果的 journal 写入，留下 pending。
  这是可控的持久化边界故障注入，随后正常关闭并重开 domain；不是 SIGKILL 或断电测试。

两种恢复方式都先重开 domain，再恢复最后一个 agent：

| 模式 | 行为 |
| --- | --- |
| `durable-recovery` | 对 failed 显式 retry，对 pending 执行 resume；沿用持久共享修复 |
| `rerun-unfinished` | 对未完成 agent 重新探测、完整重算它的因果分支，再绑定 |

对照保留先前成功的 agent，避免把不必要的整批重跑算作优势。两者都分配新的
独立工作区、再次验证输入、复制输出。每次检查所有 checkpoint 与实际文件内容，
检查重开前后历史一致性，以及先前成功的 checkpoint 序号保持不变。

## 统计口径

- `executionToolCalls` 包含故障前和恢复时的读取/派生工具；`recoveryExecutionToolCalls` 只计重开后的执行。
- `probeCalls` 单列探测；分发读取、写入、输入校验和失败尝试也全部计数。
- `recoveryMs` 包含关闭/重开、历史查询与恢复；`cleanupMs` 单列资源核对和回收。
- `elapsedMs` 从首次刷新到恢复、资源核对完成；初始夹具构建及最终正确性断言不计入。
- fixture 无并发写入和外部引用。只回收 abandoned fork 中被既有 API 判为 review 的项；保留全部历史基线。
- 完整重跑 pending 分支不会终结旧恢复计划，因此旧分配仍为 retain。这是可观测的资源遗留，不伪造旧计划完成。

本基准验证 **checkpoint 与隔离工作区恢复**，没有将文件提交到主工作区，
不衡量 OCC 发布成功率，也不运行模型；`modelTokens: null`，工具次数不能折算为 token。
保留的资源在记录指标后随整个临时 fixture 删除，不用于证明生产资源可删除。

## 本机样本

[原始报告](causal-recovery.sample.json)：3 次重复、4 agent、1000 轮哈希，12 个样本全部正确。

| 故障 | 恢复方式 | 总执行次数 | 探测次数 | 恢复均值 ms | 总耗时均值 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 绑定失败 | 持久重试 | 2 | 4 | 55.03 | 382.47 |
| 绑定失败 | 重跑未完成分支 | 4 | 5 | 152.35 | 504.29 |
| 结果记录中断 | 持久续跑 | 2 | 4 | 55.74 | 393.71 |
| 结果记录中断 | 重跑未完成分支 | 4 | 5 | 153.00 | 481.63 |

这些是确定性合成负载的小样本，不是生产收益保证。下一步可扩展为子进程真正退出、
重开后输入再次改变与 OCC 提交冲突的端到端对照。
