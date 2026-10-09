# Codex evolution

## 2026-10-08 — 恢复 checkpoint 时验证编辑工具的返回结果

- 方向：沿用 ROADMAP 的观测有效性与局部恢复主线，修复证据不足却恢复上下文的问题，不扩展调度框架。
- 缺口：`recoverAgentWorkspace` 只要求 observe 的 `resultHash`。缺少哈希的 mutate 只检查是否执行成功；编辑返回的引用、诊断等内容即使改变，仍可能恢复依赖旧结果的 checkpoint。E7 已说明编辑返回值可能比后续读取更早失效。
- 计划：先写真实文件回归，证明无哈希编辑会错误恢复；恢复入口要求每一步都有非空结果哈希，包括 mutate，并在创建候选 fork 前拒绝不完整证据。已有事务提交 API 的可选 mutation 哈希语义不变。
- 验证：缺失/空哈希不调用 replay、不分叉、不改 agent 或原事务；完整但变化的编辑结果回退至较早 checkpoint，完整且一致的结果正常恢复；运行 typecheck、全量测试与打包验证。
- 基线：`pnpm install` 成功。首次测试 405 通过、7 跳过，3 个测试文件因缺少 `cc` 无法启动；补齐 build-essential 后重跑。最终结果追加在下方。
- 边界：哈希由宿主规范化并记录；内核不能证明宿主日志完整，也不据此宣称外部副作用可重放或模型成本降低。

### 实施与复现

- 先运行新增回归：旧实现 2 项失败（缺失/空 mutation 哈希仍返回 `restored`）；修复后恢复文件 18 项通过。重放编辑返回不同引用时，两种 replay policy 都恢复到编辑前的 checkpoint，候选编辑不泄漏，已花费预算保留。
- 复现命令：`pnpm exec vitest run tests/agents/workspace-recovery.test.ts`。这是确定性工具与真实文件实验，不包含模型调用或成本推断。
- 全量验证发现两个已有测试假设不稳定：ctime 用例使用当前纳秒 mtime，经过浮点 `utimes` 后可能超出清单容差；契约 9 在停止确认后、结果落盘前检查租约已释放。分别将 ctime fixture 的 mtime 固定为整秒、将租约断言放到执行结清后，保留停止后立即验证后代消失的断言；不改运行时的时间戳或停止语义。相关 3 文件共 90 项通过。

### 最终验证（2026-10-08）

- 审查确认恢复入口在候选 fork 创建前校验所有步骤；补充 observe 缺失/空哈希回归，与 mutate 共四种拒绝场景。事务提交的可选 mutation 哈希契约保持不变。
- 本轮环境仍缺少 `cc`：首次全量测试 411 通过、7 跳过，3 个文件因原生编译失败；首次打包也因此失败。安装 `build-essential` 后重跑成功。
- `pnpm typecheck`：通过（包含新增回归）。
- `pnpm test`：40 个文件通过、1 个跳过；504 项通过、7 项跳过、0 失败，耗时 79.38 秒。
- `pnpm verify:package`：构建、原生编译、打包、独立项目安装及 18 项嵌入方契约检查全部通过。
- `git diff --check`：通过。下一轮优先接入真实 agent runner，比较观测有效性驱动的局部恢复与完整重跑，量化上下文复用率、错误恢复率和实际工具/模型开销。

## 2026-10-08 — 世界状态操作系统定位与持久化因果图

- 方向：按用户新要求，从受监督执行内核升级为 AI agent 的因果可验证世界状态与执行操作系统。新增 `docs/VISION.md`，明确世界版本、执行事务、因果节点、增量修复和时间旅行抽象，以及与 Temporal / LangGraph / Docker / Git 的区别与五阶段路线。同步 README 与包描述。
- 本轮纵向切片：导出实验性 `WorkspaceCausalGraph`，复用现有 domain SQLite journal 和 TX 生命周期。工具结果节点关联 actor、事务、run、基线快照、结果哈希、声明写集与跨 agent 依赖；只引用已存在节点保证有向无环结构。
- 查询：支持上游溯源、历史序号切片、观测失效种子的传递重算计划，以及兼容现有 ObservationEntry 的事务日志提取。独立子图不进入失效闭包；已结束事务的历史在 fork 回收和 domain 重启后仍可查询。
- 文档与示例：`docs/causal-graph.md` 展示真实文件读取、派生写入、事务提交、因果查询与失效计划。声明 actor / writes / dependencies 的宿主责任，区分历史切片与文件恢复、失效计划与自动重算。
- 基线：已有 node_modules 可用且依赖未变化，无需重新安装。修改前 `pnpm test`：504 项通过、7 项跳过，耗时 78.72 秒。
- 新增 5 项测试：跨 agent 菱形依赖与独立分支、历史切片、重启后恢复并接入真实文件观测重放、实际文件提交与 fork 回收后的溯源、非法引用与关闭事务拒绝、调用方对象隔离。
- 边界：本轮没有自动修复执行器，没有放宽现有 OCC，也没有模型成本收益结论。图依赖完整性由宿主负责，当前查询读取整个 domain journal。
- 下一轮：将因果节点绑定 AgentRuntime checkpoint，在同一新基线的 disposable fork 上验证并重算失效子图；增加与完整重跑的可复现对比，先报告真实工具调用次数与正确性，再接入模型 token 计量。
- 最终验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过；`pnpm test`：41 个文件通过、1 个跳过，509 项通过、7 项跳过、0 失败，耗时 79.43 秒。

## 2026-10-08 — 共享快照上的多策略投机执行与 OCC 胜者提交

- 本轮切片：新增实验性 `speculateWorkspace`。先为所有策略创建同一基线快照的隔离事务，再并行执行回调，等待全部结束后按声明优先级尝试 OCC 提交。策略失败或事务冲突时尝试下一候选，只提交一个胜者；无胜者时返回各候选原因。
- 复用与证据：继续使用既有 snapshot / WorkspaceTransactions / observation replay；回调可返回 `CommitOptions`，也可通过 `WorkspaceCausalGraph` 记录工具来源。新增 journal 选择事件关联策略、事务、共享快照和提交结果，fork 回收后保留历史。
- 生命周期：正常结束回收其余候选与共享快照。初始化中途失败时清理已创建事务；等待所有策略结清后才清理。提交异常时停止选择其他胜者，保留可能处于应用阶段的事务及基线以供恢复，并显式汇总执行基础设施或清理错误。
- 测试：新增 5 项真实 Git/文件系统回归，覆盖并行启动与 fork 隔离、统一基线和固定优先级、外部文件变更引发 OCC 冲突后提交独立候选、全失败/冲突无胜者、提交异常保留现场、初始化失败清理与非法策略 ID 拒绝。
- 文档：更新 README、VISION 的已实现范围，新增 `docs/speculative-workspaces.md` API 示例、提交语义、观测适配与恢复说明。
- 基线与环境：依赖未变化、已有 node_modules 可用，无需 pnpm install。首次基线为 416 项通过、7 项跳过，3 个测试文件因缺少 cc 无法启动；安装 build-essential 后完成全量验证。
- 最终验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 全部通过；`pnpm test` 为 42 个文件通过、1 个跳过，514 项通过、7 项跳过、0 失败，耗时 81.84 秒。
- 边界：当前为等待全部策略结束的固定优先级选择，未实现抢先取消、多胜者合并、因果子图自动重算或模型上下文恢复。OCC 沿用现有验证强度，任务质量由策略验证，不作 token 节省结论。
- 下一轮：将投机候选的因果节点接入观测失效后的局部修复；在同一扰动任务上对比完整重跑与只重算依赖子图的正确性、真实工具调用次数与耗时，再接入模型 token 计量。

## 2026-10-08 — 从失效计划到隔离事务中的因果子图重算

- 本轮纵向切片：新增实验性 `prepareWorkspaceRepair`，复用因果图、snapshot / fork 和 WorkspaceTransactions。从当前主工作区创建新基线，冻结源历史，按拓扑顺序只执行失效闭包；菱形汇合只执行一次，下游接收替代节点的新证据，独立节点保持历史身份。
- 来源与提交：持久记录 `CAUSAL_REPAIR_PREPARED`，关联源节点、替代节点和复用节点。成功返回仍打开的事务，由宿主检查并通过既有 OCC 提交；准备完成不等于提交完成。失败时中止事务并回收本次 fork / snapshot，清理失败汇总原始错误。
- 复用边界：宿主通过 `validateReuse` 验证新基线上的独立证据和输出，通过 `execute` 实现工具重算。提交证据仍须覆盖复用输入。没有自动 AgentRuntime 上下文恢复、自动变化检测或旧副作用撤销；尚未按活跃分支筛选跨轮历史，不宣称模型 token 收益。
- 测试：新增 6 项真实 Git / 文件系统回归，覆盖受影响工具执行与实际提交、复用验证失败、执行失败清理、非法种子、并发写入 OCC 冲突，以及跨 agent 菱形依赖去重、参数隔离和重启后来源查询。定向测试 11 项全部通过。
- 文档：新增 `docs/causal-repair.md`，包含工具适配与 OCC 提交示例、生命周期和复用条件；更新 README 和 VISION 的已实现范围。
- 环境与基线：依赖未变化，现有 node_modules 可用，无需 pnpm install；补齐缺失的 build-essential。首次基线运行与测试文件修改交叠，不能当成干净基线；随后在独立 HEAD 副本验证，514 项通过、7 项跳过，耗时 85.82 秒。
- 验证过程：第一次修改后全量运行与独立 pnpm build 交叠，崩溃矩阵子进程读到正在重写的 dist 文件而失败（缺少 ignoredManifestPath 导出）；其余 519 项通过。停止并行构建后重新运行全量测试，最终结果见下方。
- 下一轮：增加选定执行分支的有效节点视图，将替代关系接入多轮修复与投机候选；用相同文件扰动对比完整重跑和局部重算的正确性、工具次数与耗时，再绑定 AgentRuntime checkpoint 和真实模型 token 计量。
- 最终验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过；不与构建交叠的 `pnpm test` 为 42 个文件通过、1 个跳过，520 项通过、7 项跳过、0 失败，耗时 83.58 秒。

## 2026-10-08 — 显式因果分支视图与连续多轮修复

