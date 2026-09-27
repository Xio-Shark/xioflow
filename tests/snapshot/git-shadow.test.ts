import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import { execFile } from 'node:child_process';
import { GitShadowSnapshotDriver } from '../../src/snapshot/git-shadow.js';
import { UnsupportedCapabilityError } from '../../src/types.js';

const execFileAsync = util.promisify(execFile);

describe('GitShadowSnapshotDriver (Step 1 & Step 3 & Step 5)', () => {
  let tempDir: string;
  let driver: GitShadowSnapshotDriver;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-git-shadow-test-'));
    driver = new GitShadowSnapshotDriver();
  });

  afterEach(async () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function git(cwd: string, args: string[]) {
    return await execFileAsync('git', args, { cwd });
  }

  async function makeRepo(): Promise<string> {
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    await git(repoDir, ['init', '-b', 'main']);
    await git(repoDir, ['config', 'user.name', 'Tester']);
    await git(repoDir, ['config', 'user.email', 'tester@test.local']);

    // 添加初始文件并提交
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Initial Repo\n');
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.env\nnode_modules/\n*.ignored\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Initial commit']);

    return repoDir;
  }

  it('1.0 非 git 目录显式失败抛出 UnsupportedCapabilityError', async () => {
    const nonGitDir = path.join(tempDir, 'not-a-repo');
    fs.mkdirSync(nonGitDir, { recursive: true });

    await expect(driver.capture([nonGitDir])).rejects.toThrow(UnsupportedCapabilityError);
    await expect(driver.fingerprint([nonGitDir])).rejects.toThrow(UnsupportedCapabilityError);
  });

  it('1.1 契约 32: 快照前后用户的 git status、HEAD、分支逐字完全一致，不改动用户现场', async () => {
    const repoDir = await makeRepo();

    // 构造复杂现场：暂存区有改动、工作区有未暂存改动、有未跟踪文件、有被忽略文件
    fs.writeFileSync(path.join(repoDir, 'staged.txt'), 'staged content\n');
    await git(repoDir, ['add', 'staged.txt']);

    fs.writeFileSync(path.join(repoDir, 'unstaged.txt'), 'unstaged content\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET_KEY=12345\n');

    const statusBefore = (await git(repoDir, ['status', '--porcelain'])).stdout;
    const stageBefore = (await git(repoDir, ['ls-files', '--stage'])).stdout;
    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout;
    const branchBefore = (await git(repoDir, ['branch'])).stdout;

    // 执行 capture
    const snapshot = await driver.capture([repoDir], {
      id: 'snap-c32',
      domainId: 'domain-test',
      opId: 'op-c32',
    });

    expect(snapshot.id).toBe('snap-c32');
    expect(snapshot.driver).toBe('git-shadow');
    expect(snapshot.coverage).toBe('worktree_non_ignored');
    expect(snapshot.treeFingerprint).toBeTruthy();
    expect(snapshot.commitHash).toBeTruthy();

    // 快照后逐字断言
    const statusAfter = (await git(repoDir, ['status', '--porcelain'])).stdout;
    const stageAfter = (await git(repoDir, ['ls-files', '--stage'])).stdout;
    const headAfter = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout;
    const branchAfter = (await git(repoDir, ['branch'])).stdout;

    expect(statusAfter).toBe(statusBefore);
    expect(stageAfter).toBe(stageBefore);
    expect(headAfter).toBe(headBefore);
    expect(branchAfter).toBe(branchBefore);
  });

  it('1.2 includeIgnored=false vs true 差异与树大小报告', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'ignored.ignored'), 'ignored bytes '.repeat(100));

    // false
    const snap1 = await driver.capture([repoDir], { includeIgnored: false });
    expect(snap1.coverage).toBe('worktree_non_ignored');
    const { stdout: tree1 } = await git(repoDir, ['ls-tree', '-r', snap1.treeFingerprint]);
    expect(tree1).not.toContain('ignored.ignored');

    // true
    const snap2 = await driver.capture([repoDir], { includeIgnored: true });
    expect(snap2.coverage).toBe('full_tree');
    const { stdout: tree2 } = await git(repoDir, ['ls-tree', '-r', snap2.treeFingerprint]);
    expect(tree2).toContain('ignored.ignored');
    expect(snap2.treeSizeBytes).toBeGreaterThan(0);
  });

  it('1.3 git gc --prune=now 后 refs/xioflow/snapshots/<id> 仍指向可读 commit 与 tree', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'some content\n');

    const snap = await driver.capture([repoDir], { id: 'snap-gc-test' });

    // 执行强力垃圾回收
    await git(repoDir, ['gc', '--prune=now']);

    // 验证 ref 存在且指向的对象依然完好可读
    const { stdout: catTree } = await git(repoDir, ['cat-file', '-t', snap.treeFingerprint]);
    expect(catTree.trim()).toBe('tree');

    const { stdout: catCommit } = await git(repoDir, ['cat-file', '-t', snap.commitHash!]);
    expect(catCommit.trim()).toBe('commit');

    // 验证 prune 可以删除 ref
    await driver.prune([snap.id]);
    await expect(git(repoDir, ['rev-parse', `refs/xioflow/snapshots/${snap.id}`])).rejects.toThrow();
  });

  it('1.4 契约 28: restore 回滚后指纹核验，被忽略文件保留，新增文件清除', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'app.ts'), 'console.log(1);\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'API_KEY=original\n');

    const snapshot = await driver.capture([repoDir]);

    // 修改已存在文件，增加新文件，修改被忽略文件
    fs.writeFileSync(path.join(repoDir, 'app.ts'), 'console.log(2);\n');
    fs.writeFileSync(path.join(repoDir, 'extra.txt'), 'extra untracked\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'API_KEY=modified\n');

    const res = await driver.restore(snapshot);
    expect(res.unrestoredPaths).toHaveLength(0);

    // 核验回滚结果
    expect(fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf8')).toBe('console.log(1);\n');
    // extra.txt 应该被清除（因为未被忽略且不在快照中）
    expect(fs.existsSync(path.join(repoDir, 'extra.txt'))).toBe(false);
    // .env 应该原样保留修改（因为被忽略，绝对不碰）
    expect(fs.readFileSync(path.join(repoDir, '.env'), 'utf8')).toBe('API_KEY=modified\n');

    // 指纹核验
    const fp = await driver.fingerprint([repoDir]);
    expect(fp).toBe(snapshot.treeFingerprint);
  });

  it('1.5 契约 54: materialize 分叉为独立 worktree，源工作区不受影响，dematerialize 清理无残留', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const a = 1;\n');

    const snap = await driver.capture([repoDir]);

    const forkDir = path.join(tempDir, 'fork-1');
    const { worktreePath } = await driver.materialize(snap.id, forkDir);

    expect(worktreePath).toBe(forkDir);
    expect(fs.existsSync(path.join(forkDir, 'feature.ts'))).toBe(true);

    // 检查 git worktree list
    const { stdout: wtList } = await git(repoDir, ['worktree', 'list']);
    expect(wtList).toContain(forkDir);

    // dematerialize
    await driver.dematerialize(forkDir);
    expect(fs.existsSync(forkDir)).toBe(false);

    const { stdout: wtListAfter } = await git(repoDir, ['worktree', 'list']);
    expect(wtListAfter).not.toContain(forkDir);
  });
});
