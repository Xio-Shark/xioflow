# xioflow 内核与 xiocode 发行版架构与协议规范

> **本文位置**：这是 xioflow 内核仓的权威协议规范。第 0–4、6–7 节为内核协议；第 5 节保留 xiocode 参考发行版的装配说明，用于界定内核边界。

> **状态**：正式实施基准规范（协议细化与事务可恢复版）  
> **核心定位**：  
> - **xioflow**：面向 Agent 应用的受监督执行内核。提供执行域管理、受监督操作、资源仲裁、停止确认、SQLite 事务持久化与崩溃恢复机制；无 UI 绑定，不绑定特定 Agent Loop 或文件格式。  
> - **xiocode**：基于 xioflow 装配的编程发行版。提供模型接入、编程工具、默认三件套工作流（PRD / Todo / Verification）、安全策略及 CLI/TUI。  
> **仓库分工**：xioflow 作为独立共享内核仓库/模块开发；xiocode 作为独立发行版仓库，通过公开导出接口消费内核。

---

## 0. 核心定位与设计决策

### 0.1 Linux 范式与边界划界

| 关注维度 | xioflow 内核负责 | xiocode 等发行版负责 |
|---|---|---|
| **管理范围** | 执行域（Execution Domain）生命周期、域内唯一所有者 | 决定按工作区、按项目还是按会话绑定执行域 |
| **任务执行** | Run 尝试分配、执行状态跟踪、受管 Operation 归属 | 怎样拆分任务、采用何种业务工作流与工件 |
| **并发编排** | 资源配额仲裁、等待依赖、取消作用域 | 串行队列、DAG 拓扑、并行候选等具体编排算法 |
| **进程管理** | 平台驱动抽象、监督协议、停止确认、事实记录 | 选择要运行的工具、传递何种命令与参数 |
| **权限安全** | 按授权范围检查受管操作，审计记录决策事实 | 人工交互提问、风险分级与交互策略配置 |
| **验证判定** | 保存可信执行事实（状态、输出证据、产物引用） | 判定什么测试输出算业务验收通过 |
| **崩溃恢复** | 启动前现场重建、冲突资源隔离、Journal 事务恢复 | 决策哪些失败允许修复、重试或重新规划 |
| **模型上下文** | 完全不处理模型上下文、自然语言与提示词 | 提示词片段拼装、规约按需注入、会话裁剪 |
| **界面与工件** | 零 UI 依赖、不强制任何特定 Markdown 文件 | CLI、TUI、三件套文档及其他呈现形式 |

### 0.2 两项核心架构裁决

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
│   └── journal_events (带单调自增序号的事件日志)                         │
│                                                                        │
│   WAL 模式 + PRAGMA synchronous = FULL / macOS F_FULLFSYNC             │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 三种持久化保证的明确界定
1. **控制事实持久化**：已确认提交的 Run 状态、Operation 启动意图、授权决策与结果，在事务提交（`commit`）后经 `FULL` 刷盘保证，掉电后 100% 可恢复；
2. **受管产物持久化**：内核确认“产物已保存”前，产物驱动必须调用 `fsync` 完成物理刷盘，而非仅仅返回路径；
3. **外部副作用状态**：外部 Shell 命令执行、远程 API 调用无法纳入本地 DB 事务。内核在外部调用前后设置**前置意图登记**与**后置结果核验**窗口，不确定现场强制进入恢复流水线。

> **掉电保证承诺边界**：在声明支持的本地文件系统（如 APFS、ext4）和正确履行同步语义的硬件存储设备上，保证已确认提交的内核事实及受管产物可恢复；不包含物理硬件损毁或设备虚报刷盘完成。

---

## 2. 核心领域模型与实体契约 (TypeScript)

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
  | 'output_exceeded';             // 输出字节数硬截断

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
  kind: 'process' | 'filesystem' | 'gate' | 'custom';
  name: string;
  inputFingerprint: string;        // 输入与配置哈希指纹
  requiredResources: string[];     // 申请占用的资源（如 ["workspace:write:root"]）
  timeoutMs?: number;              // 挂钟运行超时
  resourceBudget?: ResourceBudget; // 显式声明的资源治理预算
  status: 'pending' | 'intent_registered' | 'active' | 'stopping' | 'done';
}

