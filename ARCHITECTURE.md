# xioflow 内核与 xiocode 发行版架构与协议规范

> **本文位置**：这是 xioflow 内核仓的权威协议规范。第 0–5、7–8 节为内核协议；第 6 节保留 xiocode 参考发行版的装配说明，用于界定内核边界。分阶段落地路线与当前实现差异见 [`ROADMAP.md`](./ROADMAP.md)。

> **状态**：目标态协议规范（v2 规划版：Rust 核心 + 快照回滚 + 双部署形态）。标注「目标态」的章节尚未在 0.1.x TypeScript 参考实现中落地，以 `ROADMAP.md` 的「实现状态对照」为准。  
> **核心定位**：  
> - **xioflow**：面向 Agent 框架作者的受监督执行内核。只提供执行原语：执行域管理、受监督进程、资源仲裁、停止确认、工作区快照与回滚、SQLite 事务持久化与崩溃恢复；无 UI 绑定，不绑定特定 Agent Loop、语言或文件格式。  
> - **xiocode**：基于 xioflow 装配的编程发行版。提供模型接入、编程工具、默认三件套工作流（PRD / Todo / Verification）、安全策略及 CLI/TUI。  
> **仓库分工**：xioflow 作为独立共享内核仓库开发；xiocode 等发行版作为独立仓库，只通过公开协议 / 语言绑定消费内核。

---

## 0. 核心定位与设计决策

### 0.0 产品目标（North Star）

> xioflow 是 **Agent 执行层的「内核」**：框架作者用它执行本地进程、改动工作区，得到一套**可证明、不撒谎**的执行事实；上层产品（xiocode 及第三方框架）像 Linux 发行版一样，在同一套原语与同一份 ABI 上装配出各自的产品形态。

| 维度 | 裁定 |
|---|---|
| **目标用户** | Agent 框架作者（不是最终使用 agent 的开发者）。首要人群：在宿主机上直接执行命令的**本地优先**框架与 coding agent |
| **非目标用户** | 执行完全托管在远程容器 / microVM 的框架（销毁容器即可清场，对本内核需求弱） |
| **内核形态** | Rust 核心；同一核心提供「嵌入模式」与「daemon 模式」两种部署（§0.2 裁决 3、§5） |
| **接入方式** | 各语言薄绑定（首批 TypeScript、Python）+ 语言无关协议；绑定与协议共享同一份 conformance 契约 |
| **管辖范围** | 本地进程生命周期 + 工作区文件系统变更（快照 / 回滚）；不管 LLM 调用、不管 agent 调度 |
| **控制器边界** | 只提供执行原语（spawn / stop / lease / snapshot / rollback / recover / adjudicate / journal），类比 syscall；不提供组件模型或调度器 |
| **成功标准** | 被第三方 Agent 框架采用并通过 conformance 契约；xiocode 只是第一个发行版 |
| **护城河** | 不在单项原语（快照、沙箱、持久化执行均有成熟项目），而在「一套事务事实模型 + 三态诚实语义 + 可移植 conformance 契约」的组合，以及对该 ABI 的长期稳定承诺（§0.2 裁决 5） |

### 0.1 Linux 范式与边界划界

| 关注维度 | xioflow 内核负责 | xiocode 等发行版负责 |
|---|---|---|
| **管理范围** | 执行域（Execution Domain）生命周期、域内唯一所有者 | 决定按工作区、按项目还是按会话绑定执行域 |
| **任务执行** | Run 尝试分配、执行状态跟踪、受管 Operation 归属 | 怎样拆分任务、采用何种业务工作流与工件 |
| **并发编排** | 资源配额仲裁、等待依赖、取消作用域 | 串行队列、DAG 拓扑、并行候选等具体编排算法 |
| **进程管理** | 平台驱动抽象、监督协议、停止确认、事实记录 | 选择要运行的工具、传递何种命令与参数 |
| **工作区变更** | 快照 / 回滚原语、覆盖范围如实声明、回滚结果核验 | 何时打快照、回滚到哪个点、是否向用户确认 |
| **权限安全** | 记录发行版提交的授权决策事实（谁、何时、批准了什么）；不做授权判定，不做安全隔离 | 权限策略、人工交互提问、风险分级与交互策略配置 |
| **验证判定** | 保存可信执行事实（状态、输出证据、产物引用） | 判定什么测试输出算业务验收通过 |
| **崩溃恢复** | 启动前现场重建、冲突资源隔离、Journal 事务恢复 | 决策哪些失败允许修复、重试或重新规划 |
| **模型上下文** | 完全不处理模型上下文、自然语言与提示词 | 提示词片段拼装、规约按需注入、会话裁剪 |
| **界面与工件** | 零 UI 依赖、不强制任何特定 Markdown 文件 | CLI、TUI、三件套文档及其他呈现形式 |

### 0.2 五项核心架构裁决

#### 1. 管理范围：默认工作区级执行域，不做整机统一调度
- **执行域（Execution Domain）定义**：一个执行域拥有一份持久化 SQLite 状态库、一个活动内核所有者（Active Kernel Owner）、一套资源登记与预算配额，以及域内有序的事务事件记录；
- **单域单所有者与三锁分离架构**：
  | 锁类型 | 生命周期 | 实现与兑现机制 |
  |---|---|---|
  | **所有权锁 (Ownership Lock)** | 内核进程全程 | 操作系统文件排他锁 + `owners` 表（`owner_id`, `epoch`, `heartbeat_at`, `expires_at`） |
  | **事务写锁 (Transaction Lock)** | 毫秒级事务内 | SQLite WAL 模式原生单写者排他机制 |
  | **资源租约 (Resource Lease)** | 单个 Operation 生命周期 | `resource_leases` 持久化表（含资源标识与配额 `budget`） |
- **Epoch Fencing 代际栅栏**：
  - 内核接管已过期或解散的所有权租约时，强制执行 `epoch = epoch + 1`；
  - 随后所有状态写操作一律携带 `WHERE epoch = :current_epoch` 校验条件；
  - 若旧所有者发生脑裂复活（如因 GC/挂起导致锁文件被清理但原进程仍存活），其任何写入事务将必然因 epoch 失效而拒绝提交，彻底杜绝数据回写踩踏。
- **只读 Observer 模式**：
  - 明确支持免抢锁的只读观察者连接（如 CLI 的 `xio status`、`xio inspect`）；
  - 以只读事务打开数据库读取运行快照，严禁因纯状态监控而争夺排他所有权引发服务中断。
- **域边界说明**：
  - 序号仅在域内连续递增，不要求整机统一；
  - 同一代码仓库的多个 Git Worktree 需识别共享的 `.git` 元数据资源归属，防止并发操作 Git 索引破坏仓库；
  - 域内资源登记无法控制域外非受管程序（若外部程序抢占端口，由操作系统真实错误暴露，内核不虚构整机绝对隔离保证）。

#### 2. 异常影响范围：冻结冲突资源，允许已证明独立的运行继续
严格区分**“结果不确定”**与**“进程可能仍存活”**两个正交维度：
- **操作执行者可能仍在运行**：严格隔离其可能占用的冲突资源，禁止将其分配给新操作；
- **操作已确认停止，但副作用结果未知**：阻断盲目重放，保留现场，由恢复程序核验；
- **已证明没有资源或成果依赖的其他运行**：允许继续执行，不搞一刀切全盘挂起；
- **无法确定影响范围时**：保守暂停整个执行域的新操作；
- **发行版策略**：发行版可根据产品偏好选择更保守的全局暂停，但绝对不能放宽内核的强制隔离。

