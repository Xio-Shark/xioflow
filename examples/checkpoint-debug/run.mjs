import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph,
  compareAgentCheckpointFiles } from '../../dist/index.js';

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-checkpoint-debug-')));
const root = path.join(temp, 'repo');
fs.mkdirSync(root);
execFileSync('git', ['init', '-q', '-b', 'main', root]);
fs.writeFileSync(path.join(root, 'answer.txt'), 'initial');
execFileSync('git', ['add', '.'], { cwd: root });
execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com',
  'commit', '-qm', 'initial'], { cwd: root });
const domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'checkpoint-debug');
const supervisor = new ProcessSupervisor(domain);
const agents = new AgentRuntime(domain, { maxConcurrentAgents: 1,
  step: async () => ({ status: 'completed', checkpoint: null }) });
try {
  const store = domain.getStore();
  store.saveTask({ id: 'task', domainId: domain.domainId, name: 'debug', createdAt: new Date().toISOString() });
  store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'demo',
    status: 'running', startedAt: new Date().toISOString() });
  const graph = new WorkspaceCausalGraph(domain);
  const sides = [];
  for (const [id, answer] of [['left', '42'], ['right', '43']]) {
    const tx = await supervisor.beginWorkspaceTransaction({ txId: id, runId: 'run', root, forkPath: path.join(temp, id) });
    const operation = { kind: 'mutate', call: { tool: 'write-answer', args: { answer } }, resultHash: answer };
    const replay = async (entry, forkRoot) => {
      fs.writeFileSync(path.join(forkRoot, 'answer.txt'), entry.call.args.answer);
      return fs.readFileSync(path.join(forkRoot, 'answer.txt'), 'utf8');
    };
    await replay(operation, tx.forkRoot);
    const node = graph.record({ txId: id, actorId: id, dependsOn: [], observation: operation,
      writes: [{ status: 'M', path: 'answer.txt' }] });
    agents.create({ id, runId: 'run', input: null, checkpoint: { answer }, workspace: tx,
      causalHeads: [node.seq], maxSteps: 1 });
    sides.push({ sourceAgentId: id, checkpointSeq: agents.checkpoints(id)[0].seq,
      txId: `debug-${id}`, forkPath: path.join(temp, `debug-${id}`), replayPolicy: 'deterministic',
      observations: () => ({ closedWorld: true, log: [operation], replay }) });
    await supervisor.abortWorkspaceTransaction(id);
  }
  fs.writeFileSync(path.join(root, 'answer.txt'), 'future');
  const result = await compareAgentCheckpointFiles(agents, supervisor, { left: sides[0], right: sides[1] });
  if (result.status !== 'compared') throw new Error(`Replay diverged: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ context: result.comparison.context, files: result.files,
    replayedSteps: result.replayedSteps, live: fs.readFileSync(path.join(root, 'answer.txt'), 'utf8') }, null, 2));
} finally {
  agents.close();
  domain.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
