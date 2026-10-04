/**
 * Host for the cgroup recovery test: starts one operation whose root daemonizes a child (own session, stdio
 * closed) and exits. Run with XIOFLOW_TEST_CRASHPOINT=supervisor:process-running#1 so the host is SIGKILLed
 * right after the gate opens, before any result is recorded.
 *
 *   node cgroup-crash-worker.mjs <distIndex> <domainPath> <workDir> <cgroup|node>
 */
import path from 'node:path';

const [, , distIndex, domainPath, workDir, driverKind] = process.argv;
const kernel = await import(distIndex);

const domain = kernel.ExecutionDomain.acquire(domainPath, 'cgroup-crash');
const store = domain.getStore();
store.saveTask({ id: 'task', domainId: domain.domainId, name: 'task', createdAt: new Date().toISOString() });
store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'worker', status: 'running', startedAt: new Date().toISOString() });

const driver = driverKind === 'cgroup' ? new kernel.CgroupPlatformDriver() : new kernel.NodePlatformDriver();
const supervisor = new kernel.ProcessSupervisor(domain, driver);
const pidFile = path.join(workDir, 'escapee.pid');
const body = `
  const { spawn } = require('node:child_process');
  const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));
  d.unref();
`;
await supervisor.executeProcess({
  runId: 'run',
  opId: 'op',
  name: 'daemonize',
  command: { execPath: process.execPath, args: ['-e', body], cwd: workDir },
  requiredResources: ['res:workspace'],
});
// Not reached when the crashpoint fires.
domain.close();
