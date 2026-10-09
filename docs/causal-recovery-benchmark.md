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
- `elapsedMs` 从首次刷新到恢复、资源核对完成；初始夹具构建不计入；schemaVersion 2 包含发布前的正确性检查。
- fixture 无并发写入和外部引用。只回收 abandoned fork 中被既有 API 判为 review 的项；保留全部历史基线。
- 完整重跑 pending 分支不会终结旧恢复计划，因此旧分配仍为 retain。这是可观测的资源遗留，不伪造旧计划完成。

默认模式验证 **checkpoint 与隔离工作区恢复**，没有将文件提交到主工作区，
默认不衡量 OCC 发布成功率，也不运行模型；`modelTokens: null`，工具次数不能折算为 token。
保留的资源在记录指标后随整个临时 fixture 删除，不用于证明生产资源可删除。

## 本机样本

[原始报告](causal-recovery.sample.json)：3 次重复、4 agent、1000 轮哈希，12 个样本全部正确。

| 故障 | 恢复方式 | 总执行次数 | 探测次数 | 恢复均值 ms | 总耗时均值 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 绑定失败 | 持久重试 | 2 | 4 | 55.03 | 382.47 |
| 绑定失败 | 重跑未完成分支 | 4 | 5 | 152.35 | 504.29 |
| 结果记录中断 | 持久续跑 | 2 | 4 | 55.74 | 393.71 |
| 结果记录中断 | 重跑未完成分支 | 4 | 5 | 153.00 | 481.63 |

这些是确定性合成负载的小样本，不是生产收益保证。进程终止与恢复前输入变化对照见下文。

## 恢复到 OCC 发布的闭环

`pnpm benchmark:recovery 3 4 1000 input-changed` 在上述恢复完成后、文件发布前再次改变输入。
第四参数也可为 `stable`，作为输入不变的对照；省略时仍仅运行隔离工作区恢复。
JSON 升级为 schemaVersion 2，`publication` 标明场景，旧的隔离恢复样本仍为版本 1。

从重开的 domain 读取最后一个 agent 的当前 causal heads，取完整祖先日志，
对它的绑定事务使用 `observationPolicy: 'always'` 提交。变化场景必须在第一次读取
得到 `observation_changed`，并且主工作区尚无派生输出；随后再次刷新全部受影响 agent，
重新绑定 checkpoint，再提交一个代表性输出。稳定场景只提交一次。
所有 agent 的 checkpoint 都必须对应最新输入，主工作区文件必须正确，
最终验证必须为 `observations`，journal 必须存在对应的提交及（变化时）冲突记录。

这衡量的是共享、相同文件输出的一次发布，不是多个独立事务的原子提交。
成功提交会回收该绑定 fork；checkpoint 历史保留，不能假定其旧 fork 仍存在。
上述第四参数只在恢复后、提交前扰动输入；恢复前输入变化由下文第六参数控制，真正的进程退出可叠加下文模式。

`publication` 子对象单列提交尝试、提交重放、额外重算、探测与阶段耗时。
顶层执行/分发计数及 `elapsedMs` 包含发布阶段；`recoveryExecutionToolCalls` 和
`recoveryMs` 保持只计重开恢复，`correctOutputs` / `preservedPublications` 是发布前检查。
`checkpointsCurrent` 是发布后的新鲜度检查；重新刷新自然会推进旧 checkpoint。
`retainedForks` 是发布后剩余资源，`cleanupMs` 仍只计发布前的遗留分配回收。

[OCC 原始报告](causal-recovery-occ.sample.json) 包含两类故障、两种恢复方式的成对样本。
持久恢复继续共享同一因果节点；重跑未完成分支产生独立节点，后续变化将分别重算。
因此新增重算成本也反映因果历史的共享程度；不应将其解释成所有工作负载都固定节省一半。

本机 3 次重复、4 agent、1000 轮哈希，12 个变化场景样本全部正确：

| 恢复方式 | 全程执行次数 | 发布阶段重算 | 提交重放 | 全程均值 ms |
| --- | ---: | ---: | ---: | ---: |
| 持久恢复 | 4 | 2 | 3 | 908.86 |
| 重跑未完成分支 | 8 | 4 | 3 | 1008.04 |

均值合并两种故障，仅为本机合成负载测量；未运行模型，无 token 收益结论。

## 真实进程终止与恢复

