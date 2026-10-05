import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor, RecoveryEngine, ResourceConflictError } from '../../src/index.js';
import { buildDist } from '../support/build-dist.js';

buildDist();

it.each([
  ['gated', 'process'], ['ungated', 'process'], ['gated', 'service'], ['ungated', 'service'],
])('recovers a real %s %s crash before identity registration without repeating effects', async (mode, kind) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-spawn-evidence-'));
  let domain: ExecutionDomain | undefined;
  try {
    const crashed = spawnSync(process.execPath, [path.join(import.meta.dirname, 'spawn-evidence-worker.mjs'), root, mode, kind], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(crashed.signal, crashed.stderr).toBe('SIGKILL');
    const childPid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
    await vi.waitFor(() => {
      const state = spawnSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' });
      expect(state.error).toBeUndefined();
      // Linux may retain a zombie until init reaps it; it cannot execute or hold the gate open.
      expect(state.status === 1 || (state.status === 0 && state.stdout.trim().startsWith('Z'))).toBe(true);
    }, { timeout: 3000, interval: 25 });
    const effectPath = path.join(root, 'effects');
    const effects = () => fs.existsSync(effectPath) ? fs.readFileSync(effectPath, 'utf8') : '';
    const expectedEffects = mode === 'gated' ? '' : 'effect\n';
    expect(effects()).toBe(expectedEffects);
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'spawn-evidence');
    const opId = kind === 'service' ? 'service#1' : 'op';
    expect(domain.getStore().getOperation(opId)).toMatchObject({
      status: 'intent_registered', processIdentity: undefined, spawnGated: mode === 'gated',
    });
    const recoveryDriver = new NodePlatformDriver();
    // Switching drivers on restart must not reinterpret the original launch's safety.
    recoveryDriver.capabilities.gatedSpawn = mode !== 'gated';
    const report = await new RecoveryEngine(domain, recoveryDriver).recover();
    expect(report.recoveredOperations).toEqual([{
      opId, action: mode === 'gated' ? 'cleaned_unspawned' : 'isolated_indeterminate',
      resourcesReleased: mode === 'gated',
    }]);
    const store = domain.getStore();
    store.saveRun({
      id: 'retry', taskId: 'task', domainId: domain.domainId, owner: 'test',
      status: 'running', startedAt: new Date().toISOString(),
    });
    const supervisor = new ProcessSupervisor(domain, new NodePlatformDriver());
    const result = await supervisor.executeProcess({
      runId: 'retry', opId, name: 'retry', inputFingerprint: store.getOperation(opId)!.inputFingerprint,
      command: {
        execPath: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("effects", "duplicate\\n")'], cwd: root,
      },
    });
    expect(result).toMatchObject({ status: mode === 'gated' ? 'failed' : 'indeterminate', replayed: true, runId: 'run' });
    expect(effects()).toBe(expectedEffects);
    if (mode === 'ungated') {
      expect(() => domain!.allocateResources('replacement', ['res:workspace'])).toThrow(ResourceConflictError);
    }
    domain.close();
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'spawn-evidence');
    await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    expect(domain.isResourceLocked('res:workspace')).toBe(mode === 'ungated');
    expect(effects()).toBe(expectedEffects);
  } finally {
    domain?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
