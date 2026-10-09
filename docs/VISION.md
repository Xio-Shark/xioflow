# xioflow：AI agent 的因果可验证世界状态与执行操作系统

xioflow 的目标是让多个 agent 在同一个不断变化的世界中投机执行，解释每次行动依据的状态，并以可检查的证据决定哪些结果可以提交、哪些计算必须重做。受监督的命令执行是底座，世界状态、因果关系和增量执行是产品主线。

## 核心抽象

- **世界版本**：已有 snapshot / fork / rollback 定义文件系统的版本与分支；外部系统需要显式的版本化适配器。
- **执行事务**：已有 WorkspaceTransactions 在隔离工作区执行，通过文件读写集与观测重放做 OCC 校验。
- **因果节点**：一次观测或工具调用关联 agent、事务、基线快照、结果哈希、文件写集和上游节点。journal 序号作为持久身份，依赖只能向过去引用。
- **失效与修复**：观测结果改变使其依赖子图失效；独立子图可保留，宿主重算失效节点并记录新的分支。工具返回值也属于观测证据。
- **执行历史**：AgentRuntime checkpoint 与 journal 共同解释上下文与世界状态；时间切片查询不等于已经恢复文件系统。

## 与已有系统的区别

| 系统 | 主要负责 | xioflow 的关注点 |
| --- | --- | --- |
| Temporal | 持久化流程、重试、活动调度 | 活动依据的观测是否仍有效，多个分支的世界变更如何提交 |
| LangGraph | agent 图编排与上下文 checkpoint | 上下文和文件世界是否因果一致，失效后重做哪些节点 |
| Docker | 进程和文件系统隔离、镜像环境 | 分支之间的观测依赖、冲突与结果提交 |
| Git | 文件版本和文本合并 | 哪些工具结果、决策和派生变更因合并而失效 |

这些系统可以作为执行宿主或隔离后端。xioflow 复用现有监督器、快照、事务和 journal，不重建编排框架。

## 分阶段路线

