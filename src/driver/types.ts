import { IdentityVerificationResult, ResourceBudget } from '../types.js';

export interface StructuredCommand {
  execPath: string;
  args: string[];
  cwd: string;
  /**
   * 一次性 stdin 管道内容：提供时创建 stdin 管道，写入后立即关闭。
   * 子进程提前退出导致的 EPIPE 不是启动失败，由退出码体现。
   */
  stdin?: string | Uint8Array;
  /**
   * stdin 模式：
   * - 'once'（默认）：提供 stdin 时写入后立即关闭管道
   * - 'stream'：保持 stdin 管道开放供调用方持续写入，由 ManagedProcessHandle.stdin 暴露
   */
  stdinMode?: 'once' | 'stream';
  /**
   * 显式环境变量白名单：提供时按原样使用，绝不注入宿主 PATH。
   * 需要 PATH 时请自行放入白名单（发行版通常有更严格的密钥剔除策略）。
   */
  envWhiteList?: Record<string, string>;
  /**
   * 未提供 envWhiteList 时是否继承宿主 process.env，默认 true。
   * 设为 false 时子进程得到空环境（故障关闭，适合安全敏感调用方）。
   */
  inheritEnv?: boolean;
  /**
   * OS 级硬限制（仅在 `resourceBudget.enforcement: 'hard'` 且驱动声明了对应能力时由监督器填写）。
   * 驱动必须在进程能够 fork 之前施加，否则显式拒绝启动。
   */
  hardLimits?: { memoryMaxBytes?: number; pidsMax?: number };
}

export interface ProcessIdentity {
  pid: number;
  pgid?: number;
  startTimeMonotonic?: number; // 纳秒/微秒级时钟
  spawnTime: string;           // 宿主记录的 ISO8601 时刻，仅供展示，不作为身份证据（§4.1.1）
  /**
   * spawn 时从 OS 读取的进程创建时间（ISO8601，毫秒精度按平台来源而定）。
   * 跨重启身份核验的唯一肯定证据；读不到时缺省，核验如实返回 cannot_determine。
   */
  osStartTime?: string;
  commandFingerprint?: string; // sha256(JSON.stringify([execPath, ...args]))，仅作审计事实，不参与身份判定
  bootId?: string;             // 宿主启动标识（Linux /proc/sys/kernel/random/boot_id 等），跨重启判等；0.2.0 起在 spawn 登记时写入
  /**
   * 进程在放行前被放入的专属 cgroup（绝对路径，CgroupPlatformDriver）。整棵树无法逃出它，
   * 崩溃恢复据此判断树是否已空，不依赖 pid / pgid 复用核验。
   */
  cgroupPath?: string;
}

/**
 * 根进程自然退出、输出排空之后，进程树是否已空。
 * - `empty`：驱动能证明树已空（子收割者 ECHILD、cgroup populated 0）
 * - `residual`：已知仍有后代存活
 * - `unknown`：驱动无法回答（看不到换了进程组的逃逸者）
 */
export type TreeSettlement = 'empty' | 'residual' | 'unknown';

export type StopProcessStatus = 'confirmed_stopped' | 'not_stopped' | 'cannot_determine';

export interface StopProcessResult {
  stopped: StopProcessStatus;       // 是否确认完全停止 (0.2.0 三态化)
  /**
   * 确认停止的范围。`subreaper_tree`：Linux 子收割者下整棵子树（含 setsid / 双 fork 逃逸者）已空，
   * 由 waitpid ECHILD 证明；`tracked_tree`：macOS 上所有被跟踪到的后代（后代链、会话成员）均已消失。
   */
  scope: 'direct_child' | 'process_group' | 'containment_cgroup' | 'subreaper_tree' | 'tracked_tree' | 'unknown';
  // containment_cgroup：进程专属 cgroup 的 cgroup.events 报告 populated 0，整棵树（含逃逸者）已空
  residualPids?: number[];         // 存疑的残留进程 PID
  errorDetails?: string;
}

export interface ManagedProcessHandle {
  identity: ProcessIdentity;
  stdin?: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  /**
   * 根进程自身的退出事实，不等待仍持有管道的后代（onExit 的 close 语义会等）。
   * 未提供时监督器退化为 onExit。
   */
  onRootExit?: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  onExit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  rawProcess?: any;
  /**
   * 门管道受控启动控制 (P0-3)
   */
  releaseGate?: () => void;
  destroyGate?: () => void;
}

export interface PlatformCapabilities {
  processGroupKill: boolean;       // 是否支持杀死整个进程组 (PGID)
  accurateStartTime: boolean;      // 是否支持微秒级系统进程创建时钟核验 (兼容字段)
  startTimeSource?: 'procfs' | 'ps_lstart' | 'none'; // 真实时钟事实来源 (0.2.0 P0-1)
  memoryHardLimit: boolean;        // 是否支持 OS 级硬内存限制 (Linux cgroup v2)
  pidsLimit: boolean;              // 是否支持后代进程总数限制
  cpuLimit: boolean;               // 是否支持 CPU 时间硬限制
  descendantEnumeration: 'full' | 'cgroup' | 'subreaper' | 'none'; // 后代枚举与逃逸检测能力（subreaper：孤儿必然回到持有者，可证明树空）
  gatedSpawn?: boolean;            // 是否支持门管道受控启动 (0.2.0 P0-3)
  confinement?: string[];          // 支持的写入限制驱动名称列表 (契约 #56)
}

export interface PlatformDriver {
  name: string;
  capabilities: PlatformCapabilities;
  spawn(command: StructuredCommand): Promise<ManagedProcessHandle>;
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
  /**
   * 回收一个已经没有任何合法 owner 的进程组（崩溃恢复专用）。
   *
   * `terminate` 只在"原 leader 还在"时有意义；当 leader 已被 SIGKILL 成僵尸、
   * 组里却还有后代进程时，只有按 pgid 定向清场才能既确认结果又不留孤儿。
   * 可选实现：不支持进程组的平台可以不提供，恢复会如实报告未回收的残留进程。
   */
  terminateGroup?(pgid: number, graceMs: number): Promise<StopProcessResult>;
  /**
   * 根进程自然退出且输出排空后调用：最多等待 waitMs 让后代自行结束，再回答树是否已空。
   * 不提供时监督器按 `unknown` 处理（结果声明 `treeSettlement: 'unverified'`）。
   */
  settleTree?(identity: ProcessIdentity, waitMs: number): Promise<TreeSettlement>;
  /**
   * 硬限制命中事实（cgroup memory.events oom_kill、pids.events max）。没有专属 cgroup 的身份返回 null。
   */
  readLimitEvents?(identity: ProcessIdentity): Promise<{ memoryOomKills: number; pidsMaxHits: number } | null>;
  sampleMetrics?(identity: ProcessIdentity): Promise<{ rssBytes: number; pidsCount: number; cpuTimeMs: number }>;
  /**
   * 异步读取宿主启动唯一标识（N2 / 契约 #42）
   */
  readBootId?(): Promise<string | null>;
  /**
   * 异步读取指定进程组的所有成员与启动时间事实（N2 / 契约 #42）
   */
  getGroupEvidence?(pgid: number): Promise<{ pid: number; startTimeMs: number | null }[]>;
}