#### 3. 部署形态：一个核心，嵌入与 daemon 两种模式，同一协议
「单域单所有者」与「每个框架进程各嵌一份库」不可同时成立：同一工作区的第二个嵌入方只会拿到 `DomainLockedError`，而各开一个域又会丢失跨 agent 的资源仲裁。内核语义要求**一个工作区只有一个仲裁者**，因此：
- **嵌入模式**：内核以库形式运行在宿主进程内，宿主即域所有者。适用单 agent / 单进程场景，零运维；
- **daemon 模式**：内核作为工作区级常驻进程持有域所有权，多个客户端（不同框架、不同语言、多个 agent）通过 §5 协议连接，由 daemon 统一仲裁租约；
- **同一契约**：两种模式执行同一份协议语义与 conformance 契约，嵌入模式的语言绑定只是「进程内传输」的协议实现；
- **升级路径**：嵌入方检测到域已被 daemon 持有时，必须以协议客户端身份接入，禁止抢锁或另开影子域。

#### 4. 回滚诚实性：快照驱动可插拔，覆盖范围必须如实声明
内核不做安全沙箱（§8），因此无法观察受管进程写到了哪里。回滚能力的承诺边界由两个正交能力共同决定：
- **快照驱动（SnapshotDriver）**：决定「能恢复什么」——git 影子引用、APFS clonefile、btrfs/ZFS 快照、overlay 等均作为驱动，内核只定义契约（§3.5、§4.1）；
- **写入限制驱动（ConfinementDriver，可选）**：决定「是否确知没写到别处」——可借助 bubblewrap、`sandbox-exec`、Anthropic `srt` 等外部工具把写入限制在快照根目录内。它服务于**回滚正确性**，不作为安全边界承诺；
- **覆盖声明**：每次回滚结果必须携带 `coverage`：`complete`（有写入限制且快照覆盖全部根目录）/ `declared_roots`（仅保证声明根目录，范围外副作用未知）/ `none`；
- **禁止虚报**：没有写入限制时，回滚结果永远不得声明 `complete`。

#### 5. ABI 稳定：协议与契约是产品，实现是参考
Linux 发行版生态建立在 syscall ABI 长期稳定之上。xioflow 的等价物是：
- **三件 ABI**：§5 的协议消息形状、§1 的 `domain.db` schema（带 `user_version` 迁移）、§7 的 conformance 契约；
- **版本策略**：协议与 schema 独立于任何语言包的版本号，按 SemVer 演进；破坏性变更必须提升主版本并提供迁移；
- **实现地位**：Rust 核心是规范实现，TypeScript 0.1.x 是历史参考实现；任何实现（含第三方）以通过 conformance 等级为准，而不以代码同源为准。

---

## 1. 持久化架构与掉电保证 (SQLite Transactional Store)

为实现系统断电级崩溃恢复，内核控制状态放弃易损坏的自研纯文本追加，统一采用 **嵌入式 SQLite 事务存储**。

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Execution Domain 存储边界                       │
│                                                                        │
│   SQLite Database (domain.db)                                          │
│   ├── tasks / runs / operations (状态表)                               │
│   ├── resource_leases (持久化资源占用表)                                │
│   ├── snapshots (快照引用、覆盖范围与校验指纹，目标态)                  │
│   └── journal_events (带单调自增序号的事件日志)                         │
│   PRAGMA user_version = schema 版本（ABI，迁移必须显式）               │
│                                                                        │
│   WAL 模式 + PRAGMA synchronous = FULL / macOS F_FULLFSYNC             │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 三种持久化保证的明确界定
1. **控制事实持久化**：已确认提交的 Run 状态、Operation 启动意图、授权决策与结果，在事务提交（`commit`）后经 `FULL` 刷盘保证，掉电后 100% 可恢复；
2. **受管产物持久化**：内核确认“产物已保存”前，产物驱动必须调用 `fsync` 完成物理刷盘，而非仅仅返回路径；刷盘或写入失败必须作为事实（如 `spillError`）上报，且不得返回指向不完整文件的产物引用；
3. **外部副作用状态**：外部 Shell 命令执行、远程 API 调用无法纳入本地 DB 事务。内核在外部调用前后设置**前置意图登记**与**后置结果核验**窗口，不确定现场强制进入恢复流水线。

> **掉电保证承诺边界**：在声明支持的本地文件系统（如 APFS、ext4）和正确履行同步语义的硬件存储设备上，保证已确认提交的内核事实及受管产物可恢复；不包含物理硬件损毁或设备虚报刷盘完成。

### 1.2 Schema 版本与迁移（ABI）
- `domain.db` 的表结构是 ABI 的一部分（§0.2 裁决 5）：以 `PRAGMA user_version` 标记版本，任何实现打开数据库时先校验版本；
- 版本低于自身：在所有权锁内执行显式、可回放的迁移，迁移本身写入 `journal_events`；版本高于自身：拒绝打开并报 `SchemaTooNewError`，禁止降级写入；
- 目的：TypeScript 0.1.x 实现遗留的域（含崩溃现场）能被 Rust 核心原样接管并裁决。

---

## 2. 核心领域模型与实体契约 (TypeScript 记法)

> 下列类型用 TypeScript 记法描述**协议形状**，不代表实现语言；Rust 核心与各语言绑定以此为序列化契约。

