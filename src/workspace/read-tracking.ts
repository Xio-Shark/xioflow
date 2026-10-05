import fs from 'node:fs';
import path from 'node:path';

/**
 * 读集观测：基于访问时间，不需要任何特权。
 *
 * fork 刚建好时把每个条目的 atime 设为 mtime 之前（ATIME_MARGIN_S）；此后任何读取（读文件内容、列目录）
 * 会让 atime 不早于 mtime（同一时钟 tick 内可能相等）：Linux relatime 在 atime <= mtime 时更新，macOS APFS 只在 atime 严格早于
 * mtime 时更新（实测：atime == mtime 时读取不更新），留出余量同时覆盖秒级时间粒度的文件系统。
 * 只 stat 不会改变 atime，所以扫描本身不污染结果；列目录前先 stat，再 readdir。
 *
 * 局限（如实声明而不是假装知道）：
 * - 文件系统以 noatime 挂载时观测不到任何读取：probeReadTracking 返回 'unobserved'；
 * - 先读后写的文件只留下写的证据（它已在写集里，冲突判定不受影响）；
 * - 进程读 fork 之外的路径不在读集里（事务只对 fork 内的状态负责）。
 */
export type ReadTracking = 'atime' | 'unobserved';

const SKIP = new Set(['.git']);
const ATIME_MARGIN_S = 2;

export function resetAccessTime(abs: string, st: fs.BigIntStats): void {
  const mtime = Number(st.mtimeNs) / 1e9;
  fs.utimesSync(abs, mtime - ATIME_MARGIN_S, mtime);
}

/** 归一后 atime 早于 mtime；Linux 在同一时钟 tick 内读取时，两者可以相等。 */
export function wasAccessed(st: fs.BigIntStats): boolean {
  return st.atimeNs >= st.mtimeNs;
}

function walk(dir: string, visit: (abs: string, rel: string, st: fs.BigIntStats) => void, rel = ''): void {
  const st = fs.lstatSync(dir, { bigint: true });
  visit(dir, rel, st);
  for (const name of fs.readdirSync(dir)) {
    if (!rel && SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const childStat = fs.lstatSync(abs, { bigint: true });
    if (childStat.isDirectory()) walk(abs, visit, childRel);
    else visit(abs, childRel, childStat);
  }
}

/** 把 root 下每个条目（跳过顶层 .git）的 atime 设到其 mtime 之前。目录在列举之后再归一。 */
export function normalizeAccessTimes(root: string): void {
  const dirs: Array<[string, fs.BigIntStats]> = [];
  walk(root, (abs, _rel, st) => {
    if (st.isSymbolicLink()) return; // utimes 会跟随链接，改到链接目标上
    if (st.isDirectory()) dirs.push([abs, st]);
    else resetAccessTime(abs, st);
  });
  // 深的目录先归一：父目录的 mtime 不受子目录 atime 变化影响
  for (const [abs, st] of dirs.reverse()) resetAccessTime(abs, st);
}

/**
 * 读过的条目（相对 root，目录以 `/` 结尾，root 本身为 `./`）：atime 不早于 mtime。
 */
export function collectReadSet(root: string): string[] {
  const reads: string[] = [];
  walk(root, (_abs, rel, st) => {
    if (st.isSymbolicLink()) return;
    if (wasAccessed(st)) reads.push(st.isDirectory() ? `${rel || '.'}/` : rel);
  });
  return reads.sort();
}

/** 在 dir 所在文件系统上实测一次「读取会推进 atime」。探针文件放在 dir 下并立即删除。 */
export function probeReadTracking(dir: string): ReadTracking {
  const probe = path.join(dir, `.xioflow-atime-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'probe');
    resetAccessTime(probe, fs.statSync(probe, { bigint: true }));
    const before = fs.statSync(probe, { bigint: true }).atimeNs;
    fs.readFileSync(probe);
    return fs.statSync(probe, { bigint: true }).atimeNs > before ? 'atime' : 'unobserved';
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
