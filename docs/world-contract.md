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
隔离执行及 AgentRuntime 已接入；下一步收敛 refresh、strict commit、explain 与 close 状态机。

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

内部 `src/world/prepare.ts` 的 `prepareWorldStep` 现将冻结的 WorldAgent 声明适配到
executeWorldStep；类型集中在 `src/world/contract.ts`，原 spec 仅重导出，仍无公开入口。
宿主在固定版本 fork 执行，覆盖声明和产物 id/kind/hash/dependsOn 保存为 checkpoint，
候选身份、版本、输出指纹及声明另以 WORLD_STEP_PREPARED/WORLD_STEP_UNKNOWN 持久化。
manifestHash 不匹配、宿主 unknown、null 依赖、产物依赖或 mutation 未包含于 heads 祖先
均返回 unknown；伪造节点、重复产物 id、空 hash 等格式错误返回 failed，保留执行证据。
明确的 [] 仍可 prepared；未跟踪的观测序号作为 head 时保留 null，不误报为伪造节点。
prepared 仅表示声明和隔离产物已准备，不表示通过重放、业务验收或允许发布；本入口不写主目录。
模型响应和工具结果通过 artifact.body 提供 UTF-8 正文，hash 必须等于其 SHA-256 小写十六进制摘要；
正文随 checkpoint 和候选 journal 持久化，缺失正文返回 unknown/artifact_body_missing，类型错误或
哈希不匹配返回 failed。空正文有效。文件产物可不提供 body，文件输出仍由 fork 树指纹固定。
内部 readWorldArtifacts 按 worldId/id/atSeq 读取准确的候选事件，重验正文哈希；证据缺失或损坏
直接失败，不重跑模型，不推进 journal。关闭重开后仍可读；返回值与后续宿主修改相互隔离。
这仅覆盖文本产物，尚无二进制正文或内容寻址去重；refresh、strict commit 和资源报告仍待接通。

内部 `src/world/validation.ts` 的 `validateWorldCandidate` 已接入 refresh 的探测阶段，
复用 validateWorkspaceCausalBranches，在当前目录的独立快照上重放候选固定截止点的祖先日志。
它按 worldId/id/atSeq 读取原候选，不接受调用方覆盖 heads、coverage 或输出指纹；适配器
id/version 须匹配。unknown 保留原原因并跳过重放；完整候选先验文本正文和输出树指纹，
重放后再次验输出。成功哈希分歧为 changed，工具异常或输出损坏为 failed，异常不产生失效计划。
WORLD_VALIDATION_STARTED/COMPLETED 保存原候选引用、验证报告序号、原因和固定因果路径；
readWorldCandidateValidation 只读恢复准确历史报告，关闭重开后不调用工具或推进 journal。
matched 仅说明此次探测匹配，changed 的计划仅从首个分歧扩展，不是完整变化清单；两者都不是
刷新候选或提交许可。宿主仍须完整声明依赖和确定性工具语义，保持候选静止；未接通
增量/全量重算、新版本候选、strict commit 和资源恢复状态机。验证正常结束沿用旧入口回收探测
fork；固定世界版本快照保留供修复使用，异常保留 started/事务证据，尚无自动恢复或统一资源报告。

内部 `recomputeWorldCandidate` 补齐显式全量重算路径，供后续统一 refresh 的
`onUnknown: 'recompute'` 和完整重跑对照使用。按持久候选引用读取原 task，默认重新捕获当前
目录的固定版本；传入 validation 引用时从持久 changed 报告恢复版本，核对原候选身份。
复用 prepareWorldStep/AgentRuntime 执行完整任务；refresh 上下文为 null，
旧模型响应、文件产物和依赖均不复用，也不会将验证异常自动当作重算许可。
新版本复用首次创建的精确覆盖与快照检查，WORLD_VERSION_STARTED/CREATED/FAILED
记录版本身份和失败；WORLD_RECOMPUTE_STARTED/COMPLETED/FAILED 关联旧候选及新结果。
原句柄基线保持不变，新候选使用新 snapshotId 和版本截止点，关闭重开后可用既有验证入口重验。
未知候选可显式重算，但新执行仍必须提供完整依赖和产物证据，否则继续 unknown；宿主异常为 failed。
准备不发布文件，失败保留 journal、快照及既有执行资源；尚无自动续跑、幂等重算或统一资源回收。
本入口仍为内部实现，未自动选择策略，未接增量刷新或公开 WorldHandle。

