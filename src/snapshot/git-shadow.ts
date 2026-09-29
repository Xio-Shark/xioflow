import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import { execFile } from 'node:child_process';
import {
  SnapshotDriver,
  SnapshotRef,
  UnsupportedCapabilityError,
} from '../types.js';

const execFileAsync = util.promisify(execFile);

export interface GitShadowDriverOptions {
  execGitTimeoutMs?: number;
}

async function resolveRealPath(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export class GitShadowSnapshotDriver implements SnapshotDriver {
  public readonly name = 'git-shadow';
  public readonly coverage = 'worktree_non_ignored';
  private readonly timeoutMs: number;
  private readonly snapshotRepos: Map<string, string> = new Map();
  private readonly worktreeRepos: Map<string, string> = new Map();

  constructor(options?: GitShadowDriverOptions) {
    this.timeoutMs = options?.execGitTimeoutMs ?? 15000;
  }

  private async git(
    cwd: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const mergedEnv = env ? { ...process.env, ...env } : process.env;
      return await execFileAsync('git', args, {
        cwd,
        env: mergedEnv,
        timeout: this.timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err: any) {
      const msg = err.stderr || err.stdout || err.message;
      throw new Error(`git ${args[0]} failed: ${msg}`);
    }
  }

  /**
   * 两棵树之间逐文件的差异（不做重命名合并）。路径相对仓库根，`-z` 保证非 ASCII 路径原样返回。
   * status：A 新增、D 删除、M 内容变化、T 类型变化（文件 / 符号链接 / 子模块）。
   */
  public async diffTrees(
    cwd: string,
    fromTree: string,
    toTree: string,
    pathspecs: string[] = []
  ): Promise<Array<{ status: 'A' | 'D' | 'M' | 'T'; path: string }>> {
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, toTree];
    if (pathspecs.length > 0) args.push('--', ...pathspecs);
    const { stdout } = await this.git(cwd, args);
    const fields = stdout.split('\0').filter(Boolean);
    const changes: Array<{ status: 'A' | 'D' | 'M' | 'T'; path: string }> = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i];
      if (status !== 'A' && status !== 'D' && status !== 'M' && status !== 'T') {
        throw new Error(`git diff-tree reported unexpected status "${status}" for ${fields[i + 1]}`);
      }
      changes.push({ status, path: fields[i + 1] });
    }
    return changes;
  }

  public async assertGitRepo(cwd: string): Promise<{ repoRoot: string; commonDir: string }> {
    try {
      const realCwd = await resolveRealPath(cwd);
      const { stdout: rootOut } = await this.git(realCwd, ['rev-parse', '--show-toplevel']);
      const repoRoot = await resolveRealPath(rootOut.trim());
      const { stdout: commonOut } = await this.git(realCwd, ['rev-parse', '--git-common-dir']);
      const rawCommon = commonOut.trim();
      const commonDir = path.isAbsolute(rawCommon)
        ? await resolveRealPath(rawCommon)
        : await resolveRealPath(path.resolve(repoRoot, rawCommon));
      return { repoRoot, commonDir };
    } catch {
      throw new UnsupportedCapabilityError('snapshot:git-shadow', process.platform);
    }
  }

  public async capture(
    roots: string[],
    options?: {
      id?: string;
      domainId?: string;
      opId?: string;
      includeIgnored?: boolean;
      maxTreeSizeBytes?: number;
    }
  ): Promise<SnapshotRef> {
    if (!roots || roots.length === 0) {
      throw new Error('capture requires at least one root directory');
    }

    const realRoots = await Promise.all(roots.map((r) => resolveRealPath(r)));
    const { repoRoot } = await this.assertGitRepo(realRoots[0]);

    const snapshotId = options?.id || `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xio-git-shadow-index-'));
    const indexFile = path.join(tempDir, 'index');
    const env: Record<string, string> = { GIT_INDEX_FILE: indexFile };

    try {
      // 1. 若存在有效 HEAD，将 HEAD 的 tree 读入临时 index 作为基线
      let hasHead = false;
      try {
        await this.git(repoRoot, ['rev-parse', '--verify', 'HEAD'], env);
        hasHead = true;
      } catch {
        hasHead = false;
      }

      if (hasHead) {
        await this.git(repoRoot, ['read-tree', 'HEAD'], env);
      }

      // 2. 将指定 roots 的工作区改动加入临时 index
      const addArgs = ['add', '-A'];
      if (options?.includeIgnored) {
        addArgs.push('-f');
      }
      addArgs.push('--');
      for (const r of realRoots) {
        const rel = path.relative(repoRoot, r) || '.';
        addArgs.push(rel);
      }

      await this.git(repoRoot, addArgs, env);

      // 3. 写入 tree
      const { stdout: treeOut } = await this.git(repoRoot, ['write-tree'], env);
      const treeFingerprint = treeOut.trim();

      // 4. 统计树大小与大小限制检查
      let treeSizeBytes: number | undefined;
      try {
        const { stdout: lsTreeOut } = await this.git(repoRoot, ['ls-tree', '-r', '-l', treeFingerprint]);
        let total = 0;
        for (const line of lsTreeOut.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4 && parts[1] === 'blob') {
            const size = parseInt(parts[3], 10);
            if (!isNaN(size)) total += size;
          }
        }
        treeSizeBytes = total;
      } catch (sizeErr: any) {
        // 调用方设了大小上限却无法统计大小时，不能静默跳过上限检查
        if (options?.maxTreeSizeBytes) {
          throw new Error(
            `Cannot enforce maxTreeSizeBytes=${options.maxTreeSizeBytes}: failed to measure snapshot tree size: ${sizeErr?.message ?? String(sizeErr)}`
          );
        }
        treeSizeBytes = undefined;
      }

      if (options?.maxTreeSizeBytes && treeSizeBytes !== undefined && treeSizeBytes > options.maxTreeSizeBytes) {
        throw new Error(
          `Snapshot tree size (${treeSizeBytes} bytes) exceeds limit of ${options.maxTreeSizeBytes} bytes`
        );
      }

      // 5. 创建独立提交对象（防 gc）并写入私有 ref
      const commitEnv: Record<string, string> = {
        ...env,
        GIT_AUTHOR_NAME: 'xioflow Snapshot',
        GIT_AUTHOR_EMAIL: 'snapshot@xioflow.local',
        GIT_COMMITTER_NAME: 'xioflow Snapshot',
        GIT_COMMITTER_EMAIL: 'snapshot@xioflow.local',
      };

      const { stdout: commitOut } = await this.git(
        repoRoot,
        ['commit-tree', treeFingerprint, '-m', `xioflow snapshot ${snapshotId}`],
        commitEnv
      );
      const commitHash = commitOut.trim();

      const refName = `refs/xioflow/snapshots/${snapshotId}`;
      await this.git(repoRoot, ['update-ref', refName, commitHash]);

      this.snapshotRepos.set(snapshotId, repoRoot);

      const ref: SnapshotRef = {
        id: snapshotId,
        domainId: options?.domainId || 'default',
        opId: options?.opId || 'default-op',
        driver: this.name,
        roots: realRoots,
        coverage: options?.includeIgnored ? 'full_tree' : 'worktree_non_ignored',
        treeFingerprint,
        commitHash,
        createdAt: new Date().toISOString(),
        treeSizeBytes,
      };

      return ref;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  public async fingerprint(roots: string[], options?: { against?: SnapshotRef }): Promise<string> {
    if (!roots || roots.length === 0) {
      throw new Error('fingerprint requires at least one root directory');
    }
    const against = options?.against;
    const realRoots = await Promise.all(roots.map((r) => resolveRealPath(r)));
    const { repoRoot } = await this.assertGitRepo(realRoots[0]);

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xio-git-shadow-fp-'));
    const indexFile = path.join(tempDir, 'index');
    const env: Record<string, string> = { GIT_INDEX_FILE: indexFile };

    try {
      // 与 capture 保持一致：只有"没有 HEAD（空仓库）"才跳过基线；read-tree 本身失败必须暴露，
      // 否则会得到一个与 capture 口径不同的指纹，回滚核验会给出错误结论
      if (against) {
        // 以快照树为基线：roots 之外的条目与快照逐字相同，只有 roots 内的差异会改变指纹
        await this.git(repoRoot, ['read-tree', against.treeFingerprint], env);
      } else {
        const hasHead = await this.git(repoRoot, ['rev-parse', '--verify', 'HEAD'], env).then(
          () => true,
          () => false
        );
        if (hasHead) {
          await this.git(repoRoot, ['read-tree', 'HEAD'], env);
        }
      }

      const addArgs = ['add', '-A'];
      if (against?.coverage === 'full_tree') {
        // 与 capture(includeIgnored: true) 同口径
        addArgs.push('-f');
      }
      addArgs.push('--');
      for (const r of realRoots) {
        const rel = path.relative(repoRoot, r) || '.';
        addArgs.push(rel);
      }
      await this.git(repoRoot, addArgs, env);

      const { stdout } = await this.git(repoRoot, ['write-tree'], env);
      return stdout.trim();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  public async restore(
    snapshot: SnapshotRef,
    _options?: { force?: boolean }
  ): Promise<{ unrestoredPaths: string[] }> {
    const unrestoredPaths: string[] = [];
    if (!snapshot.roots || snapshot.roots.length === 0) {
      throw new Error('Snapshot contains no root paths');
    }

    const realRoots = await Promise.all(snapshot.roots.map((r) => resolveRealPath(r)));
    const { repoRoot } = await this.assertGitRepo(realRoots[0]);

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xio-git-shadow-restore-'));
    const indexFile = path.join(tempDir, 'index');
    const env: Record<string, string> = { GIT_INDEX_FILE: indexFile };

    try {
      // 1. 读取快照树到临时 index
      const treeOrCommit = snapshot.commitHash || snapshot.treeFingerprint;
      await this.git(repoRoot, ['read-tree', treeOrCommit], env);

      // 快照树 = HEAD 基线 + roots 内的工作区改动，roots 之外的条目只是 HEAD 的副本，
      // 因此所有读取与写回都必须限定在 roots 内，否则会把用户在 roots 之外未提交的改动覆盖回 HEAD。
      const rootPathspecs = realRoots.map((r) => path.relative(repoRoot, r) || '.');
      const splitZ = (out: string) => out.split('\0').filter(Boolean);

      // 2. 以快照口径算出 roots 当前的树，只处理与快照有差异的路径：
      // 全量 checkout-index 会在 roots=仓库根时重写整个仓库（mtime 全变，触发 watcher / 增量构建）。
      const currentTree = await this.fingerprint(snapshot.roots, { against: snapshot });
      const toCheckout: string[] = [];
      const toDelete: string[] = [];
      for (const change of await this.diffTrees(repoRoot, currentTree, snapshot.treeFingerprint, rootPathspecs)) {
        // current → snapshot 方向：D 表示快照里没有、当前有
        if (change.status === 'D') toDelete.push(change.path);
        else toCheckout.push(change.path);
      }

      // 3. 删除候选只能是未被忽略的文件（tracked + untracked）：
      // 严格尊重 .gitignore，绝不能动被忽略文件（如 .env, node_modules），full_tree 快照也一样
      let deletable = toDelete;
      if (toDelete.length > 0 && snapshot.coverage === 'full_tree') {
        const { stdout: liveFilesOut } = await this.git(repoRoot, [
          'ls-files',
          '-z',
          '--exclude-standard',
          '-c',
          '-o',
          '--',
          ...rootPathspecs,
        ]);
        const liveFiles = new Set(splitZ(liveFilesOut));
        deletable = toDelete.filter((rel) => liveFiles.has(rel));
      }

      // 4. 清理「在工作区中未被忽略、但不在快照中」的文件
      for (const liveRel of deletable) {
        const absPath = path.resolve(repoRoot, liveRel);
        const inScope = realRoots.some((root) => absPath === root || absPath.startsWith(root + path.sep));
        if (inScope) {
          try {
            await fs.promises.access(absPath, fs.constants.W_OK);
            await fs.promises.unlink(absPath);
          } catch {
            unrestoredPaths.push(absPath);
          }
        }
      }

      // 5. 通过临时 index 只检出与快照有差异的文件（分批传参，避免超长 argv）
      const CHECKOUT_BATCH = 500;
      for (let i = 0; i < toCheckout.length; i += CHECKOUT_BATCH) {
        const batch = toCheckout.slice(i, i + CHECKOUT_BATCH);
        try {
          await this.git(repoRoot, ['checkout-index', '-f', '--', ...batch], env);
        } catch (checkoutErr: any) {
          const before = unrestoredPaths.length;
          const lines = (checkoutErr.message || '').split('\n');
          for (const line of lines) {
            const match = line.match(/unable to (?:create|unlink|write) file '?([^':]+)'?/i);
            if (match) {
              unrestoredPaths.push(path.resolve(repoRoot, match[1].trim()));
            }
          }
          if (unrestoredPaths.length === before) {
            throw checkoutErr;
          }
        }
      }

      return { unrestoredPaths };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  public async prune(snapshotIds: string[], options?: { repoRoot?: string }): Promise<void> {
    for (const id of snapshotIds) {
      // 内存映射在宿主重启后为空；此时必须由调用方给出 repoRoot，不能静默跳过让快照 ref 永久残留
      const repoRoot = options?.repoRoot || this.snapshotRepos.get(id);
      if (!repoRoot) {
        throw new Error(
          `Cannot prune snapshot ${id}: source repository root unknown (pass options.repoRoot, e.g. SnapshotRef.roots[0])`
        );
      }
      const refName = `refs/xioflow/snapshots/${id}`;
      const { repoRoot: resolvedRoot } = await this.assertGitRepo(repoRoot);
      // 仓库已确认存在后，只把"ref 本来就不存在"视为已清理；删除失败原样抛出
      const exists = await this.git(resolvedRoot, ['show-ref', '--verify', '--quiet', refName]).then(
        () => true,
        () => false
      );
      if (exists) {
        await this.git(resolvedRoot, ['update-ref', '-d', refName]);
      }
      this.snapshotRepos.delete(id);
    }
  }

  /**
   * 从 linked worktree 自身反查所属仓库的 git common dir（不依赖进程内存映射，宿主重启后仍可用）
   */
  private async resolveWorktreeCommonDir(worktreePath: string): Promise<string> {
    const { stdout } = await this.git(worktreePath, ['rev-parse', '--git-common-dir']);
    const raw = stdout.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);
  }

  public async materialize(
    snapshotId: string,
    newRoot: string,
    options?: { repoRoot?: string }
  ): Promise<{ worktreePath: string }> {
    const rawPath = path.resolve(newRoot);
    const repoRoot = options?.repoRoot || this.snapshotRepos.get(snapshotId);
    if (!repoRoot) {
      throw new Error(`Cannot materialize snapshot ${snapshotId}: source repository root unknown`);
    }
    const refName = `refs/xioflow/snapshots/${snapshotId}`;
    await this.git(repoRoot, ['worktree', 'add', '--detach', rawPath, refName]);
    const realWorktreePath = await resolveRealPath(rawPath);
    this.worktreeRepos.set(rawPath, repoRoot);
    this.worktreeRepos.set(realWorktreePath, repoRoot);
    return { worktreePath: rawPath };
  }

  public async dematerialize(
    newRoot: string,
    options?: { force?: boolean; repoRoot?: string }
  ): Promise<void> {
    const rawPath = path.resolve(newRoot);
    let realPath: string;
    try {
      realPath = await resolveRealPath(newRoot);
    } catch {
      realPath = rawPath;
    }
    const repoRoot =
      options?.repoRoot ||
      this.worktreeRepos.get(realPath) ||
      this.worktreeRepos.get(rawPath);

    const args = ['worktree', 'remove'];
    if (options?.force) {
      args.push('--force');
    }
    args.push(realPath);
    if (repoRoot) {
      await this.git(repoRoot, args);
    } else {
      // 宿主重启后映射为空：从 worktree 自身反查仓库，而不是猜测父目录是仓库
      const commonDir = await this.resolveWorktreeCommonDir(realPath);
      await this.git(path.dirname(realPath), [`--git-dir=${commonDir}`, ...args]);
    }
    this.worktreeRepos.delete(realPath);
    this.worktreeRepos.delete(rawPath);
  }
}
