import crypto from 'node:crypto';

export const WORKSPACE_INDEX_SCHEMA_VERSION = 'xio/workspace-index/1' as const;

export type WorkspaceIndexCoverage = 'complete' | 'non_ignored' | 'declared_roots' | 'unknown';

export interface WorkspaceIndexWriteEntry {
  status: 'A' | 'D' | 'M' | 'T';
  path: string;
}

export interface WorkspaceIncrementalIndex {
  schemaVersion: typeof WORKSPACE_INDEX_SCHEMA_VERSION;
  root: string;
  /** 内容被读取过的相对路径；无法观测时为 null。 */
  readSet: string[] | null;
  /** 基线树到当前树的逐路径写集。 */
  writeSet: WorkspaceIndexWriteEntry[];
  /** 目录发现/列举得到的路径集合；扫描不完整时为 null。 */
  discoverySet: string[] | null;
  /** 宿主声明的符号投影哈希；没有声明时为 null。 */
  symbolSlice: Record<string, string> | null;
  /** ignored manifest 的 digest；未捕获时为 null。 */
  ignoredManifest: string | null;
  /** 符号链接等无法由普通 readSet 证明的路径依赖。 */
  pathDependencies: string[] | null;
  coverage: WorkspaceIndexCoverage;
  coverageBasis: string[];
  digest: string;
}

export interface WorkspaceIncrementalIndexInput {
  root: string;
  readSet: string[] | null;
  writeSet: WorkspaceIndexWriteEntry[];
  discoverySet: string[] | null;
  symbolSlice?: Record<string, string> | null;
  ignoredManifest?: string | null;
  pathDependencies: string[] | null;
  coverageNotes?: string[];
}

function uniqueSorted(values: readonly string[] | null): string[] | null {
  return values === null ? null : [...new Set(values)].sort();
}

function stableSymbolSlice(value: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!value) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function normalizeWriteSet(values: readonly WorkspaceIndexWriteEntry[]): WorkspaceIndexWriteEntry[] {
  return [...values]
    .map((entry) => ({ status: entry.status, path: entry.path }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.status.localeCompare(b.status));
}

function indexBody(index: Omit<WorkspaceIncrementalIndex, 'digest'>): string {
  return JSON.stringify(index);
}

export function workspaceIndexDigest(index: Omit<WorkspaceIncrementalIndex, 'digest'>): string {
  return crypto.createHash('sha256').update(indexBody(index)).digest('hex');
}

export function buildWorkspaceIncrementalIndex(input: WorkspaceIncrementalIndexInput): WorkspaceIncrementalIndex {
  const readSet = uniqueSorted(input.readSet);
  const discoverySet = uniqueSorted(input.discoverySet);
  const pathDependencies = uniqueSorted(input.pathDependencies);
  const symbolSlice = stableSymbolSlice(input.symbolSlice);
  const writeSet = normalizeWriteSet(input.writeSet);
  const missing: string[] = [];
  if (readSet === null) missing.push('read_set_unobserved');
  if (discoverySet === null) missing.push('discovery_set_unobserved');
  if (pathDependencies === null) missing.push('path_dependencies_unobserved');

  const coverage: WorkspaceIndexCoverage = missing.length > 0
    ? 'unknown'
    : input.ignoredManifest
      ? 'complete'
      : 'non_ignored';
  const coverageBasis = [
    ...(missing.length > 0 ? missing : ['read_set_observed', 'discovery_set_scanned', 'path_dependencies_scanned']),
    ...(input.ignoredManifest ? ['ignored_manifest_captured'] : ['ignored_manifest_not_captured']),
    ...(symbolSlice ? ['symbol_slice_declared'] : ['symbol_slice_not_declared']),
    ...(input.coverageNotes ?? []),
  ];
  const body: Omit<WorkspaceIncrementalIndex, 'digest'> = {
    schemaVersion: WORKSPACE_INDEX_SCHEMA_VERSION,
    root: input.root,
    readSet,
    writeSet,
    discoverySet,
    symbolSlice,
    ignoredManifest: input.ignoredManifest ?? null,
    pathDependencies,
    coverage,
    coverageBasis,
  };
  return { ...body, digest: workspaceIndexDigest(body) };
}

function mergeNullableSets(previous: string[] | null, current: string[] | null): string[] | null {
  if (previous === null || current === null) return null;
  return uniqueSorted([...previous, ...current]);
}

/**
 * 合并同一事务的后续 inspect/commit 观测。读集、发现集和路径依赖累积；
 * 写集取当前基线到 fork 的完整差异，避免把已删除路径误当作仍然写入。
 */
export function mergeWorkspaceIncrementalIndex(
  previous: WorkspaceIncrementalIndex | undefined,
  current: WorkspaceIncrementalIndex,
): WorkspaceIncrementalIndex {
  if (!previous) return current;
  return buildWorkspaceIncrementalIndex({
    root: current.root,
    readSet: mergeNullableSets(previous.readSet, current.readSet),
    writeSet: current.writeSet,
    discoverySet: mergeNullableSets(previous.discoverySet, current.discoverySet),
    symbolSlice: previous.symbolSlice ?? current.symbolSlice,
    ignoredManifest: previous.ignoredManifest ?? current.ignoredManifest,
    pathDependencies: mergeNullableSets(previous.pathDependencies, current.pathDependencies),
  });
}

/** 从旧 journal 读取 index；不信任坏 digest，调用方会退回 unknown。 */
export function parseWorkspaceIncrementalIndex(value: unknown): WorkspaceIncrementalIndex | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WorkspaceIncrementalIndex>;
  if (candidate.schemaVersion !== WORKSPACE_INDEX_SCHEMA_VERSION || typeof candidate.digest !== 'string') return undefined;
  if (typeof candidate.root !== 'string' || !Array.isArray(candidate.writeSet)) return undefined;
  const { digest, ...body } = candidate as WorkspaceIncrementalIndex;
  if (workspaceIndexDigest(body) !== digest) return undefined;
  return candidate as WorkspaceIncrementalIndex;
}