```typescript
/**
 * 逻辑工作单元
 */
export interface Task {
  id: string;                      // 任务唯一标识
  domainId: string;                // 所属执行域
  name: string;
  createdAt: string;               // ISO8601
  meta?: Record<string, unknown>;  // 发行版元数据
}

/**
 * 单次执行尝试
 */
export interface Run {
  id: string;
  taskId: string;
  domainId: string;
  owner: string;                   // 执行所有者（session-id / agent-runner）
  status: KernelRunStatus;
  terminationReason?: TerminationReason;
  startedAt: string;
  endedAt?: string;
  configSnapshotWhiteList?: Record<string, unknown>; // 白名单安全配置快照
}

export type KernelRunStatus =
  | 'queued'        // 已排队
  | 'starting'      // 正在启动准备
  | 'running'       // 正常执行中
  | 'stopping'      // 停止中，等待底层驱动确认
  | 'succeeded'     // 成功收尾（所有操作已结清）
  | 'failed'        // 显式执行失败
  | 'cancelled'     // 已确认停止
  | 'indeterminate';// 结果不确定（无法确认是否停止或副作用未明）

export type TerminationReason = 
  | 'completed'
  | 'user_cancelled'
  | 'timed_out'
  | 'resource_preempted'
  | 'crash_detected'
  | 'memory_exceeded'              // 物理/进程树内存超限
  | 'cpu_exceeded'                 // CPU 时间超限
  | 'pids_exceeded'                // 后代进程数超限 (防止 fork 炸弹)
  | 'output_exceeded'              // 输出字节数硬截断
  | 'client_lost';                 // 目标态：daemon 模式下发起方客户端断连（§5.3）

/**
 * 资源治理预算契约
 */
export interface ResourceBudget {
  maxMemoryBytes?: number;         // 进程树总内存 (RSS/cgroup memory)
  maxPids?: number;                // 后代进程总数 (cgroup pids.max)
  maxCpuTimeMs?: number;           // CPU 时间（与 wall-clock timeoutMs 是两个维度）
  maxOutputBytes?: number;         // stdout+stderr 落盘上限 (spill 封顶)
  enforcement: 'observe' | 'soft' | 'hard';
}

/**
 * 受监督原子操作
 */
export interface Operation {
  id: string;
  runId: string;
  kind: 'process' | 'snapshot' | 'rollback' | 'filesystem' | 'gate' | 'custom';
  name: string;
  inputFingerprint: string;        // 输入与配置的内容哈希（sha256），不是可读拼接串
  requiredResources: string[];     // 申请占用的资源（如 ["workspace:write:root"]）
  timeoutMs?: number;              // 挂钟运行超时
  resourceBudget?: ResourceBudget; // 显式声明的资源治理预算
  mutationRoots?: string[];        // 目标态：本操作可能改动的工作区根目录（快照 / 回滚 / 写入限制的作用范围）
  snapshotBefore?: boolean;        // 目标态：意图登记时是否先打前置快照（§3.5）
  status: 'pending' | 'intent_registered' | 'active' | 'stopping' | 'done';
}

/**
 * 多态执行结果
 */
export type OperationResult =
  | ProcessOperationResult
  | SnapshotOperationResult
  | RollbackOperationResult
  | FilesystemOperationResult
  | GenericOperationResult
  | IndeterminateResult;

export interface BaseResult {
  durationMs: number;
  completedAt: string;
}

export interface ProcessOperationResult extends BaseResult {
  kind: 'process';
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: string | null;           // POSIX 信号名（如 'SIGKILL'）；Windows 为 null
  stdout: string;                  // 内存保留的 Head + Tail（§4.3）或完整输出
  stderr: string;
  isTruncated: boolean;            // 聚合字段：任一流达到有界上限被截断
  stdoutTruncated: boolean;        // 逐流截断事实
  stderrTruncated: boolean;
  stdoutRef?: string;              // 逐流完整转储 (spill) 的产物引用，仅在刷盘成功时出现
  stderrRef?: string;
  stdoutHash?: string;             // 对落盘内容计算的 sha256
  stderrHash?: string;
  spillError?: string;             // 转储失败事实；出现时对应 *Ref 必须缺省
  spawnFailure?: string;           // 可执行文件无法启动（区别于子进程自己退出 127）
  peakMemoryBytes?: number;        // 采样到的进程树内存峰值
  cpuTimeMs?: number;              // 消耗的 CPU 时间
  identityVerification: IdentityVerificationResult;
  stopVerification?: StopProcessResult; // 停止确认凭据
}

/**
 * 目标态：工作区快照（§3.5）
 */
export interface SnapshotRef {
  id: string;
  driver: string;                  // 'git-shadow' | 'apfs-clonefile' | 'btrfs' | 'overlay' | 第三方
  roots: string[];                 // 实际覆盖的根目录
  coverage: 'worktree_non_ignored' | 'full_tree';  // git 影子引用不含被忽略文件，必须如实声明
  treeFingerprint: string;         // 快照内容指纹，用于回滚后核验
  createdAt: string;
}

export interface SnapshotOperationResult extends BaseResult {
  kind: 'snapshot';
  status: 'succeeded' | 'failed';
  snapshot?: SnapshotRef;
  errorMessage?: string;
}

export interface RollbackOperationResult extends BaseResult {
  kind: 'rollback';
  status: 'restored' | 'partial' | 'failed';
  snapshotId: string;
  coverage: 'complete' | 'declared_roots' | 'none';     // §0.2 裁决 4：无写入限制时不得为 complete
  verifiedFingerprint: boolean;    // 回滚后工作区指纹是否与快照一致
  unrestoredPaths?: string[];      // partial 时列出未能恢复的路径
  outOfScopeEffects: 'none_possible' | 'possible';      // 受管操作期间是否可能写到根目录之外
}

/**
 * 目标态：人工裁决记录（§3.6）
 */
export interface AdjudicationRecord {
  operationId: string;
  verdict: 'confirmed_stopped' | 'abandon_with_residuals';
  actor: string;                   // 发行版提交的裁决者标识（用户 / 策略名）
  note?: string;
  residualPids?: number[];         // abandon 时如实保留残留进程事实
  decidedAt: string;
}

export interface FilesystemOperationResult extends BaseResult {
  kind: 'filesystem';
  status: 'succeeded' | 'failed';
  targetPath: string;
  action: 'create' | 'modify' | 'delete';
  bytesWritten?: number;
  errorMessage?: string;
}

export interface GenericOperationResult extends BaseResult {
  kind: 'generic';
  status: 'succeeded' | 'failed' | 'cancelled';
  outputRef?: string;              // 不可变产物引用
  errorMessage?: string;
}

export interface IndeterminateResult extends BaseResult {
  kind: 'indeterminate';
  status: 'indeterminate';
  reason: string;                  // 未知原因
  recoveryGuidance: string;        // 人工恢复或现场排查指引
}

export type IdentityVerificationResult =
  | 'is_original_process'          // 确认为原启动进程
  | 'not_original_process'         // 确定已不是原进程
  | 'cannot_determine';            // 无法可靠判断
```

---

## 3. 六大核心运行协议 (Formal Protocols)

### 3.1 启动协议：先登记意图，再执行 (Intent-First Spawn Protocol)
杜绝“启动了进程却无记录”的崩溃盲区。规范实现采用**两段式受控启动（Gated Spawn）**：子进程在 `exec` 之前阻塞在一道门上，身份落库后才放行，从构造上消除“已执行但无身份记录”的窗口：

```text
1. [事务提交] 在 SQLite 中写入 Operation 意图、输入指纹与资源占用 (status: intent_registered)
   └── 若 snapshotBefore = true，先按 §3.5 完成前置快照并在同一事务登记 SnapshotRef
2. [驱动预备] PlatformDriver.spawn(command, { gated: true })
   ├── POSIX：fork 后子进程在 pre-exec 阶段阻塞读取门管道；Windows：CREATE_SUSPENDED 创建
   └── 获得 ProcessIdentity（pid、pgid / job、OS 级进程启动时间、命令指纹）
3. [事务提交] 登记执行身份并推进为 'active'
4. [放行] 驱动打开门（写门管道 / ResumeThread），子进程才开始 exec 目标程序
   └── 宿主在 3 之前崩溃：门管道 EOF，子进程必须直接退出、绝不 exec ⇒ “无身份 ⇔ 未执行” 由构造保证
5. [正常监督] 挂载实时流排空泵、注册超时定时器与退出监听
6. [驱动终止] 进程结束或触发停止，驱动产出初步结果
7. [事务提交] 原子写入 OperationResult 并根据确认事实释放相关资源占用
```

**无法提供受控启动的驱动**（如 0.1.x 的 Node `child_process` 实现）必须声明 `capabilities.gatedSpawn = false`，且恢复时对 `intent_registered` 且无身份的操作**不得**直接判定未启动：只有驱动能证明进程表中不存在与该操作命令指纹、工作目录匹配的进程时，才可判为 `cleaned_unspawned`；否则判为 `indeterminate` 并保留租约。

### 3.2 资源恢复协议：先建隔离，再开新操作 (Recovery-Before-Execution Protocol)
启动内核时，严禁先接收新操作再慢悠悠恢复：

