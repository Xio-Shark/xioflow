import fs from 'node:fs';
import path from 'node:path';

/**
 * 读集观测：基于访问时间，不需要任何特权。
 *
 * fork 刚建好时把每个条目的 atime 归一到 mtime；此后任何读取（打开文件读内容、列目录）
 * 都会让 atime 越过 mtime——Linux relatime 在 atime <= mtime 时必定更新，macOS APFS 同样更新。
 * 只 stat 不会改变 atime，所以扫描本身不污染结果；列目录前先 stat，再 readdir。
 *
 * 局限（如实声明而不是假装知道）：
 * - 文件系统以 noatime 挂载时观测不到任何读取：probeReadTracking 返回 'unobserved'；
 * - 先读后写的文件只留下写的证据（它已在写集里，冲突判定不受影响）；
 * - 进程读 fork 之外的路径不在读集里（事务只对 fork 内的状态负责）。
 */
export type ReadTracking = 'atime' | 'unobserved';

const SKIP = new Set(['.git']);

function walk(dir: string, visit: (abs: string, rel: string, st: fs.Stats) => void, rel = ''): void {
  const st = fs.lstatSync(dir);
  visit(dir, rel, st);
  for (const name of fs.readdirSync(dir)) {
    if (!rel && SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const childStat = fs.lstatSync(abs);
    if (childStat.isDirectory()) walk(abs, visit, childRel);
    else visit(abs, childRel, childStat);
  }
}

/** 把 root 下每个条目（跳过顶层 .git）的 atime 设为其 mtime。目录在列举之后再归一。 */
export function normalizeAccessTimes(root: string): void {
  const dirs: Array<[string, fs.Stats]> = [];
  walk(root, (abs, _rel, st) => {
    if (st.isSymbolicLink()) return; // utimes 会跟随链接，改到链接目标上
    if (st.isDirectory()) dirs.push([abs, st]);
    else fs.utimesSync(abs, st.mtimeMs / 1000, st.mtimeMs / 1000);
  });
  // 深的目录先归一：父目录的 mtime 不受子目录 atime 变化影响
  for (const [abs, st] of dirs.reverse()) fs.utimesSync(abs, st.mtimeMs / 1000, st.mtimeMs / 1000);
}

/**
 * 读过的条目（相对 root，目录以 `/` 结尾，root 本身为 `./`）：atime 严格晚于 mtime。
 */
export function collectReadSet(root: string): string[] {
  const reads: string[] = [];
  walk(root, (_abs, rel, st) => {
    if (st.isSymbolicLink()) return;
    if (st.atimeMs > st.mtimeMs) reads.push(st.isDirectory() ? `${rel || '.'}/` : rel);
  });
  return reads.sort();
}

/** 在 dir 所在文件系统上实测一次「读取会推进 atime」。探针文件放在 dir 下并立即删除。 */
export function probeReadTracking(dir: string): ReadTracking {
  const probe = path.join(dir, `.xioflow-atime-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'probe');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(probe, past, past);
    fs.readFileSync(probe);
    return fs.statSync(probe).atimeMs > past.getTime() ? 'atime' : 'unobserved';
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
