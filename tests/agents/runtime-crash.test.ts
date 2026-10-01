import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRuntime, ExecutionDomain } from '../../src/index.js';
import { buildDist } from '../support/build-dist.js';

buildDist();

it.each(['step', 'recovery', 'command'])('recovers a scheduler killed during %s without automatic replay or budget reset', async (mode) => {
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
    const charged = mode === 'recovery' ? 0 : 1;
    expect(runtime.get('a')).toMatchObject({ status: 'interrupted', stepsUsed: charged, checkpoint: { turn: 0 } });
    await runtime.drain();
    expect(step).not.toHaveBeenCalled();
    runtime.restoreCheckpoint('a', runtime.checkpoints('a')[0].seq);
    runtime.resume('a'); await runtime.drain();
    expect(runtime.get('a')).toMatchObject({ status: 'completed', stepsUsed: charged + 1 });
    if (mode === 'command') expect(fs.readFileSync(path.join(root, 'command-count'), 'utf8')).toBe('x');
  } finally {
    runtime?.close(); domain?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
