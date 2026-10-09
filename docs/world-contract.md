# 单世界契约（M1 冻结草案）

本页落实 [NORTH_STAR 第 2、6 节](NORTH_STAR.md)，统一入口类型见
[spec/world-contract.ts](../spec/world-contract.ts)，接入示例与结果穷尽检查见
[tests/world-contract.types.ts](../tests/world-contract.types.ts)，由 `pnpm typecheck` 检查。
这些是设计交付物，**尚无可调用的 openWorld，也未导出新包 API**；M2 才验证运行行为。
北极星示意调用中的 step/refreshed 在本草案中需先检查结果，再取 candidate；增加
statePath 以明确重开身份，禁止用临时目录隐式冒充持久世界。

## 覆盖声明与宿主责任

首发仅支持单机单 Git 工作区。适配器 id/version、规范化覆盖清单及哈希与快照一起持久化；
重开校验其一致性，基线缺失或适配器语义版本不符即失败，不回退到当前目录。

| 内容 | 适配器必须声明 / 内核核对 |
| --- | --- |
| 文件集合 | paths 为规范化相对路径，含不存在但可能被读取/创建的路径；记录文件存在性、内容、类型与模式。目录枚举须覆盖成员集合，新增成员也会失效；排除项列入 excluded。 |
| 路径边界 | 拒绝绝对路径、越界路径、重复/歧义路径和符号链接；元数据 statePath 在覆盖外。新增覆盖须产生新版本，不能修改旧清单。 |
| 工具 | 每次 observe/mutate 在隔离 fork 执行，完整记录参数与可见结果哈希；宿主提供确定性 replay 和只读 accept。读取排除文件或未声明文件返回 unknown。 |
| 模型与上下文 | 每次响应保存为带哈希的产物，dependsOn 覆盖模型实际看到的全部观测与控制依赖；null 是未跟踪，[] 是明确无依赖。任一必需依赖未跟踪时整项成果 unknown。 |
| 非文件效果 | 网络读取、时钟、随机数等未保存且未版本化的输入无法证明有效，返回 unknown；不可逆外部写入不允许进入可重放工具集。 |
| 验收与静止性 | accept 检查实际发布来源，只允许 true 通过；验收异常不是冲突。宿主保持候选与重放目录静止，内核核对准备指纹及验收前后指纹。 |

内核不能发现宿主隐瞒的读取，complete 是可核验声明下的保证，不是自动推断。
模型响应不是确定性 replay；依赖失效后重新调用 agent，保留累计预算。
AgentStepContext.record 连接现有因果节点；含 null 的记录必须持久保留未知证据，不能转成 []。

## 状态与操作

句柄、候选、提交尝试和资源状态分别持久化；不能用一个“成功”覆盖全部事实。
WorldRef 的 worldId/id/atSeq 指定不可变历史视图；候选保存原始输入与驱动关联，refresh
在同一进程复用驱动。AgentStepContext.refresh 提供失效计划和可复用产物，宿主只重算计划内步骤；
初次执行/完整重算时为 null。重开可查询和续发布；重新推理需要宿主重新接入相同 agent，缺失则 failed。

| 状态 / 输入 | 操作与下一状态 | 可见结果 |
| --- | --- | --- |
| 未打开 | openWorld 核对 root、statePath、适配器；打开或重开 | WorldHandle；不可打开时抛错，无有效句柄 |
| open 句柄 | runAgentStep 建快照/fork，记录执行与产物 | prepared / unknown；执行异常为 failed，带只读查询 ref |
| prepared / unknown / 已冲突候选 | refresh 在当前固定基线上探测；复用未失效节点、拓扑重算闭包 | 新的 prepared / unknown / failed；不发布、不改原候选 |
| unknown + onUnknown=reject | 不执行重算 | unknown，保留候选与原因 |
| unknown + onUnknown=recompute | 完整重算所选任务并重新声明覆盖 | prepared 或仍 unknown；不能用重算次数证明覆盖 |
| prepared / unknown 候选 | commit 先绑定 key，再检查覆盖、输出、重放、验收及 OCC | 验证中；发布前拒绝不会写主目录 |
| 验证通过 | 先持久化 committing 与来源证据，再应用文件 | committed 或 undetermined |
| committed | 仅表示持久文件发布事实 | checkpoint 的 pending/bound/failed 分开记录，不影响原凭据 |
| 任意已知 ref / key 身份 | explain 固定 atSeq 查询依赖路径、发布、绑定与资源 | 只读 WorldExplanation；无修复、模型调用或预算/journal 变化 |
| open 句柄 | close 阻止新操作、等待已接收操作结束，再回收可回收资源 | closed + 逐资源 reclaimed/retained/cleanup_failed |
| closed 句柄 | 重复 close 返回已记录报告；其他操作拒绝 | 查询/恢复需 openWorld 同一 statePath |