```text
1. [获取所有权] 尝试获取执行域 SQLite 文件排他锁；失败则抛出 DomainLockedError
2. [加载未终结状态] 从数据库加载所有处于 'active'、'stopping'、'intent_registered' 的 Run 与 Operation
3. [重建隔离屏障] 将所有未结清操作声明的 requiredResources 立即载入内存隔离表，阻止任何新操作申请
4. [驱动现场核查]：
   ├── 核对进程身份 (verifyIdentity)：
   │   ├── is_original_process: 发送停止流水线，推进至安全终态
   │   ├── not_original_process: 进程已死，核对产物并结清资源
   │   └── cannot_determine: 标记为 indeterminate，保留隔离屏障，禁止分配
   ├── leader 已死但进程组 / job 仍有存活成员：按组定向清场，确认组空后才结清；清不掉则 indeterminate
   └── 核对受管文件修改现场（§3.4 后置条件；有前置快照的按 §3.5 核验指纹）
5. [Run 状态收敛] 本轮裁决后，所属 Run 若已无未终结操作：存在 indeterminate ⇒ Run 置 indeterminate；
   否则置 failed(terminationReason = crash_detected)。禁止让 Run 永久停留在 running
6. [开放安全操作] 仅对已确认没有资源冲突且与未终结操作无关的独立运行开放执行
```

### 3.3 Run 完成协议：业务修复与执行事实分开 (Run Completion Protocol)
在实际编程场景中，测试报错 -> 修复代码 -> 测试通过是正常回路，内核不能因为中间有失败操作就强行将 Run 标死，但也不能只看最后一次成功而掩盖错误。

#### 内核 Run 结束条件判定表

| 检查项 | 必须满足的内核条件 | 不满足时的处理 |
|---|---|---|
| **操作收尾** | 该 Run 下所有发起的 Operation 均已达到终态（无 `active`/`stopping`） | 阻断 Run 结束，等待底层收尾 |
| **资源结清** | 该 Run 占用的临时排他资源已安全释放 | 保持 Run 活跃，进行资源清理 |
| **无悬挂不确定态** | 关键操作不存在未裁决的 `indeterminate` 状态 | 标记 Run 为 `indeterminate` 并报警 |
| **业务验收结论** | 发行版显式提交 `reportRunSucceeded()` 或 `reportRunFailed()` | 内核仅确认执行事实完整，不自行猜测业务对错 |

> **重要规则**：内核中的 `Run.status = succeeded` 仅表示“该执行尝试在内核受管协议下已完整合法收尾”，**不代表该任务的所有业务需求在逻辑上必然完全正确**（业务验收由发行版自行断言）。

### 3.4 恢复协议：凭证后置条件关联，不凭存在猜成功
恢复已崩溃的操作时，严禁因为“目标文件存在”或“Git 有个 commit”就盲目推断为成功：

```text
恢复验证链路：
[Operation 记录] ──> [输入与配置指纹一致性] ──> [执行凭证(Transaction ID/日志签名)] ──> [驱动验证后置条件]
                                                                                            │
                                                                   ┌────────────────────────┴────────────────────────┐
                                                                   ▼ 全部吻合                                         ▼ 缺失或存疑
                                                            提交 Succeeded                                    提交 Indeterminate
```

### 3.5 快照与回滚协议：先快照再改动，回滚必须可核验（目标态）
快照与回滚本身都是受管 Operation（`kind: 'snapshot' | 'rollback'`），走同一套意图登记、租约与恢复流水线：

```text
快照 (snapshot)：
1. [意图登记] 申请 mutationRoots 对应的 workspace 写租约（与写入该根目录的其他操作互斥）
2. [驱动捕获] SnapshotDriver.capture(roots) -> SnapshotRef（含 coverage 与 treeFingerprint）
3. [事务提交] SnapshotRef 写入 snapshots 表；驱动必须在返回前完成持久化（git 对象落盘 / clone 完成）

回滚 (rollback)：
1. [前置条件] 目标根目录上不存在 active / stopping / 未裁决 indeterminate 的操作，否则拒绝并给出持有者诊断
2. [意图登记] 申请根目录独占写租约，登记目标 snapshotId
3. [驱动恢复] SnapshotDriver.restore(snapshot)
4. [核验] SnapshotDriver.fingerprint(roots) 与 snapshot.treeFingerprint 比对
   ├── 一致 -> status: restored
   ├── 部分路径无法恢复 -> status: partial + unrestoredPaths
   └── 驱动失败 -> status: failed
5. [覆盖声明] 依 §0.2 裁决 4 计算 coverage 与 outOfScopeEffects：
   自上次快照以来任一受管操作在无写入限制下运行 ⇒ outOfScopeEffects = 'possible'，coverage ≤ declared_roots
6. [事务提交] 写入 RollbackOperationResult，释放租约

崩溃恢复：rollback 处于未终结状态时，恢复引擎重新计算指纹：与快照一致 ⇒ restored；否则 indeterminate 并保留租约。
```

- **快照保留与回收**：内核只提供 `pruneSnapshots(filter)` 原语，且拒绝回收仍被未终结 / 未裁决操作引用的快照；保留策略由发行版决定；
- **首个规范驱动**：`git-shadow`——用临时 `GIT_INDEX_FILE` 执行 `add -A` + `write-tree` + `commit-tree`，写入私有 ref `refs/xioflow/snapshots/<id>`，不触碰用户 index 与分支；覆盖声明为 `worktree_non_ignored`（被忽略文件如 `node_modules` 不在快照内，必须如实声明）。

### 3.6 人工裁决协议：indeterminate 必须有受审计的出口（目标态）
`indeterminate` 保留租约是正确的，但必须提供唯一、受审计的出口，否则资源会被永久冻结，调用方只能绕过协议直接改库：

```text
adjudicate(opId, verdict, actor, note?)
1. [前置条件] 操作结果必须为 indeterminate；否则拒绝
2. [事实补全] 驱动再做一次身份核验与残留扫描，把结果附入裁决记录（裁决者看到的是最新事实，而非崩溃时的旧事实）
3. [事务提交] 写入 AdjudicationRecord（epoch 栅栏校验）与 journal 事件 OPERATION_ADJUDICATED
   ├── confirmed_stopped：释放租约；若第 2 步仍发现存活残留，此裁决被拒绝，只能选择 abandon_with_residuals
   └── abandon_with_residuals：释放租约，但 residualPids 永久保留在事实中，Run 结论不得为 succeeded
```

- 内核不自动裁决、不设超时自动释放；是否向用户提问、采用何种策略由发行版决定；
- 任何绕过本协议的租约释放入口（如直接调用内部 `releaseResources`）都不属于公开 API。

---

## 4. 平台驱动契约与停止确认流水线

### 4.1 平台驱动能力与 Containment 隔离容器抽象

在工业级内核中，`spawn` 的职责绝非“启动并拿到 PID 再说”，而是**“启动并立即置入一个可整组终止与资源隔离的容器 (Containment)”**：
- 在 POSIX 上，通过 `detached: true` 建立独立进程组（PGID），成为 Group Leader；
- 在 Linux 上，优先置入 systemd user scope 或委派 cgroup v2 子树；
- 在 Windows 上，通过 `CREATE_NEW_PROCESS_GROUP` 并关联 Job Object 句柄；
- 凡无法建立容器级身份的 spawn 必须在驱动层显式暴露能力缺失，严禁静默退化为不可靠的单 PID 管理。