- 本轮纵向切片：新增 `WorkspaceCausalGraph.view(heads, atSeq?)`，按结果节点选择包含全部上游的执行分支；允许跨 agent / 事务依赖，排除未选中的投机候选及旧版本。支持历史切片、去重和 domain 重启后查询，不修改原 journal。
- 接入执行：`planRecomputation` 和 `prepareWorkspaceRepair` 支持可选 `heads`；失效种子必须位于所选视图，在创建事务前校验。修复返回替代后的 heads，并在 `CAUSAL_REPAIR_PREPARED` 持久记录 sourceHeads / heads；下一轮直接沿用当前分支，无需重算其他历史版本（查询仍读取 domain journal）。省略 heads 保留旧 API 的 domain 全历史行为，同时返回末端结果集合供迁移。
- 验证：新增 3 项回归，覆盖跨 agent 分支选择、候选排除、历史边界和参数隔离；连续两次真实文件扰动各只执行当前分支的两个受影响工具，独立输出复用，两次 OCC 提交后文件正确；重启后恢复各代视图；视图外种子不创建事务或 fork。定向测试 14 项通过。
- 文档：更新 README、VISION、因果图 API 与修复示例，说明连续修复如何使用新的节点身份和 heads，以及 prepared 分支与已提交世界的区别。
- 环境与基线：已有 node_modules 与 cc 可用，依赖未变化，无需 pnpm install；修改前干净基线 520 项通过、7 项跳过，耗时 89.96 秒。
- 边界：分支选择由宿主显式提供；没有自动物化旧输出、自动变化检测、AgentRuntime 上下文恢复或文件时间旅行。视图不会证明提交状态或依赖完整性；测试中的工具次数不构成模型 token 或耗时收益结论。
- 下一轮：基于显式分支构建相同扰动任务下的完整重跑 / 局部修复基准，记录正确性、真实工具次数与耗时；随后将投机候选 OCC 冲突接入局部修复，并绑定 AgentRuntime checkpoint。
- 最终验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过；构建结束后运行 `pnpm test`，42 个文件通过、1 个跳过，523 项通过、7 项跳过、0 失败，耗时 85.20 秒。

## 2026-10-08 — 因果局部修复的可复现文件基准
- 新增 `pnpm benchmark:causal [trials] [branches] [hashRounds]`，复用真实 Git/文件事务、因果图、局部修复与 OCC，比较完整重跑、增量修复、不校验复用；输出版本化 JSON、环境和原始样本。
- 任务：独立的 read→derive→write 分支，逐轮轮换输入扰动和策略顺序；每个策略从相同内容的新工作区开始，验证全部输出；不使用人工 sleep 或模型调用。
- 计量：分别统计实际工具次数、变化检测读取、复用验证读取、复用节点、实际提交校验等级与端到端耗时，包含验证及事务成本，不把节点节省当作 token 收益。
- 实测：3 轮×4 分支，重跑与修复均 3/3 正确，工具次数 12→3，修复另有 4+6 次验证读取；中位耗时 95.63→86.45 ms；不校验复用 0/3 正确。原始 JSON 与口径见 `docs/causal-repair-benchmark.md`。
- 测试：新增 6 项，覆盖相同扰动与输出哈希、独立分支复用、负对照错误、全部节点失效、指标统计及非法参数。同步 README/VISION，创建缺失的交接摘要。
- 基线：已有依赖和 cc，无需 install；首次基线与新增文件交叠触发同步子进程门禁，已使用异步 execFile；独立 HEAD 副本干净基线 523 通过、7 跳过。
- 最终验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 通过；`pnpm test` 为 43 文件通过、1 跳过，529 项通过、7 跳过，耗时 84.52 秒；实测采样未与测试/构建交叠。
- 边界与下一轮：当前固定依赖、确定性文件任务、无并发写入，`modelTokens: null`；下一轮将投机候选 OCC 冲突接入显式分支的局部修复，再绑定 AgentRuntime checkpoint 与真实模型计量。

## 2026-10-08 — 投机候选冲突后的因果局部修复
- 新增策略 `repair(original, conflict)`：原候选 OCC 冲突后，在当前世界新建事务，按显式 heads 局部重算，再走普通 OCC；每候选一次修复，保留优先级，再次冲突转向后备候选。
- 复用 `prepareWorkspaceRepair`，原 fork 保留供宿主验证及物化独立输出；重算后通过 `commitOptions` 收集包含复用输入的提交证据。
- `candidate.commit` 保留原冲突，`candidate.repair` 保存新事务、heads 与提交结果；新增 `SPECULATION_REPAIR_PREPARED` 关联策略及前后事务。
- 生命周期：正常回收原候选、修复 fork 和全部基线；修复回调错误终止并清理；提交抛错保留不确定事务及基线，不再选择其他胜者。
- 新增 5 项集成测试：选中子图及下游重算、独立结果物化与兄弟分支隔离、再次冲突回退、工具/证据错误清理、不确定提交保留；更新 README、VISION 和 API 示例。
- 环境与基线：依赖未变，无需 install；首次基线因缺 cc 导致 3 套件无法启动，安装 gcc / libc6-dev 后独立 HEAD 副本 529 通过、7 跳过（90.21 秒）。
- 验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 通过；`pnpm test` 534 通过、7 跳过（96.11 秒）。
- 边界与下一轮：变化种子、完整依赖和复用有效性由宿主负责，不自动恢复上下文或合并多个胜者；下一步绑定 AgentRuntime checkpoint 与因果 heads，再扩展投机修复基准。

## 2026-10-08 — AgentRuntime 上下文与因果分支绑定
- create / step result 新增 causalHeads，与 checkpoint 在同一 AGENT_STATE 事件持久化；验证同 domain 已有节点并去重，允许跨 actor / 事务依赖。
- checkpoints 返回历史 workspace / heads；checkpointCausalView 按保存时序查询所选分支与祖先，排除后续节点和兄弟分支。
- findValidCheckpoint 使用候选自己的 heads；restoreCheckpoint / recoverCheckpoint 同步恢复上下文与 heads，保留工作区重建契约及已消耗预算。
- 未声明 / null 表示未跟踪，[] 表示空分支；新步骤不提供 heads 会清除旧关联；旧 journal 兼容，非法步骤引用保留旧 checkpoint 并中断。
- 新增 5 项集成测试：历史分支及重开 domain、候选证据校验、空与缺失语义、异步恢复失败/成功、非法引用；同步 README、VISION 和运行时契约示例。
- 环境与基线：已有依赖和 cc，无需 install；基线 534 通过、7 跳过（88.77 秒）。
- 验证：pnpm typecheck、pnpm build、git diff --check 通过；全量 539 通过、7 跳过（87.47 秒）。
- 边界与下一轮：历史绑定不恢复文件或证明提交/当前有效性；下一步按 checkpoint heads 查询受失效影响的 agent，接通因果修复与上下文重建。

## 2026-10-08 — 跨 agent 因果失效与恢复计划
- 新增 AgentRuntime.planCausalRecovery(changed)，从已确认变化的观测追踪跨 agent 依赖，返回受影响上下文、失效 heads 和选中分支内的失效节点。
- 为受影响 agent 选择最近未受这些种子影响的历史 checkpoint；区分 unaffected / untracked，包含终态输出，不写 journal 或执行工具。
- 新增 3 项集成测试，覆盖依赖传播、兄弟分支隔离、候选恢复、最近候选、重开 domain、未跟踪历史、终态输出与非法种子。
- 更新 README、VISION、运行时契约与 recoverCheckpoint 接入示例；示例检查 checkpoint 推进，由宿主重建和验证世界状态。
- 无需 install；初次全量与编辑重叠，原有 539 项通过、新增 3 项因缓存旧实现失败；稳定代码后重新完成全量验证。
- 验证：pnpm typecheck、pnpm build、git diff --check 通过；定向 8 通过；pnpm test 542 通过、7 跳过（85.91 秒）。
- 边界与下一步：恢复候选不证明当前有效，不自动重建模型上下文；下一轮编排影响计划、文件子图修复与上下文重建并绑定新 heads。

## 2026-10-08 — 因果修复与 agent 上下文原子绑定
- 新增 recoverCausalCheckpoint(id, expectedCheckpointSeq, prepare)，拒绝过期计划和未跟踪上下文，在独占恢复期接收宿主重建结果。
- causal_repaired checkpoint 原子绑定新上下文、工作区与显式 heads，记录源 checkpointRef；保留预算，清除旧验证版本，成功后停在 paused。
- 抽取并复用既有恢复生命周期：准备失败保留原上下文，绑定失败/中断调用 discard，shutdown 等待恢复结束。
- 新增 4 项集成测试，覆盖实际文件变化后的局部修复/独立节点复用、重开与恢复、过期计划、失败清理、中断及未跟踪/终态拒绝。
- 更新 README、VISION、运行时契约与宿主 prepareWorkspaceRepair / 上下文重建接入示例；重写交接摘要。
- 无需 install；基线 542 通过、7 跳过；pnpm typecheck、pnpm build、git diff --check 通过，定向 64 通过，全量 546 通过、7 跳过（90.90 秒）。
- 边界与下一步：绑定不提交文件或证明世界有效；宿主重建上下文、验证复用与计量修复成本，下一轮将投机冲突修复或跨 agent 重建纳入基准。

## 2026-10-08 — 多 agent 兼容结果合并
- speculateWorkspace 新增 commitPolicy: all_valid，按声明顺序逐个 OCC 提交；默认 first_valid 保持单胜者。
- winners 返回全部胜者，winner 保留首个；后续候选检查先前提交，继续支持观测重放与一次因果局部修复。
- 新增逐候选提交 journal，记录策略、实际事务及累计胜者；批次非原子，异常保留已有提交并停止不确定提交后的选择。
- 新增 5 项测试覆盖兼容合并、写冲突、读观测失效、跨胜者局部修复、部分提交异常与原有修复复用。
- 更新 README、VISION、投机使用说明与多 agent 示例，重写 37 行交接摘要。
- 环境已有 node_modules；初始基线 453 通过、7 跳过，3 套件缺 cc；安装 build-essential 后恢复原生测试。
- 验证：pnpm typecheck、pnpm build、git diff --check 通过；pnpm test 551 通过、7 跳过（89.94 秒）。
- 下一步：将多 agent 合并冲突修复纳入可复现基准，比较完整重跑的正确性、工具成本与耗时。

## 2026-10-08 — 投机合并冲突恢复基准
- 新增 pnpm benchmark:merge：真实 Git / SQLite / 同快照双策略执行，all_valid 发生写冲突后对照全量重跑与因果局部修复。
- 复用 speculateWorkspace / prepareWorkspaceRepair；局部恢复验证独立输入与原 fork 输出，再物化可复用结果。
- 指标计入首次失败投机，分别报告恢复工具、检测读取、复用校验、复制写入、全部输出正确性与端到端耗时。
- 实测 3×4 分支均 3/3 正确；总工具 25→16、恢复工具 12→3；局部额外 4 读+6 校验读+3 写，modelTokens null。
- 新增 5 项测试覆盖轮换扰动、逐文件独立 oracle、全失效无复用及参数校验；更新协议、JSON 样本、README / VISION 与 44 行交接。
- 基线 551 通过、7 跳过；全量发现 src 同步子进程门禁，已改用现有异步 execFile 方式并重新生成样本。
- 最终验证：pnpm typecheck、pnpm build、git diff --check 通过；pnpm test 556 通过、7 跳过（88.72 秒）。
- 下一步：仅观测失效的合并冲突基准，或跨 agent 恢复编排与真实模型计量。