/**
 * 多态执行结果
 */
export type OperationResult =
  | ProcessOperationResult
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
  signal: NodeJS.Signals | null;
  stdout: string;                  // 内存保留的 head 截断或完整输出
  stderr: string;
  isTruncated: boolean;            // 标记输出是否达到有界上限被截断
  outputRef?: string;              // 溢出时完整流转储 (spill) 到 artifacts 的物理文件引用
  peakMemoryBytes?: number;        // 采样到的进程树内存峰值
  cpuTimeMs?: number;              // 消耗的 CPU 时间
  identityVerification: IdentityVerificationResult;
  stopVerification?: StopProcessResult; // 停止确认凭据
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

## 3. 四大核心运行协议 (Formal Protocols)

### 3.1 启动协议：先登记意图，再执行 (Intent-First Spawn Protocol)
杜绝“启动了进程却无记录”的崩溃盲区：

```text
1. [事务提交] 在 SQLite 中写入 Operation 意图、输入指纹与资源占用 (status: intent_registered)
   └── 崩溃判定：若此时崩溃，重启时发现此状态且无进程身份，安全清理资源，判定为未启动。
2. [驱动调用] 调用 PlatformDriver.spawn(command)
   └── 获得底层进程执行身份 ProcessIdentity (pid, startTimeMonotonic)
3. [事务提交] 更新 Operation 记录执行身份并推进为 'active' (status: active)
   └── 崩溃判定：若在此步之间崩溃，重启恢复时凭登记的输入意图与驱动比对，进入核验。
4. [正常监督] 挂载实时流排空泵、注册超时定时器与退出监听
5. [驱动终止] 进程结束或触发停止，驱动产出初步结果
6. [事务提交] 原子写入 OperationResult 并根据确认事实释放相关资源占用
```

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
   └── 核对受管文件修改现场（校验输入指纹与后置条件）
5. [开放安全操作] 仅对已确认没有资源冲突且与未终结操作无关的独立运行开放执行
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
  spawn(command: StructuredCommand, containment?: ContainmentSpec): Promise<ManagedProcessHandle>;
  /**
   * 基于单调时钟与指纹的多维进程身份核验 (防止 PID 环回复用)
   */
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  /**
   * 执行具备组级确认与逃逸扫描的终结流水线
   */
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
  /**
   * 周期采样进程树资源指标 (用于 observe/soft 治理)
   */
  sampleMetrics?(identity: ProcessIdentity): Promise<ProcessTreeMetrics>;
}

export interface PlatformCapabilities {
  processGroupKill: boolean;         // 是否支持整组终止 (-pgid / TerminateJobObject / cgroup.kill)
  accurateStartTime: boolean;        // 是否支持微秒级系统进程创建时钟核验
  memoryHardLimit: boolean;          // 是否支持 OS 级硬内存限制 (Linux cgroup v2 memory.max)
  pidsLimit: boolean;                // 是否支持后代进程总数限制 (cgroup pids.max)
  cpuLimit: boolean;                 // 是否支持 CPU 时间硬限制 (cgroup cpu.max)
  descendantEnumeration: 'full' | 'cgroup' | 'none'; // 后代枚举与逃逸检测能力
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
  args: string[];
  cwd: string;
  envWhiteList?: Record<string, string>; // 严格白名单环境变量，绝不落盘全量 env
}

export interface ProcessIdentity {
  pid: number;
  pgid?: number;                     // POSIX 进程组 ID —— spawn 时用 detached: true 建组
  jobId?: string;                    // Windows Job Object 句柄标识
  cgroupPath?: string;               // Linux cgroup v2 路径
  startTimeMonotonic?: number;       // 单调系统启动时间戳
  spawnTime: string;                 // ISO8601
  commandFingerprint: string;        // execPath + args 哈希，辅助多维核验
}

