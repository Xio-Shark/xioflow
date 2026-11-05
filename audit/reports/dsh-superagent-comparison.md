# dsh-superagent 对照：和 xioflow 像在哪、能借什么

> 对照对象：`deepseek-ai/dsh-superagent-prototype`，克隆于 2026-10-31，commit `6337fc8`（`git log -1`），版本 0.1.0，MIT。
> 对照基准：`@xioflow/kernel` 0.8.0 工作树（`src` 22,967 行，`ARCHITECTURE.md` 1,004 行）。
> 一句话定性：**不是竞品，是上下两层。** prototype 是会话之上的工作编排层（谁可以开工、开成什么工单、干完怎么回话），xioflow 是会话之下的执行事实层（进程有没有真死、工作区改了什么、能不能证明）。它们的缝隙恰好重合在同一条线上：prototype 的 `DshExecutor` 那一层，正是 xioflow 现在占的那一层。

---

## 1. 规模与形态

| 维度 | xioflow | dsh-superagent |
|---|---|---|
| 层位置 | 执行域 / 进程 / 工作区事务 | 会话 / 工单 / 人 |
| 源码 | 22,967 行 TS（63 文件） | 15,205 行 TS/TSX（约 50 文件） |
| 测试 | 63 文件，14,907 行 | 59 spec，14,960 行 |
| 文档 | `ARCHITECTURE.md` 1,004 + `spec/` 796 | 9 篇编号文档，1,973 行 |
| 运行时依赖 | 0 | 2（`proper-lockfile`、`zod`） |
| 宿主 | Node 嵌入式库 / MCP / CLI | DSH bundle（peerDep `dsh ^0.2.1-alpha.2`） |
| 状态 | SQLite `domain.db`，`PRAGMA user_version` | SQLite `orchestrator.sqlite`，`SCHEMA_VERSION` |
| 失败语义代表 | `indeterminate` | `unavailable` / `dropped` |

两边规模几乎同形，测试都压到和源码一比一。这不是巧合，是同一类系统在「靠测试代替信任」上的自然收敛。

---

## 2. 相同的地方（各自独立写出来的）

### 2.1 不知道就说不确定，不伪造成功

- xioflow：README 的四条硬保证「No fake running / No blind replay / No premature release / No invented process facts」；`indeterminate` 保留租约（`src/types.ts:39`、`:233`）。
- prototype：`docs/000-philosophy.md:15`「a draft is marked unfinished, a failure is reported as a failure, and a limit is never bypassed to avoid asking」；`docs/003-execution.md:130`「A launch that failed is not tried again on its own」；`docs/002-authorization.md:149`「an undelivered candidate never expires」；Eval 连续两次超时后第三次才记 `unavailable`。
- 关键相似点：两边都把「未知」做成**独立状态**，而不是映射成失败。xioflow 叫 `indeterminate`，prototype 叫 `unavailable`。

### 2.2 事务内登记意图，事务外执行副作用

- prototype：`Engine` 全同步、每个命令一个事务，端口在事务内 `enqueue`，适配器提交后才动（`docs/007-architecture.md:48`、`:164-170`）。`src/app/effects.ts` 是约 180 行的通用耐久队列：按 `(kind,key)` 合并且保留队列位序、指数退避、`Later` 表示「现在不能跑」不计失败、每 kind 并发上限、有序 kind、per-kind 健康。
- xioflow：准入 → 意图落库 → 才 `spawn`（README「Recovery needs durable launch evidence」一节）；`registerOperationIntent`（`src/domain.ts:796`）；`BEGIN IMMEDIATE` 单写者（`src/store/sqlite.ts:71`）。
- 相同结论：外部副作用跨不过本地事务，所以两边都在跨越处放了一条耐久接缝。差别只在接缝之后放什么——prototype 放通用队列，xioflow 放恢复流水线。

### 2.3 一类状态只有一个写者