## 2026-10-08 — 历史 checkpoint 分叉与确定性重放
- 新增 forkAgentCheckpoint：复用历史事务基线、观测重放和 AgentRuntime，重建文件世界后创建具有历史上下文 / heads 的新 agent。
- 逐步校验包含 mutation 的结果哈希；分歧返回首个位置及错误并清理 fork，创建失败也清理，共享历史基线保留。
- 同 Run 创建计入 agent 限额，已用步数不回退；记录 AGENT_CHECKPOINT_FORK_PREPARED 来源，实际绑定以 AGENT_STATE 为准。
- 7 项新增测试覆盖真实历史文件重建、源 fork 删除、Run 预算、重启查询、重放分歧 / 异常、缺失快照和哈希隔离。
- 新增 docs/checkpoint-forks.md 契约与示例，更新 README / VISION 与 45 行交接摘要。
- 边界：checkpoint 粒度、宿主保证完整确定性操作前缀；不重放模型 / 外部系统，不自动提交；准备后崩溃由宿主回收事务。
- 验证：基线 556 通过、7 跳过；定向 19 通过；pnpm typecheck、pnpm build、git diff --check 通过；全量 563 通过、7 跳过（88.94 秒）。
- 下一步：历史分支上下文 / 因果 / 文件差异查询及对照调试示例。

## 2026-10-08 — 跨 agent 历史 checkpoint 因果对照
- 新增 compareAgentCheckpoints：对照历史上下文、工作区绑定、共同 / 独有因果节点与结构分歧起点。
- JSON Pointer 字段差异区分新增 / 删除 / 修改；数组整体比较；节点按 journal 身份比较，不按哈希合并。
- 两侧各用自身历史序号，隔离后续 / 兄弟分支；未跟踪证据显式返回 untracked；纯查询不消耗预算。
- 新增 5 项测试并扩展历史重放集成测试，覆盖跨 agent、重启、结果副本、转义、空证据与历史切片。
- 新增 docs/checkpoint-comparison.md 对照调试示例，更新 README / VISION / 分叉文档与 52 行交接。
- 边界：writes 是声明的写入来源，不是实际文件 diff；结构分歧不证明语义错误或观测失效。
- 验证：基线 563 通过、7 跳过；定向 24 通过；typecheck / build / diff 检查通过；全量 568 通过、7 跳过（89.89 秒）。
- 下一步：历史重放分支的实际文件差异与可运行对照调试示例。

## 2026-10-08 — 历史 checkpoint 文件世界对照
- 新增 compareAgentCheckpointFiles：重建两侧历史文件世界，返回实际文件 A/D/M/T 差异及上下文 / 因果对照。
- 提取共享历史重放路径，复用 forkAgentCheckpoint 的基线、完整前缀与逐步结果哈希校验。
- 不创建 agent；分歧显式返回 side；成功 / 分歧 / 异常清理临时事务，保留历史基线。
- 新增 5 项测试，覆盖历史源删除、主目录变化、跨基线子目录、二进制 / 特殊路径 / 符号链接、分歧与清理。
- 新增可运行 examples/checkpoint-debug/run.mjs，更新 README / VISION / 契约与 60 行交接摘要。
- 边界：仅同原始工作区根和 Git 快照覆盖范围，无文本 patch；前缀真实性和确定性由宿主保证。
- 环境基线因缺 cc 有 3 套件未启动，安装 gcc / libc6-dev 后恢复；修正新增夹具违反事务独占绑定的问题。
- 验证：typecheck / build / 示例 / diff 检查通过；定向 29 通过；全量 573 通过、7 跳过（90.34 秒）。
- 下一步：跨 agent 失效恢复编排，连接影响计划、局部上下文重建与批次结果。

## 2026-10-08 — 跨 agent 因果恢复批次
- 新增 recoverAgentCausalBatch，连接失效计划与单 agent 局部上下文恢复，保留初始计划和逐项结果。
- 跳过过期 checkpoint 和未停止 agent；宿主放弃或中断不发布新上下文，失败继续后续项。
- 复用 causal_repaired journal、独占恢复、预算和 discard 机制，不回滚已成功绑定。
- 新增 4 项集成测试：真实多工作区重算 / 重开 domain、失败清理、过期计划、终态与中断。
- 新增批次契约和集成示例，更新 README / VISION / runtime spec，交接摘要保持 60 行以内。
- 边界：批次非原子，登记顺序非拓扑顺序；共享祖先可能重复重算，宿主负责依赖协调和 OCC 提交。
- 验证：基线 573 通过、7 跳过；定向 33 通过；typecheck / build / diff 检查通过；全量 577 通过、7 跳过（90.99 秒）。
- 下一步：共享失效祖先的重算去重与结果分发，明确依赖顺序及部分失败语义。

## 2026-10-08 — 多分支共享因果修复
- 新增 prepareWorkspaceBranchRepair：合并兼容分支视图，按历史节点 seq 去重并拓扑重算共享祖先。
- 在同一修复事务内执行，按分支 id 分发 sourceHeads / 新 heads，保留独立与空分支。
- 分发映射与替代关系同条 journal 持久化；连续修复不引入旧版本或未选兄弟分支。
- 复用既有 OCC 和失败清理；任一步失败中止整个准备，不发布部分结果。
- 新增 4 项集成测试，覆盖双代文件提交 / 重启、调用去重、失败回收、非法选择与 OCC 冲突。
- 更新共享修复示例、批次恢复边界、README / VISION；交接摘要 59 行。
- 验证：基线 577 通过、7 跳过；定向 18 通过；typecheck / build / diff 通过；全量 581 通过、7 跳过（93.17 秒）。
- 下一步：协调共享事务所有权与跨 agent 上下文绑定；当前文件提交与 checkpoint 绑定非原子。

## 2026-10-08 — 共享因果重算与独立上下文绑定
- 新增 recoverAgentSharedCausalBatch：冻结影响计划，一次 prepare 后逐项绑定共享修复分支。
- 校验 agent id / sourceHeads，自动填入新 heads；保留 checkpoint 版本检查、部分失败与持久恢复。
- 共享 repair 由宿主持有；bind 提供独立事务和上下文，避免回收成功 agent 依赖的共享资源。
- 保留单事务单活跃 agent；明确输出分发、复用验证和 OCC 仍由宿主实现，批次非原子。
- 新增 3 项集成测试，覆盖祖先去重、独立文件世界、重启、预算、过期计划、失败和所有权拒绝。
- 修正原有恢复测试夹具：记录 OS 启动时间，避免墙钟 / btime 差异触发 PGID 复用误判。
- 验证：基线 578 通过 / 3 失败 / 7 跳过；原失败复验通过；定向 36 通过；全量 584 通过、7 跳过（94.69 秒）；typecheck / build / diff 通过。
- 下一步：自动化共享输出分发与 OCC 提交协调，基准计入重算、验证、复制成本。

## 2026-10-08 — 共享祖先重算与独立输出分发基准
- 新增 pnpm benchmark:shared：真实 Git / journal / fork / OCC 上对比独立修复、共享修复、不校验复用。
- 固定公共 read→derive→N 个分支 write；共享输出分发至独立事务，逐份验证输入，再逐项提交。
- 计入实际工具、检测、分发读写 / 字节、输入验证、事务数与端到端耗时；无模型 token 推断。
- 3×4 实测两种修复均 3/3 正确，工具 12→6；复制 264 字节，事务 4→5，中位耗时 358.16→384.95 ms。
- 新增 6 项测试：重复扰动、独立 oracle、负对照、单分支无收益及非法参数；保存原始 JSON 和协议文档。
- 基线缺 cc 导致 3 个测试文件构建失败；安装 build-essential，未修改原生执行代码。
- 下一步：通用共享输出分发与 OCC 证据迁移，优化额外事务及复制成本。

## 2026-10-08 — 因果分支再验证与自动修复种子
- 新增 validateWorkspaceCausalBranches：同一当前世界基线，逐分支隔离重放完整因果前缀。
- 首次哈希差异映射为因果 seq，跨分支去重并生成联合失效计划，直接接入共享修复器。
- 区分 matched / changed / failed；工具异常不充当失效证据，分支失败不污染其余工作区。
- 回收验证事务及临时基线；不提交、不绑定 checkpoint，复用验证与 OCC 仍必需。
- 新增 5 项集成测试，覆盖修复提交、基线冻结、变更隔离、工具错误及非法声明。
- 补充 API 使用文档和入口链接；交接摘要 59 行；先独立提交遗留暂存的共享修复基准。
- 验证：基线 590 通过 / 7 跳过；最终 typecheck 通过，595 测试通过 / 7 跳过（98.49 秒）。
- 下一步：持久化验证报告与基线身份，串联自动探测和局部修复；推进通用输出分发。

## 2026-10-08 — 持久验证证据驱动自动共享修复
- CAUSAL_VALIDATION_COMPLETED 保存源分支、基线 SnapshotRef 元数据、探测状态及去重种子。
- listWorkspaceCausalValidations 支持 domain 重开、Run 过滤与报告序号历史切片，按冻结源图重建计划。
- prepareWorkspaceCausalRefresh 自动探测并准备一次共享修复；任一 failed 或全部 unchanged 不分配修复事务。
- 持久关联 validationSeq / repair txId，关联失败回收修复；成功仍由宿主 OCC 提交与绑定 checkpoint。
- 新增 6 项测试，覆盖重开 / 快照回收、历史查询、真实文件提交、失败探测及修复 / 日志故障清理。
- 文档明确修复采用新基线、报告不是 OCC 证书，以及崩溃可能留下未关联准备记录；交接摘要 59 行。
- 验证：基线 595 通过 / 7 跳过；最终 pnpm typecheck 通过，pnpm test 601 通过 / 7 跳过（100.40 秒）。
- 下一步：通用共享输出分发与提交协调，接入真实模型基准。

## 2026-10-08 — 每次提交的强制观测 OCC
- 新增 observationPolicy: 'always'：无文件冲突、无 atime 读证据时仍重放完整操作日志。
- 成功仅报告 observations，从当前世界的重放分叉提交；默认 on_conflict 保持兼容。
- 校验 closedWorld 与 observe 哈希；观测失效可返回空文件冲突数组，写写冲突仍拒绝。
- 复用重放期间世界变动检测、临时资源回收及 TX_COMMITTING 崩溃后继续应用。
- 新增 7 项测试覆盖 noatime、过期观测、并发修改、无效声明、进程逃逸、写冲突和重启恢复。
- 共享修复集成测试接入强制提交；补充完整因果视图日志示例及复用祖先限制。
- 验证：基线 601 通过 / 7 跳过；pnpm typecheck 通过，最终 608 通过 / 7 跳过（101.00 秒）。
- 下一步：通用输出分发与提交协调，量化强制观测验证成本并扩展真实模型基准。