同句柄提交按既有队列串行；close 与已接受的提交不能竞态回收来源。
等待完成后，close 将未进入 committing 的未发布候选持久中止，再检查引用决定回收；
历史引用仍保留，不会让 abandoned 的 open 候选永久占用临时 fork。
多个句柄写同一 statePath 不属于首发支持范围，应拒绝第二个写者。
成功候选再次使用新 key 提交也不能重复发布，返回其原始提交身份；新 key 不绑定。

## 六类失败、重试和资源归属

| 输入 / 故障 | 预期返回 | 可重试性 | 资源归属 |
| --- | --- | --- | --- |
| 覆盖缺失、heads/产物依赖为 null | refresh 为 unknown；commit 为 unknown/coverage_unknown | 此 key 终态；补证或完整重算产生新候选与新 key，仍未知就仍拒绝 | 内核保留候选至 close；宿主补齐声明，不能放宽 strict |
| 重放、指纹、验收回调抛错 | commit 为 validation_failed；准备/刷新为 failed，记录具体失败阶段与原因；不得作为 changed 或 conflict | 原候选原 key 可重试；重新核对全部门禁 | 内核清理临时验证 fork，保留候选；清理失败留记录 |
| 刷新后输入/写集又变化 | conflict；主目录不写 | 此 key 终态；refresh 新候选、新事务、新 key | 旧候选终止发布资格；close 在引用检查后回收 |
| TX_COMMITTING 后应用抛错、响应丢失 | undetermined + worldId/candidateId/txId/key；若已查到 TX_COMMITTED 则 committed | 同 key 续恢复；禁止另建事务补偿性重复发布 | 内核保留来源、基线、journal 和未决身份，close 不回滚部分写入 |
| 独立 key 重试 | 同候选的终态 key 返回原结果；validation_failed/undetermined 续原尝试；不同候选占用同 key 返回 key_conflict 与原身份 | 重开后同样成立；不能重新绑定、重验终态或重复发布 | key 绑定与终态结果持久化；不依赖 fork 尚存在 |
| close 时有未决提交、历史引用或清理异常 | closed 报告逐项 retained 或 cleanup_failed，含恢复身份与原因 | 重复 close 不重做清理；重开后按记录重试回收 | 内核只回收自有且无引用的终态资源；journal、历史所需基线、未决来源保留；宿主拥有模型/外部资源 |

输出损坏返回 rejected/output_changed，业务验收 false 返回 rejected/acceptance_rejected；
两者均是 key 的终态拒绝，修复产生新候选。参数非法、跨世界引用、关闭后调用为编程错误并抛错，
不分配 key。key 冲突优先检查，返回原绑定身份，不读取或更改请求候选。
持久存储不可用时无法保证结构化返回：抛错/进程死亡不证明未写入；调用者保留提交前已知的
worldId、candidateId、txId、key，重开按同 key 查询/恢复。查询截止点早于 key 绑定时 publication=null，
不能据此推断其后未发布。固定历史不存在则明确报错，不偷偷改查最新状态。
按提交 identity 查询可省略 atSeq，此时只读取一次当前 journal 截止点，并在返回 ref.atSeq 中固定它；
后续重开复查传入该截止点，避免必须接触底层 journal 才能发现丢失响应的提交结果。

close 无法写入报告时抛错，保留恢复元数据；不得宣称清理已被持久确认。
committed 的 receipt 仅证明文件提交，历史结果不证明当前文件仍有效；资源回收和 checkpoint
绑定失败分别可查，不能为修复它们重新发布文件。

## 既有入口的收敛映射与实现缺口