内部 `refreshWorldCandidate` 现将持久探测、增量准备与全量重算收敛为同一流程：matched 在探测固定版本上重建候选，
unknown 按 onUnknown 返回 unknown 或完整重算；工具异常、产物篡改直接 failed，不自动重试。
changed 通过验证引用让 prepareRepairedWorldCandidate 在同一固定版本上增量准备；
恢复前核对版本事件、覆盖、快照归属以及 Git ref/commit/tree/blob，缺失或错配直接 failed，
不重新抓取当前目录。重放期间再次改变主目录时，新候选仍对应探测版本，后续验证会检出变化。
unknown 没有可用探测版本，继续重新采集。增量准备先重验复用节点和物化产物。
WORLD_REFRESH_STARTED/RECOMPUTING/FAILED/COMPLETED 保存原引用、验证引用、选择路径和结果；
readWorldRefresh 按固定引用只读查询，关闭重开后不调用模型或推进 journal。
matched 复用路径不调用模型：在探测版本的新事务中完整重放所选祖先子图，核对每个结果 hash，
物化写入并映射节点、heads 和已保存产物的依赖；通过普通 prepareWorldStep 保存新版本候选与 checkpoint。
重放前后核验原候选产物，重放不匹配或异常返回 failed，不自动完整重算；失败资源保留。
WORLD_REUSE_PREPARED/FAILED 保存验证引用、新结果及节点映射，关闭重开后仍能读取产物和解释，
并以新候选继续刷新；显式空依赖 `[]` 可复用常量产物，无须调用工具或模型，`null` 仍为 unknown。
复用仍不授予发布许可；strict commit 须再次重验，尤其是刷新后再次发生变化时。它尚非公开 WorldHandle 的完整实现，未提供断点续跑、
幂等刷新或统一资源清理；中断后只有 started 的操作不被当作完成，已有资源保留供后续恢复。

内部验证增加 `selected_nodes` 范围，refresh 使用该范围；原 `prefix` 首差探测保持可用。
它把持久候选祖先子图中的每个节点作为分支 head，复用既有验证器，在同一当前快照的
独立 fork 上重放各自声明的完整祖先日志。每个分支仍首差即停，但独立节点继续检查，
因此被首差遮住的独立变化会进入失效闭包，独立工具异常使整体 failed 且不返回复用计划。
分歧后的后继已被失效，不声称知道其中每个节点是否另有变化；异常仍不转成变化种子。
宿主必须完整声明数据、控制及文件副作用依赖，子图才构成独立可重放的分支。
验证报告持久保存 scope；旧报告缺 scope 时按 prefix 读取。unknown、产物完整性检查及
只读历史规则不变；无新公开入口、无发布许可。逐节点验证会重复祖先工作，尚无性能收益承诺。
此计划描述探测基线；changed 刷新在同一固定版本上重验复用节点、物化产物并执行增量任务。

内部 `explainWorldPreparation` 将候选、验证报告和完成的 refresh 汇入固定截止点的只读解释。
只接受准确的 `worldId/id/atSeq`，从 journal 解析候选覆盖、验证原因、变化源和依赖路径；
不读取当前文件、不调用适配器或模型、不追加事件，返回对象修改不影响历史。
刷新全量重算后，`candidate` 指向新成果，而 `validation.previous` 明确标识失效计划所属的
旧成果；`refresh.strategy/result` 说明实际执行路径，`plan.unaffected` 不代表已经增量复用。
unknown 或验证异常没有计划；失败刷新仍保留旧候选及实际失败结果，不冒充准备成功。
候选自身截止点早于后续验证，因此直接解释候选时 plan 为 null，不隐式取最新验证。
该内部视图尚不包含发布、checkpoint 绑定或资源清理事实；完整 WorldExplanation/公开句柄
仍待这些状态机接入，不把未实现字段填成虚假的成功或资源已回收状态。