```typescript
export interface PlatformDriver {
  name: string;
  capabilities: PlatformCapabilities;
  /**
   * 启动受管命令并置入隔离容器
   */
  spawn(
    command: StructuredCommand,
    options?: { containment?: ContainmentSpec; gated?: boolean } // gated：§3.1 两段式受控启动
  ): Promise<ManagedProcessHandle>;
  /**
   * 基于 OS 进程启动时间与指纹的多维进程身份核验 (防止 PID 环回复用)
   */
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  /**
   * 执行具备组级确认与逃逸扫描的终结流水线
   */
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
  /**
   * 崩溃恢复专用：leader 已死时按 pgid / job 定向清场并确认组空
   */
  terminateGroup?(group: { pgid?: number; jobId?: string; cgroupPath?: string }, graceMs: number): Promise<StopProcessResult>;
  /**
   * 周期采样进程树资源指标 (用于 observe/soft 治理)；实现必须是非阻塞的（§4.4.5）
   */
  sampleMetrics?(identity: ProcessIdentity): Promise<ProcessTreeMetrics>;
}

export interface PlatformCapabilities {
  processGroupKill: boolean;         // 是否支持整组终止 (-pgid / TerminateJobObject / cgroup.kill)
  startTimeSource: 'os' | 'none';    // 'os'：能读取内核记录的进程创建时间（跨宿主重启可用）；'none'：只能靠 PID 存活
  gatedSpawn: boolean;               // 是否支持 §3.1 两段式受控启动
  memoryHardLimit: boolean;          // 是否支持 OS 级硬内存限制 (Linux cgroup v2 memory.max)
  pidsLimit: boolean;                // 是否支持后代进程总数限制 (cgroup pids.max)
  cpuLimit: boolean;                 // 是否支持 CPU 时间硬限制 (cgroup cpu.max)
  descendantEnumeration: 'full' | 'cgroup' | 'job' | 'none'; // 后代枚举与逃逸检测能力
}

/**
 * 目标态：快照驱动（§0.2 裁决 4、§3.5）
 */
export interface SnapshotDriver {
  name: string;
  coverage: 'worktree_non_ignored' | 'full_tree';
  capture(roots: string[]): Promise<SnapshotRef>;
  restore(snapshot: SnapshotRef): Promise<{ unrestoredPaths: string[] }>;
  fingerprint(roots: string[]): Promise<string>;
  prune(snapshotIds: string[]): Promise<void>;
}

/**
 * 目标态：写入限制驱动（可选，服务于回滚正确性，不是安全边界）
 */
export interface ConfinementDriver {
  name: string;                      // 'bubblewrap' | 'sandbox-exec' | 'srt' | 第三方
  /** 把命令包装为“只能写 writableRoots”的形式；无法兑现时必须抛错，禁止返回未受限命令 */
  wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand;
}

export interface ContainmentSpec {
  pgidLeader: boolean;               // POSIX detached: true 建组
  jobObject?: boolean;               // Windows Job Object 关联
  cgroupScope?: {                    // Linux cgroup v2 隔离区
    scopeName: string;
    budget?: ResourceBudget;
  };
}

export interface StructuredCommand {
  execPath: string;
  args: string[];                    // argv，永不经 shell 包装
  cwd: string;
  stdin?: string | Uint8Array;       // 一次性 stdin 管道，写入后关闭
  envWhiteList?: Record<string, string>; // 精确环境：给什么就是什么，不注入 PATH，绝不落盘全量 env
  inheritEnv?: boolean;              // 仅在无白名单时生效；false 得到空环境
}

export interface ProcessIdentity {
  pid: number;
  pgid?: number;                     // POSIX 进程组 ID —— spawn 时建组
  jobId?: string;                    // Windows Job Object 标识
  cgroupPath?: string;               // Linux cgroup v2 路径
  osStartTime?: string;              // 内核记录的进程创建时间（见下方身份核验规则）
  bootId?: string;                   // 宿主启动标识（Linux /proc/sys/kernel/random/boot_id 等），跨重启判等
  spawnTime: string;                 // ISO8601（宿主记录，仅供展示，不作为身份证据）
  commandFingerprint: string;        // execPath + args 的 sha256，辅助核验
}

export interface StopProcessResult {
  stopped: 'confirmed_stopped' | 'not_stopped' | 'cannot_determine'; // 停止三态收敛
  scope: 'direct_child' | 'process_group' | 'containment_cgroup' | 'job_object' | 'unknown';
  residualPids?: number[];           // 逃逸后代或存疑残留进程 PID 列表
  errorDetails?: string;
}

export interface ProcessTreeMetrics {
  rssBytes: number;                  // 进程树物理内存 (Resident Set Size)
  pidsCount: number;                 // 后代存活进程数
  cpuTimeMs: number;                 // 用户态+内核态 CPU 耗时
}
```

#### 4.1.1 进程身份核验规则（防 PID 复用）
- **唯一可信证据是 OS 记录的进程创建时间**：Linux 读 `/proc/<pid>/stat` 第 22 字段 `starttime` 并结合 `boot_id`；macOS 读 `proc_pidinfo(PROC_PIDTBSDINFO)` 的 `pbi_start_tvsec/pbi_start_tvusec`；Windows 读 `GetProcessTimes` 的创建时间；
- 判定表：
  | 观察 | 结论 |
  |---|---|
  | PID 不存在、或为僵尸（已退出待收尸） | `not_original_process` |
  | `bootId` 与当前宿主不同 | `not_original_process`（重启后原进程必然已不存在） |
  | OS 创建时间与记录一致 | `is_original_process` |
  | OS 创建时间与记录不一致 | `not_original_process` |
  | 驱动无法读取 OS 创建时间（`startTimeSource = 'none'`） | `cannot_determine` |
- **禁止**以「命令行包含 execPath」「宿主进程内的单调时钟」作为跨重启的身份证据：前者会把复用了同一 PID 的无关同名进程（如另一个 `node`）判为原进程，进而被恢复流水线误杀；
- `commandFingerprint` 只能用于否定（不一致 ⇒ 非原进程），不能单独用于肯定。

### 4.2 停止确认流水线 (Stopping Pipeline)

严禁把“向 PID 发送了信号”等同于“进程已停止”：
1. **组级投递与降级升级**：
   - 优先向 `-pgid`（或通过 `cgroup.kill` / `TerminateJobObject`）发送 `SIGINT`；
   - 宽限期 `graceMs`（默认 3000ms）超时后升级发送 `SIGTERM`，继而 `SIGKILL`；
2. **组空轮询核验 (Wait for ESRCH)**：
   - 发送 `SIGKILL` 到 `-pgid` 后，驱动周期轮询 `kill(-pgid, 0)` 直至返回 `ESRCH`（确认进程组内已无存活进程）；
3. **逃逸后代显式扫描 (Escaped Descendants Audit)**：
   - 孙进程可能调用 `setsid()` 脱离原有 PGID。驱动在组空后执行一次后代树扫描（Linux 遍历 `/proc` 父子链，或核验 cgroup 成员）；
   - 若扫描到脱离残留进程，如实记录于 `residualPids`，停止判定置为 `'cannot_determine'` 或 `'not_stopped'`——**绝不因组空而草率判定为完全停止**；
4. **决策分流与隔离释放**：
   - `stopped === 'confirmed_stopped'`：确认为完全终结，推进为 `cancelled` 或 `timed_out`，原子释放相关资源租约；
   - `stopped !== 'confirmed_stopped'`：保留现场资源隔离屏障，推进为 `indeterminate`，记录告警事件并阻止资源被新操作复用。
