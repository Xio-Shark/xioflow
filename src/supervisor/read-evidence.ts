import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { artifactPath, readArtifact, removeOwnedArtifact, writeArtifact, type ArtifactFacts, type OwnedArtifact } from '../artifacts.js';
import { isPathContained } from '../capability/path-utils.js';
import type { VfsSyscallEvents } from '../driver/vfs-trace.js';
import { EvidenceStatus, ReadEvidence } from '../types.js';
import { probeReadTracking, resetAccessTime, wasAccessed } from '../workspace/read-tracking.js';

/**
 * 读集证据：一条命令跑完后，记下它在 roots 里读过哪些文件（内容哈希）、列过哪些目录（条目集合哈希），
 * 以及跑完那一刻 roots 里每个文件的 size / mtime。之后可以问这份结果还能不能代表当前的工作区。
 *
 * 读集来自访问时间（`read-tracking.ts`），范围是 `content_reads`：只 stat 不读内容的文件不在里面。
 * 「只看 stat 就复用的缓存」（Python 字节码缓存、增量编译器）正是这样的依赖，所以默认情况下读集之外
 * 有改动时只答 `unknown`；调用方声明已排除这类缓存（`statCaches: 'ruled_out'`）后才按读集答 `fresh`。
 * 符号链接无法按 atime 判断是否被使用，另记链接本身的指纹；它们变化时仍只能答 `unknown`。
 *
 * 看不到的：roots 之外的依赖、环境变量、常驻进程替命令读的文件、命令运行期间别人的写入。
 */
export interface TrackReadsSpec {
  /** 绝对路径的目录。证据只覆盖这些目录之内。 */
  roots: string[];
  /** 调用方保证命令不使用只靠 stat 校验的缓存（例如给 Python 指了一个空的字节码缓存目录）。 */
  statCaches?: 'ruled_out';
  /** 读集采集方式：默认 `auto`（驱动支持进程级 VFS 追踪时优先走零扫盘 `vfs`，否则回退 `atime`）。 */
  mode?: 'auto' | 'vfs' | 'atime';
}

interface RootEvidence {
  root: string;
  /** 读过的条目 -> 指纹；null 表示这个根的读取没有被观测到。 */
  reads: Record<string, string> | null;
  /** 无法判断是否被使用的符号链接 -> 链接文本哈希；旧证据不含此字段。 */
  pathDependencies?: Record<string, string>;
  /** 每个非目录条目 -> `size:mtimeNs`；符号链接用链接文本哈希，不跟随其目标。 */
  tree: Record<string, string>;
}

interface EvidenceFile {
  version: 1;
  opId: string;
  statCaches: 'ruled_out' | 'possible';
  roots: RootEvidence[];
}

const SKIP_TOP = new Set(['.git']);
const CHANGED_LIMIT = 50;
const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const evidenceDigest = (roots: RootEvidence[]) => sha(JSON.stringify(roots.map((r) => (
  r.pathDependencies === undefined ? [r.root, r.reads] : [r.root, r.reads, r.pathDependencies]
))));

export const readEvidencePath = (artifactsDir: string, opId: string) => artifactPath(artifactsDir, opId, '-reads.json.gz');

function isVanishedEntryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function tryResetAccessTime(abs: string, st: fs.BigIntStats): void {
  try {
    resetAccessTime(abs, st);
  } catch (err) {
    // 并发进程清理临时文件/目录时可能在遍历后、utimes 前删除子条目
    if (!isVanishedEntryError(err)) throw err;
  }
}

function walk(dir: string, visit: (abs: string, rel: string, st: fs.BigIntStats) => void, rel = ''): void {
  let dirStat: fs.BigIntStats;
  try {
    dirStat = fs.lstatSync(dir, { bigint: true });
  } catch (err) {
    if (rel && isVanishedEntryError(err)) return;
    throw err;
  }
  if (!dirStat.isDirectory()) {
    if (rel) return;
    throw new Error(`Read tracking root is not a real directory: ${dir}`);
  }
  visit(dir, rel, dirStat);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (rel && isVanishedEntryError(err)) return;
    throw err;
  }
  for (const name of names) {
    if (!rel && SKIP_TOP.has(name)) continue;
    const abs = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(abs, { bigint: true });
    } catch (err) {
      if (isVanishedEntryError(err)) continue;
      throw err;
    }
    if (st.isDirectory()) walk(abs, visit, childRel);
    else visit(abs, childRel, st);
  }
}