## 2026-10-08 — 因果刷新自动发布
- 新增 refreshWorkspaceCausalBranches：探测变化、共享修复、完整联合证据重放与提交一次完成。
- 从修复 heads 提取拓扑日志，包含复用祖先，固定 observationPolicy: 'always'。
- 成功回收基线；冲突中止回收；提交抛错保留恢复资源，以事务 journal 判断实际进度。
- 复用 validationSeq→txId→提交事件追溯；不绑定 checkpoint、不分发独立事务。
- 新增 3 项集成测试覆盖共享输出、复用祖先再次失效及提交异常；早退测试改用新入口。
- 补充 API 示例、联合日志完整性及资源生命周期契约，更新 VISION。
- 基线因缺少 cc 无法完成，补齐 gcc / libc6-dev；最终 typecheck 通过，test 611 通过 / 7 跳过（98.97 秒）。
- 下一步：独立输出分发与 checkpoint 发布协调，量化强制验证成本。

## 2026-10-08 — 自动因果刷新的端到端验证成本
- 新增 pnpm benchmark:refresh，对比完整重跑 / 自动刷新 / 不校验复用；两种发布均强制重放。
- 分别计量生成、探测、复用校验、提交重放工具调用与 journal 事务 / 快照数、耗时、正确率。
- 支持零 / 局部 / 全部输入变化，轮换扰动分支与运行次序；新增 9 项行为和参数测试。
- 默认实测：两种验证模式均 3/3 正确，生成 8→2，但总调用 16→23、耗时约 188→296 ms。
- 保存原始 JSON 与复现文档；无模型调用，modelTokens 为 null，不把生成节省等同整体收益。
- 全量门禁发现同步子进程调用，已改为既有异步 execFile 方案；基线 611 通过 / 7 跳过。
- 最终 pnpm typecheck、pnpm benchmark:refresh 通过；pnpm test 620 通过 / 7 跳过（104.92 秒）。
- 下一步：以此成本基线优化重复验证，或接通独立输出分发与 checkpoint 发布协调。

## 2026-10-09 — 同基线因果观测复用
- 新增可选 replayReuse: baseline_observations，验证 / 自动刷新按节点身份复用 mutation 前的纯观测。
- 缓存只属于单次基线；mutation 后独立重放，工具错误不缓存，完整提交验证保留。
- 持久报告增加策略及 reusedSteps，兼容旧 v1 报告；新增 6 项测试并扩展刷新提交回归。
- 新增 pnpm benchmark:probe-reuse 与原始 JSON：四分支无变化 8→5 次，变化 4→1 次，12/12 正确。
- 探测中位耗时约 94.69→89.55 / 98.40→93.25 ms；只量化探测，不声称端到端或 token 收益。
- 更新适配器纯度契约、示例及 VISION；交接保持 60 行。
- 基线 620 通过 / 7 跳过；最终 typecheck、基准通过，test 626 通过 / 7 跳过（106.85 秒）。
- 下一步：共享祖先场景接入端到端刷新成本基准，或独立输出 / checkpoint 发布协调。

## 2026-10-09 — 共享祖先刷新的端到端成本对照
- benchmark:refresh 新增观测复用模式、共享输入及共享输入失效选项，沿用真实文件工具与强制提交重放。
- 单列 reusedProbeSteps；覆盖无变化、局部 / 全部独立输入变化、共享祖先失效，增加 5 项测试。
- 四组各三轮受验证模式 36/36 正确；保存全部 48 个样本及环境、输出哈希、阶段成本。
- 四分支普通→缓存总调用分别 12→9、29→26、26→23、22→19；有变化时仍高于完整重跑 18。
- 耗时没有稳定改善，不推导模型 token 收益；更新协议、VISION 和 60 行交接。
- 基线 626 通过 / 7 跳过；最终 typecheck、build、基准及 CLI 通过，test 631 通过 / 7 跳过（112.21 秒）。
- 下一步：基于完整验证成本选择重跑 / 增量修复，或独立输出 / checkpoint 发布协调。

## 2026-10-09 — 成本驱动的因果刷新策略
- refresh / prepare refresh 可选 costModel，按执行、复用验证和完整提交重放估算选择增量或全部重算。
- 新增 planWorkspaceCausalRefresh 纯查询；相等保留增量，拒绝非有限 / 负值 / 溢出，估算器收到副本。
- full 复用共享修复事务，仅重算选中联合祖先、按拓扑去重，保留强制 OCC 及分支 heads。
- 结果及关联 journal 保存 decision 成本分解；默认行为与旧事件兼容，新增 8 项测试。
- 补充 API 示例、成本单位与边界；探测成本已发生，当前不声称实测加速或 token 收益。
- 初始基线缺 cc 导致两组失败；安装 gcc / libc6-dev 后针对性 116 项通过。
- 最终 pnpm typecheck 通过，pnpm test 639 通过 / 7 跳过（117.37 秒）；交接保持 60 行。
- 下一步：端到端基准接入自适应策略，校准估算误差与实际总成本。

## 2026-10-09 — 自适应刷新成本的端到端评测
- benchmark:refresh 新增 adaptive，接通现有 costModel、观测复用与强制提交重放。
- 实际复用校验轮数与估算独立配置；schemaVersion=2 记录决策、实际成本、预测误差与策略计数。
- 新增 8 项测试，覆盖持平、完整重算、低估成本、无变化和无效配置；CLI 保持原参数兼容。
- 四组各三轮受验证模式 48/48 正确；三轮校验固定→自适应 40→26 调用，低估时仍40、误差14。
- 保存60个原始样本及协议；重复校验仅敏感性负载，直接完整重跑18次，不声称稳定耗时或token收益。
- 基线639通过/7跳过；最终 typecheck、build、CLI通过，test 647通过/7跳过（142.86秒）。
- 更新 VISION 和60行交接；下一步探索探测前策略选择，或独立输出 / checkpoint 发布协调。

## 2026-10-09 — 无探测的完整因果子图重算与发布
- 新增 recomputeWorkspaceCausalBranches，宿主可直接选择完整重算，省去旧观测探测事务。
- 复用共享修复：冻结选中联合祖先、共享节点一次、重建各分支 heads，不执行兄弟候选。
- 与自动刷新共用强制完整日志重放 / OCC 发布路径，冲突回收、未知提交保留恢复资源。
- CAUSAL_RECOMPUTATION_PREPARED 持久关联来源 / 策略 / txId；不伪造验证报告或变化证据。
- 新增10项用例覆盖无变化、变化、竞态、执行/关联/提交异常及非法输入；针对性38项通过。
- 更新 API 示例、VISION 和60行交接；当前显式选策略，尚不预测失效率或证明端到端加速。
- 验证：基线647通过/7跳过；typecheck通过；最终pnpm test 657通过/7跳过（124.73秒）。
- 下一步：接入 benchmark:refresh 对照直接重算与探测后自适应，再做探测前成本选择。

## 2026-10-09 — 无探测因果重算的六模式成本基准
- benchmark:refresh 接入 causal-recompute，直接调用完整因果重算 API，共享祖先去重且强制提交重放。
- schemaVersion=3 新增因果节点、验证报告、重算准备的 journal 计数；显式重算不伪造自适应决策。
- 扩展输出一致性、零探测、共享祖先、无变化和复用成本断言，新增共享与独立输入同时失效场景。
- 四场景六模式各三轮，受验证结果60/60正确；原始报告存入 causal-recompute.sample.json。
- 局部变化自适应→直接重算26→18次调用，331.50→232.93ms；无变化9→18次，直接重算更贵。
- 手工重跑同为18次且本轮耗时略低；明确因果管理成本、样本限制与无模型/token结论。
- 更新基准文档、VISION与60行交接；下一步探索基于变化概率的探测前策略选择。
- 验证：基线657通过/7跳过；typecheck/build通过；针对性23项；最终658通过/7跳过（147.86秒）。

## 2026-10-09 — 探测前的概率成本策略
- 新增 planWorkspaceCausalRefreshPolicy 与 refreshWorkspaceCausalBranchesWithPolicy，按条件预期总成本选择探测或直接因果重算。
- 联合祖先估算去重，持平保留探测；校验概率、非负有限成本及溢出，完整复用既有发布和回收路径。
- CAUSAL_REFRESH_POLICY_SELECTED 在工作区分配前记录预测、来源及事务身份；失败不伪造完成，不自动重试另一策略。
- 新增概率极值、预测失准、零探测、OCC 冲突回收、持久查询、估算去重及日志失败测试。
- 更新 API 示例、VISION 和 60 行交接；不声称自动学习概率或实测 token 收益。
- 初始基线565通过，3文件缺cc受阻；补齐gcc/libc后针对性142通过；typecheck/build通过；最终670通过/7跳过（127.48秒）。
- 下一步：六模式基准增加探测前策略，使用独立预测并测量失准时实际成本与正确性。

## 2026-10-09 — 独立先验的七模式策略基准
- benchmark:refresh 新增 causal-refresh-policy，复用生产探测前策略 API，schemaVersion=4。
- CLI --forecast=JSON 固定先验；不读取本轮扰动或实测结果，区分探测前总成本与探测后剩余成本。
- 记录策略 journal 数、实际阶段调用、总成本预测偏差；补充命中/失准与非法概率测试。
- 四组先验与扰动交叉场景各三轮，受验证模式72/72正确，原始报告 causal-refresh-policy.sample.json。
- 局部变化直接重算26→18次；无变化误判重算9→18次；预测准确不等于策略最优，无token结论。
- 更新 VISION、基准协议与60行交接；下一步持久化刷新阶段遥测，支持跨运行成本估计。
- 验证：基线670通过/7跳过；typecheck/build通过；针对性30项；最终677通过/7跳过（140.76秒）；CLI非法预测拒绝通过。

## 2026-10-09 — 持久化刷新策略执行遥测
- 策略入口新增 CAUSAL_REFRESH_MEASURED 与 telemetrySeq，关联预测决策及验证报告。
- 按探测、复用校验、重算、OCC重放记录真实回调次数/异常/耗时，另记含工作区开销的总耗时。
- listWorkspaceCausalRefreshTelemetry 支持跨Run、历史切片与重开；保留冲突、失败、抛错样本。
- 遥测落盘失败提示已观察执行状态；双失败保留AggregateError，不重试或撤销已提交结果。
- 补充阶段计数、持久查询与失败注入测试；更新使用示例、VISION及60行交接。
- 验证：基线677通过/7跳过；typecheck/build通过；针对性56项；最终683通过/7跳过（146.55秒）。
- 下一步：按任务特征聚合历史遥测并独立评估成本估计；缺失不算零成本，不冒充token收益。

