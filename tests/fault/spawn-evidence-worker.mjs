import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } from '../../dist/index.js';

const [, , root, mode, kind] = process.argv;
const domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'spawn-evidence');
const store = domain.getStore();
store.saveTask({ id: 'task', domainId: domain.domainId, name: 'task', createdAt: new Date().toISOString() });
store.saveRun({
  id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'crash-worker',
  status: 'running', startedAt: new Date().toISOString(),
});

class CrashBeforeIdentityDriver extends NodePlatformDriver {
  async spawn(command) {
    const handle = await super.spawn(command);
    fs.writeFileSync(path.join(root, 'child.pid'), String(handle.identity.pid));
    if (mode === 'ungated') {
      // Wait for a real, completed side effect, but never return the identity to the supervisor.
      await handle.onExit;
      if (fs.readFileSync(path.join(root, 'effects'), 'utf8') !== 'effect\n') {
        throw new Error('Expected one real execution before the crash');
      }
    }
    process.kill(process.pid, 'SIGKILL');
    throw new Error('SIGKILL did not terminate the crash worker');
  }
}

const driver = new CrashBeforeIdentityDriver();
driver.capabilities.gatedSpawn = mode === 'gated';
const supervisor = new ProcessSupervisor(domain, driver);
const command = {
  execPath: process.execPath,
  args: ['-e', 'require("node:fs").appendFileSync("effects", "effect\\n"); setTimeout(() => {}, 300);'],
  cwd: root,
};
if (kind === 'service') {
  await supervisor.startService({ serviceId: 'service', runId: 'run', command, requiredResources: ['res:workspace'] });
} else {
  await supervisor.executeProcess({ runId: 'run', opId: 'op', name: 'op', command, requiredResources: ['res:workspace'] });
}
throw new Error('Expected a crash before identity registration');