- prototype：`docs/007-architecture.md:259-271` 的「One writer per state」表；`HealthBoard.claim` 拒绝第二个 claim（`src/infra/health.ts:18`）。
- xioflow：单域单所有者 + 三锁分离 + epoch fencing（ARCHITECTURE §0.2 裁决 1）；「One arbiter per domain」（README Guarantees 表）。

### 2.4 内容派生的幂等键

- prototype：`src/core/ids.ts:3` `key(...) = sha256(JSON).slice(0,32)`；Trigger 只存一次，重复进入走 disposition 的 `duplicate`。
- xioflow：`opId` + 输入指纹；同 `opId` 同指纹加入在飞或重放，不同指纹 `OperationIdConflictError`；每次重放写 `OPERATION_REPLAYED`。

### 2.5 窄端口 + 角色化能力面

- prototype：`EngineForSources` / `EngineForMainSession` / `EngineForPeople` / `EngineForSettings` / `EngineForExecutor` 五个 `Pick`（`docs/007-architecture.md:64`），并明文规定「what may import what」（同文件 `:257-258`）。
- xioflow：`PlatformDriver` / `SnapshotDriver` / `ConfinementDriver` 三份驱动契约 + §8 非目标声明。

### 2.6 规范本身进测试

- prototype：`tests/docs.spec.ts`（编号文档只能引用更早的文档、本地链接必须可解析、007 的表必须列全每个模块与每个测试）、`tests/class-docs.spec.ts`（每个类前面必须有 JSDoc）、`tests/model-surface.spec.ts`（模型可见面不许漂移）。
- xioflow：`conformance/` + `src/testing/contract-suite.ts`；`scripts/check-doc-sync.mjs` 只校验中英标题树。

### 2.7 schema 只增不减，新库拒绝旧实现写入

- prototype：`SCHEMA_VERSION` 只增，迁移在启动时一次完成，旧 schema 拒绝启动（`docs/007-architecture.md:486`）。
- xioflow：`PRAGMA user_version` + `SchemaTooNewError` + 所有权锁内可回放迁移（ARCHITECTURE §1.2）。

---

## 3. 各自缺的那一半

| 缺口 | xioflow | dsh-superagent |
|---|---|---|
| 进程 / 工作区硬事实 | 有：三态、租约、进程树结算、reaper/cgroup、快照回滚 coverage、confinement | 无：worker 以操作者身份无审批执行（`docs/003:27`），wrapper 自认不构成边界（`docs/003:80`），无工作区快照回滚（`snapshot`/`rollback` 只出现在事务与设置快照里），停止确认交给宿主 |
| 授权事实 | 只有 capability 的作用域 + `issuedBy` + TTL（`src/types.ts:626`）；没有「凭什么、多强、哪条规则、哪个策略版本」 | 有：Policy / 准入表 / 强度 / 规则匹配 / Mandate 记录 `policyVersion`，恢复前 revalidate |
| 外部事件续做 | 无。Run 结束即结束，新事件等于新 Run | 有：Subscription 扇出、人工消息以同一 Mandate 唤醒已结束 Ticket、bot/CI 不唤醒 |
| 排队公平 | 租约 FIFO + `waitTimeoutMs`，没有优先级 | `WorkerSlots`：并发上限之外给人留一格，唤醒优先于 launch（`src/executor/dsh.ts:169`、`:188`） |
| 运维健康面 | 只有 OTel span/metric，`grep -rli health src` 为空 | `HealthBoard`：单写者、成功自清、连败三次才报错（`src/infra/health.ts:18-40`、`src/app/effects.ts:7`、`:155`） |
| 面向人的出口 | 无。recovery 只返回 `recoveryGuidance` 文本 | Outbox + Channel + attention + 面板 |

---

## 4. 值得借鉴的（按价值/成本排序）

### A. capability 加 `basis`（最高价值，成本中等，动 ABI）

现状：`Capability = { id, scope, issuedBy, expiresAt, parentId, epoch, revokedAt }`（`src/types.ts:626-637`），准入时只校验 epoch、过期、作用域包含（`src/capability/check.ts:84`）。