## 2026-10-09 — 从历史遥测估计刷新成本并保留时间验证集
- 策略入口可选 taskKey 持久标记可比较任务；新增 estimateWorkspaceCausalRefreshHistory 纯查询。
- 按类别跨Run估计变化比例与条件回调毫秒成本，forecast可显式接入现有策略入口。
- 固定训练截止点；决策与遥测均需完成，后续决策独立评估总成本MAE，迟到完成只计训练缺失。
- 区分失败、缺失及无变化标签的直接重算；缺少任一变化类别不生成预测，旧日志不混入。
- 覆盖历史冻结、重开重现、任务隔离和错误样本；文档明确选择偏差与毫秒口径，不声称token收益。
- 验证：基线683通过/7跳过；typecheck/build通过；针对性62项；最终690通过/7跳过（145.59秒）。
- 下一步：基准引入固定训练窗口和独立探测评估，对比历史预测与静态先验的实际执行成本。

## 2026-10-09 — 历史刷新策略的独立时间验证基准
- 新增 benchmark:refresh-history，复用真实文件夹具、因果图、OCC和持久遥测。
- 固定训练窗口与扰动计划；历史预测和每节点成本仅训练校准，独立探测验证不混入策略样本。
- 相同扰动下交替运行历史/静态先验策略，报告正确性、工具次数、回调/总耗时、预测MAE及训练开销。
- 三任务样例均正确；历史/静态总耗时190.818/201.524ms、回调3.603/3.286ms，不声称全面收益。
- 增加冻结窗口、任务隔离、等价输出及参数校验测试，补充协议、样例、VISION与交接摘要。
- 验证：typecheck/build/native通过；针对性37项通过；全量验证结果待记录。
- 下一步：工具类别成本校准与分布漂移、多重复评估，再接入真实模型token。

## 2026-10-09 — 冻结滑动训练窗口与变化率漂移
- 历史预测新增 trainingAfterSeq，以决策序号排除过时样本，返回 excludedDecisions。
- 独立时间验证集新增变化率差值与 Brier 分数；报告样本量，不自动换策略或授权复用。
- 窗口按决策开始时间选择，旧任务迟到不混入；单类别可报告漂移但仍不臆造条件成本预测。
- 覆盖默认兼容、边界、冻结重开、双向漂移及失败/无标签排除；新增可运行 API 示例。
- 验证：基线697通过/7跳过；typecheck通过；最终706通过/7跳过。
- 下一步：基准固定工作负载漂移，比较全历史与近期窗口，多次重复评估实际成本。

## 2026-10-09 — 分布漂移的成对重复执行基准
- 新增独立 causal-drift 基准：旧分布→近期分布→冻结验证，每次重复重新训练。
- 相同输入扰动对照全历史/近期预测，交替策略顺序，共享训练成本校准，强制 OCC 提交。
- 报告独立验证 Brier/MAE、训练开销、真实回调次数、正确性及成对耗时差，不宣称 token 收益。
- 两次重复8个对照均正确；Brier 0.25→0.1875，但近期回调平均慢0.01149ms，未证明加速。
- 新增窗口隔离、顺序交替、预测退化、结果等价与非法协议测试；已有暂存改动保持原样。
- 验证：typecheck/build与可运行示例通过；最终全量测试待完成。
- 下一步：多节点异质工具负载与双向漂移，增加重复次数再评估稳定收益。

## 2026-10-09 — 可解释的因果失效路径
- 新增 explainRecomputation：为每个失效结果列出全部变化源及各自最短声明依赖路径。
- 复用原重算计划，支持跨 agent、heads 选择与 atSeq 历史切片；等长路径按序号确定选择。
- 广度优先遍历避免枚举菱形路径；只读查询，不自动发现变化或授权复用。
- 覆盖多源汇合、快捷边、重复种子、历史重开、分支隔离、空输入与返回值隔离。
- 新增 API 示例、路径复杂度与边界说明，并链接修复文档；交接摘要保持60行。
- 验证：基线713通过/7跳过；定向20通过；typecheck通过；最终715通过/7跳过。
- 本轮提交隔离原有暂存基准代码；下一步将解释路径接入checkpoint恢复预览。

## 2026-10-09 — checkpoint 因果恢复解释预览
- 新增 AgentRuntime.explainCausalRecovery 与公开返回类型，复用跨 agent 影响计划及最短证据路径查询。
- 每个受影响 checkpoint 返回历史分支内的重算解释、actor/事务/工具元数据及最近未受影响恢复候选。
- 全局校验变化源，再按 checkpoint 筛选；排除其他候选和后续节点，常规规划不支付路径生成成本。
- 测试覆盖多源汇合、确定路径、终态与未跟踪上下文、只读预算/事件、返回隔离和 domain 重开。
- 补充恢复预览示例与 runtime 契约，交接摘要保持60行；保留原有暂存基准改动。
- 基线因缺cc有3个文件失败；补齐gcc/libc开发依赖后原生构建成功，typecheck通过、定向38通过、全量717通过/7跳过。
- 下一步：将观测验证changed接入恢复预览，提供探测→解释→共享恢复的完整示例。

## 2026-10-09 — 从观测探测到共享 checkpoint 恢复
- 新增 refreshAgentSharedCausalBatch：显式选中 agent，自动读取 heads、重放探测变化、生成失效路径并共享恢复。
- 探测前冻结 checkpoint；任一工具失败阻断整批，探测期间版本变化返回 checkpoint_changed，不用旧证据修复新上下文。
- 复用共享恢复的冻结计划与独立事务绑定；未选中不恢复，未跟踪单列，recovered 须检查逐项 outcomes。
- AGENT_CAUSAL_REFRESH_PLANNED 持久关联 validationSeq 与 checkpoint 序号；实际发布仍由 causal_repaired 记录。
- 补充自动恢复示例、runtime 契约与定位入口；保持宿主复用验证、上下文分发、OCC 和资源管理职责。
- 验证：基线717通过/7跳过；新增5例，定向43通过；pnpm typecheck通过；pnpm test最终722通过/7跳过；diff检查通过。
- 下一步：持久恢复计划查询与重开后的解释重建，串联探测、共享修复及逐项发布历史。

## 2026-10-09 — 重开后重建冻结的恢复计划
- 新增 listAgentCausalRefreshPlans：只读 journal 查询，按 Run / atSeq 返回计划与 validationSeq、原 checkpoint 引用。
- 无需 AgentRuntime 即可重建上下文、失效子图、最短因果路径和 restartFrom；复用 checkpoint 引用解析与因果图解释。
- 后续修复/恢复/新增节点不改写历史 preview；prepare 失败仍可查询意图，返回深拷贝，未知版本及缺失引用明确报错。
- 文档补充查询示例与部分失败语义：计划不代表 checkpoint 发布或 OCC 成功，不猜测共享修复/发布归属。
- 验证：基线722通过/7跳过；新增7例，定向50通过；pnpm typecheck通过；最终pnpm test为729通过/7跳过；diff检查通过。
- 下一步：持久关联planSeq、共享修复事务和逐项causal_repaired，覆盖部分绑定失败与崩溃窗口。

## 2026-10-09 — 共享恢复的持久发布归属
- 新增 listAgentCausalRefreshExecutions：只读关联冻结计划、共享修复事务及逐项 checkpoint 发布，支持 Run / atSeq / 重开。
- AGENT_CAUSAL_REFRESH_PREPARED 在 bind 前关联 planSeq 与 txId；refreshPreparationSeq 与 causal_repaired checkpoint 同事务落盘。
- failed / skipped 逐项持久化；pending 表示截止点没有结果，不猜测旧记录归属、不授权自动重试；不宣称 OCC 提交。
- 关联或结果写入失败向调用方抛错，已发布 checkpoint 不回滚，共享资源仍由宿主管理；补充示例与 runtime 契约。
- 验证：基线729通过/7跳过；定向53通过，覆盖部分失败/跳过、发布事务注入故障回滚、历史切片及重开；typecheck通过；全量732通过/7跳过；diff检查通过。
- 下一步：明确部分恢复批次的续跑协议，核对版本和事务状态后重做未完成绑定。

## 2026-10-09 — 中断共享恢复的未发布绑定续跑
- 新增 resumeAgentSharedCausalRefresh：从持久完整 repair 恢复 pending 绑定，不重复探测或共享重算。
- 续跑检查共享事务开放状态、冻结 checkpoint 版本及独立事务归属；原子发布沿用原 preparation，已有终态不重试。
- 同 domain 同准备记录拒绝重叠绑定；完成批次重复调用无写入，旧记录缺少 repair 明确拒绝。
- 宿主显式 bind 负责核对中断副作用、保留和校验共享输出；文件发布仍需 OCC；补充 API 示例与定位文档。
- 验证：原版本定向53通过；新增5例及终态幂等/缺失准备断言；pnpm typecheck通过，全量737通过/7跳过；补齐gcc/libc开发包后原生reaper实际构建通过，diff检查通过。
- 下一步：持久记录绑定尝试与独立事务分配身份，提供孤立资源核对，再支持 failed 的显式重试。

## 2026-10-09 — 绑定尝试身份与中断资源核对
- 共享refresh/resume在bind前持久记录attempt，第三参数reserveTransaction在分配前保存独立事务意图；既有回调兼容。
- 拒绝已用/重复/共享事务身份和回调结束后的登记；登记失败不进入宿主后续分配，不自动分配或删除资源。
- listAgentCausalBindingAttempts关联计划、准备、checkpoint及登记，支持Run/planSeq/atSeq/重开，报告TX生命周期与当前agent引用。
- 续跑产生新attempt、保留旧归属；reserved不证明没有部分分配，无当前引用不证明可删除，宿主核实后沿用abort回收。
- 更新定位、资源核对示例和60行交接；验证基线737通过/7跳过，定向60通过，pnpm typecheck通过，全量739通过/7跳过，diff检查通过。
- 下一步：依托持久尝试归属支持failed绑定显式重试，完善历史checkpoint资源保留及部分分配回收协议。

