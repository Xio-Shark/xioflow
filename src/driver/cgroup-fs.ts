import fs from 'node:fs';
import path from 'node:path';

/**
 * cgroup v2 文件接口的最小封装（Documentation/admin-guide/cgroup-v2.rst）。
 * 只读写 cgroupfs 文件，不依赖 systemd；权限与委派前提由调用方检查。
 */

export const CGROUP_MOUNT = '/sys/fs/cgroup';

/** 当前进程所在的 cgroup v2 路径（`/proc/self/cgroup` 的 `0::` 行），不是纯 v2 时返回 null。 */
export function readOwnCgroup(): string | null {
  let content: string;
  try {
    content = fs.readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return null;
  }
  return parseOwnCgroup(content);
}

/** `/proc/<pid>/cgroup` 内容里的 v2 路径，转成挂载点下的规范化绝对路径。 */
export function parseOwnCgroup(content: string): string | null {
  const line = content.split('\n').find((l) => l.startsWith('0::'));
  // 容器的 cgroup 命名空间里是 `0::/`：规范化，避免末尾斜杠让「宿主就在根里」的判断失效
  return line ? path.resolve(CGROUP_MOUNT, `.${line.slice(3).trim()}`) : null;
}

export function isCgroup2Mounted(): boolean {
  try {
    return fs.existsSync(path.join(CGROUP_MOUNT, 'cgroup.controllers'));
  } catch {
    return false;
  }
}

export function readControllers(dir: string, file: 'cgroup.controllers' | 'cgroup.subtree_control'): string[] {
  return fs.readFileSync(path.join(dir, file), 'utf8').trim().split(/\s+/).filter(Boolean);
}

/** `key value` 行格式（cgroup.events、memory.events、pids.events、cpu.stat）。文件不存在返回 null。 */
export async function readKeyValues(file: string): Promise<Record<string, number> | null> {
  let content: string;
  try {
    content = await fs.promises.readFile(file, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const out: Record<string, number> = {};
  for (const line of content.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined) out[key] = Number(value);
  }
  return out;
}

/**
 * cgroup 里是否还有进程（`cgroup.events` 的 `populated`）。目录不存在返回 false：
 * 仍有成员的 cgroup 无法被 rmdir，也不会随重启以外的事件消失。
 */
export async function isPopulated(dir: string): Promise<boolean> {
  const events = await readKeyValues(path.join(dir, 'cgroup.events'));
  return events !== null && events.populated === 1;
}

/** 在 timeoutMs 内等待 cgroup 变空。 */
export async function waitUnpopulated(dir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isPopulated(dir))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function readProcs(dir: string): Promise<number[]> {
  try {
    const content = await fs.promises.readFile(path.join(dir, 'cgroup.procs'), 'utf8');
    return content.split('\n').map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** 对 cgroup 内所有进程发信号；进程恰好退出（ESRCH）不算错误。 */
export async function signalProcs(dir: string, signal: NodeJS.Signals): Promise<void> {
  for (const pid of await readProcs(dir)) {
    try {
      process.kill(pid, signal);
    } catch (err: any) {
      if (err.code !== 'ESRCH') throw err;
    }
  }
}

/** `cgroup.kill`（Linux 5.14+）：原子地 SIGKILL 整个 cgroup 子树，不存在 pid 复用竞争。 */
export function killAll(dir: string): void {
  fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1');
}

export function writeFile(dir: string, file: string, value: string): void {
  fs.writeFileSync(path.join(dir, file), value);
}

/** 已空的 cgroup 才能删除；目录已不存在视为已删除。 */
export function removeCgroup(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}
