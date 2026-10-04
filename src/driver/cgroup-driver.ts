import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ManagedProcessHandle,
  PlatformCapabilities,
  PlatformDriver,
  ProcessIdentity,
  StopProcessResult,
  StructuredCommand,
  TreeSettlement,
} from './types.js';
import { IdentityVerificationResult } from '../types.js';
import { NodePlatformDriver } from './node-driver.js';
import * as cg from './cgroup-fs.js';

type LimitEvents = { memoryOomKills: number; pidsMaxHits: number };

const HOST_LEAF = 'xioflow-host';
const OPS_DIR = 'xioflow-ops';
const LIMIT_CONTROLLERS = ['memory', 'pids'] as const;

/** 前提不满足（非 Linux、没有 cgroup v2、cgroup 未委派给宿主）：显式失败，从不静默退回别的驱动。 */
export class CgroupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CgroupUnavailableError';
  }
}

export interface CgroupDriverOptions {
  /**
   * 委派给宿主的 cgroup v2 目录，缺省为宿主进程自己所在的 cgroup。宿主必须位于它之内：
   * 迁移进程需要对源与目标的共同祖先的 `cgroup.procs` 有写权限。
   */
  root?: string;
}

/**
 * Linux cgroup v2 驱动：每个进程在门管道放行之前被放进专属 cgroup，任何 fork（含 setsid、双 fork）都留在里面。
 *
 * - 树是否已空由 `cgroup.events populated` 证明（scope `containment_cgroup`），停止以 `cgroup.kill` 收尾。
 * - `hard` 预算落到 `memory.max`（无 swap、OOM 杀整组）与 `pids.max`。
 * - cgroup 路径随身份在放行前落盘，崩溃恢复据此判断整棵树，pid 是否属于该 cgroup 即身份证据。
 *
 * 构造时把根 cgroup 里的进程移到 `xioflow-host` 叶子（cgroup v2 不允许有进程的 cgroup 向子 cgroup 分配控制器），
 * 再为 `xioflow-ops` 启用 memory / pids。控制器启用失败时如实不声明硬限制能力，原因见 `limitsUnavailableReason`。
 */
export class CgroupPlatformDriver implements PlatformDriver {
  public readonly name = 'cgroup';
  public readonly capabilities: PlatformCapabilities;
  public readonly root: string;
  public readonly opsDir: string;
  public readonly limitsUnavailableReason?: string;
  private readonly inner = new NodePlatformDriver();
  /** 带硬限制的 cgroup：删除前把限制命中事实留下，供结果读取。 */
  private readonly limitedDirs = new Set<string>();
  private readonly retiredLimitEvents = new Map<string, LimitEvents>();

  /** 不做任何修改地检查前提；可用时返回 null，否则返回原因。 */
  public static unavailableReason(options: CgroupDriverOptions = {}): string | null {
    try {
      resolveRoot(options);
      return null;
    } catch (err: any) {
      return err.message;
    }
  }

  constructor(options: CgroupDriverOptions = {}) {
    const { root, own } = resolveRoot(options);
    this.root = root;
    this.opsDir = path.join(root, OPS_DIR);
    if (own === root) moveRootProcessesToLeaf(root);
    fs.mkdirSync(this.opsDir, { recursive: true });
    const enabled = enableLimitControllers(root, this.opsDir);
    this.limitsUnavailableReason = enabled.reason;
    this.capabilities = {
      ...this.inner.capabilities,
      processGroupKill: true,
      gatedSpawn: true,
      memoryHardLimit: enabled.controllers.includes('memory'),
      pidsLimit: enabled.controllers.includes('pids'),
      cpuLimit: false,
      descendantEnumeration: 'cgroup',
    };
  }

