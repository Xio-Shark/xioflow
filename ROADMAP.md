# xioflow 路线图与优化流程

> 产品目标与协议以 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 为准（§0.0 产品目标、§0.2 五项架构裁决、§7 契约清单）。本文件是**执行计划与「规范 ↔ 当前实现」差异的唯一来源**。
> 不设日期，按出口条件推进；每个阶段的出口条件满足之前，不启动依赖它的阶段。

---

## 0. 推进原则

1. **协议与契约先行，实现跟随**：任何行为先落到 ARCHITECTURE 与 §7.2 契约编号，再写实现。
2. **先写失败契约再修**：每个缺陷对应一个 §7.2 条目，先让它在当前实现上失败，修复后变绿。
3. **先修“撒谎”的地方**：返回虚假成功、虚报能力、吞掉失败的问题，优先级高于新功能。
4. **采用与技术并行**：从 P1 起同步寻找外部设计伙伴；止损线写死在 §7。
5. **活性检查与一致性重扫**：任务与 Checklist 严禁写快照死事实（如写死未发布的版本号或临时暂停状态），一律采用活性对账表达式（如 `dist-tags.latest == 依赖版本`）；**每阶段出口时强制重扫 open 任务一致性**，消除跨仓与跨阶段事实脱节。

---

## 1. 阶段总览

| 阶段 | 目标 | 关键产出 | 出口条件 | 依赖 |
|---|---|---|---|---|
| **P0 止血** | 修掉 0.1.x 上已被证实的诚实性与挂起缺陷，保护 xiocode 现网用户 | Trusted Publishing 跑通；`0.1.5`；`0.2.0` | §2.4 | — |
| **0.3.0 幂等执行** | opId 域内唯一、幂等重放与审计事件（契约 #45–#49） | `quickRun`、durable 引擎重放套件（Temporal/LangGraph）、设计伙伴切入 | 0.3.0 发布与采用门判定 | P0 出口（0.2.0 发布） |
| **service 监督** | 长驻子进程（如 MCP stdio server）生命周期受管与重启（契约 #50–#52） | `kind: 'service'`、stdio stream 模式、readiness 探测、声明式重启 | 通过契约 #50–#52 | P0 出口（0.2.0 发布） |
| **P1 协议与契约冻结 v1** | 把 ABI 从 TypeScript 代码里剥离成语言无关的规范 | JSON Schema、schema v1 与迁移、黑盒 conformance、`xf-fixture` | §3.3 | P0 + 采用门放行（§7，D11） |
| **P2 Rust 核心 MVP（嵌入模式）** | 规范实现落地，三平台可用 | Rust crates、Node / Python 绑定、`@xioflow/kernel` 1.0 | §4.4 | P1 |
| **P3 快照回滚与写入限制** | 兑现“进程 + 文件系统变更”的管辖范围 | `git-shadow` 快照驱动、materialize 分叉、capability、写入限制驱动 | §5.3 | P2（TS 实现先行，D21） |
| **P4 daemon 与多客户端** | 兑现“一个工作区一个仲裁者” | `xioflowd`、客户端模式绑定、service client_lost | §6.3 | P2（与 P3 可并行） |
| **P5 生态与采用** | 让第三方框架真正接入 | 设计伙伴、集成指南、英文规范 | §7 | 从 P0 出口起并行（采用门在 P1 之前判定） |

关键路径与并行：产品侧关键路径为 **P0 → 观察期（≥5工作日） → 2.0-cut**；内核仓推进 **P0 → 采用门 → P1 → P2 → P3 / P4**。P0 出口（0.2.0 发布并在 xiocode 完成适配）后，产品侧启动 5 工作日真实观察期；内核仓在同一窗口做 0.3.0 接入体验并外联设计伙伴，观察期结束时按 §7 判定采用门，放行才启动 P1。P3 / P4 的阶段依赖将随 D21（新原语先在 TS 落地）在下一次规范修订中调整。

---

## 2. P0 — 0.1.x 止血

xiocode 默认走内核路径，下列缺陷此刻就在用户机器上发生。P0 只在 TypeScript 实现上修，不引入新架构。

