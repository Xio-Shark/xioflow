import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } = await import(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-reaper-retention-'));
const domain = ExecutionDomain.acquire(root, 'retention');
const driver = new ReaperPlatformDriver({ helperPath: process.argv[3] });
const streams = [];
const identities = [];
const spawn = driver.spawn.bind(driver);
driver.spawn = async (command) => {
  const handle = await spawn(command);
  streams.push(new WeakRef(handle.stdout), new WeakRef(handle.stderr));
  identities.push(handle.identity);
  return handle;
};
const supervisor = new ProcessSupervisor(domain, driver);
domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'test', createdAt: new Date().toISOString() });
domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
try {
  for (let i = 0; i < 8; i++) {
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const pending = supervisor.executeProcess({
      runId: 'run', opId: `op-${i}`, name: 'retention', timeoutMs: 2000,
      command: { execPath: process.execPath, args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], cwd: root },
      onStreamChunk: () => ready(),
    });
    await started;
    assert.equal((await supervisor.cancelOperation(`op-${i}`, 100)).stopped, 'confirmed_stopped');
    assert.equal((await pending).status, 'cancelled');
  }
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
  const retainedStreams = streams.filter((reference) => reference.deref() !== undefined).length;
  assert.equal(retainedStreams, 0, 'completed reaper sessions retain their output streams');
  for (const identity of identities) {
    assert.equal((await driver.terminate(identity, 100)).stopped, 'confirmed_stopped');
  }
  console.log(JSON.stringify({ retainedStreams, terminalFacts: identities.length }));
} finally { domain.close(); fs.rmSync(root, { recursive: true, force: true }); }