## 2026-10-09 — 失败绑定的因果重试
- 新增retryAgentSharedCausalRefresh：按agentId与最新failureSeq仅重试一个failed，复用持久共享repair，不重新探测/重算，不消耗agent step预算。
- 重试意图先落盘，关联原失败与冻结checkpoint；历史查询验证failed→pending→新结果，保留旧失败与atSeq切片。
- 过期请求、已完成项及同准备重叠调用拒绝；共享事务开放和checkpoint检查沿用既有路径，其他绑定结果不变。
- 意图落盘失败不调用bind；授权后中断可由resume接续，二次失败需要新的失败序号；宿主仍核对历次分配和副作用。
- 增加六种重试场景，覆盖重开、再次失败、历史切片、无重复共享计算、事务关闭、checkpoint推进和落盘故障；更新API示例与定位。
- 验证：基线739通过/7跳过，typecheck通过，定向66通过；全量745通过/7跳过，diff检查通过。
- 下一步：查询历史checkpoint资源引用，为部分分配和孤立事务提供可审查回收计划。

## 2026-10-09 — 历史工作区引用与资源回收预览
- 新增listAgentCheckpointWorkspaceReferences，查询checkpoint工作区、历史TX_BEGUN基线与当前标志，支持Run/事务/时间切片和重开。
- 新增planAgentCausalResourceCleanup，冻结journal截止点，关联共享修复、绑定尝试、生命周期与checkpoint引用，输出retain/review和证据。
- 资源归属过滤不缩小引用扫描：跨Run、跨事务共用基线仍保留；共享输出、pending发布、历史引用与committing均附保留原因。
- 纯查询不删除文件、不重放工具或写journal；未登记分配、外部使用者与磁盘存在性仍需宿主核对，暂不拆分fork与基线回收。
- 集成覆盖中断、续跑、孤立分配、跨Run共享基线、checkpoint推进、历史切片与重开；补充API示例和定位。
- 初始基线657通过/7跳过，2套件缺cc；已补gcc/libc6-dev。typecheck通过；全量745通过/7跳过，1处新增测试断言失败。
- 失败因runtime关闭追加journal导致默认截止点前进；改用冻结atSeq后pnpm test定向67通过，时间预算内未再次重跑全量。
- 下一步：区分可释放fork和需保留历史基线，接通显式资源回收与冻结证据核对。

## 2026-10-09 — 因果 fork 回收的持久结果
- 新增 listAgentCausalForkCleanups，按请求关联 pending/aborted/failed，支持 Run/事务/atSeq 和 domain 重开。
- 精确核对 TX_ABORTED 的事务与请求 reason；无终态不推断文件存在或操作仍运行，历史请求不会借用后续重试结果。
- abort 失败持久记录 AGENT_CAUSAL_FORK_CLEANUP_FAILED；结果落盘也失败时 AggregateError 保留两个错误。
- 覆盖异事务/无关终止、历史切片、只读查询、重开、失败后重新规划及双重故障；补充 API 示例与交接。
- 下一步：扩展共享输出生命周期，或将恢复/重试/回收故障场景纳入可复现基准；继续保留时间旅行基线。
- 验证：基线746通过/7跳过；pnpm typecheck通过，pnpm test全量747通过/7跳过（51套件通过），git diff --check通过。

## 2026-10-09 — 持久共享恢复的故障成本基准
- 新增 benchmark:recovery：真实文件、AgentRuntime、journal重开，覆盖分发后绑定失败与结果记录中断。
- 对照retry/resume与仅未完成分支完整重跑；核对所有checkpoint/文件、历史一致性及已发布checkpoint不变。
- 计故障前/恢复工具、探测、分发、恢复/回收耗时；实际回收可核对fork，保留旧pending计划的资源与全部基线。
- 3次重复/4 agent/1000轮哈希，12样本正确；总工具4→2，恢复均值约152–153ms→55–56ms。
- 新增集成测试、CLI、协议与原始样本；明确仅隔离工作区恢复、不含OCC提交/模型token，故障注入不等于进程断电。
- 验证：pnpm typecheck、pnpm test通过（749通过/7跳过，52套件通过）；12基准样本正确，git diff --check通过。首次扫描发现新增同步Git调用违反src门禁，已改为异步。
- 下一步：真实进程退出、重开后输入再变及OCC冲突的端到端恢复基准。

## 2026-10-09 — 恢复结果的 OCC 发布闭环基准
- benchmark:recovery 增加 stable/input-changed：重开恢复→完整因果日志强制OCC→旧观测拒绝→重新刷新全部agent→代表输出提交。
- schemaVersion=2 单列提交重放、再重算、探测与耗时；校验最新checkpoint、主工作区文件、观测验证及事务journal证据。
- 真实文件12个变化样本全部正确；持久恢复/未完成分支重跑全程执行4/8，提交重放均3；新增稳定/变化集成测试与原始报告。
- 保留默认隔离恢复模式；明确发布仅一个共享输出，非多事务原子提交，不冒充模型token收益。
- 初始基线因环境缺cc导致两套原生测试无法加载，已安装gcc/libc6-dev；最终验证结果见下行。
- 下一步：真实子进程退出与恢复过程中的输入变化，检查持久共享输出失效后的恢复策略。
- 验证：pnpm typecheck、pnpm build、pnpm test通过（751通过/7跳过，52套件通过）；12个OCC样本正确，git diff --check通过。

## 2026-10-09 — 真实进程终止后的共享因果恢复
- benchmark:recovery 新增第五参数 sigkill；在 failed/pending 持久边界保持 domain/SQLite 打开，由父进程 SIGKILL worker 后接管。
- 复用既有夹具与 retry/resume/OCC 链路；IPC 仅携带计数和核对证据，业务状态从 journal 与共享工作区恢复。
- schemaVersion=3 分离进程边界耗时，恢复计时包含首次接管；明确不是断电、任意指令边界或模型测试。
- 两类故障×两种策略×稳定/再变化集成测试通过；3次重复/4 agent/1000轮哈希的12个变化样本正确，全程工具8→4。
- 更新协议、VISION、原始报告与60行交接；下一步覆盖恢复期间输入变化与持久共享输出失效。
- 验证：基线751通过/7跳过；pnpm typecheck、pnpm build、pnpm test通过（753通过/7跳过，53套件通过）；12个SIGKILL样本正确，git diff --check通过。

## 2026-10-09 — 共享因果恢复前的观测有效性验证
- 新增 resumeAgentSharedCausalRefreshWithValidation：当前同基线重放 pending 的修复后因果分支，有效才复用持久 repair 续跑绑定。
- stale/validation_failed 保留 pending；错误不是变化证据，无 pending 幂等返回；验证与绑定共用重叠保护，探测后复查共享事务。
- AGENT_CAUSAL_RESUME_VALIDATED 关联原计划、准备与验证报告；不把探测匹配视为文件发布证明，仍需宿主输出核对和强制 OCC。
- 增加重开后匹配/输入再变化/工具异常/探测期间checkpoint推进与事务关闭覆盖，更新示例、VISION及60行交接。
- 下一步将验证入口接入真实进程恢复基准，并补共享输出完整性证据。
- 验证：首轮753通过/7跳过；pnpm typecheck、pnpm test通过（758通过/7跳过，53套件通过），git diff --check通过。

## 2026-10-09 — 真实进程恢复前的验证成本对照
- benchmark:recovery 第六参数 recoveryInput 开启 pending 三策略：直接续跑、先验证再续跑、完整重跑未完成分支；兼容旧矩阵。
- 恢复前扰动独立于发布前扰动；stale 直接刷新，直接绑定被拒后刷新；已发布历史保持，最终强制 OCC 核对全批新鲜度。
- schemaVersion=4 单列恢复绑定/探测/拒绝/分发校验与持久验证关联，支持 close/SIGKILL；不将减少分配视为必然耗时收益。
- 新增稳定/过时输入与两种生命周期集成覆盖，更新协议、VISION及60行交接。
- 验证：基线758通过/7跳过；定向10通过；pnpm typecheck、pnpm test通过（762通过/7跳过，53套件通过）。
- 下一步：持久共享输出完整性证据，防止观测有效但共享文件被改写时分发错误结果。
- 保存18个真实SIGKILL原始样本，全部正确；过时输入恢复绑定2→1，附稳定场景验证开销及实测耗时。

## 2026-10-09 — 持久共享输出完整性验证
- 共享refresh准备时保存基线身份、coverage及文件树指纹，复用现有snapshot fingerprint，无新增快照或重算。
- 验证resume在观测探测前后核对共享输出；output_invalid区分changed/missing/unavailable，拒绝时保留pending且不绑定。
- AGENT_CAUSAL_SHARED_OUTPUT_VALIDATED记录plan/preparation与指纹证据，重开可查；旧无证据记录需重新刷新或宿主自行核对。
- 覆盖新增/删除/改写/不可读、缺失证据、探测中改写及最终指纹计算期间事务关闭；更新示例、VISION与60行交接。
- 范围沿用基线coverage，不证明上下文或分发结果；宿主保持共享fork静止，最终提交仍需强制OCC。
- 下一步：在真实进程恢复基准增加输出损坏矩阵，并单列文件完整性验证成本。
- 验证：初始基线669通过、3套件缺cc无法加载；安装gcc/libc6-dev后pnpm typecheck与pnpm test通过（769通过/7跳过，53套件通过），git diff --check通过。

## 2026-10-09 — 混合大小派生输出的恢复成本基准
- benchmark:recovery schemaVersion=6 增加逐文件字节配置，保持摘要checkpoint，生成/重放/分发/OCC覆盖全部payload。
- 输出损坏注入最后一个payload；直接恢复分配后校验，验证恢复在绑定前拒绝，均保留原有历史与发布检查。
- 恢复阶段单列实际宿主分发读写字节和耗时，包含失败尝试；summary报告验证/分发耗时与读取字节均值。
- 新增稳定/篡改/删除混合文件及非法规模覆盖，真实SIGKILL用例同步校验payload；更新协议与60行交接。
- 下一步：多规模多轮独立测量，将完整恢复成本接入策略；应用层字节非物理I/O，合成负载不代表模型收益。

## 2026-10-09 — 恢复策略的持久成本反馈
- 新增 listAgentCausalResumeTelemetry，按 taskKey/runId/atSeq 查询决策、实际路径与未决记录，重开可复现。
- 恢复策略记录验证+续跑、重算两个阶段实测耗时与 repaired/skipped/failed 计数，拒绝证据沿用原因果引用。
- forecastUnit 默认 host，仅显式 ms 且流程完成时计算预测误差；旧记录缺测量不补零，不把完成当成全批成功。
- 覆盖四种实际恢复路径、历史截断、任务筛选、重开、旧记录与错误结果引用；更新契约、VISION及60行交接。
- 初始基线696通过、7跳过，3套件因缺cc无法加载；安装gcc/libc6-dev后，pnpm typecheck与pnpm test通过（790通过/7跳过，54套件通过），git diff --check通过。
- 下一步：按pending规模/输出大小冻结训练窗口，独立多轮校准；当前遥测不自动学习，不含后续OCC发布成本。