/**
 * 一趟遍历的归一：只动 atime 不早于 mtime 的文件（上次归一之后被读过的，以及两个时间相等的新文件）。
 * 目录每次都归一，因为这趟遍历本身就列了它。事务路径用的全量归一（`normalizeAccessTimes`）不受影响。
 */
export function normalizeAccessTimesOnePass(root: string): void {
  const dirs: Array<[string, fs.BigIntStats]> = [];
  walk(root, (abs, _rel, st) => {
    if (st.isSymbolicLink()) return; // utimes 会跟随链接，改到链接目标上
    if (st.isDirectory()) dirs.push([abs, st]);
    else if (wasAccessed(st)) tryResetAccessTime(abs, st);
  });
  // 深的目录先归一：父目录的 mtime 不受子目录 atime 变化影响
  for (const [abs, st] of dirs.reverse()) tryResetAccessTime(abs, st);
}

function fingerprint(root: string, entry: string): string {
  const abs = path.join(root, entry);
  try {
    // 取证时是真实路径，复核时任意一层可能已变成链接。不要为判断有效性去读根之外的目标。
    let current = root;
    for (const part of entry.split('/').filter(Boolean)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return 'symbolic_link';
    }
    if (entry.endsWith('/')) {
      const names = fs.readdirSync(abs).filter((name) => !(entry === './' && SKIP_TOP.has(name)));
      return sha(names.sort().join('\n'));
    }
    return sha(fs.readFileSync(abs));
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return 'missing';
    throw err;
  }
}

/** 一趟遍历同时得到读过的条目（目录以 `/` 结尾，根为 `./`）与全树的 stat 清单。 */
function scanTree(
  root: string,
  collectReads: boolean,
): { reads: string[]; tree: Record<string, string>; pathDependencies: Record<string, string> } {
  const reads: string[] = [];
  const tree: Record<string, string> = Object.create(null);
  const pathDependencies: Record<string, string> = Object.create(null);
  walk(root, (abs, rel, st) => {
    if (st.isSymbolicLink()) {
      try {
        pathDependencies[rel] = sha(fs.readlinkSync(abs));
        tree[rel] = `link:${pathDependencies[rel]}`;
      } catch (err) {
        if (!isVanishedEntryError(err)) throw err;
      }
      return;
    }
    if (!st.isDirectory()) tree[rel] = `${st.size}:${st.mtimeNs}`;
    if (collectReads && wasAccessed(st)) reads.push(st.isDirectory() ? `${rel || '.'}/` : rel);
  });
  return { reads: collectReads ? reads.sort() : reads, tree, pathDependencies };
}

const scan = (root: string) => scanTree(root, true);
const scanTreeOnly = (root: string): { tree: Record<string, string>; pathDependencies: Record<string, string> } => {
  const { tree, pathDependencies } = scanTree(root, false);
  return { tree, pathDependencies };
};

function resolveVfsEntry(root: string, candidatePath: string, forceDir: boolean): string | null {
  let resolved: string;
  let isDir = forceDir;
  try {
    const st = fs.lstatSync(candidatePath);
    if (st.isSymbolicLink()) return null;
    isDir = isDir || st.isDirectory();
    resolved = fs.realpathSync(candidatePath);
  } catch {
    resolved = path.resolve(candidatePath);
  }
  if (!isPathContained(root, resolved)) return null;
  const rel = path.relative(root, resolved).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  const top = rel.split('/')[0];
  if (top && SKIP_TOP.has(top)) return null;
  if (isDir) return `${rel || '.'}/`;
  if (!rel) return './';
  return rel;
}