  public async spawn(command: StructuredCommand): Promise<ManagedProcessHandle> {
    const handle = await this.inner.spawn(command);
    if (!handle.releaseGate) {
      handle.destroyGate?.();
      throw new Error('CgroupPlatformDriver requires gated spawn: the child must not run before it is placed');
    }
    // 子进程此刻阻塞在门上还没 exec，也就还不可能 fork：放进 cgroup 之后的一切后代都继承它
    const dir = path.join(this.opsDir, `op-${handle.identity.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(dir);
      if (command.hardLimits) this.applyLimits(dir, command.hardLimits);
      cg.writeFile(dir, 'cgroup.procs', String(handle.identity.pid));
    } catch (err: any) {
      handle.destroyGate?.();
      await Promise.race([handle.onExit.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      try {
        cg.removeCgroup(dir);
      } catch {}
      this.limitedDirs.delete(dir);
      throw new Error(`could not place process ${handle.identity.pid} into cgroup ${dir}: ${err.message}`);
    }
    return { ...handle, identity: { ...handle.identity, cgroupPath: dir } };
  }

  /** pid 仍在该操作专属的 cgroup 里就是原进程；cgroup 不存在或 pid 不在其中就不是。 */
  public async verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult> {
    if (!identity.cgroupPath) return this.inner.verifyIdentity(identity);
    try {
      const procs = await cg.readProcs(identity.cgroupPath);
      return procs.includes(identity.pid) ? 'is_original_process' : 'not_original_process';
    } catch {
      return 'cannot_determine';
    }
  }

  /** SIGINT（grace）→ SIGTERM（1s）→ cgroup.kill，以 populated 0 为停止证据。 */
  public async terminate(identity: ProcessIdentity, graceMs: number = 2000): Promise<StopProcessResult> {
    const dir = identity.cgroupPath;
    if (!dir) return this.inner.terminate(identity, graceMs);
    try {
      if (await cg.isPopulated(dir)) {
        await cg.signalProcs(dir, 'SIGINT');
        if (!(await cg.waitUnpopulated(dir, graceMs))) {
          await cg.signalProcs(dir, 'SIGTERM');
          if (!(await cg.waitUnpopulated(dir, 1000))) {
            cg.killAll(dir);
            if (!(await cg.waitUnpopulated(dir, 2000))) {
              const residualPids = await cg.readProcs(dir);
              return {
                stopped: 'cannot_determine',
                scope: 'unknown',
                residualPids,
                errorDetails: `cgroup ${dir} still populated after cgroup.kill: ${residualPids.join(', ')}`,
              };
            }
          }
        }
      }
    } catch (err: any) {
      return { stopped: 'cannot_determine', scope: 'unknown', errorDetails: `cgroup ${dir}: ${err.message}` };
    }
    const cleanupError = await this.retire(dir);
    return { stopped: 'confirmed_stopped', scope: 'containment_cgroup', ...(cleanupError ? { errorDetails: cleanupError } : {}) };
  }

  public async settleTree(identity: ProcessIdentity, waitMs: number): Promise<TreeSettlement> {
    const dir = identity.cgroupPath;
    if (!dir) return this.inner.settleTree(identity, waitMs);
    try {
      if (!(await cg.waitUnpopulated(dir, waitMs))) return 'residual';
    } catch {
      return 'unknown';
    }
    await this.retire(dir);
    return 'empty';
  }

  public async readLimitEvents(identity: ProcessIdentity): Promise<LimitEvents | null> {
    const dir = identity.cgroupPath;
    if (!dir) return null;
    const retired = this.retiredLimitEvents.get(dir);
    if (retired) {
      this.retiredLimitEvents.delete(dir);
      return retired;
    }
    return readLimitEventsFrom(dir);
  }

  public async sampleMetrics(identity: ProcessIdentity) {
    const dir = identity.cgroupPath;
    if (!dir) return this.inner.sampleMetrics(identity);
    try {
      const memory = await fs.promises.readFile(path.join(dir, 'memory.current'), 'utf8');
      const pids = await fs.promises.readFile(path.join(dir, 'pids.current'), 'utf8');
      const cpu = await cg.readKeyValues(path.join(dir, 'cpu.stat'));
      return {
        rssBytes: Number(memory.trim()),
        pidsCount: Number(pids.trim()),
        cpuTimeMs: Math.round((cpu?.usage_usec ?? 0) / 1000),
      };
    } catch {
      // 控制器未启用或 cgroup 已删除：退回进程树采样
      return this.inner.sampleMetrics(identity);
    }
  }

  public async readBootId(): Promise<string | null> {
    return this.inner.readBootId();
  }

  public async getGroupEvidence(pgid: number) {
    return this.inner.getGroupEvidence(pgid);
  }

  public async terminateGroup(pgid: number, graceMs: number = 2000): Promise<StopProcessResult> {
    return this.inner.terminateGroup(pgid, graceMs);
  }

  private applyLimits(dir: string, limits: NonNullable<StructuredCommand['hardLimits']>): void {
    this.limitedDirs.add(dir);
    if (limits.memoryMaxBytes) {
      cg.writeFile(dir, 'memory.max', String(limits.memoryMaxBytes));
      // 不让 swap 把硬限制变成软限制；OOM 时杀整棵树，而不是留下半个进程树
      if (fs.existsSync(path.join(dir, 'memory.swap.max'))) cg.writeFile(dir, 'memory.swap.max', '0');
      cg.writeFile(dir, 'memory.oom.group', '1');
    }
    if (limits.pidsMax) cg.writeFile(dir, 'pids.max', String(limits.pidsMax));
  }

  /** 已空的 cgroup：留下限制命中事实后删除。删除失败不影响已证明的停止，只作为说明返回。 */
  private async retire(dir: string): Promise<string | undefined> {
    if (this.limitedDirs.delete(dir)) {
      const events = await readLimitEventsFrom(dir).catch(() => null);
      if (events) this.retiredLimitEvents.set(dir, events);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        cg.removeCgroup(dir);
        return undefined;
      } catch (err: any) {
        // populated 0 之后最后一个僵尸的解除关联可能稍晚
        if (err.code !== 'EBUSY' || attempt >= 10) return `cgroup ${dir} was emptied but not removed: ${err.message}`;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }
}

async function readLimitEventsFrom(dir: string): Promise<LimitEvents> {
  const memory = await cg.readKeyValues(path.join(dir, 'memory.events'));
  const pids = await cg.readKeyValues(path.join(dir, 'pids.events'));
  return { memoryOomKills: memory?.oom_kill ?? 0, pidsMaxHits: pids?.max ?? 0 };
}

function resolveRoot(options: CgroupDriverOptions): { root: string; own: string } {
  if (process.platform !== 'linux') throw new CgroupUnavailableError(`cgroup v2 is Linux only (got ${process.platform})`);
  if (!cg.isCgroup2Mounted()) throw new CgroupUnavailableError(`cgroup v2 is not mounted at ${cg.CGROUP_MOUNT}`);
  const current = cg.readOwnCgroup();
  if (!current) throw new CgroupUnavailableError('the host process is not in a cgroup v2 hierarchy');
  // 本进程之前已经把自己移进了叶子：根是叶子的父目录
  const own = path.basename(current) === HOST_LEAF ? path.dirname(current) : current;
  const root = path.resolve(options.root ?? own);
  if (own !== root && !own.startsWith(`${root}/`)) {
    throw new CgroupUnavailableError(`the host process (in ${current}) must run inside the cgroup root ${root}`);
  }
  for (const target of [root, path.join(root, 'cgroup.procs'), path.join(root, 'cgroup.subtree_control')]) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new CgroupUnavailableError(
        `${root} is not delegated to uid ${process.getuid?.()}: ${target} is not writable ` +
          '(run the host under `systemd-run --user --scope -p Delegate=yes` or in a container with a private cgroup namespace)'
      );
    }
  }
  return { root, own };
}

/** cgroup v2「无内部进程」规则：根里的进程（宿主与同一委派范围里的其他进程）移到叶子。 */
function moveRootProcessesToLeaf(root: string): void {
  const leaf = path.join(root, HOST_LEAF);
  fs.mkdirSync(leaf, { recursive: true });
  const procs = fs.readFileSync(path.join(root, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean);
  for (const pid of procs) {
    try {
      cg.writeFile(leaf, 'cgroup.procs', pid);
    } catch {
      // 进程恰好退出不是问题；留在根里的进程会让启用控制器失败（EBUSY），由 limitsUnavailableReason 如实报告
    }
  }
}

function enableLimitControllers(root: string, opsDir: string): { controllers: string[]; reason?: string } {
  const available = cg.readControllers(root, 'cgroup.controllers');
  const wanted = LIMIT_CONTROLLERS.filter((c) => available.includes(c));
  const missing = LIMIT_CONTROLLERS.filter((c) => !available.includes(c));
  try {
    for (const dir of [root, opsDir]) {
      const enabled = cg.readControllers(dir, 'cgroup.subtree_control');
      const toEnable = wanted.filter((c) => !enabled.includes(c));
      if (toEnable.length > 0) cg.writeFile(dir, 'cgroup.subtree_control', toEnable.map((c) => `+${c}`).join(' '));
    }
  } catch (err: any) {
    return { controllers: [], reason: `could not enable ${wanted.join(', ')} for ${opsDir}: ${err.message}` };
  }
  return {
    controllers: wanted,
    ...(missing.length > 0 ? { reason: `controllers not delegated to ${root}: ${missing.join(', ')}` } : {}),
  };
}