## 2026-10-09 — 冻结窗口恢复成本估计
- 新增 estimateAgentCausalResumeHistory，按 taskKey/精确 pending 数量跨 Run 拟合验证续跑与拒绝重算阶段成本。
- 冻结决策/完成截止点，迟到结果不泄漏；失败、部分发布、跳过、未决、缺测与直接重算分列。
- 后续独立决策报告阶段 MAE/Brier；成功验证含分发，resume=0 为合计编码，宿主显式采用 forecast。
- 新增11项测试覆盖分组、窗口、重开、拒绝类型、失败排除和非法测量；补充示例、VISION与60行交接。
- 验证：基线 pnpm test 790通过/7跳过；pnpm typecheck、新增11项测试与 git diff --check通过；修改后全量测试已启动，结果待核对 /tmp/xioflow-final.log。
- 下一步：真实恢复基准多规模独立验证，检验拒绝后重算成本代表直接重算的假设，不宣称生产/token收益。

## 2026-10-09 — 将成果验收接入 OCC 发布
- 按最新 NORTH_STAR 优先收敛发布契约，暂停扩大成本预测入口；复用现有事务队列与重放。
- CommitOptions.publication 增加覆盖声明、准备输出指纹及实际重放目录只读业务验收；自动强制完整观测重放。
- 覆盖未知、候选损坏、验收拒绝/异常/改写输出均在应用前拒绝，TX_PUBLICATION_REJECTED 留痕；保留候选并回收临时重放。
- TX_COMMITTING 持久保存已验收来源指纹，提交中断后继续应用先核对；损坏保留 committing 资源，不假装撤销已写文件。
- 新增7项行为测试与接入/故障表，更新VISION及60行交接；不是完整openWorld，也未承诺终态key幂等或跨checkpoint原子性。
- 验证：初始708通过/7跳过，3套件缺cc；已安装gcc/libc6-dev。pnpm typecheck、定向27项和git diff --check通过；全量结果待下行记录。
- 下一步：冻结统一世界句柄类型/状态表，接通终态发布身份与重试查询；宿主仍须保持fork静止并完整声明依赖。

## 2026-10-09 — 持久提交凭据与终态幂等
- 推进M1发布契约缺口：复用TX_COMMITTED，WorkspaceCommitReceipt携带domain内commitSeq，同txId重试返回原发布事实。
- 新增只读getWorkspaceCommitResult；重开与候选已删除仍可查询，不重新验收、应用或清理；undefined不冒充未写入。
- 清理失败前移除终态活动缓存，避免abort改写已提交状态；成功凭据不证明资源回收或checkpoint绑定完成。
- 新增并发/重开/主目录后续修改、清理失败、未知/中止事务测试；更新既有恢复重试预期与发布契约文档。
- 下一步仍为M1：统一世界句柄类型、状态表、覆盖清单与六类故障资源归属；独立key与close尚未实现。
- 验证：基线808通过/7跳过；pnpm typecheck、最终pnpm test（811通过/7跳过）与git diff --check通过。

## 2026-10-09 — 冻结单世界 M1 契约
- 新增非公开 spec/world-contract.ts 类型草案，覆盖 openWorld/runAgentStep/refresh/explain/commit/close，复用既有观测、因果解释与提交凭据类型。
- docs/world-contract.md 收敛状态表、文件/上下文覆盖声明及六类失败、重试和资源归属；区分发布、checkpoint绑定与回收事实。
- 明确独立key绑定与终态幂等、验证异常不算失效、未决来源保留、固定截止点解释和close中止未发布候选。
- 编译接入示例检查结果穷尽、非成功无receipt及严格observations验证；不导出或假装实现统一运行入口。
- M1设计交付物齐备；下一轮进入M2，从持久世界身份、覆盖清单与重开校验开始，尚无M2六类场景验收。
- 验证：基线与最终pnpm test均811通过/7跳过；pnpm typecheck（含契约编译检查）与git diff --check通过。

## 2026-10-09 — M2 世界基线身份一致性
- 审查上一轮内部openWorldState后，优先修复私有ref与snapshot.commitHash未交叉核对的缺口，防止materialize/restore读取不同基线。
- 重开要求原提交身份、snapshot.opId世界归属及worktree_non_ignored覆盖模式一致；同树不同提交也拒绝。
- 新增7项损坏/修复测试：提交元数据、私有ref、归属、覆盖模式及缺失blob/子树；拒绝不改journal/主目录，修复后保持原身份重开。
- 保持内部入口；M2仍缺隔离runAgentStep、refresh/strict commit/explain/close状态机与六类场景各10次验收。
- 验证：基线828通过/7跳过，世界状态24项与pnpm typecheck通过；最终全量测试运行中。

## 2026-10-09 — M2 隔离执行基础
- 内部executeWorldStep连接固定世界快照、WorkspaceTransactions与AgentRuntime，持久保存输入、因果观测、响应checkpoint及输出指纹。
- null观测单独留证并保持未跟踪heads；限制步骤内依赖，阻止执行结束后继续record；异常保留事务/预算证据且不发布。
- 新增5项测试覆盖隔离与外部扰动、重开身份、null/[]、工具异常后再次执行及伪造heads/迟到回调。
- 尚未导出公开入口；executed不等同prepared，M2仍缺覆盖/产物适配、refresh/strict commit/explain/close与完整验收。
- 验证：基线835通过/7跳过，新增5项与pnpm typecheck通过；最终全量结果待更新。

## 2026-10-09 — M2 WorldAgent 候选准备
- 内部prepareWorldStep复用隔离执行，将WorldAgent覆盖/产物声明收敛到prepared/unknown候选；共享类型取代两份契约。
- 覆盖哈希不匹配、未跟踪依赖及heads遗漏返回unknown；伪造依赖与畸形产物声明失败，保留证据且不发布。
- checkpoint与候选事件保存覆盖/产物引用、固定版本、输出指纹及身份；重开保持原journal。
- 产物正文仍由宿主保存，未声称内容引用已验真；M2还缺统一句柄、正文恢复、refresh/strict commit/explain/close及完整验收。
- 验证：基线840通过/7跳过；最终typecheck与全量测试结果待回填。

## 2026-10-09 — M2 文本产物证据持久化
- 先补齐刷新复用前提：model_response/tool_result正文保存至既有checkpoint/journal，SHA-256验真；缺正文unknown，格式或哈希错误failed。
- 内部readWorldArtifacts按固定worldId/id/atSeq只读恢复，再验正文哈希；不重跑模型，不新增公开入口，file继续由fork指纹固定。
- 新增6项测试覆盖空正文/中文/工具结果、宿主修改、重开身份、错误历史引用、数据库正文损坏及缺失/无效正文。
- M2尚缺refresh/explain/strict commit/close统一状态机、独立key与六场景完整验收；下一轮接入已有观测验证及持久刷新关系。
- 验证：基线因缺gcc有3个原生套件失败；已修复工具链；针对性24项及typecheck通过，全量复验运行中。

## 2026-10-09 — M2 候选观测验证收敛
- 内部validateWorldCandidate复用既有隔离重放，读取固定候选证据，持久关联原候选、底层报告、未知原因及因果路径。
- matched/changed/unknown/failed分流；unknown不重放，异常不算变化；正文和重放前后输出指纹核验阻止损坏成果复用。
- readWorldCandidateValidation支持固定截止点的重开只读查询，不调用模型或推进journal；不新增公开入口。
- 新增9项覆盖匹配/变化/异常、重开路径、伪造声明、输出篡改及null/[]；仍无新版本候选、完整refresh或发布许可。
- M2后续先接修复准备，再收敛strict commit/key/explain/close与六场景完整验收；不扩成本策略。
- 验证：基线859通过/7跳过，新增9项及pnpm typecheck通过；最终全量复验运行中，提交前回填。

## 2026-10-09 — M2 显式全量重算与新版本候选
- 先补齐unknown完整重算与公平全量对照的共同路径：内部recomputeWorldCandidate从持久旧候选/task重新执行，不复用旧产物，不新增公开入口。
- captureWorldRevision复用首次创建的覆盖/快照检查，保存当前不可变版本，原句柄基线不变；新候选继续使用既有prepare和验证入口。
- journal保存版本与重算开始/完成/失败、旧候选及新结果；未知依赖仍unknown，宿主异常failed，失败资源保留，不发布文件。
- 新增7项覆盖新输入/版本、原task、重开关联、再次变化、unknown新证据、符号链接/忽略漏收、宿主异常及外来引用。
- 下一轮收敛refresh探测→拒绝/全量重算状态机；增量修复须完整校验复用证据，M2尚未完成。
- 验证：基线868通过/7跳过，相关31项及pnpm typecheck通过；最终全量复验运行中，提交前回填。

## 2026-10-09 — M2 内部 refresh 流程收敛
- refreshWorldCandidate组合持久探测与既有全量重算；matched复用原候选，unknown按显式策略拒绝或重算，异常阻断。
- changed暂时全量执行，避免首差之外的未验证节点被误复用；保持隔离、不发布、不自动重试。
- journal关联原候选、验证引用、选择路径与结果；readWorldRefresh支持关闭重开后的固定历史只读查询。
- 新增9项覆盖变化/无变化、unknown两种策略与重算后仍未知、工具/输出/宿主异常、伪造字段与引用、再次变化及重开。
- 下一轮补齐增量复用证据并接修复准备；统一句柄、strict commit/key/explain/close及M2完整验收仍缺。
- 验证：基线875通过/7跳过；新增9项及pnpm typecheck通过；最终全量复验待完成。

## 2026-10-09 — M2 首差之外的独立依赖验证
- 内部selected_nodes范围复用既有同基线多分支隔离重放，以每个选定节点的完整祖先验证独立证据，不新增公开入口。
- 独立多源变化进入失效闭包，首差之后的独立工具异常返回failed且无计划；refresh据此阻断重算。
- 持久scope并兼容旧prefix报告；关闭重开只读查询一致。changed仍完整重算，实际修复基线重验/物化/增量执行留待下一轮。
- 新增4项覆盖独立变化/异常、fork隔离、重开与refresh阻断；M2统一句柄/发布/key/explain/close和完整验收仍缺。
- 验证：初始基线796通过/7跳过、2套件因缺cc加载失败；已补gcc/libc6-dev，typecheck及相关22项通过，全量结果提交前回填。

## 2026-10-09 — M2 固定截止点的准备历史解释
- 内部explainWorldPreparation收敛候选/验证/refresh历史，复用持久报告，不增加公开入口。
- 变化路径明确归属旧候选；新候选和实际full/reuse/failed结果单独保留，不把unaffected当作实际复用。
- 查询不读当前文件、不调用工具/模型、不推进journal；拒绝错配/外域/未完成引用，返回值与持久数据隔离。
- 新增4项测试覆盖无变化/变化、关闭重开与后续历史、预算不变、unknown/异常、引用及关闭状态。
- 发布/绑定/资源报告仍待接入；下一轮优先修复基线固定与复用重验，M2仍未完成。
- 验证：基线888通过/7跳过；pnpm typecheck与相关14项通过；最终全量复验待完成。