export interface StopProcessResult {
  stopped: 'confirmed_stopped' | 'not_stopped' | 'cannot_determine'; // 停止三态收敛
  scope: 'direct_child' | 'process_group' | 'containment_cgroup' | 'unknown';
  residualPids?: number[];           // 逃逸后代或存疑残留进程 PID 列表
  errorDetails?: string;
}

export interface ProcessTreeMetrics {
  rssBytes: number;                  // 进程树物理内存 (Resident Set Size)
  pidsCount: number;                 // 后代存活进程数
  cpuTimeMs: number;                 // 用户态+内核态 CPU 耗时
}
```

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
1. **内存缓冲封顶**：单操作内存保留上限默认 10MB。超出后置位 `isTruncated = true`，停止向内存累加，但在内存中保留 **Head（前置概览）+ Tail（最新异常）**；
2. **溢出落盘转储 (Spill to Artifacts)**：超出内存阈值的输出数据，后台泵持续以流式追加写入受管 artifacts 临时文件，操作完成前必须调用 `fsync` 刷盘，并在结果中登记 `outputRef` 产物哈希与物理路径。既严守内存上限，又 100% 完整留存 50MB+ 崩溃日志或诊断证据；
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
- 配额记录持久化在 `resource_leases` 的 `budget` 列中；
- 发生掉电或重启时，恢复引擎在加载未终结操作时自动还原已占用的域配额水位，无需额外恢复机制。

#### 4.4.4 三大主流操作系统平台落地实践

> **核心原则：诚实声明，绝不承诺底层给不了的能力。**

| 操作系统平台 | hard 内存/CPU/PIDs 限制 | 整组终止与逃逸防护 | v1 落地与交付策略 |
|---|---|---|---|
| **Linux** | **cgroup v2 统一治理**：<br>• `memory.max`（硬限 OOM kill）<br>• `memory.high`（软节流）<br>• `pids.max`（防 fork 炸弹）<br>• `cpu.max`（CPU 配额） | **`cgroup.kill`**：<br>内核级原子终止整组，成员枚举天然完备，从根源杜绝逃逸后代 | **双轨实现**：<br>1. 优先调用 `systemd-run --user --scope -p MemoryMax=...`（免 root 优雅建组）；<br>2. 无 systemd 用户会话时降级写入委派子树 cgroupfs；<br>3. 均不可用时 `memoryHardLimit` 诚实声明为 `false` |
| **macOS** | **无原生等价进程树硬限**：<br>`setrlimit` 仅限单进程，无法约束衍生子进程树 | **PGID 进程组终止**：<br>依赖 `kill(-pgid, signal)` 广播 | **诚实声明**：<br>• 支持 `observe` + `soft` + PGID kill；<br>• `memoryHardLimit` 显式声明为 `false`；<br>• 可选通过 `sandbox-exec` 做文件/网络策略约束，但绝不包装成假内存硬限制 |
| **Windows** | **Job Object 容器**：<br>• `JOB_OBJECT_LIMIT_JOB_MEMORY`<br>• `ACTIVE_PROCESS`<br>• `KILL_ON_JOB_CLOSE` | **`TerminateJobObject`**：<br>句柄关联的所有进程整组原子退出 | **阶段落地**：<br>• Node.js 运行时未暴露 Win32 Job API，v1 采用小型独立 helper 宿主管理进程；<br>• helper 缺省时先降级为 observe-only，原生 C++ Addon 后置 |

#### 4.4.5 内核自保工程守则 (Kernel Self-Preservation)
1. **发行版宿主防爆**：CLI 启动脚本与发行版 Node 部署默认显式配置 `--max-old-space-size=4096`；
2. **事件批量入库**：高频流式输出与进度事件汇聚成批量事务入 SQLite，避免每次字符写入触发文件系统 fsync；
3. **零字符串无限拼接**：内部传输一律使用定长 Buffer 与流式管道，禁止在主事件循环中做巨量字符串 `+` 操作。

---

## 5. 发行版装配与 xiocode 编程工作流

xiocode 作为编程发行版，装配具体工作流组件与编程工具：

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

## 6. 十五项跨装配一致性契约测试 (Universal Contract Tests)

为严格证明 xioflow 共享内核的独立性与可靠性，项目实现**无头 API 消费者**与**xiocode 发行版**共同运行的 16 项一致性契约测试：

### 进程监督与基础恢复 (1–8)
1. **错误命令启动**：启动不存在的程序立即返回失败，绝不产生假运行状态（No Fake Running）；
2. **大输出有界排空**：产生 50MB 日志子进程顺畅退出，缓冲区排空，标记 `isTruncated: true`；
3. **未确认停止锁保留**：进程处于 `stopping` 未确认退出时，其申请的排他资源绝对不被释放；
4. **资源冲突可诊断**：两个 Operation 争抢同一资源，后发起者排队并输出持有者与等待时长诊断；
5. **不确定副作用防重放**：`indeterminate` 状态的操作在启动恢复时阻断自动重试，强制等待人工处理；
6. **崩溃可靠恢复**：模拟掉电崩溃，已提交 SQLite 事务的事实在重启后 100% 完整重现；
7. **平台驱动能力缺失显式失败**：不支持的平台驱动能力显式暴露，绝不静默降级或伪造成功；
8. **工作流无感替换**：将三件套 Markdown 工作流替换为纯内存工作流，内核的 `KernelRunStatus` 状态跃迁规则与事件时序逻辑完全一致；

### 资源治理与整组遏制 (9–15)
9. **整组终止可靠收敛**：受管进程 fork 出 5 个孙子进程，触发取消后向 `-pgid`（或 cgroup）发信号，驱动轮询核验组状态直至 `ESRCH`，确认整组完全停止；
10. **逃逸后代诚实上报**：孙进程调用 `setsid()` 脱离原有 PGID，终止流水线后代扫描发现残留孤儿，结果如实标注 `residualPids` 与 `stopped: 'cannot_determine'`，禁止上报 `confirmed_stopped`；
11. **硬内存限制生效 (Linux cgroup)**：在 `memory.max = 100MB` 下运行内存泄漏程序，验证被内核 OOM Killer 终止，记录 `terminationReason: 'memory_exceeded'` 与 cgroup 事件；
12. **进程数量上限生效**：在 `pids.max = 20` 限制下执行 fork 炸弹，验证后续进程创建失败被拦截，宿主不受影响；
13. **Hard 请求遇不支持平台准入拒绝**：在不支持硬内存限制的环境申请 `enforcement: 'hard'`，准入检查阶段即刻拦截并抛出 `UnsupportedCapabilityError`，严禁欺瞒降级；
14. **域级总额度排队**：设置域总内存 200MB，当前活跃操作占满 200MB 时发起新操作，新操作进入队列排队，待前者释放后自动按序放行；
15. **50MB 输出完整落盘转储**：大输出操作触发内存截断后，完整日志流可靠转储至 artifacts 物理文件，完成 `fsync` 且结果中的 `outputRef` 指纹与内容均可独立校验。

---

## 7. 明确不做的边界声明 (Explicit Non-Goals)

为防范投机性抽象与无界范围膨胀，v1 阶段明确保留以下设计边界：
1. **不做微虚拟机/底层沙箱隔离 (Firecracker / bubblewrap 深度定制)**：xioflow 信任由受管组件与用户授权启动的开发工具，聚焦于进程治理与失控遏制，不承担防御对抗性恶意逃逸虚拟化的职责；
2. **不做 IO 频次限制、网络访问策略与 GPU 配额**：核心痛点在于内存爆仓、孤儿进程与失控死循环，无真实业务驱动不预先引入复杂的网络与 GPU 编排器；
3. **不做 Windows Job Object 原生 C++ Addon**：前期以跨平台 PGID 与独立 helper 进程推进，避免引入复杂的 node-gyp 编译链分发阻碍；
4. **不做跨机分布式调度与异构集群仲裁**：专注于工作区级单机单执行域的高可靠性与确定性恢复；
5. **不做 eBPF 探针注入**：常规开发机器不具备 root/CAP_SYS_ADMIN 权限，进程树与 `/proc` 采样足以满足开发期可观测性。
