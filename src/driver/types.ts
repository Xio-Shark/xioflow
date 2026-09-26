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
}

export interface ProcessIdentity {
  pid: number;
  pgid?: number;
  startTimeMonotonic?: number; // 纳秒/微秒级时钟
  spawnTime: string;
  commandFingerprint?: string;
  bootId?: string;             // 宿主启动标识（Linux /proc/sys/kernel/random/boot_id 等），跨重启判等；0.2.0 起在 spawn 登记时写入
}

export type StopProcessStatus = 'confirmed_stopped' | 'not_stopped' | 'cannot_determine';

export interface StopProcessResult {
  stopped: StopProcessStatus;       // 是否确认完全停止 (0.2.0 三态化)
  scope: 'direct_child' | 'process_group' | 'containment_cgroup' | 'unknown';
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
  descendantEnumeration: 'full' | 'cgroup' | 'none'; // 后代枚举与逃逸检测能力
  gatedSpawn?: boolean;            // 是否支持门管道受控启动 (0.2.0 P0-3)
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