## 2026-10-09 — M2 验证与修复共享固定世界版本
- 合并既有验证/修复的基线选取：可显式传baseSnapshotId，修复事件保存实际基线，调用方快照不被探测或失败清理误删。
- world验证复用captureWorldRevision检查当前覆盖并持久version；关闭重开可查询，旧报告version=null。
- 新增5项覆盖symlink/目录/忽略漏收拒绝、主目录再次变化后按原验证版本修复、复用失败阻断及快照保留。
- 保持默认临时快照清理与最终OCC边界；refresh仍全量，下一轮接复用节点重验/产物物化，M2尚未完成。
- 验证：基线892通过/7跳过；pnpm typecheck与相关17项通过；最终全量复验进行中。

## 2026-10-09 — M2 刷新重算与解释使用同一固定版本
- changed refresh把持久validation引用传给既有全量重算，避免探测后再次采集而改变解释所依据的基线；unknown仍重新采集。
- restoreWorldRevision核对版本事件、覆盖、快照归属与Git对象身份；丢失/错配失败且不调用agent，不自动回退当前目录。
- 新增6项覆盖重放期间再改价、关闭重开、快照损坏、候选错配和伪造字段；全量重算不复用旧产物、不发布。
- M2仍缺增量复用、统一句柄/strict commit/key/资源状态及完整验收；下一轮接固定版本上的复用重验和产物物化。
- 验证：基线804通过/7跳过，3套件因缺cc加载失败；补gcc/libc6-dev后typecheck及相关27项通过，全量复验待回填。

## 2026-10-09 — M2 固定版本在执行和验证时重新核验
- 发现打开后Git快照引用改写可让执行内容与候选版本分离，优先修复该正确性缺口。
- restoreWorldRevision统一初始/后续版本，执行前后核验身份，物化后核验fork指纹；验证前后检查候选及探测版本。
- 新增5项回归：初始/后续版本引用错配、重放前/期间快照丢失、执行期间快照丢失；异常不变成changed或prepared。
- 未新增公开入口；检查不是引用锁，M2仍缺增量复用、统一句柄/strict commit/key/资源状态及完整验收。
- 下一轮回到持久验证基线上的复用重验与产物物化，复用已有修复准备。
- 验证：基线903通过/7跳过；pnpm typecheck及新增5项回归通过；最终全量测试运行中，结束后回填。

## 2026-10-09 — M2 候选产物覆盖检查收敛
- 复现Git指纹漏掉新建忽略文件/空目录，导致无效候选被prepared或matched接受的正确性缺口。
- 提取既有精确文件/Git树检查，执行完成及验证重放前后统一核验产物；symlink、目录、忽略漏收均failed并保留证据。
- 新增8项回归：4类非法产物、重放前/期间不可见篡改及重开查询、合法写入/删除；修复前6失败，修复后全部通过。
- 未新增公开入口，不推断未声明依赖，不替代strict commit；M2仍缺增量refresh、统一句柄/提交key/资源事实及完整验收。
- 下一轮接持久验证基线上的复用重验与产物物化，复用已有修复准备。

## 2026-10-09 — M2 固定验证基线上的修复准备
- 内部prepareWorldRepair将持久changed/selected_nodes报告接到既有prepareWorkspaceRepair，不新增公开入口。
- 固定基线中拓扑重放复用节点、核对所有结果hash并物化写入；仅重算失效闭包，首差或工具异常阻断。
- 修复前/复用后/完成后检查原候选与版本，最终核验输出覆盖/指纹；失败abort隔离事务，保留验证基线和失败事实。
- 新增5项回归覆盖重开+后续输入变化、复用不匹配、工具异常、原产物篡改、最终覆盖异常，主目录均不发布。
- 仍只返回内部open事务；下一轮接WorldAgent增量上下文和新候选，M2仍缺统一refresh/strict commit/key/资源闭环与完整验收。

## 2026-10-09 — M2 matched 刷新绑定固定新版本
- 修复matched刷新仍返回旧基线候选的问题，复用prepareWorldStep在固定探测版本准备新事务与checkpoint。
- 完整重放所选祖先子图、核对每步hash并物化写入，映射节点/heads/已保存产物依赖，不调用模型。
- 重放前后核验源产物，物化首差、工具异常或源篡改直接failed，无模型兜底；持久保存验证引用、候选结果及节点映射。
- 新增4项回归覆盖版本冻结、模型产物/依赖映射与重开、3类物化失败；定向19项与typecheck通过。
- 基线因cc缺失中断，已补装gcc/libc6-dev；最终全量测试结果待结束后回填。
- M2未完成；下一轮接changed增量上下文与候选，仍缺统一句柄、strict commit/key、资源事实和完整验收。

## 2026-10-09 — M2 matched 刷新 WIP 收尾
- 优先完成7bfbb9c未完成切片，保留固定验证版本、完整重放与候选/checkpoint准备路径。
- 补充重开后连续复用产物及依赖映射、显式空依赖、首个分歧或异常后停止重放的回归。
- refresh/step/validation共61项及pnpm typecheck通过；全量63文件/926项通过，跳过1文件/7项，耗时232.50秒。
- M2仍未完成；下一轮将prepareWorldRepair接WorldAgent增量上下文及候选，统一句柄/strict commit/key/资源闭环仍缺。

## 2026-10-09 — M2 修复上下文的模型产物有效性边界
- prepareWorldRepair为回调及结果提供契约内refresh上下文，依赖全部unaffected的持久产物才可进入。
- 排除传递失效/混合依赖，保留显式空依赖；不从候选journal夹带过期正文，不调用模型或新增公开入口。
- 复用重放及源产物验证通过后暴露，各回调独立副本；保存可复用/失效产物ID供后续解释。
- 回归覆盖重开、后续输入变化、传递依赖、混合依赖、[]及宿主篡改上下文隔离；repair 6项/typecheck通过。
- 未跑全量（剩余时间不足5分钟），下一轮先补全量，再连接WorldAgent执行与候选/checkpoint准备；M2未完成。

## 2026-10-09 — M2 未跟踪依赖的传递语义
- 优先修正依赖未跟踪验收缺口：引用本步骤null事件及其后继返回unknown，不再误报越界失败。
- 保留实际dependsOn供历史解释，未知链不进入可复用图，checkpoint/candidate heads均为null；混入伪造序号仍拒绝。
- 新增混合/传递依赖、隔离写入、重开证据、低层heads及伪造引用回归；step/repair共33项和typecheck通过。
- 补装gcc/libc6-dev；全量63文件/930项通过，跳过1文件/7项，239.13秒。M2仍缺WorldAgent增量候选、统一句柄、strict commit/key、资源与完整验收。

## 2026-10-09 — M2 WorldAgent 增量候选准备
- matched与内部prepareRepairedWorldCandidate共用执行器，复用repair产物筛选；固定版本重放物化unaffected后调用一次WorldAgent。
- 复用产物依赖映射为本次节点，普通prepareWorldStep保存候选与checkpoint；旧节点拒绝、未跟踪返回unknown。
- 新增增量输出、上下文/依赖映射、checkpoint、关闭重开验证及工具异常阻断测试；不新增包公开入口，changed自动refresh暂仍全量。
- repair/step/refresh共57项及typecheck通过；未跑全量（剩余不足5分钟），下一轮先补全量，再接refresh协调与解释；M2未完成。

## 2026-10-09 — M2 自动增量 refresh 收敛
- changed刷新接入既有prepareRepairedWorldCandidate，固定验证版本、复用重验和checkpoint共用原执行器；unknown仍按策略拒绝/全量。
- refresh.reusedNodes暴露全部复用节点的新身份，包括无产物节点；解释读取固定截止点的实际模式/映射，不冒充发布。
- 连续三轮交替扰动与重开验证通过，相关repair/step/refresh共58项及typecheck通过；全量63文件/935项通过，跳过1文件/7项，259.83秒。
- M2未完成；下一步接内部strict commit和刷新后再次变化的拒绝发布验收。

## 2026-10-09 — M2 内部 strict publication
- commitWorldCandidate收敛持久候选、版本/产物/覆盖检查与既有发布队列、强制重放、OCC、实际发布目录验收。
- 保存WORLD_PUBLICATION_RESULT，成功同txId重试/重开返回原回执；工具异常不冒充变化，未决保留证据。
- 新增9项测试含刷新后再次改价10次全部冲突、两候选竞争、输出篡改/业务拒绝/unknown/工具异常，以及重开回执身份。
- 相关测试及pnpm typecheck通过；未跑全量（剩余不足5分钟），下一轮先补；独立key、绑定、统一句柄/资源及完整M2验收仍缺。

### 2026-10-09 — M2 durable publication keys
- strict commit持久绑定独立key、串行协调并发请求，记录原world/candidate/tx/key身份与结果。
- 终态重试不重验，冲突返回原身份；成功/未决/终态拒绝不能用新key绕过。
- readWorldPublication只读固定截止点，TX_COMMITTED补足world结果丢失；绑定前null、未决保留身份。
- 新增并发幂等、重开历史查询、终态拒绝、非法引用、验收异常重试和回执恢复回归。
- 验证：commit 13项、pnpm typecheck通过；未跑全量，下一轮补。M2尚未完成，工具异常重试/绑定/close仍缺。

### 2026-10-09 — M2 retryable strict publication tool failures
- strict publication区分工具异常与确定性分歧，保存TX_REPLAY_FAILED的步骤/错误，清理重放资源并保留open候选。
- world层保留具体工具错误，原key/事务跨重开可完整重验；旧非publication入口兼容原语义。
- 观测与部分写入异常各10次跨重开，验证主目录不变、临时fork删除、历史身份不变及恢复后成功；另验重试前输入变化仍冲突。
- 相关43项及pnpm typecheck通过；全量待本轮最后补跑。M2仍缺绑定、统一句柄/close和完整验收。

### 2026-10-09 — M2 fixed-prefix publication explanations
- explainWorldPublication组合准备/刷新证据与发布查询，严格核验持久world/candidate/tx/key身份。
- 固定截止点区分准备未发布、发布未决和TX_COMMITTED，关联刷新验证路径与实际复用映射。
- 无变化/局部变化回归验证文件、journal、Run预算不变，历史与身份跨重开稳定，拒绝伪造身份。
- 验证：commit/refresh相关38项及pnpm typecheck通过；全量待最后补跑。
- M2仍缺checkpoint绑定、资源事实、统一句柄和完整验收；未新增公开API。
