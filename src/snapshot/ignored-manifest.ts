import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IgnoredChanges } from '../types.js';

/**
 * 被忽略文件清单：不复制内容，只记每个文件的元数据，用来证明「回滚时它们和拍快照时一样」。
 *
 * 证据强度：内容改写必然推进 ctime，而非特权进程无法把 ctime 改回过去，所以四项全等 ⇒ 内容未变。
 * 反过来不成立：只有 ctime 变了（chmod 来回、utimes、内核自己的读集归一）不代表内容变了，
 * 这种条目单独归为 `metadataOnly`，结论是「无法证明」，既不算未变也不算已变。
 * utimes 经由双精度秒传时间戳，把 mtime 写回原值时会丢掉亚微秒位（实测读集归一之后 mtime 差几百纳秒），
 * 所以 mtime 相差不到 1 微秒也按「只动了元数据」处理，而不是报成已修改。
 */
const UTIMES_PRECISION_NS = 1000n;

function sameMtime(a: string, b: string): boolean {
  const delta = BigInt(a) - BigInt(b);
  return (delta < 0n ? -delta : delta) < UTIMES_PRECISION_NS;
}

export interface IgnoredManifestEntry {
  path: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
}

/** 回滚结果里每类最多列出的路径数；总数在 counts 里。 */
export const IGNORED_CHANGES_LIMIT = 50;

export type IgnoredManifestVerdict = 'unchanged' | 'changed' | 'inconclusive';

export function ignoredManifestPath(domainPath: string, snapshotId: string): string {
  return path.join(domainPath, 'artifacts', `${snapshotId}-ignored.manifest`);
}

/** 逐项 lstat。列举与 lstat 之间消失的文件直接略过：它不在这一刻的清单里，比较时自然表现为增 / 删。 */
export function collectIgnoredEntries(paths: string[]): IgnoredManifestEntry[] {
  const entries: IgnoredManifestEntry[] = [];
  for (const p of paths) {
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(p, { bigint: true });
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    entries.push({
      path: p,
      size: st.size.toString(),
      mtimeNs: st.mtimeNs.toString(),
      ctimeNs: st.ctimeNs.toString(),
      mode: Number(st.mode),
    });
  }
  // 按码点排序，不用 localeCompare：清单比较不做大小写或区域归一
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 写清单并 fsync，返回内容的 sha256。清单含路径名（可能敏感），权限收紧到属主。 */
export function writeIgnoredManifest(file: string, entries: IgnoredManifestEntry[]): string {
  const body = JSON.stringify({
    version: 1,
    entries: entries.map((e) => [e.path, e.size, e.mtimeNs, e.ctimeNs, e.mode]),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** 读回清单；文件不在或内容与登记的摘要不符时返回 null（调用方据此不给出「未变」的结论）。 */
export function readIgnoredManifest(file: string, digest: string): IgnoredManifestEntry[] | null {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (crypto.createHash('sha256').update(body).digest('hex') !== digest) return null;
  const parsed = JSON.parse(body) as { entries: Array<[string, string, string, string, number]> };
  return parsed.entries.map(([p, size, mtimeNs, ctimeNs, mode]) => ({ path: p, size, mtimeNs, ctimeNs, mode }));
}

export function diffIgnoredEntries(
  before: IgnoredManifestEntry[],
  after: IgnoredManifestEntry[]
): { verdict: IgnoredManifestVerdict; changes?: IgnoredChanges } {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const metadataOnly: string[] = [];
  const current = new Map(after.map((e) => [e.path, e]));
  for (const old of before) {
    const now = current.get(old.path);
    if (!now) {
      removed.push(old.path);
      continue;
    }
    current.delete(old.path);
    if (now.size !== old.size || now.mode !== old.mode || !sameMtime(now.mtimeNs, old.mtimeNs)) modified.push(old.path);
    else if (now.ctimeNs !== old.ctimeNs) metadataOnly.push(old.path);
  }
  added.push(...current.keys());

  const counts = {
    added: added.length,
    removed: removed.length,
    modified: modified.length,
    metadataOnly: metadataOnly.length,
  };
  const definite = counts.added + counts.removed + counts.modified;
  if (definite === 0 && counts.metadataOnly === 0) return { verdict: 'unchanged' };
  const cut = (list: string[]) => list.slice(0, IGNORED_CHANGES_LIMIT);
  return {
    verdict: definite > 0 ? 'changed' : 'inconclusive',
    changes: {
      added: cut(added),
      removed: cut(removed),
      modified: cut(modified),
      metadataOnly: cut(metadataOnly),
      truncated: Object.values(counts).some((n) => n > IGNORED_CHANGES_LIMIT),
      counts,
    },
  };
}