5. **所有等待必须有界**：超时 / 取消路径等待的是**根进程退出事实**，而不是 stdio 管道关闭；逃逸后代持有管道时，操作仍须在 `timeoutMs + 停止流水线宽限 + 排空超时` 之内返回（结论为 `indeterminate`），不得挂到逃逸进程自行退出；
6. **停止请求必须有真实对象**：对不存在、已终结或所属域已关闭的操作发起停止，必须返回显式错误（如 `OperationNotActiveError`），禁止返回 `confirmed_stopped`。

```text
取消 / 超时 / 资源超限触发
 └──> Run 状态进入 'stopping'（锁定冲突资源，拒绝新子操作申请）
       └──> 向进程组 (-pgid) 或 cgroup 发送优雅中断 (SIGINT)
             └──> 启动受控宽限期计时器 graceMs (如 3000ms)
                   └──> 仍未退出？升级发送 SIGTERM -> SIGKILL (-pgid)
                         └──> 轮询 kill(-pgid, 0) 直至 ESRCH（组内无进程）
                               └──> 触发逃逸后代扫描 (/proc 链或 cgroup 枚举)
                                     ├── 存在逃逸或无法核查 -> stopped: 'cannot_determine' -> 保持资源隔离，标为 indeterminate
                                     └── 组空且无逃逸残留 -> stopped: 'confirmed_stopped' -> 推进终态并释放资源租约
```

### 4.3 有界输出排空与溢出转储机制 (Spill to Artifacts)

大输出处理遵循“内存封顶、流式落盘、防止管道死锁”原则：
1. **内存缓冲封顶**：单操作内存保留上限默认 10MB（逐流计算）。超出后置位对应流的 `*Truncated = true`，停止向内存累加，但在内存中保留 **Head（前置概览）+ Tail（最新异常）**——测试失败信息通常在输出尾部，只保留 Head 不满足本条；截断点必须落在 UTF-8 字符边界；
2. **溢出落盘转储 (Spill to Artifacts)**：每个流从第一个字节起流式追加写入受管 artifacts 文件，操作完成前必须 `fsync` 刷盘；发生截断时在结果中登记逐流 `*Ref` 与**对落盘内容**计算的 `*Hash`。既严守内存上限，又完整留存 50MB+ 诊断证据；未截断的转储文件可在结清时删除；
   - **转储失败必须可见**：打开、写入或刷盘任一步失败，记录 `spillError`，且不得返回对应 `*Ref`；
   - **产物回收**：内核提供 `pruneArtifacts(filter)` 原语，拒绝回收仍被未终结 / 未裁决操作引用的产物，保留策略由发行版决定；
3. **防内核管道死锁排空泵**：即便发生截断或写盘，**必须持续监听并在底层消费 `stream.on('data')`**，严防 OS 内核管道缓冲区（常见 64KB）被塞满导致子进程永久挂起；
4. **排空超时守护**：等待 stdio 关闭设置有界超时（默认 2000ms），超时后强制截断结清，防止持有着 stdout/stderr 句柄的僵尸进程导致主进程事件循环无限等待；
5. **域级缓冲总量守卫**：执行域内所有活跃操作的内存缓冲总和设置上限（默认 200MB）。当全域累积缓冲达到阈值时，新操作准入排队，防止突发并发操作各自 10MB 击穿宿主 Node 进程。

### 4.4 资源治理体系与平台适配矩阵 (Resource Governance & Platform Containment)

将资源治理提升为与进程监督对等的第一公民，构建“操作预算 + 域级配额 + 平台驱动隔离”三层防护网。

#### 4.4.1 三级 Enforcement 执行语义

| 治理级别 | 核心语义 | 底层兑现与执行路径 |
|---|---|---|
| **`observe`** | 只观测采样，不干预执行 | 驱动周期采样进程树 RSS / CPU，写入结果元数据；超限不打断 |
| **`soft`** | 发现超限触发优雅停止流水线 | 监测循环核对预算，超限后状态转为 `stopping`，进入标准停止流水线，终止原因为对应 `_exceeded` |
| **`hard`** | 操作系统底层物理强力阻止超限 | 依赖 OS 内核机制（Linux cgroup v2 / Windows Job Object）封顶；**驱动若不支持 hard，准入期直接拒绝** |

#### 4.4.2 准入期能力强校验 (Pre-admission Capability Check)
- 校验时机提前至 `intent_registered` 事务提交之前；
- 若操作声明了 `enforcement: 'hard'`（如硬内存预算），但当前平台驱动声明 `capabilities.memoryHardLimit === false`，内核**必须直接抛出 `UnsupportedCapabilityError` 拒绝受理**；
- **禁止静默降级**：绝不允许为了表面成功而把 `hard` 偷偷降级成 `observe` 或 `soft` 假装支持。

#### 4.4.3 域级配额与并发排队 (Domain Budget & Admission Queue)
单个操作设限无法防止整机 OOM（例如 10 个操作各要 1GB 内存）。执行域在 SQLite 中维系域级资源总水位：
```text
domainBudget = {
  maxTotalMemoryBytes: 4096 * 1024 * 1024, // 4GB 域内存预算
  maxConcurrentOps: 8,                      // 最大并发受管进程数
  maxTotalOutputBytes: 500 * 1024 * 1024    // 500MB 全域输出落盘上限
}

准入检查：
  activeOpsBudgetSum + newOp.resourceBudget <= domainBudget
  ├── 满足 -> 登记进入 intent_registered，分配配额
  └── 超标 -> 新操作保持 pending 状态排入执行域等待队列，等待已有租约结清
```
- **计数口径**：每个未终结 Operation 都计入 `maxConcurrentOps`，与其是否申请资源无关（不申请资源的操作不得绕过并发上限）；
- **排队语义**：等待队列按登记顺序 FIFO 放行，并对每个等待者给出持有者与已等待时长诊断；禁止靠轮询竞争决定先后；
- **配额持久化**：域级预算本身写入 `domain.db`（而非仅存于宿主内存），单操作占用记录在 `resource_leases` 的 `budget` 列中；
- 发生掉电或重启时，恢复引擎在加载未终结操作时自动还原已占用的域配额水位，无需额外恢复机制。

#### 4.4.4 三大主流操作系统平台落地实践

> **核心原则：诚实声明，绝不承诺底层给不了的能力。**

| 操作系统平台 | hard 内存/CPU/PIDs 限制 | 整组终止与逃逸防护 | v1 落地与交付策略 |
|---|---|---|---|
| **Linux** | **cgroup v2 统一治理**：<br>• `memory.max`（硬限 OOM kill）<br>• `memory.high`（软节流）<br>• `pids.max`（防 fork 炸弹）<br>• `cpu.max`（CPU 配额） | **`cgroup.kill`**：<br>内核级原子终止整组，成员枚举天然完备，从根源杜绝逃逸后代 | **双轨实现**：<br>1. 优先调用 `systemd-run --user --scope -p MemoryMax=...`（免 root 优雅建组）；<br>2. 无 systemd 用户会话时降级写入委派子树 cgroupfs；<br>3. 均不可用时 `memoryHardLimit` 诚实声明为 `false` |
| **macOS** | **无原生等价进程树硬限**：<br>`setrlimit` 仅限单进程，无法约束衍生子进程树 | **PGID 进程组终止**：<br>依赖 `kill(-pgid, signal)` 广播 | **诚实声明**：<br>• 支持 `observe` + `soft` + PGID kill；<br>• `memoryHardLimit` 显式声明为 `false`；<br>• 可选通过 `sandbox-exec` 做文件/网络策略约束，但绝不包装成假内存硬限制 |
| **Windows** | **Job Object 容器**：<br>• `JOB_OBJECT_LIMIT_JOB_MEMORY`<br>• `ACTIVE_PROCESS`<br>• `KILL_ON_JOB_CLOSE` | **`TerminateJobObject`**：<br>句柄关联的所有进程整组原子退出 | **Rust 核心直接调用 Win32 Job API**：<br>• `CREATE_SUSPENDED` + 关联 Job + `ResumeThread` 同时兑现受控启动与整组容器；<br>• 0.1.x TypeScript 实现不支持 Windows，如实声明 `processGroupKill: false` |