prototype 的 `Mandate` 是同位置但厚一层的记录：`basis` 记下 strength、source、scope、row、sender、matched rules、`via`（`docs/007-architecture.md:125-133`），并且明文规定「widen scope means a new Ticket」「只有人工 stop 与 revalidation 失败会改变它」（`docs/001-domain.md:34`、`docs/002-authorization.md:129-141`）。

这填的是 ARCHITECTURE 护城河话术里的空档：现在能证明「做了什么、停没停」，证明不了「凭什么被允许写这块地」。落点：`src/types.ts` 的 `Capability`、`src/domain.ts:937` `issueCapability`、`src/capability/check.ts`，新增 journal 事件 `CAPABILITY_REVALIDATED`。

### B. `policyVersion` 盖在每张 capability 上（高价值，成本低）

prototype 的实现：`policyVersion = key(POLICY_REVISION, JSON.stringify({ rules, mode, sources }))`（`src/policy.ts:116`），并且明确「模型、并发、暂停状态、轮询间隔的变化不使已有决定失效」。版本一变：丢弃在跑的 Eval、把 Trigger 重新排队、只给受影响的 live Ticket 发 `policy-changed` Input，**不立即吊销 Mandate**（`docs/002-authorization.md:107-119`）。

xioflow 现在没有这个概念。`policy` 一词在内核里只指 `restart.policy`（`src/types.ts:481`）与 `replayPolicy`（`src/agents/workspace-recovery.ts:49`）。后果很具体：授权规则在 14:03 改了，没人能回答「哪些在飞 op 是在旧规则下准入的」。落点：`capability.policyVersion`、journal 事件 `POLICY_VERSION_CHANGED`、沿用「不追溯吊销，只影响新准入与恢复时 revalidate」的语义。

### C. effects 式耐久后置队列（中高价值，成本低）

`src/app/effects.ts` 的能力清单见 2.2。xioflow 现在把后置工作散着做：事务提交串行化用手搓 promise 链（`src/workspace/transactions.ts:142`），OTel 导出失败只打一行 `OTLP export failed (will retry)`（`src/mcp/server.ts:138`），artifact GC 同步执行（`src/domain.ts:824`）。

可借的场景三种，都不碰进程语义：journal→OTLP 游标重试、run 结束后的 artifact GC、回滚后的核验。纪律比代码更重要：`Later` 区分「现在不能跑」和「失败」，`ordered` 保序，`quiet` 避免把票据级失败升级成系统级错误。

### D. HealthBoard 的单写者纪律（中价值，成本低）

`claim` 拒绝第二个写者、`release` 之后写变 no-op、成功自清、连败三次才报错（`src/infra/health.ts:18-40`；`src/app/effects.ts:7`、`:155`）。

xioflow 没有任何 health 概念。它的诚实性目前是「每次调用返回值诚实」，没有「这个子系统现在坏不坏」的聚合事实。落点：`NodePlatformDriver` / `ReaperPlatformDriver` / `SnapshotDriver` / `RecoveryEngine` / MCP server 各 claim 一条，经 `xio status` 与 OTLP gauge 暴露。

### E. 文档即索引，由测试守（中价值，成本低到中，需要一个新约定）

`tests/docs.spec.ts` 断言 007 的模块表和测试表必须列全 `src` 与 `tests` 下的每一项。prototype 因此有一个文件级的代码地图，读的人从文档就能走到文件。

xioflow 没有这一层，而且是刻意没有：`ARCHITECTURE.md` 是协议规范，不是代码索引。实测：67 个 `src/**/*.ts` 里只有 `src/fault/crashpoint.ts` 在 ARCHITECTURE 里出现过；10-24 那次 confinement/gateway 提交在 ARCHITECTURE 里 `grep -ci "landlock\|gateway"` 为 0。这不等于文档错，但意味着 23k 行的仓库没有一个「哪个文件负责哪条契约」的入口。

