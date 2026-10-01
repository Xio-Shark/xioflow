import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { isPathContained } from '../capability/path-utils.js';
import { EvidenceStatus, ReadEvidence } from '../types.js';
import { probeReadTracking } from '../workspace/read-tracking.js';

/**
 * 读集证据：一条命令跑完后，记下它在 roots 里读过哪些文件（内容哈希）、列过哪些目录（条目集合哈希），
 * 以及跑完那一刻 roots 里每个文件的 size / mtime。之后可以问这份结果还能不能代表当前的工作区。
 *
 * 读集来自访问时间（`read-tracking.ts`），范围是 `content_reads`：只 stat 不读内容的文件不在里面。
 * 「只看 stat 就复用的缓存」（Python 字节码缓存、增量编译器）正是这样的依赖，所以默认情况下读集之外
 * 有改动时只答 `unknown`；调用方声明已排除这类缓存（`statCaches: 'ruled_out'`）后才按读集答 `fresh`。
 *
 * 看不到的：roots 之外的依赖、环境变量、常驻进程替命令读的文件、命令运行期间别人的写入。
 */
export interface TrackReadsSpec {
  /** 绝对路径的目录。证据只覆盖这些目录之内。 */
  roots: string[];
  /** 调用方保证命令不使用只靠 stat 校验的缓存（例如给 Python 指了一个空的字节码缓存目录）。 */
  statCaches?: 'ruled_out';
}

interface RootEvidence {
  root: string;
  /** 读过的条目 -> 指纹；null 表示这个根的读取没有被观测到。 */
  reads: Record<string, string> | null;
  /** 每个非目录条目 -> `size:mtimeNs` */
  tree: Record<string, string>;
}

interface EvidenceFile {
  version: 1;
  opId: string;
  statCaches: 'ruled_out' | 'possible';
  roots: RootEvidence[];
}

const SKIP_TOP = new Set(['.git']);
const ATIME_MARGIN_NS = 2_000_000_000n;
const CHANGED_LIMIT = 50;
const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

export const readEvidencePath = (artifactsDir: string, opId: string) => path.join(artifactsDir, `${opId}-reads.json.gz`);

function walk(dir: string, visit: (abs: string, rel: string, st: fs.BigIntStats) => void, rel = ''): void {
  visit(dir, rel, fs.lstatSync(dir, { bigint: true }));
  for (const name of fs.readdirSync(dir)) {
    if (!rel && SKIP_TOP.has(name)) continue;
    const abs = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(abs, { bigint: true });
    if (st.isDirectory()) walk(abs, visit, childRel);
    else visit(abs, childRel, st);
  }
}

function resetAccessTime(abs: string, st: fs.BigIntStats): void {
  const mtime = Number(st.mtimeNs) / 1e9;
  fs.utimesSync(abs, mtime - Number(ATIME_MARGIN_NS) / 1e9, mtime);
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
    else if (st.atimeNs >= st.mtimeNs) resetAccessTime(abs, st);
  });
  // 深的目录先归一：父目录的 mtime 不受子目录 atime 变化影响
  for (const [abs, st] of dirs.reverse()) resetAccessTime(abs, st);
}

