import { AgentRuntime, ExecutionDomain } from '../../dist/index.js';

const domain = ExecutionDomain.acquire(process.argv[2], 'crash-agents');
const store = domain.getStore();
store.saveTask({ id: 'task', domainId: domain.domainId, name: 'crash', createdAt: new Date().toISOString() });
store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'crash', status: 'running', startedAt: new Date().toISOString() });
const runtime = new AgentRuntime(domain, {
  maxConcurrentAgents: 1,
  ...(process.argv[3].startsWith('scope-') ? { runBudget: { maxSteps: 3, maxAgents: 3, maxPendingCommands: 2 } } : {}),
  async validate(_agent, signal) {
    if (process.argv[3] === 'interrupt-checking' || process.argv[3] === 'shutdown-checking') {
      signal.addEventListener('abort', () => process.kill(process.pid, 'SIGKILL'), { once: true });
      if (process.argv[3].startsWith('shutdown-')) void runtime.shutdown();
      else void runtime.interrupt('a');
      await new Promise(() => {});
    }
    return 'valid';
  },
  async step(_agent, execution) {
    if (process.argv[3] === 'scope-cancel') {
      execution.signal.addEventListener('abort', () => process.kill(process.pid, 'SIGKILL'), { once: true });
      void runtime.interrupt('a');
      await new Promise(() => {});
    }
    if (process.argv[3] === 'scope-waiting' && _agent.id === 'a') return { status: 'completed', checkpoint: { turn: 1 } };
    if (process.argv[3] === 'interrupt-running' || process.argv[3] === 'shutdown-running') {
      execution.signal.addEventListener('abort', () => process.kill(process.pid, 'SIGKILL'), { once: true });
      if (process.argv[3].startsWith('shutdown-')) void runtime.shutdown();
      else void runtime.interrupt('a');
      await new Promise(() => {});
    }
    if (process.argv[3] === 'command') {
      const result = await execution.executeProcess({
        opId: 'once', name: 'once',
        command: { execPath: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("command-count", "x")'], cwd: process.argv[2] },
      });
      if (result.status !== 'succeeded') throw new Error(`Command failed: ${result.status}`);
    }
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  },
});
runtime.create({ id: 'a', runId: 'run', maxSteps: 3, input: null, checkpoint: { turn: 0 } });
if (process.argv[3].startsWith('scope-')) {
  runtime.create({ id: 'child', parentId: 'a', runId: 'run', maxSteps: 3, input: null, checkpoint: 0 });
  runtime.create({ id: 'grandchild', parentId: 'child', runId: 'run', maxSteps: 3, input: null, checkpoint: 0 });
}
if (process.argv[3] === 'recovery') {
  runtime.pause('a');
  await runtime.recoverCheckpoint('a', async () => {
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  });
} else await runtime.drain();