所以这条不是补测试，是新增一层：一份 `CODE-MAP.md`（模块 → 责任 → 对应契约号，测试文件 → 覆盖的契约），再由一个 30 行的测试守住完整性；`scripts/check-doc-sync.mjs:43` 继续只管中英标题树。价值在接手成本，不在正确性。

### F. 订阅式续做，但窄化成「不授予新权」（高价值，成本高，依赖 A+B）

prototype 的 Subscription：订阅线程上的消息扇出给 Ticket 当上下文，绕过 gate、不授予任何新权、不能唤醒被人工停掉的 Ticket、bot/CI 不唤醒已结束 Ticket（`docs/001-domain.md:37`、`docs/002-authorization.md:20-45`）。

对内核可用的形态不是「Ticket」，而是：外部事实（CI 结果、测试结果、文件变化）可以**继续**一个已存在的 op 作用域，永远不能**扩大**它；续做前必须走 A 的 revalidate。这样既守住 §8 裁决 3「不做业务编排」，又给「证据触发工作」留了一个内核级原语。不要照搬 Ticket 生命周期——那需要对话存在，属于发行版。

### G. 给人的唤醒留一条优先通道（中价值，成本低）

prototype：并发上限之外再留一格给人工消息与状态查询，且唤醒优先于 launch（`src/executor/dsh.ts:169`、`:188`）。

xioflow：`allocateResourcesWithWait` 是 FIFO + `waitTimeoutMs`，一次批量 launch 可以让人按下的键排在后面。这在 xiocode 里是能被感知的卡顿。落点：租约加 priority，或 supervisory 保留格。

---

## 5. 不该借鉴的

- 面板 / prompts 版本 / settings 修订：xioflow 零 UI 是明确裁决，模型可见面属于发行版。
- Ticket / Eval / Mandate 整套编排域：只在有对话与多人的产品里成立，进内核就是 §8 禁止的业务编排。
- Source 适配器（GitHub/Feishu）与 Outbox：需要会话与渠道身份，属于发行版。
- 「prepare 命令 = 边界」式的措辞：prototype 自己都写明不构成边界（`docs/003:80`）。xioflow §8.1「capability 不是安全边界」要保持。

---

## 6. 反过来，它应该借 xioflow 的

- **进程真相**：worker 以操作者身份无审批执行，没有停止确认、没有孤儿/`setsid` 逃逸清点。xioflow 的 SIGINT→SIGTERM→SIGKILL + `residualPids` + `treeSettlement` 正是缺的那块（README Guarantees 表）。
- **意图先落库再 spawn**：prototype 的 launch 效应在瞬时失败时会重跑，重跑前没有进程级事实可查，只能靠提示词让 agent「先查 git 历史和工作区，再重复外部动作」（`docs/003:146`）。xioflow 的 `indeterminate` + 不盲目重试能把这从提示词纪律变成协议。
- **工作区快照/回滚**：Ticket 目录现在只能靠 git 自证。xioflow 的 snapshot + `coverage` 声明给了「回滚到什么程度」的诚实措辞。

---

## 7. 建议的落地顺序

第一批（只加字段与校验，不动既有语义）：
1. **B**：`capability.policyVersion` + `POLICY_VERSION_CHANGED`。验收：改规则后新 op 带新版本，旧 op 保持旧版本，journal 可查。
2. **D**：三个驱动各 claim 一条健康条目。验收：注入一次采样失败条目变 error，下次成功自清。
3. **E**：`CODE-MAP.md` + 完整性测试。验收：故意加一个未登记文件 CI 失败，登记后通过。这一条纯文档，可与 1、2 并行。

第二批（动 ABI，需要迁移与 conformance 契约）：
4. **A**：`capability.basis` + `revalidate`。验收：新增契约覆盖「basis 失效则恢复被拒」。
5. **G**：租约优先级。验收：新增契约覆盖「人工唤醒不被批量 launch 饿死」。

第三批（等发行版出现真实需求）：
6. **C**：effects 队列，先只接 OTLP 导出与 artifact GC 两个 kind。
7. **F**：订阅式续做，依赖 A+B，先出 spec 不出实现。
