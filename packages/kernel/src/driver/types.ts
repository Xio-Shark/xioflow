import { IdentityVerificationResult } from '../types.js';

export interface StructuredCommand {
  execPath: string;
  args: string[];
  cwd: string;
  envWhiteList?: Record<string, string>;
}

export interface ProcessIdentity {
  pid: number;
  startTimeMonotonic?: number; // 纳秒/微秒级时钟
  spawnTime: string;
}

export interface StopProcessResult {
  stopped: boolean;                // 是否确认完全停止
  scope: 'direct_child' | 'process_group' | 'unknown';
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

export interface PlatformDriver {
  name: string;
  capabilities: {
    processGroupKill: boolean;     // 是否支持杀死整个进程组 (PGID)
    accurateStartTime: boolean;    // 是否支持微秒级系统进程创建时钟核验
  };
  spawn(command: StructuredCommand): Promise<ManagedProcessHandle>;
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
}
