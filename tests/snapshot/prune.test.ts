import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('ProcessSupervisor.pruneSnapshots', () => {
  let tempDir: string;
  let repoDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-prune-test-'));
    repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Tester']);
    git(repoDir, ['config', 'user.email', 'tester@test.local']);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'prune-domain');
    supervisor = new ProcessSupervisor(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task-1', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    store.saveRun({
      id: 'run-1',
      taskId: 'task-1',
      domainId: domain.domainId,
      owner: 'test',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('删除私有 ref 与 store 记录并写 SNAPSHOT_PRUNED；未知 id 幂等跳过', async () => {
    const res = await supervisor.captureSnapshot({ runId: 'run-1', opId: 'op-snap-1', roots: [repoDir] });
    const id = res.snapshot!.id;
    expect(git(repoDir, ['for-each-ref', `refs/xioflow/snapshots/${id}`])).not.toBe('');

    const pruned = await supervisor.pruneSnapshots([id, 'snap-unknown'], { runId: 'run-1' });

    expect(pruned).toEqual([id]);
    expect(git(repoDir, ['for-each-ref', `refs/xioflow/snapshots/${id}`])).toBe('');
    expect(domain.getStore().getSnapshot(id)).toBeNull();
    const events = domain.getStore().getJournalEvents(domain.domainId).filter((e) => e.type === 'SNAPSHOT_PRUNED');
    expect(events).toHaveLength(1);
    expect(events[0].payload.snapshotId).toBe(id);
    await expect(
      supervisor.rollback({ runId: 'run-1', opId: 'op-rb-1', snapshotId: id }),
    ).rejects.toThrow(/Snapshot not found/);
  });
});
