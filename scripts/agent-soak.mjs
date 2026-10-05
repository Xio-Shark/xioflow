import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { AgentRuntime, CgroupPlatformDriver, ExecutionDomain } from '../dist/index.js';

const durationSeconds = Number(process.env.XIOFLOW_SOAK_SECONDS ?? 120);
assert(Number.isSafeInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 86400, 'XIOFLOW_SOAK_SECONDS must be 1..86400');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agent-soak-'));
const domain = ExecutionDomain.acquire(root, 'soak');
if (process.env.XIOFLOW_EXPECT_CGROUP === '1') domain.setDriver(new CgroupPlatformDriver());
domain.setDomainBudget({ maxConcurrentOps: 1 });
const store = domain.getStore();
store.saveTask({ id: 'task', domainId: domain.domainId, name: 'soak', createdAt: new Date().toISOString() });
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const start = performance.now();
const initialMemory = process.memoryUsage();
let peakRss = initialMemory.rss;
let cycles = 0;
let faults = 0;
let crashes = 0;
let rejectedCommands = 0;
let observedPids = 0;
const samples = [];
let entered;
let runtime;
const pending = new Set();

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function crashProbe(mode) {
  const crashRoot = fs.mkdtempSync(path.join(root, 'crash-'));
  const killed = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../tests/agents/crash-worker.mjs'), crashRoot, mode], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const reopened = ExecutionDomain.acquire(crashRoot, 'crash-agents');
  const agents = new AgentRuntime(reopened, { maxConcurrentAgents: 1, step: async () => { throw new Error('Unexpected replay'); } });
  try {
    assert(agents.list().every((agent) => agent.status === 'interrupted'));
    await agents.drain();
    assert.equal(agents.getRunUsage('run').stepsUsed, mode === 'scope-cancel' ? 1 : 2);
  } finally { await agents.shutdown(); reopened.close(); fs.rmSync(crashRoot, { recursive: true, force: true }); }
  crashes++;
}

runtime = new AgentRuntime(domain, {
  maxConcurrentAgents: 2,
  runBudget: { maxSteps: 4, maxAgents: 3, maxPendingCommands: 4 },
  step: async (agent, execution) => {
    if (agent.parentId === null) return { status: 'completed', checkpoint: 1 };
    let output = '';
    const commands = Array.from({ length: 64 }, (_, index) => execution.executeProcess({
      opId: `${agent.id}-${index}`, name: 'soak-child', waitTimeoutMs: 10_000, timeoutMs: 10_000,
      requiredResources: ['exclusive'],
      command: {
        execPath: process.execPath, cwd: root,
        args: ['-e', index === 0 ? 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000)' : 'require("node:fs").writeFileSync("unexpected", "x")'],
      },
      onStreamChunk: (stream, chunk) => {
        if (stream !== 'stdout') return;
        output += chunk.toString('utf8');
        if (!output.includes('\n')) return;
        const pids = JSON.parse(output.trim());
        assert(pids.length === 2 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
        observedPids += pids.length; entered(pids);
      },
    }));
    const results = await Promise.allSettled(commands);
    rejectedCommands += results.filter((result) => result.status === 'rejected').length;
    return { status: 'completed', checkpoint: 2 };
  },
});

try {
  while (performance.now() - start < durationSeconds * 1000) {
    const runId = `run-${cycles}`;
    store.saveRun({ id: runId, taskId: 'task', domainId: domain.domainId, owner: 'soak', status: 'running', startedAt: new Date().toISOString() });
    const parent = `${runId}-parent`; const child = `${runId}-child`;
    for (const id of [parent, child]) runtime.create({ id, runId, ...(id === child ? { parentId: parent } : {}), input: null, checkpoint: 0, maxSteps: 3 });
    const started = new Promise((resolve) => { entered = resolve; });
    const draining = runtime.drain(); pending.add(draining);
    let timer;
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Soak process did not start in 15 seconds')), 15_000); });
    const pids = await Promise.race([started, timedOut]).finally(() => clearTimeout(timer));
    if (cycles % 5 === 0) {
      const record = store.recordJournalEvent.bind(store);
      store.recordJournalEvent = (event) => {
        if (event.payload.transition === 'interrupt_requested') throw new Error('injected ENOSPC at journal boundary');
        return record(event);
      };
      try {
        await assert.rejects(runtime.interrupt(parent), /injected ENOSPC/);
        assert.equal(runtime.get(child).reason, null);
        faults++;
      } finally { store.recordJournalEvent = record; }
    }
    await runtime.interrupt(parent);
    await draining; pending.delete(draining);
    for (const pid of pids) assert.equal(alive(pid), false, `Residual process ${pid}`);
    assert.equal(fs.existsSync(path.join(root, 'unexpected')), false, 'Queued side effect escaped cancellation');
    assert.equal(domain.isResourceLocked('exclusive'), false);
    assert.equal(runtime.getRunUsage(runId).pendingCommands, 0);
    assert.equal(runtime.getRunUsage(runId).stepsUsed, 2);
    assert.equal(runtime.get(child).checkpoint, 0);
    assert.equal(runtime.get(parent).status, 'interrupted');
    store.reportRunFailed(runId, 'user_cancelled');
    cycles++;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (cycles % 20 === 0) {
      await crashProbe(cycles % 40 === 0 ? 'scope-waiting' : 'scope-cancel');
      const sample = { cycles, elapsedMs: Math.round(performance.now() - start), rss: process.memoryUsage().rss,
        journalEvents: store.getJournalEvents(domain.domainId).length, eventLoopP99Ms: delay.percentile(99) / 1e6 };
      samples.push(sample); console.log(JSON.stringify({ progress: sample }));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await runtime.shutdown();
  const report = { status: 'PASS', node: process.version, platform: process.platform,
    driver: domain.getDriver()?.constructor.name ?? 'NodePlatformDriver', durationMs: Math.round(performance.now() - start),
    cycles, journalFaults: faults, hostCrashes: crashes, rejectedCommands, observedPids, residualProcesses: 0,
    initialMemory, finalMemory: process.memoryUsage(), peakRss,
    journalEvents: store.getJournalEvents(domain.domainId).length,
    databaseBytes: fs.statSync(path.join(domain.domainPath, 'domain.db')).size,
    eventLoopP99Ms: delay.percentile(99) / 1e6, eventLoopMaxMs: delay.max / 1e6, samples };
  console.log(JSON.stringify(report));
} finally {
  await runtime.shutdown(); await Promise.allSettled(pending); delay.disable(); domain.close();
  fs.rmSync(root, { recursive: true, force: true });
}