export interface ReadTrackingSession {
  readonly useVfs: boolean;
  /** 在进程启动之前调用：atime 模式归一访问时间；vfs 模式为零开销空操作。 */
  begin(): void;
  /** 在进程退出之后调用：收集读集、写证据文件，返回放进操作结果的摘要。不抛错。 */
  collect(
    artifactsDir: string,
    onArtifactCreated?: (artifact: OwnedArtifact, facts: ArtifactFacts) => void,
    vfsEvents?: VfsSyscallEvents
  ): ReadEvidence;
  close(): void;
}

/**
 * 同一个根上同时只能有一条 atime 命令被观测：后来者的归一会抹掉先来者的读取痕迹。
 * VFS 模式按进程树独立输出 syscall trace，不受并发干扰且无需启动前扫盘重置 atime。
 */
export class ReadTracker {
  private readonly active = new Map<string, string[]>();

  public open(opId: string, spec: TrackReadsSpec, options?: { useVfs?: boolean }): ReadTrackingSession {
    const roots = spec.roots.map((root) => {
      if (!path.isAbsolute(root) || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`trackReads: root "${root}" must be an absolute path to an existing directory`);
      }
      return fs.realpathSync(root);
    });
    const useVfs = options?.useVfs === true || spec.mode === 'vfs';
    const busy = useVfs
      ? false
      : [...this.active.values()].flat().some((held) => roots.some((root) => isPathContained(held, root) || isPathContained(root, held)));
    if (!useVfs && !busy) this.active.set(opId, roots);
    const observed = new Map<string, boolean>();
    const base = { scope: 'content_reads' as const, statCaches: spec.statCaches ?? ('possible' as const), roots };

    return {
      useVfs,
      begin: () => {
        if (useVfs || busy) return;
        for (const root of roots) {
          const canObserve = probeReadTracking(root) === 'atime';
          if (!canObserve) {
            observed.set(root, false);
            continue;
          }
          try {
            normalizeAccessTimesOnePass(root);
            observed.set(root, true);
          } catch {
            // 与 collect() 一致：证据准备失败不得中断命令本身，按未观测降级
            observed.set(root, false);
          }
        }
      },
      collect: (artifactsDir, onArtifactCreated, vfsEvents) => {
        try {
          const perRoot: RootEvidence[] = roots.map((root) => {
            if (useVfs) {
              const { tree, pathDependencies } = scanTreeOnly(root);
              if (!vfsEvents) {
                return { root, reads: null, tree, pathDependencies };
              }
              const vfsReads = new Set<string>();
              for (const p of vfsEvents.reads) {
                const entry = resolveVfsEntry(root, p, false);
                if (entry) vfsReads.add(entry);
              }
              for (const d of vfsEvents.listedDirs) {
                const entry = resolveVfsEntry(root, d, true);
                if (entry) vfsReads.add(entry);
              }
              const sorted = [...vfsReads].sort();
              return {
                root,
                reads: Object.fromEntries(sorted.map((entry) => [entry, fingerprint(root, entry)])),
                tree,
                pathDependencies,
              };
            }
            const { reads, tree, pathDependencies } = scan(root);
            if (!observed.get(root)) return { root, reads: null, tree, pathDependencies };
            return { root, reads: Object.fromEntries(reads.map((entry) => [entry, fingerprint(root, entry)])), tree, pathDependencies };
          });
          const file: EvidenceFile = { version: 1, opId, statCaches: base.statCaches, roots: perRoot };
          const ref = readEvidencePath(artifactsDir, opId);
          // 全树清单占了大头，路径文本压缩比高
          const data = zlib.gzipSync(JSON.stringify(file));
          const artifact = writeArtifact(ref, data);
          try {
            onArtifactCreated?.(artifact, {
              sha256: sha(data),
              sizeBytes: data.length,
            });
          } catch (error) {
            try { removeOwnedArtifact(artifact); } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Read evidence ownership recording and cleanup both failed', { cause: error });
            }
            throw error;
          }
          const tracked = perRoot.every((r) => r.reads !== null);
          return {
            ...base,
            tracking: tracked ? (useVfs ? 'vfs' : 'atime') : 'unobserved',
            ...(tracked
              ? {}
              : {
                  reason: useVfs
                    ? ('no_vfs' as const)
                    : busy
                      ? ('roots_busy' as const)
                      : ('no_atime' as const),
                }),
            entryCount: perRoot.reduce((sum, r) => sum + Object.keys(r.reads ?? {}).length, 0),
            digest: evidenceDigest(perRoot),
            ref,
          };
        } catch (err: any) {
          // 命令本身的结果不能因为证据收集失败而丢掉：如实记为失败，evidenceStatus 据此回答 unknown
          return { ...base, tracking: 'failed', error: err?.message || String(err) };
        }
      },
      close: () => {
        if (!useVfs) this.active.delete(opId);
      },
    };
  }
}