内部验证现先用 captureWorldRevision 核验当前精确文件覆盖并固定版本，报告保存 version；
旧报告缺此字段时返回 null，不把旧探测身份冒充可用修复基线。当前覆盖变成 symlink、
目录或被忽略的现存文件时，返回 failed 且不重放。版本随历史保留，重开查询不重新抓取。
validateWorkspaceCausalBranches 与 prepareWorkspaceRepair（含共享分支）接受可选 baseSnapshotId，
可对同一固定版本探测和修复；省略时保持既有当前快照行为。显式快照由调用方拥有，
验证结束或修复失败均不删除它；修复 journal 保存实际 baseSnapshotId，失败仍回收修复 fork。
共享快照不豁免 validateReuse、产物物化检查或最终 OCC；当前目录再次改变时不能凭旧探测发布。
world refresh 的 changed 分支自动调用 prepareRepairedWorldCandidate；unknown/recompute 仍使用完整重算。

固定版本的核验也覆盖句柄打开后的使用阶段：`restoreWorldRevision` 统一接受初始
`WORLD_CREATED` 与后续 `WORLD_VERSION_CREATED`，核对持久身份、覆盖及 Git 对象。
步骤在创建事务前核验版本，物化后核对 fork 的基线指纹，执行后再次核验；验证在重放
前后核验旧候选版本，并在重放后核验探测版本。引用缺失或错配返回 failed，不调用后续
agent、不生成 prepared/changed 结论，已有执行证据和预算保留。该检查不是 Git 引用锁，
也不替代提交阶段的严格验证；未承诺抵御检查间瞬时改写再恢复的外部并发操作。

候选产物也遵守相同的精确文件覆盖契约：执行完成后、验证重放前后，统一检查声明路径的
文件类型及祖先，并核对实际存在的文件是否进入指纹所代表的 Git 树。新建的忽略文件和
空目录可能不改变 Git 指纹，因此仅比较指纹不足以证明产物完整；这两类情况以及符号链接
均返回 failed，保留失败证据，不进入 prepared/matched/changed。合法的普通文件写入、
删除及声明不存在的路径仍可通过。检查仅覆盖声明路径，不推断隐藏依赖，不替代最终 strict
commit，也不构成文件系统锁。

内部 `src/world/repair.ts` 的 `prepareWorldRepair` 将持久的 changed / selected_nodes 验证报告
接到既有 prepareWorkspaceRepair；从报告恢复固定版本和原候选证据，不重新采集当前目录。
复用节点按拓扑顺序在修复事务中完整重放，逐个比较观测及写入结果哈希，写入重放同时物化
复用产物；首差或异常阻断重算。修复前、复用后及完成后核验原候选产物和两个固定版本，
最终核验新产物覆盖与指纹。失败中止隔离事务并记录 WORLD_REPAIR_FAILED，验证基线保留。
WORLD_REPAIR_PREPARED 记录验证引用、版本、复用/替换节点、输出指纹及事务身份。
修复回调第四参及返回值 `refresh` 提供 WorldAgent 增量上下文：固定原候选元数据、解释计划、
全部依赖均在 unaffected 集合内的持久产物。显式 [] 可复用，null 不可复用；传递依赖失效
及混合依赖产物均排除。只在复用重放和源产物核验通过后暴露上下文，各回调获得独立副本。
原候选元数据不夹带 journal 中的失效正文；WORLD_REPAIR_PREPARED 保存可复用/失效产物 ID。
本切片仍只返回内部 open 事务；未执行 WorldAgent 或绑定新 checkpoint，未产生新的 WorldCandidate，
自动增量 refresh 使用下述 WorldAgent 准备执行器。工具结果哈希依赖适配器声明，不代替最终 OCC、业务验收或
独立 oracle；非确定性模型响应只选择持久正文，失效后的模型调用仍须由后续 agent 适配层执行。

未跟踪依赖的工具链保留已记录事件身份：后续观测/写入可引用本步骤中依赖为 null 的事件，
以及其传递后继；这些事件保存实际 dependsOn，但不进入可复用因果图。结果和 checkpoint
的 causalHeads 为 null，候选返回 unknown；混合依赖中出现伪造或跨步骤序号仍失败。