`pnpm benchmark:recovery 3 4 1000 input-changed sigkill` 将每个样本的首次刷新放入
独立 Node 子进程。最后一个 agent 的 failed 或 pending 状态形成后，worker 通过 IPC
报告基准计数与核对信息，保持 domain / SQLite 连接打开。父进程发送 `SIGKILL`，
核对退出 signal 后重新获取 domain，从 journal 执行 retry / resume 或重跑未完成分支。
worker 不调用 runtime.close / domain.close，也不执行 finally 清理；这验证真实进程死亡、
遗留 domain 锁和持久共享输出的恢复，但不模拟机器掉电或任意写入指令处崩溃。
两类故障仍先按上述方式注入，再在已知持久边界杀进程。

第五参数默认 `close`，保留正常关闭对照。schemaVersion 3 增加 `interruption`，
进程终止样本附 `processCrash.signal / gracefulClose / crashBoundaryMs`。
`crashBoundaryMs` 包含子进程启动、夹具构建、首次刷新、IPC 和确认死亡；
该模式的 `elapsedMs` 包含上述开销及完整恢复与发布，不能直接与旧模式总耗时比较。
`recoveryMs` 从新实例首次获取 domain 前开始，计入遗留锁处理与 journal 重开。
业务恢复只读取持久 journal / 工作区；IPC 内容只用于基准计数、故障定位和历史对照。
省略第六参数时，`stable` 与 `input-changed` 均覆盖两类故障和两种恢复策略；第四参数的输入扰动仍在恢复后发生。

[进程终止原始报告](causal-recovery-crash.sample.json) 提供可复现的成对样本，
工具调用与正确性独立于进程启动耗时统计，不运行模型或推算 token 收益。

## 恢复前输入变化与验证成本

```sh
pnpm benchmark:recovery 3 4 1000 input-changed sigkill input-changed
pnpm benchmark:recovery 3 4 1000 input-changed sigkill stable
```

第六参数 `recoveryInput` 开启 pending 绑定的三策略对照；省略时保持原来的两类故障、
两策略矩阵。此参数独立于第四参数：第六参数在 domain 重开后、恢复前改变输入，
第四参数仍在恢复完成后、OCC 发布前改变输入。也支持 `close` 作为正常关闭对照。

| 策略 | 恢复前输入已变化时的行为 |
| --- | --- |
| `durable-recovery` | 直接 resume，独立事务分配后的输入校验拒绝绑定，再刷新未完成分支 |
| `validated-recovery` | 重放 pending 修复后 heads，得到 stale 后直接刷新未完成分支，避免一次无效绑定 |
| `rerun-unfinished` | 直接刷新未完成分支，重新探测并重算 |

schemaVersion 4 的 `recoveryEvidence` 单列恢复阶段的绑定、探测、分发输入校验次数与
拒绝绑定次数；`resumeStatus / resumeValidationSeq / validationRecorded` 核对验证关联事件。
summary 同时报告恢复绑定、探测和拒绝次数均值。稳定输入下验证要重放读取与派生两个节点，
直接续跑无需探测；变化输入下先验证增加一次读取探测，却避免一次事务分配及分发输入校验。
不能只以绑定次数判断耗时收益：探测本身也创建隔离 fork，真实阶段耗时一并报告。

恢复仅更新最后一个 agent。`correctOutputs` 检查它对应恢复时的输入，其他已发布结果
仍对应各自历史输入；`preservedPublications` 检查它们未被推进。这不等于全批结果新鲜。
如果第四参数为 stable 且恢复前输入已变化，发布阶段先刷新其余 agent；若为 input-changed，
则保留先 OCC 拒绝、再刷新全批的流程。最终 `checkpointsCurrent` 检查全批最新状态。

stale 验证保留旧 pending 计划，新刷新不会伪造它完成；直接续跑的拒绝会留下 failed 记录。
资源保留差异因此属于真实结果，指标之后才清理整个夹具。此基准没有篡改共享输出，
不能证明磁盘完整性，也不包含模型/token 测量。

本机各3次重复、4 agent、1000轮哈希，18个SIGKILL样本全部正确；
[变化输入报告](causal-recovery-validation-changed.sample.json)、[稳定输入报告](causal-recovery-validation-stable.sample.json)。

| 恢复前输入 | 策略 | 恢复绑定 | 恢复探测 | 恢复均值 ms |
| --- | --- | ---: | ---: | ---: |
| changed | durable-recovery | 2 | 1 | 208.16 |
| changed | rerun-unfinished | 1 | 1 | 152.82 |
| changed | validated-recovery | 1 | 2 | 223.22 |
| stable | durable-recovery | 1 | 0 | 64.04 |
| stable | rerun-unfinished | 1 | 1 | 162.17 |
| stable | validated-recovery | 1 | 2 | 120.87 |

均值仅代表此合成负载；验证避免过时绑定，但稳定输入会增加重放成本。
