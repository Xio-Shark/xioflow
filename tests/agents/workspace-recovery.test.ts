import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentRuntime, type AgentData, ExecutionDomain, ProcessSupervisor, recoverAgentWorkspace } from '../../src/index.js';
import type { ObservationEntry, ObservationValidation } from '../../src/workspace/transactions.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const steps = [
  { tool: 'read', args: { path: 'util.mjs' } },
  { tool: 'edit', args: { path: 'util.mjs', old: 'foo', replacement: 'bar' } },
  { tool: 'read', args: { path: 'caller.mjs' } },
  { tool: 'edit', args: { path: 'caller.mjs', old: 'foo', replacement: 'bar' } },
];

function execute(call: ObservationEntry['call'], root: string): string {
  const file = path.join(root, String(call.args.path));
  if (call.tool === 'read') return fs.readFileSync(file, 'utf8');
  if (call.tool === 'poison') { fs.writeFileSync(file, 'must be discarded'); return 'different result'; }
  const current = fs.readFileSync(file, 'utf8');
  if (!current.includes(String(call.args.old))) throw new Error('edit anchor missing');
  fs.writeFileSync(file, current.replaceAll(String(call.args.old), String(call.args.replacement)));
  return 'ok';
}

const logOf = (checkpoint: AgentData) => (checkpoint as { log: unknown }).log as ObservationEntry[];
const observations = (checkpoint: AgentData): ObservationValidation => ({
  log: logOf(checkpoint), closedWorld: true,
  replay: async (entry, root) => hash(execute(entry.call, root)),
});