内部 `prepareRepairedWorldCandidate` 现在与 matched 路径共用候选准备执行器，并复用
prepareWorldRepair 的产物筛选规则。changed / selected_nodes 报告的固定版本上，先重放
unaffected 节点并物化写入、核验所有哈希，再调用一次 WorldAgent.execute；首差或异常不调用 agent。
refresh.previous 与 plan 保持历史身份，reusableArtifacts.dependsOn 映射为本次新节点，
宿主须在返回 artifacts/heads 中显式保留所需复用成果，并记录新工作的依赖；直接引用旧节点拒绝。
普通 prepareWorldStep 负责覆盖、产物、候选及 AgentRuntime checkpoint 保存；null 依赖返回 unknown。
新候选支持关闭重开后取回产物和再次验证，WORLD_REUSE_* 记录 incremental 模式及节点映射。
refresh 协调器自动选择此增量路径，strategy 为 incremental；发布使用下述内部 strict commit，业务结果仍由宿主验收。
refresh.reusedNodes 提供全部复用节点的 sourceSeq → replacementSeq 映射（包括无产物节点），
宿主可据此声明新依赖和 heads；plan 保持源节点身份。底层 prepareWorldRepair 保留原复用节点身份。
explainWorldPreparation.reuse 从固定截止点读取实际 matched/incremental 模式及已重放节点映射，
失败时可能仅有部分映射，不表示候选准备成功；最终状态仍以 refresh.result 为准。

### 内部 strict publication（M2 部分实现）
`commitWorldCandidate(world, ref, adapter, { key })` 只消费固定候选记录，忽略调用方改写的 heads、覆盖和输出。
它复用事务发布队列、完整观测重放、OCC 与实际发布目录的只读 accept；核验固定版本、持久产物、
候选输出及发布目录精确覆盖。unknown 不发布，工具异常为 validation_failed，变化为 conflict，
输出篡改或业务拒绝为 rejected。WORLD_PUBLICATION_RESULT 保存结果，TX_COMMITTED 回执是文件发布事实。
同 domain 内该入口共用 supervisor 队列；同 txId 成功重试及关闭重开直接读取原回执，候选清理不改变身份。
已写 TX_COMMITTING 但未有回执的异常返回 undetermined 并保留证据；本层尚未实现自动恢复未决发布。
独立 key 在验证前写入 WORLD_PUBLICATION_KEY_BOUND，同 domain 串行协调绑定和发布；冲突 key
返回原身份，终态重试不重验，成功候选使用新 key 返回原身份且不绑定新 key。内部省略 key 时使用候选 id。
WORLD_PUBLICATION_KEY_RESULT 持久保存带 worldId/candidateId/txId/key 的结果；validation_failed 可用原 key 重试。
`readWorldPublication(world, key, atSeq?)` 固定截止点只读查询；绑定前为 null，绑定后缺结果为 undetermined，
若截止点内已有 TX_COMMITTED 则直接恢复 committed（即使 world 结果未写入）。查询不依赖候选文件。
这是内部桥接，不是冻结的 WorldHandle.commit 实现：仍缺 checkpoint 绑定状态及 close 资源报告；
strict publication 的工具异常保存 TX_REPLAY_FAILED（失败索引、已匹配步数与错误），清理临时重放 fork/快照，
底层事务保持 open；原候选原 key 在关闭重开后可重试，重新完整重放并核验所有门禁。
异常发生在写入一部分之后也不发布临时内容；重试前世界变化仍须判冲突。旧的非 publication 入口保持既有冲突语义。
不能据此宣称 M2 或崩溃恢复已完成。


### 内部 publication explanation（M2 部分实现）
`explainWorldPublication` 组合现有 preparation 和 publication 只读查询，返回固定截止点、
准备证据及发布事实。候选/验证/refresh 引用沿用其精确截止点；提交身份查询省略 atSeq
时只捕获一次当前 journal head。身份的 worldId/candidateId/txId/key 必须全部匹配
该截止点内的持久 key 绑定；绑定尚未发生的身份查询拒绝，准备引用仍可查询 publication=null。
绑定后缺结果为 undetermined；TX_COMMITTED 截止点即可报告发布，不依赖后续 world 结果事件。
刷新候选的提交解释关联其 WORLD_REFRESH_COMPLETED，保留变化路径、实际复用映射和验证基线。
查询不读取当前工作区、不执行工具、不写 journal 或改变 Run 预算；固定截止点重开结果一致。
这是内部组合视图，尚未实现 checkpoint 绑定或 close 资源事实，也未新增公开 API。