1. **可查询因果历史（已实现）**：持久记录跨 agent / 事务依赖，追溯上游证据，按历史序号查询，生成最小的显式依赖失效闭包。提供与现有 ObservationValidation 兼容的日志。
2. **增量修复执行器（文件子图与多轮分支已实现）**：`prepareWorkspaceRepair` 在新事务中按拓扑顺序重算失效闭包、关联替代节点，并保留独立结果（见 [使用说明](causal-repair.md)）；`view(heads)` 选择结果及其因果上游，修复持久记录并返回替代后的 heads，支持连续修复、历史分支比较与投机候选隔离。宿主验证复用条件，随后走既有 OCC 提交。AgentRuntime checkpoint 已绑定显式 causal heads 与历史工作区，可查询上下文的证据分支并随上下文恢复（见 [契约](../spec/agent-runtime.md#causal-checkpoints)）；`planCausalRecovery` 已支持跨 agent 失效影响查询，返回当前 checkpoint 的失效子图及最近未受变化影响的历史恢复候选，单独报告未跟踪上下文；`recoverCausalCheckpoint` 已接通宿主局部修复与上下文重建，在独占恢复期校验 checkpoint 版本，并将新上下文、工作区与修复 heads 原子绑定；`recoverAgentCausalBatch` 已接通跨 agent 批次恢复，逐项报告成功、跳过与失败并拒绝过期 checkpoint（见 [批次契约](causal-recovery-batches.md)）；`prepareWorkspaceBranchRepair` 已支持兼容分支在一个文件世界中共享祖先去重、拓扑重算及持久 heads 分发（见 [共享修复](causal-repair.md#多-agent-共享祖先去重)）；`recoverAgentSharedCausalBatch` 已将一次共享重算接到多个 agent 的独立事务与上下文绑定，保留逐项版本检查和部分失败结果，共享资源始终由宿主持有；`validateWorkspaceCausalBranches` 已支持同一当前基线的独立分支重放，将首次哈希差异映射为去重因果种子与联合修复计划，隔离工具错误及分支变更（见 [因果再验证](causal-validation.md)）；`prepareWorkspaceCausalRefresh` 已将持久验证报告接入自动共享修复准备，保存基线身份并关联触发报告与替代节点；提交可选 `observationPolicy: 'always'`，在无文件冲突或无读取追踪时仍强制重放完整证据，成功只报告观测验证；`refreshWorkspaceCausalBranches` 已接通探测、共享修复与强制完整证据重放提交，冲突回收、未知提交保留恢复资源；同基线探测可选 `baseline_observations`，按因果节点去重 mutation 前的纯观测，保留错误重试、分支隔离与强制提交重放；刷新现可按宿主成本模型选择增量修复或完整选中子图重算，计入复用验证和完整提交重放，持久保存决策；估算不代表实测收益，自适应路径仍需先探测。`recomputeWorkspaceCausalBranches` 已支持宿主显式选择跳过探测、完整重算选中联合祖先并强制重放提交，共享节点只执行一次，来源和策略持久可查；尚不自动预测探测前策略。[六模式基准](causal-refresh-benchmark.md#无探测的因果重算对照) 已对照无探测重算、探测后自适应与手工完整重跑，报告完整工具成本、因果记录及实际耗时；无变化时探测仍有优势。后续独立输出分发与 checkpoint 发布协调。依赖不完整时不能推断可复用。
3. **投机多分支提交（含冲突局部修复）**：`speculateWorkspace` 在同一快照上并行执行多个策略，按声明顺序通过现有 OCC 选择胜者并回收其余候选（见 [使用说明](speculative-workspaces.md)）；候选可通过 `repair` 在 OCC 冲突后按显式 heads 局部重算，再次通过普通 OCC 竞争胜者；显式 `commitPolicy: 'all_valid'` 已支持多个 agent 兼容结果依次合并，每个候选重新经过 OCC，保留读依赖冲突与局部修复；批次非原子，逐候选 journal 记录提交进度。
4. **时间旅行调试（checkpoint 历史分叉与因果对照已实现）**：`forkAgentCheckpoint` 从历史 checkpoint 绑定的基线快照重建隔离工作区，重放完整操作前缀并核对结果，匹配后在同一 Run 内创建具有历史上下文与 causal heads 的新 agent，保留已消耗的 Run 预算（见 [契约和示例](checkpoint-forks.md)）。`compareAgentCheckpoints` 已支持跨 agent 历史上下文字段差异、共同 / 独有证据与结构分歧起点查询（见 [对照调试示例](checkpoint-comparison.md)）。`compareAgentCheckpointFiles` 已通过历史基线重放提供同根工作区的实际文件差异，成功或失败均回收临时分支，附可运行对照示例。后续扩展任意 journal 序号恢复；确定性和操作前缀完整性由宿主适配器明确声明。
5. **可复现评测（确定性文件基准已实现）**：`pnpm benchmark:causal` 比较完整重跑、局部修复和不校验复用，输出逐分支正确性、真实工具次数、额外验证读取与端到端耗时（见 [基准协议](causal-repair-benchmark.md)）。`pnpm benchmark:merge` 已覆盖同快照双策略合并冲突，计入首次失败投机、局部重算、复用验证与输出复制成本（见 [合并基准](speculative-merge-benchmark.md)）。`pnpm benchmark:shared` 已对比逐分支独立修复与共享祖先去重，计入独立工作区分发、输入再验证和 OCC 提交；默认四分支工具 12→6，但轻量任务实测耗时上升（见 [共享修复基准](shared-repair-benchmark.md)）。`pnpm benchmark:refresh` 已覆盖自动探测、复用校验和强制提交重放的完整成本，与同等提交保证的完整重跑比较，并覆盖无变化 / 局部 / 全部失效（见 [刷新验证成本](causal-refresh-benchmark.md)）。共享祖先端到端基准已对照普通 / 观测复用刷新，覆盖无变化、局部 / 全部独立输入变化及共享输入失效，分别计入探测、复用验证、修复和强制提交重放成本。自适应刷新基准已覆盖成本持平、复用校验较贵和估算失准，记录策略选择、实际阶段调用与成本预测误差；重复校验是敏感性负载，不代表生产收益。后续接入真实模型：相同任务、相同扰动对比完整重跑、无监督执行与增量修复，记录成功率、错误复用率、工具次数、耗时和真实模型 token。脚本节点数量的节省不能冒充模型收益。

## 当前边界

因果边由宿主显式声明，内核验证引用结构，但不能自动证明依赖完整。因果图的失效计划是纯查询；局部修复入口通过宿主回调执行工具，不自动恢复上下文或放宽 OCC。文件写集是宿主记录的来源说明，提交仍以现有事务检查为准。非确定性工具和外部副作用不能仅靠哈希变成可重放操作。
