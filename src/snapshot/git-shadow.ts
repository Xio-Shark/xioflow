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
      } catch {}

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

  public async fingerprint(roots: string[]): Promise<string> {
    if (!roots || roots.length === 0) {
      throw new Error('fingerprint requires at least one root directory');
    }
    const realRoots = await Promise.all(roots.map((r) => resolveRealPath(r)));
    const { repoRoot } = await this.assertGitRepo(realRoots[0]);

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xio-git-shadow-fp-'));
    const indexFile = path.join(tempDir, 'index');
    const env: Record<string, string> = { GIT_INDEX_FILE: indexFile };

    try {
      try {
        await this.git(repoRoot, ['read-tree', 'HEAD'], env);
      } catch {}

      const addArgs = ['add', '-A', '--'];
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

      // 2. 查出快照中的所有文件路径（相对 repoRoot）
      const { stdout: snapshotFilesOut } = await this.git(repoRoot, ['ls-tree', '-r', '--name-only', snapshot.treeFingerprint]);
      const snapshotFiles = new Set(
        snapshotFilesOut
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      );

      // 3. 查出当前工作区中存在、未被忽略的全部文件（tracked + untracked）
      // 严格尊重 .gitignore，绝不能动被忽略文件（如 .env, node_modules）
      const { stdout: liveFilesOut } = await this.git(repoRoot, ['ls-files', '--exclude-standard', '-c', '-o']);
      const liveFiles = liveFilesOut
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      // 4. 清理「在工作区中未被忽略、但不在快照中」的文件
      for (const liveRel of liveFiles) {
        if (!snapshotFiles.has(liveRel)) {
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
      }

      // 5. 通过临时 index 检出覆盖工作区文件 (checkout-index -a -f)
      try {
        await this.git(repoRoot, ['checkout-index', '-a', '-f'], env);
      } catch (checkoutErr: any) {
        const lines = (checkoutErr.message || '').split('\n');
        for (const line of lines) {
          const match = line.match(/unable to (?:create|unlink) file '([^']+)'/i);
          if (match) {
            unrestoredPaths.push(path.resolve(repoRoot, match[1]));
          }
        }
        if (unrestoredPaths.length === 0) {
          throw checkoutErr;
        }
      }

      return { unrestoredPaths };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  public async prune(snapshotIds: string[], options?: { repoRoot?: string }): Promise<void> {
    for (const id of snapshotIds) {
      const repoRoot = options?.repoRoot || this.snapshotRepos.get(id);
      if (repoRoot) {
        try {
          await this.git(repoRoot, ['update-ref', '-d', `refs/xioflow/snapshots/${id}`]);
        } catch {}
      }
      this.snapshotRepos.delete(id);
    }
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
      await this.git(path.dirname(realPath), args);
    }
    this.worktreeRepos.delete(realPath);
    this.worktreeRepos.delete(rawPath);
  }
}
