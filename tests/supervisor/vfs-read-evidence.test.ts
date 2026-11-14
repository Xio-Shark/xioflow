import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '../../src/index.js';
import { parseVfsTraceContent } from '../../src/driver/vfs-trace.js';
import { evaluateReadEvidence, ReadTracker } from '../../src/supervisor/read-evidence.js';
import { locateNativeShimLibrary } from '../../src/driver/reaper-driver.js';

describe('xio-reaper/1 protocol and VFS read evidence', () => {
  let tempDir: string;
  let repo: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-vfs-ev-')));
    repo = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repo, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 3}\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'unrelated\n');
    fs.writeFileSync(path.join(repo, 'fixtures/a.txt'), 'a\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports versioned xio-reaper/1 protocol capabilities', async () => {
    assert(ReaperPlatformDriver.isAvailable(), 'xioflow-reaper binary must be built');
    const driver = new ReaperPlatformDriver();
    const info = await driver.getProtocolInfo();
    expect(info.protocol).toBe('xio-reaper/1');
    expect(['linux', 'darwin']).toContain(info.platform);
    expect(['subreaper_tree', 'tracked_tree']).toContain(info.treeScope);
    expect(info.features).toEqual(expect.arrayContaining(['gate', 'stop_ladder', 'rusage', 'signal']));
  });

  it('parses VFS syscall trace lines into categorized sets', () => {
    const parsed = parseVfsTraceContent(
      [
        `R\t${repo}/data.json`,
        `L\t${repo}/fixtures`,
        `W\t${repo}/out.txt`,
        `D\t${repo}/tmp.txt`,
        `E\t/etc/shadow`,
        `X\t/bin/sh`,
      ].join('\n'),
    );
    expect(parsed).toEqual({
      reads: [`${repo}/data.json`],
      listedDirs: [`${repo}/fixtures`],
      writes: [`${repo}/out.txt`],
      deletes: [`${repo}/tmp.txt`],
      denials: ['/etc/shadow'],
      shellExecs: ['/bin/sh'],
    });
  });

  it('tracks concurrent VFS sessions on the same root without roots_busy or atime sweeps', () => {
    const tracker = new ReadTracker();
    const artifactsDir = path.join(tempDir, 'artifacts');

    const s1 = tracker.open('op-vfs-1', { roots: [repo], statCaches: 'ruled_out', mode: 'vfs' });
    const s2 = tracker.open('op-vfs-2', { roots: [repo], statCaches: 'ruled_out', mode: 'vfs' });
    try {
      s1.begin();
      s2.begin();

      const ev1 = s1.collect(artifactsDir, undefined, {
        reads: [path.join(repo, 'data.json'), '/etc/hosts'],
        listedDirs: [path.join(repo, 'fixtures')],
        writes: [],
        deletes: [],
        denials: [],
        shellExecs: [],
      });
      const ev2 = s2.collect(artifactsDir, undefined, {
        reads: [path.join(repo, 'other.txt')],
        listedDirs: [],
        writes: [],
        deletes: [],
        denials: [],
        shellExecs: [],
      });

      expect(ev1.tracking).toBe('vfs');
      expect(ev2.tracking).toBe('vfs');
      expect(ev1.entryCount).toBe(2);
      expect(ev2.entryCount).toBe(1);

      expect(evaluateReadEvidence(ev1)).toEqual({ status: 'fresh', basis: 'tree_unchanged' });

      // Modify other.txt: ev1 stays fresh via reads_unchanged, while ev2 turns stale!
      fs.writeFileSync(path.join(repo, 'other.txt'), 'modified\n');
      expect(evaluateReadEvidence(ev1)).toEqual({ status: 'fresh', basis: 'reads_unchanged' });
      expect(evaluateReadEvidence(ev2)).toEqual({
        status: 'stale',
        changed: [path.join(repo, 'other.txt')],
        truncated: false,
      });

      // Adding an entry inside listed directory invalidates ev1
      fs.writeFileSync(path.join(repo, 'fixtures/b.txt'), 'b\n');
      expect(evaluateReadEvidence(ev1)).toEqual({
        status: 'stale',
        changed: [`${path.join(repo, 'fixtures')}/`],
        truncated: false,
      });
    } finally {
      s1.close();
      s2.close();
    }
  });

  it('uses native LD_PRELOAD VFS tracing end-to-end on Linux when libxioflow-shim.so is present', async () => {
    if (process.platform !== 'linux' || !locateNativeShimLibrary()) return;
    const domain = ExecutionDomain.acquire(path.join(tempDir, 'domain'), 'vfs-linux-domain');
    try {
      const store = domain.getStore();
      store.saveTask({ id: 't1', domainId: domain.domainId, name: 't1', createdAt: new Date().toISOString() });
      store.saveRun({
        id: 'r1',
        taskId: 't1',
        domainId: domain.domainId,
        owner: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      const driver = new ReaperPlatformDriver();
      expect(driver.capabilities.vfsTracing).toBe(true);
      const supervisor = new ProcessSupervisor(domain, driver);

      const res = await supervisor.executeProcess({
        runId: 'r1',
        opId: 'linux-vfs-op',
        name: 'read-check',
        command: {
          execPath: process.execPath,
          args: ['-e', "const fs=require('fs');fs.readFileSync('data.json','utf8');fs.readdirSync('fixtures');"],
          cwd: repo,
          inheritEnv: true,
        },
        trackReads: { roots: [repo], statCaches: 'ruled_out' },
      });
      assert(res.kind === 'process');
      expect(res.status).toBe('succeeded');
      expect(res.readEvidence?.tracking).toBe('vfs');
      expect(supervisor.evidenceStatus('linux-vfs-op')).toEqual({ status: 'fresh', basis: 'tree_unchanged' });

      fs.writeFileSync(path.join(repo, 'other.txt'), 'changed-outside\n');
      expect(supervisor.evidenceStatus('linux-vfs-op')).toEqual({ status: 'fresh', basis: 'reads_unchanged' });

      fs.writeFileSync(path.join(repo, 'data.json'), '{"limit": 99}\n');
      expect(supervisor.evidenceStatus('linux-vfs-op')).toEqual({
        status: 'stale',
        changed: [path.join(repo, 'data.json')],
        truncated: false,
      });
    } finally {
      domain.close();
    }
  });
});