### 2.1 发布对齐（最先做）：一次性配置 npm Trusted Publishing
- `main` 上已有僵尸 leader 恢复修复，但 npm 最新仍是 `0.1.4`，xiocode 锁定 `0.1.4`。
- 2026-09-23 本地核查：`~/.npmrc` 中的旧 token 已失效（`npm whoami` 返回 401）；npm 正在限制可绕过 2FA 的 token 直接发包（0.1.0–0.1.4 正是这样发的）；包所有者为 `xioshark`；`npm publish --dry-run` 打包正常。结论：不再使用本地 token 发包。
- 按 D1，一次性配置 Trusted Publishing（OIDC）。`release.yml` 已实现该路径，只差开关：
  1. 用户在 npmjs.com → `@xioflow/kernel` → Settings → Trusted Publisher → GitHub Actions，填写 organization `Xio-Shark`、repository `xioflow`、workflow `release.yml`，environment 留空；
  2. 设置仓库变量 `NPM_TRUSTED_PUBLISHING_ENABLED=true`；
  3. CHANGELOG 的 `[Unreleased]` 改为 `[0.1.5]`，打 tag `v0.1.5`，由 workflow 发布并校验 provenance；
  4. 确认发布成功后，建议在包设置中开启“要求 2FA 并禁止 token 发布”，彻底关闭 token 路径。
- 之后 xiocode 升级到 `0.1.5` 再发 `1.3.1`。分发渠道总表见 §8.1。

### 2.2 缺陷清单

以下均已通过对 `dist` 的黑盒调用复现；P0 实施时第一步就是把每一行写成失败测试。“契约”列对应 ARCHITECTURE §7.2 编号。

| ID | 缺陷（已实测） | 违反 | 修复方向 | 契约 |
|---|---|---|---|---|
| P0-1 | 跨重启身份核验只看“命令行包含 execPath”，复用同一 PID 的无关 `node` 进程被判为 `is_original_process`，恢复流水线会终止它；`accurateStartTime: true` 为虚报 | §4.1.1 | 读取 OS 进程创建时间（Linux `/proc/<pid>/stat` 第 22 字段 + `boot_id`；macOS 读 `ps -o lstart=`，精度为秒，配合 `commandFingerprint` 做否定）；读不到则 `cannot_determine`；能力字段改为 `startTimeSource` | #23 |
| P0-2 | `timeoutMs=500` 且有 `setsid` 逃逸后代持有管道时，`executeProcess` 要等逃逸进程自行退出才返回（实测 8070ms；常驻进程则永不返回） | §4.2 第 5 条 | 超时分支等待 `onRootExit`，排空走与正常退出相同的有界路径 | #11 |
| P0-3 | 宿主在 spawn 之后、`active` 提交之前崩溃，恢复判为 `cleaned_unspawned` 并释放租约，而子进程仍存活 | §3.1 | 声明 `gatedSpawn: false`；恢复时扫描进程表匹配完整 argv，命中则 `indeterminate` 并保留租约 | #24 |
| P0-4 | 对不存在的操作 `cancelOperation` 返回 `{ stopped: true }`；域已关闭时同样返回 true | §4.2 第 6 条 | 抛 `OperationNotActiveError` | #12 |
| P0-5 | 不申请资源的操作绕过 `maxConcurrentOps`（上限 1 时 3 个操作并发跑完） | §4.4.3 | 活跃操作集合独立于资源表计数 | #13 |
| P0-6 | 恢复后 Run 永久停留在 `running` | §3.2 第 5 步 | 恢复结束时按规则收敛 Run 状态 | #25 |
| P0-7 | `indeterminate` 没有受审计出口，只能调用公开的 `domain.releaseResources` 绕过（无 journal、无 epoch 校验） | §3.6 | 新增 `adjudicate()`；`releaseResources` 移出公开 API | #26 |
| P0-8 | 每个操作每 30ms 同步执行一次 `ps -A`，阻塞宿主事件循环（实测 1 个操作 p50 41ms；4 个并发 p50 167ms / p99 201ms） | §4.4.5 第 4 条 | 全域共享一个异步采样器，每周期只读一次进程表 | 性能基线（见 §2.4） |
| P0-9 | 转储文件打开 / 写入 / 刷盘失败被 `catch {}` 吞掉，结果仍返回 `outputRef` 与按内存流计算的哈希 | §1.1、§4.3 | 记录 `spillError`，失败时不返回引用；哈希改为对落盘内容计算 | #5 |
| P0-10 | 内存只保留 Head，测试失败信息所在的 Tail 丢失；截断可能切断 UTF-8 字符 | §4.3 | Head + Tail 环形保留，按字符边界截断 | #3 |
| P0-11 | 心跳失败路径在生产代码中调用 `unsafeSetCurrentEpochForTesting(-1)`；`ExecutionDomain` 构造失败时泄漏锁 fd 与锁文件；锁文件只凭 PID 存活判断，PID 被复用时会永久挡住 `acquire` | §0.2 裁决 1 | 内部 fence 方法；构造失败回滚锁；锁文件判定结合 owners 表租约过期 | 单测 |
| P0-12 | `inputFingerprint` 默认是可读拼接串，不是哈希 | §2 | 改为 sha256 | 单测 |
| P0-13 | 资源等待靠 50ms 轮询竞争，非 FIFO | §4.4.3 | 等待队列按登记顺序放行 | #7 |
| P0-14 | 僵尸 leader 恢复用例只在仓内测试中，未进共享套件 | §7.2 | 提升进 `@xioflow/kernel/testing` | #22 |

