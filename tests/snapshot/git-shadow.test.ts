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

  it('1.4b [回归保护] 只对子目录快照时，restore 不得改动 roots 之外的未提交改动与新文件', async () => {
    const repoDir = await makeRepo();
    fs.mkdirSync(path.join(repoDir, 'a'));
    fs.mkdirSync(path.join(repoDir, 'b'));
    fs.writeFileSync(path.join(repoDir, 'a', 'f.txt'), 'a0\n');
    fs.writeFileSync(path.join(repoDir, 'a', '中文.txt'), 'zh0\n');
    fs.writeFileSync(path.join(repoDir, 'b', 'g.txt'), 'b0\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'add a/ b/']);

    const snapshot = await driver.capture([path.join(repoDir, 'a')]);

    // agent 在 roots 内的改动
    fs.writeFileSync(path.join(repoDir, 'a', 'f.txt'), 'a1-agent\n');
    fs.writeFileSync(path.join(repoDir, 'a', '中文.txt'), 'zh1-agent\n');
    fs.writeFileSync(path.join(repoDir, 'a', 'new.txt'), 'agent created\n');
    // 用户在 roots 之外未提交的改动
    fs.writeFileSync(path.join(repoDir, 'b', 'g.txt'), 'b1-user-uncommitted\n');
    fs.writeFileSync(path.join(repoDir, 'b', 'user-new.txt'), 'user created\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# user edit\n');

    const res = await driver.restore(snapshot);
    expect(res.unrestoredPaths).toHaveLength(0);

    // roots 内回到快照
    expect(fs.readFileSync(path.join(repoDir, 'a', 'f.txt'), 'utf8')).toBe('a0\n');
    expect(fs.readFileSync(path.join(repoDir, 'a', '中文.txt'), 'utf8')).toBe('zh0\n');
    expect(fs.existsSync(path.join(repoDir, 'a', 'new.txt'))).toBe(false);
    // roots 外逐字不变
    expect(fs.readFileSync(path.join(repoDir, 'b', 'g.txt'), 'utf8')).toBe('b1-user-uncommitted\n');
    expect(fs.readFileSync(path.join(repoDir, 'b', 'user-new.txt'), 'utf8')).toBe('user created\n');
    expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toBe('# user edit\n');

    // 用户随后提交了 roots 之外的改动（HEAD 前进）：以快照为基线的核验指纹仍应与快照一致
    await git(repoDir, ['add', 'b', 'README.md']);
    await git(repoDir, ['commit', '-m', 'user commit outside roots']);
    const fp = await driver.fingerprint([path.join(repoDir, 'a')], { against: snapshot });
    expect(fp).toBe(snapshot.treeFingerprint);
  });

  it('1.4d [回归保护] restore 只重写与快照有差异的文件，未改动文件的 mtime 保持不变', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'stable.txt'), 'stable\n');
    fs.writeFileSync(path.join(repoDir, 'changed.txt'), 'v1\n');
    fs.writeFileSync(path.join(repoDir, 'removed.txt'), 'will be deleted by agent\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'files']);

    const snapshot = await driver.capture([repoDir]);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(repoDir, 'stable.txt'), past, past);
    const stableMtime = fs.statSync(path.join(repoDir, 'stable.txt')).mtimeMs;

    fs.writeFileSync(path.join(repoDir, 'changed.txt'), 'v2\n');
    fs.rmSync(path.join(repoDir, 'removed.txt'));

    const res = await driver.restore(snapshot);
    expect(res.unrestoredPaths).toHaveLength(0);
    expect(fs.readFileSync(path.join(repoDir, 'changed.txt'), 'utf8')).toBe('v1\n');
    expect(fs.readFileSync(path.join(repoDir, 'removed.txt'), 'utf8')).toBe('will be deleted by agent\n');
    expect(fs.statSync(path.join(repoDir, 'stable.txt')).mtimeMs).toBe(stableMtime);
  });

  it('1.4c [回归保护] includeIgnored 快照回滚后，同口径指纹核验一致', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'cache.ignored'), 'v1\n');
    const snapshot = await driver.capture([repoDir], { includeIgnored: true });
    expect(snapshot.coverage).toBe('full_tree');

    fs.writeFileSync(path.join(repoDir, 'cache.ignored'), 'v2\n');
    const res = await driver.restore(snapshot);
    expect(res.unrestoredPaths).toHaveLength(0);
    expect(fs.readFileSync(path.join(repoDir, 'cache.ignored'), 'utf8')).toBe('v1\n');

    const fp = await driver.fingerprint([repoDir], { against: snapshot });
    expect(fp).toBe(snapshot.treeFingerprint);
  });

  it('1.4e 快照之后 .gitignore 少了一行：当时被忽略、不在快照里的文件不得被当成新文件删掉', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, '.env'), 'API_KEY=original\n');
    const snapshot = await driver.capture([repoDir]);

    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(repoDir, 'extra.txt'), 'new and not ignored\n');

    const res = await driver.restore(snapshot);
    expect(res.unrestoredPaths).toHaveLength(0);
    expect(fs.readFileSync(path.join(repoDir, '.env'), 'utf8')).toBe('API_KEY=original\n');
    expect(fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8')).toBe('.env\nnode_modules/\n*.ignored\n');
    expect(fs.existsSync(path.join(repoDir, 'extra.txt'))).toBe(false);
    expect(await driver.fingerprint([repoDir], { against: snapshot })).toBe(snapshot.treeFingerprint);
  });

  it('1.4f 快照之后 .gitignore 多了一行：被新规则藏起来的新文件按快照时的规则清除', async () => {
    const repoDir = await makeRepo();
    const snapshot = await driver.capture([repoDir]);

    fs.appendFileSync(path.join(repoDir, '.gitignore'), 'junk.txt\n');
    fs.writeFileSync(path.join(repoDir, 'junk.txt'), 'hidden by the new rule\n');
    fs.mkdirSync(path.join(repoDir, 'sub'));
    fs.writeFileSync(path.join(repoDir, 'sub', '.gitignore'), 'secret.txt\n');
    fs.writeFileSync(path.join(repoDir, 'sub', 'secret.txt'), 'hidden by a new nested rule file\n');

    const res = await driver.restore(snapshot);
    expect(res.unrestoredPaths).toHaveLength(0);
    expect(fs.existsSync(path.join(repoDir, 'junk.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'sub', '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'sub', 'secret.txt'))).toBe(false);
    expect(await driver.fingerprint([repoDir], { against: snapshot })).toBe(snapshot.treeFingerprint);
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

  it('1.6 [回归保护] 宿主重启（新驱动实例、内存映射为空）后 dematerialize 与 prune 仍可用，未知仓库时 prune 显式报错', async () => {
    const repoDir = await makeRepo();
    fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const b = 2;\n');

    const snap = await driver.capture([repoDir], { id: 'snap-restart' });
    const forkDir = path.join(tempDir, 'fork-restart');
    await driver.materialize(snap.id, forkDir);

    // 模拟宿主重启：换一个全新的驱动实例
    const restarted = new GitShadowSnapshotDriver();

    await restarted.dematerialize(forkDir);
    expect(fs.existsSync(forkDir)).toBe(false);
    const { stdout: wtList } = await git(repoDir, ['worktree', 'list']);
    expect(wtList).not.toContain(forkDir);

    // 不给 repoRoot 不能静默跳过
    await expect(restarted.prune([snap.id])).rejects.toThrow(/repository root unknown/);
    await expect(git(repoDir, ['rev-parse', `refs/xioflow/snapshots/${snap.id}`])).resolves.toBeTruthy();

    await restarted.prune([snap.id], { repoRoot: snap.roots[0] });
    await expect(git(repoDir, ['rev-parse', `refs/xioflow/snapshots/${snap.id}`])).rejects.toThrow();
  });
});