describe('agent recovery into workspace transactions', () => {
  let temp: string; let root: string; let domain: ExecutionDomain;
  let supervisor: ProcessSupervisor; let agents: AgentRuntime;
  let paused = false;
  beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-agent-workspace-')));
    root = path.join(temp, 'repo'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'util.mjs'), 'export function foo() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'caller.mjs'), "import { foo } from './util.mjs';\nconsole.log(foo());\n");
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-qm', 'base');
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'recovery');
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'rename', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
    supervisor = new ProcessSupervisor(domain); paused = false;
    agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async (agent) => {
      const log = logOf(agent.checkpoint);
      if (log.length === steps.length) return { status: 'completed', checkpoint: agent.checkpoint };
      const call = steps[log.length];
      const entry: ObservationEntry = { kind: call.tool === 'read' ? 'observe' : 'mutate', call, resultHash: hash(execute(call, agent.workspace!.forkRoot)) };
      if (log.length === steps.length - 1 && !paused) { paused = true; agents.pause(agent.id); }
      return { status: 'ready', checkpoint: { log: [...log, entry] } as unknown as AgentData };
    } });
  });
  afterEach(() => { agents.close(); domain.close(); fs.rmSync(temp, { recursive: true, force: true }); });

  async function prepare() {
    const a = await supervisor.beginWorkspaceTransaction({ txId: 'a', runId: 'run', root, forkPath: path.join(temp, 'a') });
    const b = await supervisor.beginWorkspaceTransaction({ txId: 'b', runId: 'run', root, forkPath: path.join(temp, 'b') });
    agents.create({ id: 'agent-a', runId: 'run', input: 'rename foo to bar', checkpoint: { log: [] }, workspace: a, maxSteps: 10 });
    await agents.drain();
    const caller = path.join(b.forkRoot, 'caller.mjs');
    fs.writeFileSync(caller, `// B added this comment\n${fs.readFileSync(caller, 'utf8')}`);
    expect((await supervisor.commitWorkspaceTransaction('b')).status).toBe('committed');
    return a;
  }
  const recover = () => recoverAgentWorkspace(agents, supervisor, {
    agentId: 'agent-a', recoveryId: 'recover', root, forkPath: path.join(temp, 'recovered'), observations,
    replayPolicy: 'deterministic',
  });

  it('declares the bound fork for managed commands without replacing domain drivers', async () => {
    const tx = await supervisor.beginWorkspaceTransaction({ txId: 'managed', runId: 'run', root, forkPath: path.join(temp, 'managed') });
    agents.close();
    agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async (agent, execution) => {
      const result = await execution.executeProcess({
        opId: 'managed-read', name: 'read from outside the fork', mutationRoots: [root],
        command: { execPath: process.execPath, cwd: root,
          args: ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', path.join(agent.workspace!.forkRoot, 'util.mjs')] },
      });
      expect(result).toMatchObject({ status: 'succeeded', stdout: 'export function foo() { return 1; }\n' });
      return { status: 'completed', checkpoint: 1 };
    } });
    agents.create({ id: 'managed-agent', runId: 'run', input: null, checkpoint: 0, workspace: tx, maxSteps: 1 });
    await agents.drain();
    expect(agents.get('managed-agent')?.status).toBe('completed');
    expect(domain.getStore().getOperation('managed-read')).toMatchObject({ runId: 'run', mutationRoots: [root, tx.forkRoot] });
    expect(domain.getDriver()).toBe(supervisor.getDriver());
    expect(domain.getSnapshotDriver()).toBe(supervisor.getSnapshotDriver());
    await supervisor.abortWorkspaceTransaction(tx.txId);
  });

  it('reconstructs edits before divergence, resumes only the suffix, and preserves the competing commit', async () => {
    const original = await prepare();
    const recovered = await recover();
    expect(recovered.status).toBe('restored');
    if (recovered.status !== 'restored') return;
    expect(recovered.rejections).toHaveLength(2);
    expect(recovered.attempts).toBe(2);
    expect(recovered.skippedCheckpoints).toBe(1);
    expect(recovered.replayedSteps).toBe(5);
    expect(recovered.rejections[1].source).toBe('reused_prefix');
    expect(recovered.rejections[0].replay).toMatchObject({ divergedAt: 2, reason: 'observation_changed' });
    const state = agents.get('agent-a')!;
    expect(logOf(state.checkpoint)).toHaveLength(2);
    expect(state).toMatchObject({ status: 'paused', stepsUsed: 4, workspace: { txId: recovered.transaction.txId } });
    expect(fs.readFileSync(path.join(state.workspace!.forkRoot, 'util.mjs'), 'utf8')).toContain('function bar');
    expect(fs.readFileSync(path.join(state.workspace!.forkRoot, 'caller.mjs'), 'utf8')).toContain('// B added');
    expect(fs.readFileSync(path.join(root, 'util.mjs'), 'utf8')).toContain('function foo');
    await supervisor.abortWorkspaceTransaction(original.txId);
    agents.resume('agent-a'); await agents.drain();
    expect(agents.get('agent-a')).toMatchObject({ status: 'completed', stepsUsed: 7 });
    expect((await supervisor.commitWorkspaceTransaction(recovered.transaction.txId)).status).toBe('committed');
    expect(execFileSync(process.execPath, [path.join(root, 'caller.mjs')], { encoding: 'utf8' })).toBe('1\n');
    expect(fs.readFileSync(path.join(root, 'caller.mjs'), 'utf8')).toContain('// B added');
    expect(fs.readdirSync(temp).filter((name) => name.startsWith('recovered-'))).toEqual([]);
  });

  it('discards a candidate even when a divergent mutation already wrote files', async () => {
    await prepare();
    const result = await recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'poison', root, forkPath: path.join(temp, 'poison'),
      observations: (checkpoint) => {
        const log = logOf(checkpoint);
        const candidate = log.length > 2 ? [...log.slice(0, 2), {
          kind: 'mutate' as const, call: { tool: 'poison', args: { path: 'poison.txt' } }, resultHash: hash('old result'),
        }] : log;
        return { ...observations(checkpoint), log: candidate };
      },
    });
    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(fs.existsSync(path.join(result.transaction.forkRoot, 'poison.txt'))).toBe(false);
    expect(fs.readdirSync(temp).filter((name) => name.startsWith('poison-'))).toHaveLength(1);
    expect(domain.getStore().listSnapshots(domain.domainId).filter((snapshot) => snapshot.id.startsWith('poison-'))).toHaveLength(1);
  });

  it.each([
    { kind: 'mutate', resultHash: undefined },
    { kind: 'mutate', resultHash: '' },
    { kind: 'observe', resultHash: undefined },
    { kind: 'observe', resultHash: '' },
  ])('rejects $kind evidence with resultHash=$resultHash before replay or fork creation', async ({ kind, resultHash }) => {
    const original = await prepare();
    const before = agents.get('agent-a');
    const snapshots = domain.getStore().listSnapshots(domain.domainId);
    const replay = vi.fn(async (entry: ObservationEntry, target: string) => {
      const output = execute(entry.call, target);
      return hash(entry.kind === 'mutate' ? `${output}: references changed` : output);
    });
    const begin = vi.spyOn(supervisor, 'beginWorkspaceTransaction');
    await expect(recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'missing-hash', root, forkPath: path.join(temp, 'missing-hash'),
      observations: (checkpoint) => ({
        closedWorld: true,
        log: logOf(checkpoint).map((entry) => entry.kind === kind ? { ...entry, resultHash } : entry),
        replay,
      }),
    })).rejects.toThrow('result hashes for every step');
    expect(replay).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(agents.get('agent-a')).toEqual(before);
    expect(domain.getStore().listSnapshots(domain.domainId)).toEqual(snapshots);
    expect(fs.readFileSync(path.join(original.forkRoot, 'util.mjs'), 'utf8')).toContain('function bar');
    expect(fs.readFileSync(path.join(root, 'util.mjs'), 'utf8')).toContain('function foo');
  });

  it.each(['recheck', 'deterministic'] as const)('does not restore context after an applicable edit returns changed evidence (%s)', async (replayPolicy) => {
    await prepare();
    const result = await recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'edit-result', root, forkPath: path.join(temp, 'edit-result'), replayPolicy,
      observations: (checkpoint) => ({
        ...observations(checkpoint), replay: async (entry, target) => {
          const output = execute(entry.call, target);
          // The edit still applies, but its agent-visible references changed.
          return hash(entry.kind === 'mutate' ? `${output}: references changed` : output);
        },
      }),
    });
    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(result.rejections[0].replay).toMatchObject({ divergedAt: 1, reason: 'observation_changed' });
    expect(logOf(agents.get('agent-a')!.checkpoint)).toHaveLength(1);
    expect(agents.get('agent-a')).toMatchObject({ status: 'paused', stepsUsed: 4 });
    // Rejected candidates already edited this file; the selected fork must be clean.
    expect(fs.readFileSync(path.join(result.transaction.forkRoot, 'util.mjs'), 'utf8')).toContain('function foo');
    expect(fs.readFileSync(path.join(result.transaction.forkRoot, 'caller.mjs'), 'utf8')).toContain('// B added');
  });

  it('keeps context and workspace bound together after reopening the runtime', async () => {
    await prepare(); const result = await recover();
    expect(result.status).toBe('restored');
    const before = agents.get('agent-a');
    agents.close(); domain.close();
    domain = ExecutionDomain.acquire(path.join(temp, 'domain'), 'recovery');
    supervisor = new ProcessSupervisor(domain);
    agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async (state) => ({ status: 'completed', checkpoint: state.checkpoint }) });
    expect(agents.get('agent-a')).toEqual(before);
  });

  it('does not discard an independent older branch based on log length alone', async () => {
    const validLog: ObservationEntry[] = [steps[0], steps[2]].map((call) => ({
      kind: 'observe', call, resultHash: hash(execute(call, root)),
    }));
    agents.close();
    agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async (agent) => {
      agents.pause(agent.id);
      return { status: 'ready', checkpoint: { log: [{ ...validLog[0], resultHash: 'stale-branch' }] } as unknown as AgentData };
    } });
    agents.create({ id: 'agent-a', runId: 'run', input: null, checkpoint: { log: validLog } as unknown as AgentData, maxSteps: 4 });
    await agents.drain();
    const result = await recover();
    expect(result.status).toBe('restored');
    expect(result.attempts).toBe(2);
    expect(result.skippedCheckpoints).toBe(0);
    expect(logOf(agents.get('agent-a')!.checkpoint)).toEqual(validLog);
  });

  it('pins one baseline when the main workspace changes during failed replay', async () => {
    await prepare();
    let changed = false;
    const result = await recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'pinned', root, forkPath: path.join(temp, 'pinned'), replayPolicy: 'deterministic',
      observations: (checkpoint) => ({
        ...observations(checkpoint), replay: async (entry, target) => {
          if (!changed) {
            changed = true;
            fs.writeFileSync(path.join(root, 'util.mjs'), 'export function unrelated() { return 99; }\n');
          }
          return hash(execute(entry.call, target));
        },
      }),
    });
    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(logOf(agents.get('agent-a')!.checkpoint)).toHaveLength(2);
    expect(fs.readFileSync(path.join(result.transaction.forkRoot, 'util.mjs'), 'utf8')).toContain('function bar');
    expect((await supervisor.commitWorkspaceTransaction(result.transaction.txId)).status).toBe('conflict');
    const captures = domain.getStore().getJournalEvents(domain.domainId)
      .filter((event) => event.type === 'SNAPSHOT_CAPTURED' && event.operationId?.startsWith('pinned-'));
    expect(captures).toHaveLength(1);
  });

  it('leaves the original agent intact and cleans candidates when no checkpoint validates', async () => {
    await prepare();
    const before = agents.get('agent-a');
    const result = await recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'none', root, forkPath: path.join(temp, 'none'),
      observations: () => ({
        closedWorld: true, log: [{ kind: 'observe', call: steps[0], resultHash: 'never-matches' }],
        replay: async (entry, target) => hash(execute(entry.call, target)),
      }),
    });
    expect(result.status).toBe('no_valid_checkpoint');
    expect(result.rejections).toHaveLength(result.attempts);
    expect(agents.get('agent-a')).toEqual(before);
    expect(fs.readdirSync(temp).filter((name) => name.startsWith('none-'))).toEqual([]);
    expect(domain.getStore().listSnapshots(domain.domainId).filter((snapshot) => snapshot.id.startsWith('none-'))).toEqual([]);
  });

  it('still refuses commit if another write races after reconstruction', async () => {
    await prepare(); const result = await recover();
    if (result.status !== 'restored') throw new Error('recovery failed');
    fs.writeFileSync(path.join(root, 'util.mjs'), 'export function other() { return 2; }\n');
    const committed = await supervisor.commitWorkspaceTransaction(result.transaction.txId);
    expect(committed.status).toBe('conflict');
    expect(fs.readFileSync(path.join(root, 'util.mjs'), 'utf8')).toContain('function other');
  });

  it('does not reuse a transient tool execution failure as proof of an invalid prefix', async () => {
    await prepare();
    const result = await recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'error', root, forkPath: path.join(temp, 'error'), replayPolicy: 'deterministic',
      observations: () => ({
        closedWorld: true, log: [{ kind: 'observe', call: steps[0], resultHash: 'expected' }],
        replay: async () => { throw new Error('temporary I/O failure'); },
      }),
    });
    expect(result.status).toBe('no_valid_checkpoint');
    expect(result.skippedCheckpoints).toBe(0);
    expect(result.attempts).toBe(agents.checkpoints('agent-a').length);
    expect(result.rejections.every((entry) => entry.source === 'executed' && entry.replay.error === 'temporary I/O failure')).toBe(true);
  });

  it('rejects binding an unregistered workspace', () => {
    expect(() => agents.create({ id: 'bad', runId: 'run', input: null, checkpoint: null, maxSteps: 1,
      workspace: { txId: 'missing', forkRoot: root } })).toThrow('open transaction');
    expect(agents.list()).toEqual([]);
  });

  it('retains the shared baseline if aborting a rejected candidate fails', async () => {
    await prepare();
    const abort = vi.spyOn(supervisor, 'abortWorkspaceTransaction').mockRejectedValueOnce(new Error('cannot clean fork'));
    await expect(recover()).rejects.toThrow('cannot clean fork');
    expect(domain.getStore().listSnapshots(domain.domainId).filter((snapshot) => snapshot.id.startsWith('recover-'))).toHaveLength(1);
    expect(fs.readdirSync(temp).filter((name) => name.startsWith('recovered-'))).toHaveLength(1);
    expect(agents.get('agent-a')?.status).toBe('paused');
    abort.mockRestore();
  });

  it('does not schedule two active agents in the same workspace transaction', async () => {
    const workspace = await supervisor.beginWorkspaceTransaction({ txId: 'shared', runId: 'run', root, forkPath: path.join(temp, 'shared') });
    agents.create({ id: 'one', runId: 'run', input: null, checkpoint: null, workspace, maxSteps: 1 });
    expect(() => agents.create({ id: 'two', runId: 'run', input: null, checkpoint: null, workspace, maxSteps: 1 })).toThrow('another active agent');
    expect(agents.list()).toHaveLength(1);
  });

  it('reserves the recovering agent while independent agents can still run', async () => {
    await prepare();
    let release!: () => void; let entered!: () => void; let held = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'held', root, forkPath: path.join(temp, 'held'),
      observations: (checkpoint) => ({ ...observations(checkpoint), replay: async (entry, target) => {
        if (!held) { held = true; entered(); await gate; }
        return hash(execute(entry.call, target));
      } }),
    });
    try {
      await started;
      expect(agents.get('agent-a')?.status).toBe('recovering');
      expect(() => agents.resume('agent-a')).toThrow('recovering');
      expect(() => agents.restoreCheckpoint('agent-a', agents.checkpoints('agent-a')[0].seq)).toThrow();
      await expect(recover()).rejects.toThrow('recovering');
      expect(() => agents.close()).toThrow('recovery');
      const workspace = await supervisor.beginWorkspaceTransaction({ txId: 'independent', runId: 'run', root, forkPath: path.join(temp, 'independent') });
      agents.create({ id: 'independent', runId: 'run', input: 'rename', checkpoint: { log: [] }, workspace, maxSteps: 8 });
      await agents.drain();
      expect(agents.get('independent')?.status).toBe('completed');
      expect(agents.get('agent-a')?.status).toBe('recovering');
    } finally { release(); await pending; }
    expect(agents.get('agent-a')?.status).toBe('paused');
  });

  it('discards a prepared transaction when its Run ends before final binding', async () => {
    await prepare();
    const before = agents.get('agent-a');
    await expect(recoverAgentWorkspace(agents, supervisor, {
      agentId: 'agent-a', recoveryId: 'ended', root, forkPath: path.join(temp, 'ended'),
      observations: (checkpoint) => {
        const log = logOf(checkpoint);
        return { ...observations(checkpoint), replay: async (entry, target) => {
          const result = hash(execute(entry.call, target));
          if (log.length === 2 && entry.kind === 'mutate') domain.reportRunFailed('run');
          return result;
        } };
      },
    })).rejects.toThrow('cannot accept');
    expect(agents.get('agent-a')).toEqual(before);
    expect(fs.readdirSync(temp).filter((name) => name.startsWith('ended-'))).toEqual([]);
    expect(domain.getStore().listSnapshots(domain.domainId).filter((snapshot) => snapshot.id.startsWith('ended-'))).toEqual([]);
  });
});