**2026-09-24 / 09-25 新审出（N 系列）**：代码审查发现，未登记在上表。「证据」列标明是黑盒实测还是代码审查；代码审查项在所属批次先写失败测试补齐实测。批次 B1 已完成，B2–B4 为 0.2.0 的后续批次。

| ID | 缺陷 | 证据 | 违反 | 修复方向 | 契约 | 批次 |
|---|---|---|---|---|---|---|
| N1 | 编造执行事实：恢复与停止路径硬写 `exitCode: 137` / `signal: 'SIGKILL'`，journal 同一 op 出现两条结果事件 | 实测 | README Guarantees、§3.4 | 结果只由 `executeProcess` 写一次；未观测字段写 `null` | #41 | B1 ✅ |
| N2 | 按 pgid 清场没有身份证据：宿主重启或 pgid 复用时会误杀无关进程组 | 代码审查 | §4.1.1 | 清场前要求 `bootId` 一致且成员启动时间不早于 op spawn；否则 `indeterminate` | #42 | B2 |
| N3 | 单个 op 失败改写整个 Run；已终结 Run 仍接受新 op | 实测 | §3.3 | Run 状态只由发行版上报、恢复收敛、停止未确认三种来源改变；已终结 Run 拒绝新 op | #43 | B1 ✅ |
| N4 | spawn 后写 `active` 失败时子进程成为孤儿 | 代码审查 | §3.1 | 登记失败先经停止流水线终止子进程，再结清 | — | B2 |
| N5 | 组信号失败（含 ESRCH）退回 `kill(pid)`，该 pid 可能已被复用 | 代码审查 | §4.1.1 | 删除单 PID 退路，失败如实上报 | #42 | B2 |
| N6 | 资源释放不经 epoch 栅栏、不写 journal | 代码审查 | §0.2 裁决 1 | 私有释放 API 走栅栏并写 `RESOURCES_RELEASED` | #26 | B2 |
| N7 | 未截断的转储文件既不引用也不删除，无限累积 | 实测 | §4.3 第 2 条 | 结清时删除；最小 `pruneArtifacts` | #44 | B3 |
| N8 | 在飞 opId 重复提交：原操作的排他租约被释放，第三方随即并发进入同一资源，原操作变得不可取消 | 实测 | README Guarantees、§0.2 裁决 2 | 入口显式拒绝（`DuplicateOperationError`），原操作不受影响；0.3.0 放宽为幂等重放 | #40 | B2 |

非代码漂移（本次文档修订已处理）：CHANGELOG 把共享套件写成 19 项（实际 18 项，僵尸用例在仓内测试）；ARCHITECTURE 旧 §6 标题“十五项”与正文“18 项”矛盾且列出了未实现的 cgroup 条目。
xiocode 侧待办：`kernel-adapter.ts` 头注释仍写“内核不转发 onOutput”，与已使用的 `onStreamChunk` 不符。

