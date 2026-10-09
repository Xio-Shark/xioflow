import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ExecutionDomain, ProcessSupervisor, WorkspaceCausalGraph, validateWorkspaceCausalBranches } from '../../dist/index.js';

const exec = promisify(execFile);
const [count = 4, trials = 3] = process.argv.slice(2).map(Number);
if (process.argv.length > 4 || ![count, trials].every(n => Number.isSafeInteger(n) && n > 0)) {
  throw new Error('Usage: pnpm benchmark:probe-reuse [branches > 0] [trials > 0]');
}
const samples = [];
for (let trial = 0; trial < trials; trial++) {
  for (const changed of [false, true]) {
    for (const replayReuse of trial % 2 ? ['baseline_observations', 'none'] : ['none', 'baseline_observations']) {
      const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-probe-reuse-')));
      let domain;
      try {
        const root = path.join(temp, 'repo');
        fs.mkdirSync(root);
        await exec('git', ['init', '-q', '-b', 'main', root]);
        fs.writeFileSync(path.join(root, 'input.txt'), 'old');
        await exec('git', ['add', '.'], { cwd: root });
        await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
        domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'benchmark');
        const store = domain.getStore();
        const now = new Date().toISOString();
        store.saveTask({ id: 'task', domainId: domain.domainId, name: 'probe reuse', createdAt: now });
        store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'benchmark', status: 'running', startedAt: now });
        const supervisor = new ProcessSupervisor(domain);
        const graph = new WorkspaceCausalGraph(domain);
        const tx = await supervisor.beginWorkspaceTransaction({ txId: 'source', runId: 'run', root, forkPath: path.join(temp, 'source') });
        const input = graph.record({ txId: tx.txId, actorId: 'reader', dependsOn: [], observation: {
          kind: 'observe', call: { tool: 'read', args: {} }, resultHash: 'old',
        } });
        const branches = Array.from({ length: count }, (_, i) => ({ id: `agent-${i}`, heads: [graph.record({
          txId: tx.txId, actorId: `agent-${i}`, dependsOn: [input.seq], observation: {
            kind: 'mutate', call: { tool: 'write', args: { path: `output-${i}.txt` } }, resultHash: 'old',
          },
        }).seq] }));
        if (changed) fs.writeFileSync(path.join(root, 'input.txt'), 'new');
        let calls = 0;
        const start = performance.now();
        const report = await validateWorkspaceCausalBranches(supervisor, {
          txId: 'probe', runId: 'run', root, forkPath: path.join(temp, 'probe'),
          branches, atSeq: graph.nodes().at(-1).seq, closedWorld: true, replayPolicy: 'deterministic', replayReuse,
          replay: async (entry, dir) => {
            calls++;
            const value = fs.readFileSync(path.join(dir, 'input.txt'), 'utf8');
            if (entry.kind === 'mutate') fs.writeFileSync(path.join(dir, entry.call.args.path), value);
            return value;
          },
        });
        const elapsedMs = performance.now() - start;
        const expectedCalls = replayReuse === 'none' ? count * (changed ? 1 : 2) : 1 + (changed ? 0 : count);
        const success = report.branches.every(b => b.status === (changed ? 'changed' : 'matched'))
          && report.changed.length === (changed ? 1 : 0) && calls === expectedCalls
          && calls === report.replayedSteps && report.reusedSteps === (replayReuse === 'none' ? 0 : count - 1)
          && !fs.existsSync(path.join(root, 'output-0.txt'));
        samples.push({ trial, changed, replayReuse, success, replayedSteps: calls, reusedSteps: report.reusedSteps, elapsedMs });
      } finally {
        domain?.close();
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  }
}
console.log(JSON.stringify({ schemaVersion: 1, branches: count, trials, modelTokens: null,
  scope: 'validation only; excludes repair and commit',
  environment: { node: process.version, platform: process.platform, arch: process.arch }, samples }, null, 2));
if (samples.some(sample => !sample.success)) process.exitCode = 1;
