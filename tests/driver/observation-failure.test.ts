import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessSampler } from '../../src/driver/sampler.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { getGroupMembers } from '../../src/driver/process-facts.js';
import type { ManagedProcessHandle, ProcessIdentity } from '../../src/driver/types.js';

describe('unavailable OS process evidence', () => {
  let root: string;
  const processes: ManagedProcessHandle[] = [];
  let escapedPid = 0;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-observation-failure-'));
    vi.stubEnv('PATH', root);
    ProcessSampler.getInstance().clearCache();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const handle of processes.splice(0)) {
      handle.destroyGate?.();
      if (handle.rawProcess.exitCode === null && handle.rawProcess.signalCode === null) handle.rawProcess.kill('SIGKILL');
      await (handle.onRootExit ?? handle.onExit);
    }
    if (escapedPid) {
      try { process.kill(escapedPid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      escapedPid = 0;
    }
    ProcessSampler.getInstance().clearCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a failed process-table query instead of returning an empty snapshot', async () => {
    await expect(new ProcessSampler().getSnapshot(0)).rejects.toThrow(/process|observation/i);
  });

  it('uses one asynchronous process-table read for all watched trees in a cycle', async () => {
    let reads = 0;
    const sampler = new ProcessSampler({
      readProcessTable: async () => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          '101 1 101 S 10 00:00.01 leader-a',
          '202 1 202 S 20 00:00.02 leader-b',
        ].join('\n');
      },
    });
    const stopA = sampler.watchProcessTree(101, new Set<number>());
    const stopB = sampler.watchProcessTree(202, new Set<number>());
    try {
      await vi.waitFor(() => {
        expect(sampler.getCycleDiagnostics().cycleCount).toBeGreaterThanOrEqual(2);
      });
      const diagnostics = sampler.getCycleDiagnostics();
      expect(diagnostics.activeWatchers).toBe(2);
      expect(reads).toBe(diagnostics.cycleCount);
    } finally {
      stopA();
      stopB();
    }
    expect(sampler.getCycleDiagnostics().activeWatchers).toBe(0);
  });

  it('reports an alive process missing from a snapshot as unknown evidence', async () => {
    const sampler = ProcessSampler.getInstance();
    const snapshot = vi.spyOn(sampler, 'getSnapshot').mockResolvedValue(new Map());
    try {
      const identity: ProcessIdentity = {
        pid: process.pid,
        spawnTime: new Date().toISOString(),
      };
      await expect(new NodePlatformDriver().sampleMetrics(identity)).rejects.toThrow(/missing from the process snapshot/i);
    } finally {
      snapshot.mockRestore();
    }
  });

  it.skipIf(process.platform !== 'darwin')('does not interpret a failed macOS group query as an empty group', async () => {
    await expect(getGroupMembers(process.pid)).rejects.toThrow(/process|observation/i);
  });

  it.skipIf(process.platform === 'win32')('does not confirm a stopped tree when an unobservable escaped child survives', async () => {
    const driver = new NodePlatformDriver();
    const pidFile = path.join(root, 'escape.pid');
    const handle = await driver.spawn({ execPath: process.execPath, cwd: root, args: ['-e', `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
      setInterval(() => {}, 1000);
    `] });
    processes.push(handle);
    handle.releaseGate?.();
    await vi.waitFor(() => { expect(fs.existsSync(pidFile)).toBe(true); });
    escapedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(escapedPid, 0)).not.toThrow();
    const result = await driver.terminate(handle.identity, 100);
    expect(result.stopped).toBe('cannot_determine');
    expect(result.errorDetails).toMatch(/observation|process table/i);
    expect(() => process.kill(handle.identity.pid, 0)).not.toThrow();
    expect(() => process.kill(escapedPid, 0)).not.toThrow();
  });
});
