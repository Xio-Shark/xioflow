import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '../../src/index.js';
import { parseVfsTraceContent, parseVfsTraceFile } from '../../src/driver/vfs-trace.js';
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

  it('fails closed on missing VFS trace files, missing shim sentinels, or unobserved exec markers', () => {
    expect(parseVfsTraceFile(path.join(tempDir, 'missing.trace'))).toBeUndefined();

    const parsed = parseVfsTraceContent(['S\t1', `U\t${repo}/static-bin`, `R\t${repo}/data.json`].join('\n'));
    expect(parsed.shimLoaded).toBe(true);
    expect(parsed.unobservedExecs).toEqual([`${repo}/static-bin`]);

    const traceFile = path.join(tempDir, 'no-sentinel.trace');
    fs.writeFileSync(traceFile, `R\t${repo}/data.json\n`, 'utf8');
    expect(parseVfsTraceFile(traceFile)?.shimLoaded).toBe(false);

    const tracker = new ReadTracker();
    const artifactsDir = path.join(tempDir, 'artifacts-fc');
    const sNoSentinel = tracker.open('op-no-sentinel', { roots: [repo], statCaches: 'ruled_out', mode: 'vfs' });
    const sStaticChild = tracker.open('op-static-child', { roots: [repo], statCaches: 'ruled_out', mode: 'vfs' });
    try {
      sNoSentinel.begin();
      sStaticChild.begin();
      const ev1 = sNoSentinel.collect(artifactsDir, undefined, parseVfsTraceFile(traceFile));
      const ev2 = sStaticChild.collect(artifactsDir, undefined, parsed);
      expect(ev1.tracking).toBe('unobserved');
      expect(ev1.reason).toBe('no_vfs');
      expect(ev2.tracking).toBe('unobserved');
      expect(ev2.reason).toBe('no_vfs');

      fs.writeFileSync(path.join(repo, 'other.txt'), 'mutated\n');
      expect(evaluateReadEvidence(ev1)).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
      expect(evaluateReadEvidence(ev2)).toMatchObject({ status: 'unknown', reason: 'reads_unobserved' });
    } finally {
      sNoSentinel.close();
      sStaticChild.close();
    }
  });

  it('fails closed on Linux when executing static CGO_ENABLED=0 Go binaries or stripping LD_PRELOAD', async () => {
    if (process.platform !== 'linux' || !locateNativeShimLibrary()) return;

    const goBin = fs.existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go';
    const staticBin = path.join(tempDir, 'static-reader');
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    let builtWithGo = false;
    try {
      execFileSync(goBin, ['version'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(srcDir, 'go.mod'), 'module xio.local/staticreader\n\ngo 1.21\n');
      fs.writeFileSync(
        path.join(srcDir, 'main.go'),
        [
          'package main',
          'import ("os"; "os/exec")',
          'func main() {',
          '  _, _ = os.ReadFile("data.json")',
          '  if len(os.Args) > 1 && os.Args[1] == "--spawn-sh" {',
          '    _ = exec.Command("/bin/sh", "-c", "cat fixtures/a.txt >/dev/null").Run()',
          '  }',
          '}',
        ].join('\n'),
      );
      execFileSync(goBin, ['build', '-o', staticBin, '.'], {
        cwd: srcDir,
        env: { ...process.env, CGO_ENABLED: '0', GOCACHE: path.join(tempDir, 'gocache') },
        stdio: 'pipe',
      });
      builtWithGo = true;
    } catch {
      const cSrc = path.join(srcDir, 'reader.c');
      fs.writeFileSync(
        cSrc,
        [
          '#include <fcntl.h>',
          '#include <unistd.h>',
          'int main(void) {',
          '  int fd = open("data.json", O_RDONLY);',
          '  if (fd >= 0) close(fd);',
          '  return 0;',
          '}',
        ].join('\n'),
      );
      execFileSync('gcc', ['-static', '-O2', cSrc, '-o', staticBin], { stdio: 'pipe' });
    }

    const domain = ExecutionDomain.acquire(path.join(tempDir, 'domain-static'), 'vfs-static-domain');
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
      const supervisor = new ProcessSupervisor(domain, new ReaperPlatformDriver());

      const cases: Array<{ opId: string; execPath: string; args: string[] }> = [
        { opId: 'static-direct', execPath: staticBin, args: [] },
        ...(builtWithGo ? [{ opId: 'static-spawns-sh', execPath: staticBin, args: ['--spawn-sh'] }] : []),
        { opId: 'sh-execs-static', execPath: '/bin/sh', args: ['-c', `${staticBin} && cat fixtures/a.txt >/dev/null`] },
        { opId: 'stripped-preload', execPath: '/bin/sh', args: ['-c', 'env -u LD_PRELOAD cat data.json >/dev/null'] },
      ];

      for (const c of cases) {
        const res = await supervisor.executeProcess({
          runId: 'r1',
          opId: c.opId,
          name: c.opId,
          command: { execPath: c.execPath, args: c.args, cwd: repo, inheritEnv: true },
          trackReads: { roots: [repo], statCaches: 'ruled_out' },
        });
        assert(res.kind === 'process');
        expect(res.status, c.opId).toBe('succeeded');
        expect(res.readEvidence?.tracking, c.opId).toBe('unobserved');
        expect(res.readEvidence?.reason, c.opId).toBe('no_vfs');
      }

      fs.writeFileSync(path.join(repo, 'other.txt'), 'outside-after-bypass\n');
      for (const c of cases) {
        expect(supervisor.evidenceStatus(c.opId), c.opId).toMatchObject({
          status: 'unknown',
          reason: 'reads_unobserved',
        });
      }
    } finally {
      domain.close();
    }
  });
});
