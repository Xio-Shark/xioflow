import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRuntime, ExecutionDomain } from '../../src/index.js';
import { buildDist } from '../support/build-dist.js';

buildDist();

it.each(['scope-cancel', 'scope-waiting'])('recovers %s with the whole scope fenced and shared charges retained', async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-scope-crash-'));
  let domain: ExecutionDomain | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    const killed = spawnSync(process.execPath, [path.join(import.meta.dirname, 'crash-worker.mjs'), root, mode], { encoding: 'utf8', timeout: 10_000 });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    domain = ExecutionDomain.acquire(root, 'crash-agents');
    const step = vi.fn(async () => ({ status: 'completed' as const, checkpoint: 1 }));
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 3, step, runBudget: { maxSteps: 100, maxAgents: 100, maxPendingCommands: 100 } });
    expect(runtime.list().every((agent) => agent.status === 'interrupted')).toBe(true);
    expect(runtime.getRunUsage('run')).toEqual({ budget: { maxSteps: 3, maxAgents: 3, maxPendingCommands: 2 }, agentsCreated: 3, stepsUsed: mode === 'scope-cancel' ? 1 : 2, pendingCommands: 0 });
    await runtime.drain(); expect(step).not.toHaveBeenCalled();
    for (const id of ['a', 'child', 'grandchild']) runtime.restoreCheckpoint(id, runtime.checkpoints(id)[0].seq);
    for (const id of ['a', 'child', 'grandchild']) runtime.resume(id);
    await runtime.drain();
    expect(runtime.getRunUsage('run').stepsUsed).toBe(3);
    expect(runtime.get('grandchild')?.stepsUsed).toBe(0);
    expect(runtime.get('a')?.status).toBe('waiting');
  } finally {
    await runtime?.shutdown(); domain?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each(['step', 'recovery', 'command', 'interrupt-checking', 'interrupt-running', 'shutdown-checking', 'shutdown-running'])('recovers a scheduler killed during %s without automatic replay or budget reset', async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agent-crash-'));
  let domain: ExecutionDomain | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    const killed = spawnSync(process.execPath, [path.join(import.meta.dirname, 'crash-worker.mjs'), root, mode], { encoding: 'utf8', timeout: 10_000 });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    domain = ExecutionDomain.acquire(root, 'crash-agents');
    const step = vi.fn(async (_agent, execution) => {
      if (mode === 'command') {
        const result = await execution.executeProcess({
          opId: 'once', name: 'once',
          command: { execPath: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("command-count", "x")'], cwd: root },
        });
        expect(result).toMatchObject({ status: 'succeeded', replayed: true });
      }
      return { status: 'completed' as const, checkpoint: { turn: 1 } };
    });
    runtime = new AgentRuntime(domain, { maxConcurrentAgents: 1, step });
    const charged = mode === 'recovery' || mode.endsWith('-checking') ? 0 : 1;
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', stepsUsed: charged, checkpoint: { turn: 0 } });
    await runtime.drain();
    expect(step).not.toHaveBeenCalled();
    if (mode.startsWith('interrupt-') || mode.startsWith('shutdown-')) {
      expect(() => runtime!.resume('a')).toThrow('restore');
      expect(domain.getStore().getJournalEvents(domain.domainId).filter((event) => event.payload.transition === 'interrupt_requested')).toHaveLength(1);
    }
    runtime.restoreCheckpoint('a', runtime.checkpoints('a')[0].seq);
    runtime.resume('a'); await runtime.drain();
    expect(runtime.get('a')).toMatchObject({ status: 'completed', stepsUsed: charged + 1 });
    if (mode === 'command') expect(fs.readFileSync(path.join(root, 'command-count'), 'utf8')).toBe('x');
  } finally {
    runtime?.close(); domain?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