### 2.3 版本策略
- `0.1.5`：只包含 `main` 上已有的修复，完成 §2.1 配置后立即经 Trusted Publishing 发布。
- `0.2.0`：P0-1 至 P0-14 与 N1–N8。按 D2 已接受以下行为变更（取消不存在的操作会抛错、`releaseResources` 不再公开、能力字段 `accurateStartTime` → `startTimeSource` / `gatedSpawn`），另含重复 opId 抛 `DuplicateOperationError`、新增 `adjudicate()` 与 `reportRunCancelled()`（D22），在 CHANGELOG 中逐条列出；xiocode 同步适配后再发产品版本。

### 2.4 出口条件
- 每个 P0 项与 N 项都有“修复前失败、修复后通过”的测试；契约 #3、#5、#7、#11–#13、#22–#26、#40–#44 在共享套件中由“计划”变为已实现。
- 性能（D13）：常规 CI 只放确定性代理——执行、取消、恢复热路径上同步子进程调用为 0（静态门禁）；4 个并发操作下宿主事件循环延迟 p99 < 20ms（当前 p99 201ms）放进独立的 perf workflow，只报告、不阻断合并，发版前人工核对。
- `pnpm typecheck`、`pnpm test`、`pnpm verify:package` 全绿；xiocode 在 `0.2.0` 上全量测试通过，并完成一次 `kill -9` 恢复演练。

---

## 3. P1 — 协议与契约冻结 v1

### 3.1 产出
| 产出 | 位置 | 说明 |
|---|---|---|
| 协议 JSON Schema | `spec/protocol/v1/` | §2 / §4 / §5 全部消息形状的机器可读定义；ARCHITECTURE 保持为叙述性规范 |
| 数据库 schema v1 | `spec/schema/` | `domain.db` DDL、`user_version = 1`、从 0.1.x（`user_version = 0`）的迁移；含 `snapshots` 与裁决记录表 |
| 夹具程序 `xf-fixture` | `conformance/fixture/`（Rust） | `spawn-tree`、`escape-setsid`、`flood-output`、`hold-pipe-after-exit`、`ignore-signals`、`write-files`；它也是第一个 Rust 产物，用来提前打通 Rust 工具链与三平台构建 |
| 黑盒 conformance 套件 | `conformance/harness/` | 经 stdio 上的 §5 协议驱动被测实现；迁移现有 18 项 + 仓内僵尸用例 + P0 新增条目；能力门控条目报告 `unsupported` |
| TypeScript stdio 适配器 | `adapters/ts-stdio/` | 让 0.x 参考实现以协议形式接受 conformance 测试 |
| 停止结果三态 | TypeScript 实现 | `StopProcessResult.stopped` 从布尔改为三态，与 §4.1 对齐（已在 0.2.0 B4 提前落地收口，包含 `confirmed_stopped` \| `not_stopped` \| `cannot_determine`） |
| 英文规范 | `ARCHITECTURE.en.md`（至少 §0、§3、§5、§7） | 框架作者以英文读者为主 |

### 3.2 规则
- 协议在 P1 结束时标记为 `protocol v1.0.0-rc`，P2 出口时转为 `v1.0.0` 正式版；此后破坏性变更只能进入 v2。
- 共享套件原编号（S1–S18）在迁移后作废，统一使用 §7.2 编号。

### 3.3 出口条件
- TypeScript 参考实现经适配器通过 L1 + L2 全部条目，H 等级如实报告 `unsupported`。
- 用一个真实的 0.1.x 崩溃现场 `domain.db` 验证 v0 → v1 迁移，并能被恢复流程接管。
- JSON Schema 与 ARCHITECTURE 的类型定义逐字段一致（CI 校验）。

---

## 4. P2 — Rust 核心 MVP（嵌入模式）

