import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathContained } from '../capability/path-utils.js';
import { computeSymbolSliceCutoffHash } from '../workspace/observation-replay.js';

const MAX_EXCERPT_BYTES = 64 * 1024;
const DEFAULT_DIFF_MAX_LINES = 24;

export interface FileReadRecord {
  /** Workspace-relative POSIX path (`src/foo.ts`). */
  path: string;
  absPath: string;
  /** 16-hex SHA-256 content revision, or `'missing'` when observed absent. */
  rev: string;
  cutoffHash?: string;
  symbols?: string[];
  lineRange?: [number, number];
  excerpt?: string;
  /** Last `currentRev` already emitted to this session to avoid repeated diff spam. */
  notifiedRev?: string;
  observedAt: string;
}

export interface StaleReadNotice {
  path: string;
  previousRev: string;
  currentRev: string;
  reason: 'modified' | 'created' | 'deleted';
  compactDiff?: string;
}

export interface MutationValidationFailure {
  path: string;
  expectedRev: string;
  currentRev: string;
  reason: 'stale_read' | 'rev_mismatch';
  compactDiff?: string;
}

export function computeBytesRev(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

export function readDiskSnapshot(absPath: string): {
  exists: boolean;
  rev: string;
  sizeBytes: number;
  text?: string;
} {
  try {
    const st = fs.lstatSync(absPath);
    if (!st.isFile()) {
      return { exists: false, rev: 'missing', sizeBytes: 0 };
    }
    const buf = fs.readFileSync(absPath);
    const rev = computeBytesRev(buf);
    const isBinary = buf.subarray(0, Math.min(buf.length, 4096)).includes(0);
    return {
      exists: true,
      rev,
      sizeBytes: buf.length,
      text: isBinary ? undefined : buf.toString('utf8'),
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { exists: false, rev: 'missing', sizeBytes: 0 };
    }
    throw err;
  }
}

export function buildCompactDiff(
  beforeText: string | undefined,
  afterText: string | undefined,
  maxLines: number = DEFAULT_DIFF_MAX_LINES,
): string | undefined {
  if (beforeText === undefined && afterText === undefined) return undefined;
  const oldLines = beforeText !== undefined ? beforeText.split('\n') : [];
  const newLines = afterText !== undefined ? afterText.split('\n') : [];

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const out: string[] = [];
  const contextStart = Math.max(0, prefix - 1);
  out.push(`@@ -${prefix + 1},${Math.max(0, oldEnd - prefix + 1)} +${prefix + 1},${Math.max(0, newEnd - prefix + 1)} @@`);
  for (let i = contextStart; i < prefix; i++) {
    out.push(` ${oldLines[i]}`);
  }
  for (let i = prefix; i <= oldEnd && out.length < maxLines; i++) {
    out.push(`-${oldLines[i]}`);
  }
  for (let i = prefix; i <= newEnd && out.length < maxLines; i++) {
    out.push(`+${newLines[i]}`);
  }
  const contextAfter = Math.min(newLines.length - 1, newEnd + 1);
  if (newEnd + 1 < newLines.length && out.length < maxLines) {
    out.push(` ${newLines[contextAfter]}`);
  }
  if (out.length >= maxLines && (oldEnd - prefix + 1 + (newEnd - prefix + 1)) > maxLines) {
    out.push('... (diff truncated)');
  }
  return out.join('\n');
}

/**
 * Protocol-independent causal workspace view for a single client/LLM session.
 *
 * - Remembers every file slice read by the session along with its revision and symbol-slice Early Cutoff hash.
 * - Detects intervening external or peer-agent writes and synthesizes compact diffs once per new revision.
 * - Suppresses false-positive invalidation via `computeSymbolSliceCutoffHash` when edits only touch comments,
 *   whitespace, or symbols outside the session's observed symbol set.
 * - Prevents lost updates when a session attempts to mutate a file that drifted since it was last read.
 */
export class SessionView {
  public readonly sessionId: string;
  public readonly workspaceRoot: string;
  private readonly records = new Map<string, FileReadRecord>();
  private earlyCutoffCount = 0;

  constructor(workspaceRoot: string, sessionId: string = 'default') {
    this.workspaceRoot = fs.realpathSync(workspaceRoot);
    this.sessionId = sessionId;
  }

  public getStats(): { trackedFiles: number; earlyCutoffHits: number } {
    return {
      trackedFiles: this.records.size,
      earlyCutoffHits: this.earlyCutoffCount,
    };
  }

  public resolveWorkspacePath(targetPath: string): { absPath: string; relPath: string } {
    const lexical = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);
    if (!isPathContained(this.workspaceRoot, lexical)) {
      throw new Error(`Path "${targetPath}" escapes workspace root "${this.workspaceRoot}"`);
    }
    // Verify existing ancestor realpath does not escape via symlink
    let probe = lexical;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      if (!isPathContained(this.workspaceRoot, realProbe)) {
        throw new Error(`Path "${targetPath}" escapes workspace root "${this.workspaceRoot}" via symlink`);
      }
      const suffix = path.relative(probe, lexical);
      const resolvedAbs = suffix ? path.join(realProbe, suffix) : realProbe;
      const relPath = path.relative(this.workspaceRoot, resolvedAbs).split(path.sep).join('/');
      return { absPath: resolvedAbs, relPath };
    }
    const relPath = path.relative(this.workspaceRoot, lexical).split(path.sep).join('/');
    return { absPath: lexical, relPath };
  }

  public recordRead(
    targetPath: string,
    options?: { symbols?: string[]; startLine?: number; endLine?: number },
  ): FileReadRecord {
    const { absPath, relPath } = this.resolveWorkspacePath(targetPath);
    const snap = readDiskSnapshot(absPath);
    const existing = this.records.get(relPath);
    // Merge symbols only if both previous and current read scoped to specific symbols; reading full file widens scope.
    let mergedSymbols: string[] | undefined;
    if (options?.symbols && options.symbols.length > 0) {
      if (!existing) {
        mergedSymbols = [...new Set(options.symbols)].sort();
      } else if (existing.symbols && existing.symbols.length > 0) {
        mergedSymbols = [...new Set([...existing.symbols, ...options.symbols])].sort();
      } else {
        mergedSymbols = undefined;
      }
    }

    const cutoffHash =
      snap.text !== undefined ? computeSymbolSliceCutoffHash(snap.text, mergedSymbols) : undefined;
    const excerpt =
      snap.text !== undefined && Buffer.byteLength(snap.text, 'utf8') <= MAX_EXCERPT_BYTES
        ? snap.text
        : snap.text?.slice(0, MAX_EXCERPT_BYTES);

    const record: FileReadRecord = {
      path: relPath,
      absPath,
      rev: snap.rev,
      cutoffHash,
      symbols: mergedSymbols,
      lineRange:
        options?.startLine !== undefined && options?.endLine !== undefined
          ? [options.startLine, options.endLine]
          : existing?.lineRange,
      excerpt,
      notifiedRev: undefined,
      observedAt: new Date().toISOString(),
    };
    this.records.set(relPath, record);
    return record;
  }

  /**
   * Refresh baseline after an authorized mutation initiated by THIS session itself.
   */
  public recordWrite(targetPath: string): FileReadRecord {
    const { absPath, relPath } = this.resolveWorkspacePath(targetPath);
    const prev = this.records.get(relPath);
    const snap = readDiskSnapshot(absPath);
    const cutoffHash =
      snap.text !== undefined ? computeSymbolSliceCutoffHash(snap.text, prev?.symbols) : undefined;
    const excerpt =
      snap.text !== undefined && Buffer.byteLength(snap.text, 'utf8') <= MAX_EXCERPT_BYTES
        ? snap.text
        : snap.text?.slice(0, MAX_EXCERPT_BYTES);
    const record: FileReadRecord = {
      path: relPath,
      absPath,
      rev: snap.rev,
      cutoffHash,
      symbols: prev?.symbols,
      lineRange: prev?.lineRange,
      excerpt,
      notifiedRev: undefined,
      observedAt: new Date().toISOString(),
    };
    this.records.set(relPath, record);
    return record;
  }

  public recordVfsReads(absPaths: readonly string[]): void {
    for (const candidate of absPaths) {
      try {
        const { relPath } = this.resolveWorkspacePath(candidate);
        if (!relPath || relPath.startsWith('.git/') || relPath === '.git') continue;
        if (!this.records.has(relPath)) {
          this.recordRead(relPath);
        }
      } catch {
        // Ignore paths outside workspace root
      }
    }
  }

  public getRecordedRev(targetPath: string): string | undefined {
    const { relPath } = this.resolveWorkspacePath(targetPath);
    return this.records.get(relPath)?.rev;
  }

  /**
   * Check tracked files for external or concurrent peer modifications.
   * When `includeAlreadyNotified` is false (default for inline `exec` notifications), each new revision
   * is reported once to avoid redundant prompt token bloat while still blocking blind writes until re-read.
   */
  public checkStaleReads(options?: { includeAlreadyNotified?: boolean }): StaleReadNotice[] {
    const notices: StaleReadNotice[] = [];
    const includeAll = options?.includeAlreadyNotified === true;

    for (const record of this.records.values()) {
      const snap = readDiskSnapshot(record.absPath);
      if (snap.rev === record.rev) {
        record.notifiedRev = undefined;
        continue;
      }

      // Early Cutoff: raw bytes changed (e.g., comments, formatting, or unrelated symbol body),
      // but the semantic projection this session depends on is identical!
      if (
        snap.exists &&
        record.rev !== 'missing' &&
        snap.text !== undefined &&
        record.cutoffHash !== undefined
      ) {
        const currentCutoff = computeSymbolSliceCutoffHash(snap.text, record.symbols);
        if (currentCutoff === record.cutoffHash) {
          record.rev = snap.rev;
          record.excerpt =
            Buffer.byteLength(snap.text, 'utf8') <= MAX_EXCERPT_BYTES
              ? snap.text
              : snap.text.slice(0, MAX_EXCERPT_BYTES);
          record.notifiedRev = undefined;
          this.earlyCutoffCount++;
          continue;
        }
      }

      if (!includeAll && record.notifiedRev === snap.rev) {
        continue;
      }
      record.notifiedRev = snap.rev;

      const reason: StaleReadNotice['reason'] =
        record.rev === 'missing' ? 'created' : !snap.exists ? 'deleted' : 'modified';

      notices.push({
        path: record.path,
        previousRev: record.rev,
        currentRev: snap.rev,
        reason,
        compactDiff: buildCompactDiff(record.excerpt, snap.text),
      });
    }

    return notices;
  }

  /**
   * Validate causal safety before mutating `targetPath`.
   * - If `expectedRev` is explicitly supplied, `currentRev` on disk MUST match `expectedRev`.
   * - Otherwise, if this session previously observed `targetPath`, `currentRev` MUST match the session's
   *   recorded `rev` (or satisfy Early Cutoff if only comments/unrelated symbols changed).
   */
  public validateMutationTarget(
    targetPath: string,
    expectedRev?: string,
  ): MutationValidationFailure | null {
    const { absPath, relPath } = this.resolveWorkspacePath(targetPath);
    const snap = readDiskSnapshot(absPath);
    const record = this.records.get(relPath);

    if (expectedRev !== undefined) {
      if (snap.rev === expectedRev) return null;
      return {
        path: relPath,
        expectedRev,
        currentRev: snap.rev,
        reason: 'rev_mismatch',
        compactDiff: buildCompactDiff(record?.excerpt, snap.text),
      };
    }

    if (!record) return null;
    if (snap.rev === record.rev) return null;

    if (
      snap.exists &&
      record.rev !== 'missing' &&
      snap.text !== undefined &&
      record.cutoffHash !== undefined &&
      computeSymbolSliceCutoffHash(snap.text, record.symbols) === record.cutoffHash
    ) {
      record.rev = snap.rev;
      record.excerpt =
        Buffer.byteLength(snap.text, 'utf8') <= MAX_EXCERPT_BYTES
          ? snap.text
          : snap.text.slice(0, MAX_EXCERPT_BYTES);
      this.earlyCutoffCount++;
      return null;
    }

    return {
      path: relPath,
      expectedRev: record.rev,
      currentRev: snap.rev,
      reason: 'stale_read',
      compactDiff: buildCompactDiff(record.excerpt, snap.text),
    };
  }
}
