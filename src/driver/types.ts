import { IdentityVerificationResult, ResourceBudget } from '../types.js';

export interface StructuredCommand {
  execPath: string;
  args: string[];
  cwd: string;
  envWhiteList?: Record<string, string>;
}

export interface ProcessIdentity {
  pid: number;
  pgid?: number;
  startTimeMonotonic?: number; // 纳秒/微秒级时钟
  spawnTime: string;
  commandFingerprint?: string;
}

export interface StopProcessResult {
  stopped: boolean;                // 是否确认完全停止
  scope: 'direct_child' | 'process_group' | 'containment_cgroup' | 'unknown';
  residualPids?: number[];         // 存疑的残留进程 PID
  errorDetails?: string;
}

export interface ManagedProcessHandle {
  identity: ProcessIdentity;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onExit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  rawProcess?: any;
}

export interface PlatformCapabilities {
  processGroupKill: boolean;       // 是否支持杀死整个进程组 (PGID)
  accurateStartTime: boolean;      // 是否支持微秒级系统进程创建时钟核验
  memoryHardLimit: boolean;        // 是否支持 OS 级硬内存限制 (Linux cgroup v2)
  pidsLimit: boolean;              // 是否支持后代进程总数限制
  cpuLimit: boolean;               // 是否支持 CPU 时间硬限制
  descendantEnumeration: 'full' | 'cgroup' | 'none'; // 后代枚举与逃逸检测能力
}

export interface PlatformDriver {
  name: string;
  capabilities: PlatformCapabilities;
  spawn(command: StructuredCommand): Promise<ManagedProcessHandle>;
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
  sampleMetrics?(identity: ProcessIdentity): Promise<{ rssBytes: number; pidsCount: number; cpuTimeMs: number }>;
}