### 4.1 Crate 划分
| Crate / 包 | 职责 |
|---|---|
| `xioflow-core` | 执行域、所有权（`flock` + owners 表 + epoch）、SQLite 存储（WAL + FULL）、监督器、恢复、裁决、协议类型（serde） |
| `xioflow-driver-unix` | Linux / macOS：`pre_exec` + 门管道实现受控启动；进程组；OS 进程创建时间（`/proc`、`libproc`）；异步共享采样器 |
| `xioflow-driver-windows` | `CREATE_SUSPENDED` + Job Object + `ResumeThread`；`GetProcessTimes`；整组终止 |
| `xioflow-node`（napi-rs） | 作为 `@xioflow/kernel` 1.0 发布到 npm，按平台预编译二进制（§8.1） |
| `xioflow-py`（PyO3 + maturin） | 按平台构建 wheel 发布到 PyPI（§8.1） |
| `xioflow-stdio` | 协议 stdio 适配器，供 conformance 使用 |

### 4.2 迁移与兼容
- Rust 核心打开 0.1.x 的 `domain.db` 时按 §1.2 迁移，并能裁决其中遗留的崩溃现场。
- 内置 supervisor 回退路径与逃生开关已在 xiocode 2.0.0（基于 0.2.0 实战观察期通过后）彻底删除；P2 专职负责 TS 内核向 Rust 内核绑定的平滑切换，不再承担删 supervisor。
- **engines 策略**：最低 Node 22.13（由内核存储依赖 `node:sqlite` 无 flag 运行要求及工具链 `@rolldown/binding` 原生绑定下限 `>=22.12` 共同决定）；此后 engines 跟随支持期内的 Node LTS（Node 20 于 2026-04 已 EOL），不随实现细节（P2 换 napi-rs）回退。
- `@xioflow/kernel` 1.0 在语义相同处保持 API 形状，不同处在迁移指南中逐条列出。

### 4.3 TypeScript 实现的去留
- P2 出口后，TypeScript 实现冻结为参考实现，只接受安全修复；xiocode 默认使用 Rust 绑定满一个发行周期后弃用。

### 4.4 出口条件
- Linux / macOS / Windows CI 矩阵上通过 L1 + L2；H 等级在 Linux cgroup 可用时通过 #37、#38，其余如实报告 `unsupported`。
- 宿主事件循环不受监督负载影响（采样与转储全部在核心线程上）。
- xiocode 通过全新独立特性开关（如 `XIOCODE_KERNEL_IMPL=rust`，不复用已删除的 `XIOCODE_PROCESS_KERNEL`）切换到 Rust 绑定，全量测试与 `kill -9` 演练通过后改为默认。

---

## 5. P3 — 快照回滚与写入限制

### 5.1 快照驱动
1. **`git-shadow`（首个，规范驱动）**：临时 `GIT_INDEX_FILE` 执行 `add -A` → `write-tree` → `commit-tree`，写入 `refs/xioflow/snapshots/<id>`。恢复时用临时 index 执行 `read-tree` + `checkout-index`，删除快照中不存在的**未被忽略**文件，绝不触碰被忽略文件、用户 index、HEAD 与分支。覆盖声明为 `worktree_non_ignored`。支持 `materialize` 分叉临时工作区（`git worktree add --detach`）与 `dematerialize` 回收，用于并行候选尝试（契约 #53–#54）。
2. **`apfs-clonefile`（macOS）**、**`btrfs`（Linux 子卷）**：覆盖声明为 `full_tree`，在 git-shadow 通过 L3 之后再做。

### 5.2 写入限制与 Capability 驱动
- Linux：bubblewrap；macOS：`sandbox-exec`；可选接入 Anthropic `srt`。Windows 首版不提供，回滚一律声明 `declared_roots`。
- 引入结构化 `Capability`（§0.2 裁决 9），统一受管租约、快照根目录与写入限制范围（契约 #55–#56）。
- 文档与 API 中只能称为“回滚正确性保障”，不得称为安全边界（§8 第 1 条）。

### 5.3 出口条件
- `git-shadow` 在三平台通过 L3（#28–#32、#53–#54）；写入限制与 capability 在 Linux / macOS 可用（#55–#56）。
- 发布“快照驱动 × 写入限制 × 平台”的覆盖矩阵，每一格都有 conformance 结果支撑。
- xiocode 基于该原语提供检查点 / 回退功能（发行版侧交互）。

