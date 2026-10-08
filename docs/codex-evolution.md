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