function limited(paths: string[]): { paths: string[]; truncated: boolean } {
  return { paths: paths.slice(0, CHANGED_LIMIT), truncated: paths.length > CHANGED_LIMIT };
}

/**
 * 这份证据还能不能代表当前的工作区。
 * - 读过的文件内容变了，或列过的目录条目变了 ⇒ `stale`，列出它们；
 * - roots 里什么都没变 ⇒ `fresh`（`tree_unchanged`）；
 * - 只有读集之外的文件变了 ⇒ 已排除 stat 缓存时 `fresh`（`reads_unchanged`），否则 `unknown`；
 * - 读取没有被观测到、证据文件没了或读不出来 ⇒ `unknown`。
 */
export function evaluateReadEvidence(evidence: ReadEvidence | undefined): EvidenceStatus {
  if (!evidence) return { status: 'unknown', reason: 'not_tracked' };
  if (evidence.tracking === 'failed' || !evidence.ref) return { status: 'unknown', reason: 'evidence_missing' };
  let file: EvidenceFile;
  try {
    file = JSON.parse(zlib.gunzipSync(readArtifact(evidence.ref)).toString('utf8'));
  } catch (err: any) {
    return { status: 'unknown', reason: err?.code === 'ENOENT' ? 'evidence_missing' : 'evidence_unreadable' };
  }
  if (evidenceDigest(file.roots) !== evidence.digest) {
    return { status: 'unknown', reason: 'evidence_unreadable' };
  }

  const changedReads: string[] = [];
  const changedOutside: string[] = [];
  let unobserved = false;
  for (const { root, reads, tree, pathDependencies } of file.roots) {
    if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      changedReads.push(root);
      continue;
    }
    if (reads === null || pathDependencies === undefined) unobserved = true;
    for (const [entry, recorded] of Object.entries(reads ?? {})) {
      if (fingerprint(root, entry) !== recorded) changedReads.push(path.join(root, entry)); // 目录条目保留结尾的 `/`
    }
    const { tree: now, pathDependencies: nowDependencies } = scan(root);
    for (const rel of new Set([...Object.keys(pathDependencies ?? {}), ...Object.keys(nowDependencies)])) {
      if (pathDependencies?.[rel] !== nowDependencies[rel]) unobserved = true;
    }
    for (const rel of new Set([...Object.keys(tree), ...Object.keys(now)])) {
      if (tree[rel] !== now[rel] && !(reads && Object.hasOwn(reads, rel))) changedOutside.push(path.join(root, rel));
    }
  }

  if (changedReads.length > 0) {
    const { paths, truncated } = limited(changedReads.sort());
    return { status: 'stale', changed: paths, truncated };
  }
  if (changedOutside.length === 0) return { status: 'fresh', basis: 'tree_unchanged' };
  const { paths, truncated } = limited(changedOutside.sort());
  if (unobserved) return { status: 'unknown', reason: 'reads_unobserved', changedOutside: paths, truncated };
  if (file.statCaches === 'ruled_out') return { status: 'fresh', basis: 'reads_unchanged' };
  return { status: 'unknown', reason: 'changed_outside_read_set', changedOutside: paths, truncated };
}