#### 4.4.5 内核自保工程守则 (Kernel Self-Preservation)
1. **发行版宿主防爆**：嵌入宿主为 Node 时，CLI 启动脚本与发行版部署默认显式配置 `--max-old-space-size=4096`；
2. **事件批量入库**：高频流式输出与进度事件汇聚成批量事务入 SQLite，避免每次字符写入触发文件系统 fsync；
3. **零字符串无限拼接**：内部传输一律使用定长 Buffer 与流式管道，禁止在主事件循环中做巨量字符串 `+` 操作；
4. **不阻塞宿主**：进程树扫描、资源采样、磁盘转储不得在宿主事件循环 / 调用线程上同步执行；全域共享一个采样器（每个采样周期对所有活跃操作只读一次进程表），禁止每操作各自高频拉取全量进程表。

---

## 5. 部署形态、协议与 ABI（目标态）

### 5.1 两种部署模式

| 维度 | 嵌入模式 (Embedded) | daemon 模式 |
|---|---|---|
| 域所有者 | 宿主进程 | 工作区级常驻 `xioflowd` 进程 |
| 传输 | 进程内调用（语言绑定：napi-rs / PyO3） | Unix domain socket（`<domain>/kernel.sock`）/ Windows named pipe |
| 客户端数 | 1 | 多个（不同框架、不同语言、多个 agent） |
| 崩溃恢复 | 宿主重启后显式调用 `recovery.run` | daemon 启动时自动执行，结果可经 `recovery.lastReport` 查询 |
| 适用 | 单 agent CLI、测试、CI 单任务 | 多 agent 并行同一工作区、多个框架共存 |

两种模式使用同一套消息形状与同一份 conformance 契约；嵌入绑定只是「进程内传输」。

### 5.2 协议
- **编码**：JSON-RPC 2.0；请求与结果的字段形状即 §2 / §4 定义的类型；
- **握手**：`kernel.hello { protocolVersion, client: { name, version }, observer?: boolean }` → 返回内核版本、协议版本、schema 版本、驱动能力（`PlatformCapabilities`、快照 / 写入限制驱动列表）与 conformance 等级；
- **方法（v1 草案）**：

  | 方法 | 语义 | Observer 可用 |
  |---|---|---|
  | `domain.status` | 域所有者、epoch、活跃操作、租约、未裁决 indeterminate | 是 |
  | `task.save` / `run.open` | 登记 Task 与 Run | 否 |
  | `run.reportSucceeded` / `run.reportFailed` | §3.3 Run 完成协议 | 否 |
  | `op.execProcess` | §3.1 启动协议；参数含 `mutationRoots`、`snapshotBefore`、`confine` | 否 |
  | `op.cancel` | §4.2 停止流水线 | 否 |
  | `op.adjudicate` | §3.6 人工裁决 | 否 |
  | `snapshot.capture` / `snapshot.rollback` / `snapshot.prune` | §3.5 | 否 |
  | `artifacts.read` / `artifacts.prune` | 按引用分段读取转储产物 / 回收 | 读：是 |
  | `recovery.run` / `recovery.lastReport` | §3.2 恢复协议 | 读报告：是 |
  | `journal.read` / `journal.subscribe` | 按序号读取 / 订阅事件 | 是 |

- **通知**：`op.chunk`（实时输出投影）、`op.result`、`journal.event`。`op.chunk` 是尽力而为的投影，可因背压丢弃且必须报告丢弃计数；**事实只来自 `op.result` 与 journal**，完整输出以转储产物为准，丢弃投影永远不丢失事实。

### 5.3 客户端、所有权与断连
- 每个连接的 `client.name` 记录为其 Run 的 `owner`；租约仲裁跨客户端生效；
- **客户端断连**：该客户端发起、仍在运行的操作在 `clientGraceMs` 后以 `terminationReason: 'client_lost'` 进入停止流水线；登记为 `detached: true` 的操作除外（其结果保留供后续查询）；
- **Observer 连接**：只读事务、不持有租约、不写入任何状态，满足 §0.2 裁决 1 的只读观察者要求；
- **本机边界**：socket 文件权限 `0600`，并以对端凭据（`SO_PEERCRED` / `getpeereid` / named pipe 客户端 SID）校验同一用户；不监听任何网络端口（§8）。

### 5.4 版本与兼容
- `protocolVersion`、`domain.db` 的 `user_version`、conformance 等级三者各自按 SemVer 演进，与语言包版本解耦；
- daemon 至少同时支持当前与上一个协议主版本，客户端握手时协商；协商失败返回显式错误而不是降级运行；
- 语言绑定的公开 API 可以有语言惯用写法，但语义必须一一映射到协议方法，且通过同一 conformance 套件。

---

## 6. 发行版装配与 xiocode 编程工作流

xiocode 作为编程发行版（第一个、但不应是唯一的发行版），经 §5 协议 / 语言绑定装配具体工作流组件与编程工具：

```text
xiocode 发行版
 ├── 默认工作流组件 (ThreePieceWorkflowComponent)
 │    ├── 管理 .xioflow/tasks/<task-id>/ 三件套 Markdown (PRD / Todo / Verification)
 │    └── 维护业务状态机 (Draft -> Ready -> In Progress -> Verified -> Archived)
 ├── 编程乐高积木
 │    ├── ExactReplaceEditStrategy: 精确子串匹配，保留原文件换行符格式，未命中严格抛错
 │    ├── RuleSpecInjector: 扫描 .xioflow/spec/ 规约注入上下文
 │    ├── KernelTools: 将工具请求转为内核 Operation
 │    └── SafetyInterceptor: 高危操作拦截与人工确认
 └── 终端运行环境
      ├── 极简 Agent Loop (Pi 范式)
      └── 命令行 CLI (xio task / xio run)
```

### 换行符严格保真原则
`ExactReplaceEditStrategy` 在做子串匹配时，内部逻辑可将 CRLF 与 LF 统一解析比对；但**写回文件时必须遵循原文件的原有换行符格式**，严禁在无意中将整个文件的所有行批量变更为另一种换行符，避免污染 Git Diff。

---

## 7. 跨实现一致性契约 (Conformance Suite)

契约是 ABI 的一部分（§0.2 裁决 5）：它证明的是**执行事实**，而不是某个实现的内部结构。