---

## 6. P4 — daemon 与多客户端

### 6.1 产出
- `xioflowd`：Unix domain socket / named pipe、JSON-RPC 2.0、握手协商、对端凭据校验、Observer 只读连接、`client_lost` 处理、启动时自动恢复。service 的 `client_lost` 停止流水线在 daemon 模式补齐。
- 生命周期：由绑定按需拉起（`connectOrSpawn`），空闲退出；daemon 进程身份登记在域锁中。
- 绑定：检测到域由 daemon 持有时自动切换为客户端模式（#34）。

### 6.2 验证
- 契约 #33–#36。
- 多框架共存演示：xiocode（Node）与一个 Python agent 同时操作同一仓库，由 daemon 统一仲裁 git index 等资源。
- 浸泡测试：N 个客户端 × M 个操作，随机 `kill -9` daemon 与客户端，结束时零泄漏进程、零泄漏租约，所有 `indeterminate` 均有事实可查。

### 6.3 出口条件
- 三平台通过 L4；浸泡测试连续 5 轮无泄漏、无挂起。

---

## 7. P5 — 生态与采用（从 P0 出口起并行）

- **设计伙伴**：1–2 个在宿主机直接执行命令的开源 agent 项目（TypeScript 或 Python）。筛选依据：其 issue 中出现过孤儿进程、超时失控、输出撑爆、回滚需求，或 retry / resume 后命令被重复执行。
- **集成材料**：0.3.0 的 `quickRun`、op 幂等执行与 durable 引擎示例（Temporal activity、LangGraph node）；“用 xioflow 替换你的 subprocess 封装”示例；英文规范；conformance 等级徽章。
- **反馈闭环**：设计伙伴报告的每个 bug 先落成 §7.2 契约条目。
- **观测指标**：进行中 / 已合并的外部集成数；通过 conformance 的实现数；来自外部的 issue 数。
- **止损线（采用门，D11：前移到 P1 之前）**：观察期结束时判定。至少 1 个外部项目进入实际集成（对方仓库里有分支或 PR）⇒ 放行 P1。否则收缩为“xiocode 专用底座”：暂停 P1、Rust、Python 绑定与 daemon；只按 xiocode 的真实需求做功能（TS 版 `git-shadow` 检查点、service 监督）。

---

## 8. 横切事项

### 8.1 分发渠道（D1：registry 只经 Trusted Publishing 发布，不使用任何长期 token）

- **库**走各自语言的 registry，且只允许 CI 通过 OIDC Trusted Publishing 发布，本地不保留发包 token；
- **可执行程序**走 GitHub Release + curl 安装脚本 + Homebrew tap。brew / curl 只适合可执行程序，不能替代库的安装方式；
- 所有产物由 tag 触发的 CI 构建，GitHub Release 同时保存一份附件（tgz / wheel / 二进制 + `SHA256SUMS` + 构建来源证明），作为可追溯的构建来源。

| 产物 | 渠道 | 使用方安装方式 | 可信来源 |
|---|---|---|---|
| 内核库 `@xioflow/kernel`（0.x TypeScript、P2 起的 Node 绑定） | npm（Trusted Publishing）+ Release 附件 | `npm i @xioflow/kernel` | npm provenance；Release 附件的 `gh attestation verify` |
| xiocode CLI | npm（在 xiocode 仓配置同样的 Trusted Publishing）+ `install.sh`（curl）+ Homebrew tap | `npm i -g @xioshark/xiocode`；`curl -fsSL …/install.sh \| bash`；`brew install Xio-Shark/tap/xiocode` | 同上；tap formula 固定 sha256 |
| Rust 二进制（P2 起：`xioflowd`、`xf-fixture`、`xioflow-stdio`） | GitHub Release 按平台附件 + curl 安装脚本 + Homebrew tap | `curl … \| sh`；`brew install Xio-Shark/tap/xioflow` | Release 附件来源证明；优先评估 `cargo-dist` 一次生成 Release、curl 安装脚本与 tap formula |
| Python 绑定（P2 起） | PyPI（Trusted Publishing）+ Release 附件 wheel | `pip install xioflow` | PyPI 来源证明 |
| Rust crate（P2 起，可选） | crates.io（Trusted Publishing） | `cargo add xioflow-core` | crates.io |