| 统一操作 | 复用入口 / 文档 | M2 起仍须实现 |
| --- | --- | --- |
| openWorld / runAgentStep | snapshot/fork、WorkspaceTransactions、AgentRuntime、causal-graph.md | 持久世界身份、覆盖清单、适配器和上下文记录边界 |
| refresh | validateWorkspaceCausalBranches、prepareWorkspaceCausalRefresh、prepareWorkspaceRepair；causal-validation.md / causal-repair.md / causal-recovery-batches.md | 一个持久刷新状态机；探测异常与失效分流；不调用隐含发布的旧组合入口 |
| explain | explainRecomputation、explainCausalRecovery、checkpoint-comparison.md | 统一固定截止点的发布/绑定/资源只读视图；文件重建留调试插件 |
| commit | commitWorkspaceTransaction、getWorkspaceCommitResult；workspace-publication.md | 独立 key 绑定、所有失败归一化、未决身份；沿用 publication 门禁，禁止降级 files/write_only |
| close | planAgentCausalResourceCleanup、cleanupAgentCausalFork | 句柄生命周期、逐资源持久结果与重开重试；不删除仍被引用的快照 |

旧入口目前继续可用，本轮不删实现或基准样本。成本、窗口、预测、投机调度留宿主/插件。
M1 的类型草案、状态表、覆盖声明及六类失败语义在本页齐备；运行正确性不由类型测试证明。
M2 从持久身份与覆盖检查开始（当前进度见下节），随后串起隔离执行、刷新和严格提交，
逐步跑齐六类场景各 10 次、独立 oracle、第 3 节不变式与重开查询。

## M2 实现进度：持久世界基线

`src/world/state.ts` 的内部 `openWorldState` 已实现世界身份基础，尚未导出包入口，
也不等价于完整 `WorldHandle`。类型草案复用这里的 `FileCoverage`，避免两份覆盖类型漂移。
它复用 ExecutionDomain 单写者与 Git shadow snapshot，将 WORLD_INITIALIZING 写入 journal，
随后原子保存 snapshot 元数据与 WORLD_CREATED；创建中断保留意图和快照引用，重开明确失败，
本切片尚未提供初始化失败的自动恢复。内部 close 仅释放 domain，不承诺句柄级资源回收报告。

当前接受 Git 工作区根和工作区外的 statePath；路径按真实父目录解析，拒绝元数据经符号链接
落入工作区。覆盖为排序后的精确文件路径（允许声明不存在），拒绝重复、越界、歧义、覆盖与排除
重叠、符号链接祖先、目录和非普通文件。已声明但被 Git 忽略而未进入快照的文件拒绝打开，
不会声称已覆盖。文件类型、内容及 Git 可表示的模式由 tree fingerprint 固定；目录枚举覆盖
和完整 POSIX 权限尚未实现，不能据此声明它们有效。

重开核对 root、适配器 id/version、覆盖哈希、snapshot 元数据、私有 ref 的提交身份与树指纹和已覆盖 blob
存在性，返回原 worldId 与创建截止点。当前目录的新增或修改不改变原版本；基线缺失、ref 被换或
覆盖变化均失败，不抓取当前目录顶替历史。重开不追加世界 journal 事件；仍使用既有 domain 租约。
snapshot 的 opId 必须属于当前世界，coverage 必须保持创建时的 worktree_non_ignored；保存的
commitHash 必须存在且与私有 ref 指向的提交一致，避免 materialize 按 ref、restore 按元数据
读到不同基线。同树不同提交也不替代原提交身份；校验失败释放租约，修复原证据后可以重开。
下一步连接隔离执行及 AgentRuntime，再收敛 refresh、strict commit、explain 与 close 状态机。

内部 `src/world/step.ts` 的 `executeWorldStep` 现已连接固定世界基线、WorkspaceTransactions
与 AgentRuntime：每次创建独立 Run/事务/fork，记录输入、工具依赖、宿主响应 checkpoint、
累计步骤消耗及输出树指纹。返回 `executed` 仅表示执行产物已持久保存，不是草案的
`prepared`，不证明覆盖完整或允许提交；尚未接入公开 WorldAgent/WorldHandle。
执行始终使用该句柄的原始快照；当前目录变化留待 refresh 处理。record 先持久化再返回，
只允许本步骤已有节点作为依赖；null 观测单独保存 WORLD_OBSERVATION_UNTRACKED，
使最终 checkpoint 的 causalHeads 保持 null，不冒充空依赖。宿主必须把模型响应保存在
checkpoint，响应本身不会进入工具重放。异常记 WORLD_STEP_FAILED，保留事务/fork 和预算证据，
不写主目录、不自动重试或清理。重开可读取原 journal 和因果节点；本切片无自动续执行。
内部调用者须等待执行结束再 close；并发步骤拒绝，句柄级 close 等待与资源报告仍待实现。
