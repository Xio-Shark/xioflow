/**
 * Crash-matrix scenario host: runs one kernel scenario against the built package
 * in its own process so a crashpoint can SIGKILL it like a real supervisor crash.
 *
 *   node scenario-worker.mjs <distIndex> <domainPath> <workDir> <node|reaper> <complete|cancel> [helperPath]
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , distIndex, domainPath, workDir, driverKind, scenario, helperPath] = process.argv;
const kernel = await import(distIndex);

const domain = kernel.ExecutionDomain.acquire(domainPath, 'fault');
const store = domain.getStore();
if (!store.getTask('task')) {
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'task', createdAt: new Date().toISOString() });
}
if (!store.getRun('run')) {
  store.saveRun({
    id: 'run',
    taskId: 'task',
    domainId: domain.domainId,
    owner: 'worker',
    status: 'running',
    startedAt: new Date().toISOString(),
  });
}

const driver = driverKind === 'reaper' ? new kernel.ReaperPlatformDriver({ helperPath }) : new kernel.NodePlatformDriver();
const supervisor = new kernel.ProcessSupervisor(domain, driver);
const effects = path.join(workDir, 'effects.log');
const pidFile = path.join(workDir, 'op.pid');
// The side effect happens once per real execution; the matrix counts it to prove at-most-once.
const effect = `require('fs').appendFileSync(${JSON.stringify(effects)}, 'ran\\n'); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`;
const body = scenario === 'cancel' ? `${effect} setInterval(() => {}, 1000);` : `${effect} setTimeout(() => {}, 300);`;

const pending = supervisor.executeProcess({
  runId: 'run',
  opId: 'op',
  name: `scenario-${scenario}`,
  command: { execPath: process.execPath, args: ['-e', body], cwd: workDir },
  requiredResources: ['res:workspace'],
});

if (scenario === 'cancel') {
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
  await supervisor.cancelOperation('op', 300).catch(() => {});
}

const result = await pending;
process.stdout.write(JSON.stringify({ status: result.status, replayed: result.replayed === true }));
domain.close();