### 7.1 形式与等级
- **黑盒驱动**：套件通过 §5 协议驱动被测实现（嵌入绑定经一个 stdio 适配器暴露同一协议），只断言返回的事实 JSON 与 journal 事件，不读取实现内部状态；
- **固定夹具**：进程行为由独立的夹具程序 `xf-fixture` 产生（子命令如 `spawn-tree`、`escape-setsid`、`flood-output`、`hold-pipe-after-exit`、`ignore-signals`、`write-files`），保证各语言实现面对的是同一批进程行为；
- **等级**：
  | 等级 | 覆盖 | 通过要求 |
  |---|---|---|
  | **L1 进程监督** | 启动、停止、输出、配额 | 全部通过 |
  | **L2 恢复与所有权** | 崩溃恢复、身份核验、epoch、裁决、schema | 全部通过 |
  | **L3 快照与回滚** | §3.5 与覆盖声明 | 声明支持快照的实现全部通过 |
  | **L4 多客户端** | §5 daemon 模式 | 声明支持 daemon 的实现全部通过 |
  | **H 平台硬限制** | cgroup / Job Object | 按能力门控 |
- **能力门控**：驱动未声明的能力对应条目必须报告为 `unsupported`（附能力名），**不得计为通过**，也不得静默跳过。

### 7.2 契约清单

状态列：`S<n>` 表示已在 0.1.x 共享套件（`@xioflow/kernel/testing`，18 项）中以第 n 项实现；`R` 表示仅在内核仓自身测试中实现、待提升进共享套件；`计划` 表示尚未实现（落地阶段见 `ROADMAP.md`）。

| # | 等级 | 契约 | 状态 |
|---|---|---|---|
| 1 | L1 | 错误命令启动立即显式失败，绝不产生假 running，`spawnFailure` 与退出码 127 可区分 | S1 |
| 2 | L1 | 大输出有界排空：50MB 输出顺畅退出，逐流标记截断 | S2 |
| 3 | L1 | 内存保留 Head + Tail，截断点落在 UTF-8 边界 | 计划 |
| 4 | L1 | 50MB 输出完整转储：`fsync`，引用与对落盘内容计算的哈希可独立校验 | S15 |
| 5 | L1 | 转储失败可见：`spillError` 出现时不返回引用 | 计划 |
| 6 | L1 | 未确认停止保留租约：停止未确认前排他资源不释放 | S3 |
| 7 | L1 | 资源冲突可诊断，FIFO 排队放行 | S4（FIFO 计划） |
| 8 | L1 | 整组终止可靠收敛：5 个孙进程随整组停止 | S9 |
| 9 | L1 | 逃逸后代诚实上报：`setsid` 残留进程 ⇒ `residualPids`，禁止 `confirmed_stopped` | S10 |
| 10 | L1 | 根进程退出后仍持有管道的后代被回收，保留真实退出事实 | S17 |
| 11 | L1 | 超时 + 逃逸后代：操作在有界时间内返回 `indeterminate`，不挂到逃逸进程退出 | 计划 |
| 12 | L1 | 停止不存在 / 已终结的操作返回显式错误 | 计划 |
| 13 | L1 | 域级并发上限：超标排队、释放后放行；不申请资源的操作同样计入 `maxConcurrentOps` | S14（无资源计数：计划） |
| 14 | L1 | stdin 一次性管道：完整透传后关闭，EPIPE 不是启动失败 | S16 |
| 15 | L1 | 流式投影：chunk 按流转发，回调抛错或丢弃不影响事实 | S18 |
| 16 | L1 | 平台能力缺失与 Hard 请求在准入期显式拒绝 | S7、S13 |
| 17 | L1 | 工作流无感替换：三件套 / 纯内存工作流下状态跃迁与事件时序一致 | S8 |
| 18 | L2 | 不确定副作用防重放：`indeterminate` 恢复时不自动重试 | S5 |
| 19 | L2 | 崩溃可靠恢复：已提交事实与 epoch 重启后完整重现 | S6 |
| 20 | L2 | Epoch 栅栏：旧所有者复活写入被拒绝 | S11 |
| 21 | L2 | Run 完成协议：未完成或不确定操作阻断 Run 成功 | S12 |
| 22 | L2 | 僵尸 leader + 存活后代：恢复按组清场后才结清 | R |
| 23 | L2 | PID 复用不误判：无关同名进程占用原 PID 时不得判为原进程、不得被终止 | 计划 |
| 24 | L2 | 身份登记前崩溃：受控启动下不会执行；非受控启动下存在匹配进程则 `indeterminate` 且保留租约 | 计划 |
| 25 | L2 | 恢复后 Run 状态收敛，不停留在 running | 计划 |
| 26 | L2 | 人工裁决：唯一出口、写 journal、受 epoch 栅栏约束、残留存活时拒绝 `confirmed_stopped` | 计划 |
| 27 | L2 | Schema 版本：旧版本显式迁移，新版本拒绝打开 | 计划 |
| 28 | L3 | 回滚后指纹核验：`restored` / `partial` / `failed` 如实区分 | 计划 |
| 29 | L3 | 无写入限制时回滚 `coverage` 不得为 `complete`，`outOfScopeEffects = 'possible'` | 计划 |
| 30 | L3 | 回滚与目标根目录上的活跃 / 未裁决操作互斥 | 计划 |
| 31 | L3 | 回滚中途崩溃：恢复按指纹判定 restored 或 indeterminate | 计划 |
| 32 | L3 | `git-shadow` 快照不改动用户 index、HEAD 与分支，并如实声明 `worktree_non_ignored` | 计划 |
| 33 | L4 | 两个客户端申请同一资源互斥，诊断信息指向对方客户端 | 计划 |
| 34 | L4 | 嵌入方遇到 daemon 持有的域必须以客户端接入，不得抢锁或另开影子域 | 计划 |
| 35 | L4 | Observer 连接只读、不持有租约、不打断所有者 | 计划 |
| 36 | L4 | 客户端断连：其操作在宽限后以 `client_lost` 进入停止流水线（`detached` 除外） | 计划 |
| 37 | H | 硬内存限制（Linux cgroup `memory.max` / Windows Job）生效并记录 `memory_exceeded` | 计划 |
| 38 | H | 进程数上限（`pids.max` / Job `ACTIVE_PROCESS`）拦截 fork 炸弹，宿主不受影响 | 计划 |
| 39 | H | 域级内存总额度：占满后新操作排队，释放后按序放行 | 计划 |

---

## 8. 明确不做的边界声明 (Explicit Non-Goals)

为防范投机性抽象与无界范围膨胀，明确保留以下设计边界：
1. **不做安全沙箱 (Firecracker / microVM / 对抗性隔离)**：xioflow 信任由受管组件与用户授权启动的开发工具，聚焦于进程治理与失控遏制，不承担防御恶意逃逸的职责。§0.2 裁决 4 的写入限制驱动只服务于回滚正确性，任何文档与 API 都不得把它宣传为安全边界；
2. **不做 IO 频次限制、网络访问策略与 GPU 配额**：核心痛点在于内存爆仓、孤儿进程与失控死循环，无真实业务驱动不预先引入复杂的网络与 GPU 编排器；
3. **不做 agent 调度与组件模型**：内核只提供执行原语（§0.0），不管理 agent / turn 的优先级、抢占与编排，不提供插件生命周期；这些属于发行版；
4. **不管理 LLM 调用、提示词与模型成本**：它们不是本地执行事实，属于发行版；
5. **不做跨机分布式调度、远程执行后端与网络监听**：专注于工作区级单机执行域；daemon 只监听本机 IPC 端点；
6. **不做 eBPF 探针注入**：常规开发机器不具备 root/CAP_SYS_ADMIN 权限，进程表与 `/proc` 采样足以满足开发期可观测性。
