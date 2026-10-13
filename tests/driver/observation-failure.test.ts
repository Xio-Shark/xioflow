import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessSampler } from '../../src/driver/sampler.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { getGroupMembers } from '../../src/driver/process-facts.js';
import type { ManagedProcessHandle } from '../../src/driver/types.js';

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