### 8.2 其他

- **供应链**：所有 registry 包与 Release 附件都由 CI 构建并附来源证明，本地不保留发包 token；Rust 依赖跑 `cargo-deny` / `cargo-audit`；新依赖优先选择发布超过 7 天的版本。
- **CI 矩阵**：ubuntu / macos / windows；`kill -9` 演练作业；新增用例要求连续 5 轮无偶发失败。
- **文档同步**：协议变更与 ARCHITECTURE、JSON Schema、CHANGELOG、§7.2 状态列在同一个 PR 中更新。
- **安全**：daemon 的 socket 权限与对端凭据校验；环境变量白名单从不落盘；转储产物权限与域目录一致。

---

## 9. 需要拍板的决策点

| ID | 决策 | 推荐 | 何时需要 |
|---|---|---|---|
| D1 | 分发渠道 | **已决定**：库经 npm / PyPI Trusted Publishing 发布，不用长期 token；可执行程序走 GitHub Release + curl + Homebrew tap（§8.1） | 已定 |
| D2 | 是否接受 `0.2.0` 的行为变更（取消抛错、`releaseResources` 下线、能力字段改名） | **已接受** | 已定 |
| D3 | conformance 套件的实现语言 | 套件先用 TypeScript（复用现有 18 项），夹具用 Rust | P1 开始前 |
| D4 | 协议编码 | JSON-RPC 2.0（零依赖、各语言易接入） | P1 |
| D5 | 是否先占位 PyPI 包名与 crate 名（npm 已有） | 建议尽早占位 | P1 |
| D6 | Windows 是否在 P2 即支持 | 是；缺 Windows 会直接阻碍框架作者采用 | P2 |
| D7 | TypeScript 实现的生命周期 | P2 出口后冻结，一个发行周期后弃用 | P2 |
| D8 | 设计伙伴名单 | 由你决定 | P1 |
| D9 | Trusted Publishing 跑通后，是否在 npm 包设置中开启“要求 2FA 并禁止 token 发布” | 开启；彻底关闭 token 发包路径 | P0（0.1.5 发布成功后） |
| D11 | 采用门的位置 | **已决定**：P1 之前（§7） | 已定 |
| D12 | P0-3 的实现路线 | 先做 `/bin/sh` 门管道受控启动 spike，成立则 `gatedSpawn: true`，否则退回进程表 argv 匹配 | 0.2.0 批次 B4 |
| D13 | 性能门禁策略 | **已决定**：常规 CI 用确定性代理，墙钟指标放独立 perf workflow 只报告（§2.4） | 已定 |
| D15 | P3 / P4 的先后 | 由采用门结论与设计伙伴诉求决定 | 采用门判定后 |
| D16 | 0.2.0 适配后 xiocode 是否先发 1.4.0 | **已决定**：先发 1.4.0（保留逃生开关） | 已定 |
| D17 | opId 幂等的范围 | **已决定**：执行域内跨 Run 生效；Run 仍是单次尝试，崩溃后续跑开新 Run | 已定（规范落地于 ARCHITECTURE 下一次修订） |
| D18 | capability 是否签名 | **已决定**：嵌入模式只做结构校验、不签名；daemon 模式再议 | 已定（同上） |
| D19 | service 重启策略归属 | **已决定**：内核提供最小声明式规格 `never \| on-failure(maxRestarts, backoffMs)` | 已定（同上） |
| D20 | 门控后续任务是否提前建立 | **已决定**：提前建为 `todo`，门控条件随任务记录 | 已定 |
| D21 | 新原语的实现语言 | **已决定**：先在 TS 参考实现落地；Rust 仍由 Windows / Python / 亚秒级身份需求驱动 | 已定（§1 阶段依赖随下一次修订调整） |
| D22 | 发行版取消 Run 的公开出口 | **已决定**：0.2.0 新增 `reportRunCancelled(runId, reason)`（§3.3） | 已定 |
| D23 | `indeterminate` 的用户出口形式（xiocode） | **已决定**：CLI 子命令 `xio kernel adjudicate <opId>` | 已定 |

