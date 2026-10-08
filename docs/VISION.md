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
2. **增量修复执行器（文件子图与多轮分支已实现）**：`prepareWorkspaceRepair` 在新事务中按拓扑顺序重算失效闭包、关联替代节点，并保留独立结果（见 [使用说明](causal-repair.md)）；`view(heads)` 选择结果及其因果上游，修复持久记录并返回替代后的 heads，支持连续修复、历史分支比较与投机候选隔离。宿主验证复用条件，随后走既有 OCC 提交。AgentRuntime checkpoint 已绑定显式 causal heads 与历史工作区，可查询上下文的证据分支并随上下文恢复（见 [契约](../spec/agent-runtime.md#causal-checkpoints)）；`planCausalRecovery` 已支持跨 agent 失效影响查询，返回当前 checkpoint 的失效子图及最近未受变化影响的历史恢复候选，单独报告未跟踪上下文；`recoverCausalCheckpoint` 已接通宿主局部修复与上下文重建，在独占恢复期校验 checkpoint 版本，并将新上下文、工作区与修复 heads 原子绑定；`recoverAgentCausalBatch` 已接通跨 agent 批次恢复，逐项报告成功、跳过与失败并拒绝过期 checkpoint（见 [批次契约](causal-recovery-batches.md)）；`prepareWorkspaceBranchRepair` 已支持兼容分支在一个文件世界中共享祖先去重、拓扑重算及持久 heads 分发（见 [共享修复](causal-repair.md#多-agent-共享祖先去重)）；后续连接共享事务与多个 agent 的上下文绑定协调。依赖不完整时不能推断可复用。
3. **投机多分支提交（含冲突局部修复）**：`speculateWorkspace` 在同一快照上并行执行多个策略，按声明顺序通过现有 OCC 选择胜者并回收其余候选（见 [使用说明](speculative-workspaces.md)）；候选可通过 `repair` 在 OCC 冲突后按显式 heads 局部重算，再次通过普通 OCC 竞争胜者；显式 `commitPolicy: 'all_valid'` 已支持多个 agent 兼容结果依次合并，每个候选重新经过 OCC，保留读依赖冲突与局部修复；批次非原子，逐候选 journal 记录提交进度。
4. **时间旅行调试（checkpoint 历史分叉与因果对照已实现）**：`forkAgentCheckpoint` 从历史 checkpoint 绑定的基线快照重建隔离工作区，重放完整操作前缀并核对结果，匹配后在同一 Run 内创建具有历史上下文与 causal heads 的新 agent，保留已消耗的 Run 预算（见 [契约和示例](checkpoint-forks.md)）。`compareAgentCheckpoints` 已支持跨 agent 历史上下文字段差异、共同 / 独有证据与结构分歧起点查询（见 [对照调试示例](checkpoint-comparison.md)）。`compareAgentCheckpointFiles` 已通过历史基线重放提供同根工作区的实际文件差异，成功或失败均回收临时分支，附可运行对照示例。后续扩展任意 journal 序号恢复；确定性和操作前缀完整性由宿主适配器明确声明。
5. **可复现评测（确定性文件基准已实现）**：`pnpm benchmark:causal` 比较完整重跑、局部修复和不校验复用，输出逐分支正确性、真实工具次数、额外验证读取与端到端耗时（见 [基准协议](causal-repair-benchmark.md)）。`pnpm benchmark:merge` 已覆盖同快照双策略合并冲突，计入首次失败投机、局部重算、复用验证与输出复制成本（见 [合并基准](speculative-merge-benchmark.md)）。后续接入真实模型：相同任务、相同扰动对比完整重跑、无监督执行与增量修复，记录成功率、错误复用率、工具次数、耗时和真实模型 token。脚本节点数量的节省不能冒充模型收益。

## 当前边界

因果边由宿主显式声明，内核验证引用结构，但不能自动证明依赖完整。因果图的失效计划是纯查询；局部修复入口通过宿主回调执行工具，不自动恢复上下文或放宽 OCC。文件写集是宿主记录的来源说明，提交仍以现有事务检查为准。非确定性工具和外部副作用不能仅靠哈希变成可重放操作。