function fingerprint(root: string, entry: string): string {
  const abs = path.join(root, entry);
  try {
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
function scan(root: string): { reads: string[]; tree: Record<string, string> } {
  const reads: string[] = [];
  const tree: Record<string, string> = {};
  walk(root, (_abs, rel, st) => {
    if (!st.isDirectory()) tree[rel] = `${st.size}:${st.mtimeNs}`;
    if (st.isSymbolicLink()) return;
    if (st.atimeNs > st.mtimeNs) reads.push(st.isDirectory() ? `${rel || '.'}/` : rel);
  });
  return { reads: reads.sort(), tree };
}

export interface ReadTrackingSession {
  /** 在进程启动之前调用：归一访问时间。 */
  begin(): void;
  /** 在进程退出之后调用：收集读集、写证据文件，返回放进操作结果的摘要。不抛错。 */
  collect(artifactsDir: string): ReadEvidence;
  close(): void;
}

/**
 * 同一个根上同时只能有一条命令被观测：后来者的归一会抹掉先来者的读取痕迹。
 * 后来者不做归一，如实标为没有观测到（`roots_busy`）；先来者不受影响，只会多记几条别人的读取。
 */
export class ReadTracker {
  private readonly active = new Map<string, string[]>();

  public open(opId: string, spec: TrackReadsSpec): ReadTrackingSession {
    const roots = spec.roots.map((root) => {
      if (!path.isAbsolute(root) || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`trackReads: root "${root}" must be an absolute path to an existing directory`);
      }
      return fs.realpathSync(root);
    });
    const busy = [...this.active.values()].flat().some((held) => roots.some((root) => isPathContained(held, root) || isPathContained(root, held)));
    if (!busy) this.active.set(opId, roots);
    const observed = new Map<string, boolean>();
    const base = { scope: 'content_reads' as const, statCaches: spec.statCaches ?? ('possible' as const), roots };

    return {
      begin: () => {
        if (busy) return;
        for (const root of roots) {
          observed.set(root, probeReadTracking(root) === 'atime');
          if (observed.get(root)) normalizeAccessTimesOnePass(root);
        }
      },
      collect: (artifactsDir) => {
        try {
          const perRoot: RootEvidence[] = roots.map((root) => {
            const { reads, tree } = scan(root);
            if (!observed.get(root)) return { root, reads: null, tree };
            return { root, reads: Object.fromEntries(reads.map((entry) => [entry, fingerprint(root, entry)])), tree };
          });
          const file: EvidenceFile = { version: 1, opId, statCaches: base.statCaches, roots: perRoot };
          const ref = readEvidencePath(artifactsDir, opId);
          fs.mkdirSync(artifactsDir, { recursive: true });
          // 全树清单占了大头，路径文本压缩比高
          fs.writeFileSync(ref, zlib.gzipSync(JSON.stringify(file)), { mode: 0o600 });
          const tracked = perRoot.every((r) => r.reads !== null);
          return {
            ...base,
            tracking: tracked ? 'atime' : 'unobserved',
            ...(tracked ? {} : { reason: busy ? ('roots_busy' as const) : ('no_atime' as const) }),
            entryCount: perRoot.reduce((sum, r) => sum + Object.keys(r.reads ?? {}).length, 0),
            digest: sha(JSON.stringify(perRoot.map((r) => [r.root, r.reads]))),
            ref,
          };
        } catch (err: any) {
          // 命令本身的结果不能因为证据收集失败而丢掉：如实记为失败，evidenceStatus 据此回答 unknown
          return { ...base, tracking: 'failed', error: err?.message || String(err) };
        }
      },
      close: () => {
        this.active.delete(opId);
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
    file = JSON.parse(zlib.gunzipSync(fs.readFileSync(evidence.ref)).toString('utf8'));
  } catch (err: any) {
    return { status: 'unknown', reason: err?.code === 'ENOENT' ? 'evidence_missing' : 'evidence_unreadable' };
  }
  if (sha(JSON.stringify(file.roots.map((r) => [r.root, r.reads]))) !== evidence.digest) {
    return { status: 'unknown', reason: 'evidence_unreadable' };
  }

  const changedReads: string[] = [];
  const changedOutside: string[] = [];
  let unobserved = false;
  for (const { root, reads, tree } of file.roots) {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      changedReads.push(root);
      continue;
    }
    if (reads === null) unobserved = true;
    for (const [entry, recorded] of Object.entries(reads ?? {})) {
      if (fingerprint(root, entry) !== recorded) changedReads.push(path.join(root, entry)); // 目录条目保留结尾的 `/`
    }
    const now = scan(root).tree;
    for (const rel of new Set([...Object.keys(tree), ...Object.keys(now)])) {
      if (tree[rel] !== now[rel] && !(reads && rel in reads)) changedOutside.push(path.join(root, rel));
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