---

## 10. 实现状态对照（ARCHITECTURE → 0.1.x 现状 → 落地阶段）

| 规范条目 | 0.1.x 现状 | 落地阶段 |
|---|---|---|
| §0.2 裁决 1 所有权锁：OS 排他锁 | `O_EXCL` 建文件 + PID 存活判断 + owners 表租约 | P0（修判定）/ P2（`flock`） |
| §0.2 裁决 1 epoch 栅栏 | 已实现：`BEGIN IMMEDIATE` 事务内读后比对 | — |
| §0.2 裁决 1 只读 Observer | 未实现 | P2（嵌入只读 API）/ P4（Observer 连接） |
| §0.2 裁决 3 双部署形态 | 仅嵌入 | P2 / P4 |
| §0.2 裁决 4 回滚诚实性 | 未实现 | P3 |
| §0.2 裁决 5 ABI（协议 / schema / 契约） | 仅 TypeScript API | P1 |
| §1.2 schema 版本与迁移 | 无 `user_version` | P1 |
| §3.1 两段式受控启动 | 已实现（POSIX 门管道跳板 `gatedSpawn: true`） | 0.2.0（B4）/ P2（Rust pre_exec） |
| §3.2 第 5 步 Run 状态收敛 | 已实现 | 0.2.0（B2） |
| §3.4 后置条件恢复 | 未实现，`inputFingerprint` 未被使用 | P3（经快照指纹） |
| §3.5 快照与回滚 | 未实现 | P3 |
| §3.6 人工裁决 | 已实现（`adjudicate` 唯一审计出口） | 0.2.0（B2） |
| §4.1 `StopProcessResult` 三态 | 已实现（`confirmed_stopped \| not_stopped \| cannot_determine`） | 0.2.0（B4） |
| §4.1.1 身份核验 | 已实现（OS 启动时间 + bootId） | 0.2.0（B4）/ P2 |
| §4.2 第 5 条 有界等待 | 已实现（超时等待 `onRootExit` 有界排空） | 0.2.0（B1） |
| §4.2 第 6 条 停止请求必须有对象 | 已实现（抛 `OperationNotActiveError`） | 0.2.0（B1） |
| §4.3 Head + Tail | 已实现（Head 75% + Tail 25% 字符安全截断） | 0.2.0（B3） |
| §4.3 转储失败可见 | 已实现（`spillError` + 失败不返引用） | 0.2.0（B3） |
| §4.3 产物回收 `pruneArtifacts` | 已实现（自动清理未截断转储 + 域级 prune） | 0.2.0（B3） |
| §4.4.3 计数口径 / FIFO / 预算持久化 | 已实现（独立并发计数 + FIFO 严格排队） | 0.2.0（B2） |
| §4.4.3 域级内存 / 输出总额度 | 未实现 | P2（H 等级） |
| §4.4.4 Linux cgroup v2 | 未实现 | P2 之后（H 等级） |
| §4.4.4 Windows Job Object | 不支持 | P2 |
| §4.4.5 第 4 条 不阻塞宿主 | 已实现（全域异步采样器，热路径零同步子进程） | 0.2.0（B4） |
| §5 协议 | 无 | P1（协议 + stdio 适配器）/ P4（daemon） |
| §7 conformance | 27 项 TypeScript 共享套件（已包含 P0/N 项提升） | 0.2.0 / P1 迁移 |
| §0.2 裁决 6 / §3.7 op 幂等重放 | 0.2.0 显式拒绝（#40） | 0.3.0（TS 实现）/ P2（Rust） |
| §0.2 裁决 7 / §3.8 service 监督 | 未实现 | 0.2.0 之后独立批次（TS 实现）/ P2 |
| §0.2 裁决 8 / §3.5 快照 seq 与分叉 | 未实现 | P3（TS 实现先行） |
| §0.2 裁决 9 capability 结构校验 | 未实现 | P3（TS 实现先行） |
