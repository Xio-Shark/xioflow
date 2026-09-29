import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('workspace transactions (optimistic parallel agents)', () => {
  let tempDir: string;
  let repoDir: string;
  let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor;
  let opCounter = 0;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-tx-test-')));
    repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Tester']);
    git(repoDir, ['config', 'user.email', 'tester@test.local']);
    fs.writeFileSync(path.join(repoDir, 'config.json'), '{"port":1}\n');
    fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repoDir, 'src/b.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(repoDir, 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 });
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'tx-domain');
    supervisor = new ProcessSupervisor(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 't', createdAt: new Date().toISOString() });
    for (const runId of ['run-a', 'run-b']) {
      store.saveRun({
        id: runId,
        taskId: 'task',
        domainId: domain.domainId,
        owner: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function begin(txId: string, runId: string) {
    const tx = await supervisor.beginWorkspaceTransaction({ txId, runId, root: repoDir, forkPath: path.join(tempDir, `fork-${txId}`) });
    // CI pins the expectation so a runner that silently lost atime tracking cannot pass through the honest fallback
    if (process.env.XIOFLOW_EXPECT_READ_TRACKING) expect(tx.readTracking).toBe(process.env.XIOFLOW_EXPECT_READ_TRACKING);
    return tx;
  }

  /** An agent tool call: a real child process working inside the transaction's fork. */
  async function agent(runId: string, cwd: string, script: string) {
    const res = await supervisor.executeProcess({
      runId,
      opId: `agent-op-${++opCounter}`,
      name: 'agent-tool',
      command: { execPath: process.execPath, args: ['-e', script], cwd },
      requiredResources: [`workspace:write:${cwd}`],
    });
    expect(res.status, res.stderr).toBe('succeeded');
    return res;
  }

  it('commits disjoint parallel edits and applies both write sets to the main workspace', async () => {
    const a = await begin('tx-a', 'run-a');
    const b = await begin('tx-b', 'run-b');
    expect(a.forkRoot).not.toBe(b.forkRoot);

    await agent('run-a', a.forkRoot, `require('fs').writeFileSync('src/a.ts', 'export const a = 2;\\n')`);
    await agent('run-b', b.forkRoot, `
      const fs = require('fs');
      fs.writeFileSync('src/new.ts', 'export const n = 1;\\n');
      fs.rmSync('src/b.ts');
    `);
    // Nothing reaches the main workspace before commit
    expect(fs.readFileSync(path.join(repoDir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');

    const ca = await supervisor.commitWorkspaceTransaction('tx-a');
    expect(ca.status).toBe('committed');
    expect(ca.writeSet).toEqual([{ status: 'M', path: 'src/a.ts' }]);

    const cb = await supervisor.commitWorkspaceTransaction('tx-b');
    expect(cb.status).toBe('committed');
    expect(cb.writeSet).toEqual(
      expect.arrayContaining([
        { status: 'D', path: 'src/b.ts' },
        { status: 'A', path: 'src/new.ts' },
      ])
    );

    expect(fs.readFileSync(path.join(repoDir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(fs.readFileSync(path.join(repoDir, 'src/new.ts'), 'utf8')).toBe('export const n = 1;\n');
    expect(fs.existsSync(path.join(repoDir, 'src/b.ts'))).toBe(false);
    // Forks are removed after commit
    expect(fs.existsSync(a.forkRoot)).toBe(false);
    const types = domain.getStore().getJournalEvents(domain.domainId).map((e) => e.type);
    expect(types.filter((t) => t === 'TX_COMMITTED')).toHaveLength(2);
  });

  it('rejects the later of two writers of the same file and leaves the first version in place', async () => {
    const a = await begin('tx-a', 'run-a');
    const b = await begin('tx-b', 'run-b');
    await agent('run-a', a.forkRoot, `require('fs').writeFileSync('shared.txt', 'from a\\n')`);
    await agent('run-b', b.forkRoot, `require('fs').writeFileSync('shared.txt', 'from b\\n')`);

    expect((await supervisor.commitWorkspaceTransaction('tx-a')).status).toBe('committed');
    const cb = await supervisor.commitWorkspaceTransaction('tx-b');

    expect(cb.status).toBe('conflict');
    if (cb.status !== 'conflict') return;
    expect(cb.conflicts).toEqual([{ path: 'shared.txt', kind: 'write_write', otherTxId: 'tx-a' }]);
    expect(fs.readFileSync(path.join(repoDir, 'shared.txt'), 'utf8')).toBe('from a\n');
    await expect(supervisor.commitWorkspaceTransaction('tx-b')).rejects.toThrow(/has conflicts/);
    await supervisor.abortWorkspaceTransaction('tx-b');
    expect(fs.existsSync(b.forkRoot)).toBe(false);
  });

  it('detects a stale read: B decided from a file that A changed and committed first', async () => {
    const a = await begin('tx-a', 'run-a');
    const b = await begin('tx-b', 'run-b');

    // B reads config.json and writes a file derived from it; it never writes config.json
    await agent('run-b', b.forkRoot, `
      const fs = require('fs');
      const port = JSON.parse(fs.readFileSync('config.json', 'utf8')).port;
      fs.writeFileSync('src/server.ts', 'listen(' + port + ');\\n');
    `);
    await agent('run-a', a.forkRoot, `require('fs').writeFileSync('config.json', '{"port":2}\\n')`);
    expect((await supervisor.commitWorkspaceTransaction('tx-a')).status).toBe('committed');

    const cb = await supervisor.commitWorkspaceTransaction('tx-b');
    if (b.readTracking === 'unobserved') {
      // noatime filesystem: reads cannot be observed, and the result says so instead of pretending
      expect(cb.readSet).toBeNull();
      expect(cb.status).toBe('committed');
      return;
    }
    expect(cb.readSet).toContain('config.json');
    expect(cb.status).toBe('conflict');
    if (cb.status !== 'conflict') return;
    expect(cb.conflicts).toEqual([{ path: 'config.json', kind: 'read_write', otherTxId: 'tx-a' }]);
    expect(fs.existsSync(path.join(repoDir, 'src/server.ts'))).toBe(false);
  });

  it('treats a directory listing as a read of its entries, not of their contents', async () => {
    const a = await begin('tx-a', 'run-a');
    const b = await begin('tx-b', 'run-b');
    const c = await begin('tx-c', 'run-b');
    // B globs src/ to generate an index; C only lists the root
    await agent('run-b', b.forkRoot, `
      const fs = require('fs');
      fs.writeFileSync('index.txt', fs.readdirSync('src').sort().join('\\n'));
    `);
    await agent('run-b', c.forkRoot, `require('fs').writeFileSync('notes.txt', String(require('fs').readdirSync('.').length))`);
    // A edits an existing file and adds a new one under src/
    await agent('run-a', a.forkRoot, `
      const fs = require('fs');
      fs.writeFileSync('src/a.ts', 'export const a = 3;\\n');
      fs.writeFileSync('src/added.ts', '');
    `);
    expect((await supervisor.commitWorkspaceTransaction('tx-a')).status).toBe('committed');

    const cb = await supervisor.commitWorkspaceTransaction('tx-b');
    const cc = await supervisor.commitWorkspaceTransaction('tx-c');
    if (b.readTracking === 'unobserved') return;
    expect(cb.status).toBe('conflict');
    if (cb.status === 'conflict') {
      expect(cb.conflicts).toEqual([{ path: 'src/', kind: 'read_write', otherTxId: 'tx-a' }]);
    }
    // The root's entries did not change (src/ already existed), so listing it is not stale
    expect(cc.status).toBe('committed');
  });

  it('reports writes that bypassed transactions as external conflicts', async () => {
    const b = await begin('tx-b', 'run-b');
    await agent('run-b', b.forkRoot, `require('fs').writeFileSync('shared.txt', 'from b\\n')`);
    fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'edited directly\n');

    const cb = await supervisor.commitWorkspaceTransaction('tx-b');
    expect(cb.status).toBe('conflict');
    if (cb.status !== 'conflict') return;
    expect(cb.conflicts).toEqual([{ path: 'shared.txt', kind: 'external_write', otherTxId: undefined }]);
    expect(fs.readFileSync(path.join(repoDir, 'shared.txt'), 'utf8')).toBe('edited directly\n');
  });

  it('preserves the executable bit and symbolic links when applying', async () => {
    const a = await begin('tx-a', 'run-a');
    await agent('run-a', a.forkRoot, `
      const fs = require('fs');
      fs.writeFileSync('run.sh', '#!/bin/sh\\necho changed\\n');
      fs.symlinkSync('src/a.ts', 'link-to-a');
    `);
    expect((await supervisor.commitWorkspaceTransaction('tx-a')).status).toBe('committed');
    expect(fs.statSync(path.join(repoDir, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(repoDir, 'link-to-a'))).toBe('src/a.ts');
  });

  it('finishes an interrupted commit from the journal after a supervisor restart', async () => {
    const a = await begin('tx-a', 'run-a');
    await agent('run-a', a.forkRoot, `require('fs').writeFileSync('src/a.ts', 'export const a = 9;\\n')`);
    const effects = await supervisor.inspectWorkspaceTransaction('tx-a');
    // Crash right after TX_COMMITTING: validated, nothing applied yet
    domain.getStore().recordJournalEvent({
      domainId: domain.domainId,
      runId: 'run-a',
      type: 'TX_COMMITTING',
      payload: { txId: 'tx-a', effects },
      timestamp: new Date().toISOString(),
    });
    domain.close();
    domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'tx-domain');
    supervisor = new ProcessSupervisor(domain);

    const res = await supervisor.commitWorkspaceTransaction('tx-a');
    expect(res.status).toBe('committed');
    expect(fs.readFileSync(path.join(repoDir, 'src/a.ts'), 'utf8')).toBe('export const a = 9;\n');
    await expect(supervisor.commitWorkspaceTransaction('tx-a')).rejects.toThrow(/already closed/);
  });

  it('refuses to reuse a transaction id', async () => {
    await begin('tx-a', 'run-a');
    await expect(begin('tx-a', 'run-a')).rejects.toThrow(/already exists/);
  });
});
