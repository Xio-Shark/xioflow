import { describe, expect, it } from 'vitest';
import { AgentCommandGroup, type AgentCommandOptions, type AgentCommandResult } from '../../src/agents/execution.js';

const options: AgentCommandOptions = {
  opId: 'op', name: 'test', command: { execPath: process.execPath, args: [], cwd: process.cwd() },
};
const succeeded: AgentCommandResult = {
  kind: 'process', status: 'succeeded', exitCode: 0, signal: null, stdout: '', stderr: '',
  isTruncated: false, identityVerification: 'not_original_process', durationMs: 0, completedAt: '2026-10-01T00:00:00Z',
};

describe('per-quantum command group', () => {
  it('releases a reservation before the next sequential command is submitted', async () => {
    let pending = 0;
    const group = new AgentCommandGroup(async () => succeeded, undefined, () => {
      if (pending === 1) throw new Error('queue full');
      pending++;
      return () => { pending--; };
    });
    for (let i = 0; i < 100; i++) await group.context.executeProcess(options);
    expect(pending).toBe(0);
    expect(await group.finish()).toEqual([]);
  });
  it.each(['agent', 'command'] as const)('composes %s cancellation with the command signal', async (source) => {
    const agent = new AbortController(); const command = new AbortController();
    let signal!: AbortSignal;
    const group = new AgentCommandGroup(async (submitted) => {
      signal = submitted.abortSignal!;
      return succeeded;
    }, agent.signal);
    await group.context.executeProcess({ ...options, abortSignal: command.signal });
    expect(group.context.signal).toBe(agent.signal);
    const reason = new Error(source);
    (source === 'agent' ? agent : command).abort(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    await group.finish();
  });

  it('rejects commands submitted after interruption without admission', async () => {
    const controller = new AbortController();
    let submitted = false;
    const group = new AgentCommandGroup(async () => { submitted = true; return succeeded; }, controller.signal);
    const reason = new Error('interrupted');
    controller.abort(reason);
    await expect(group.context.executeProcess(options)).rejects.toBe(reason);
    expect(await group.finish()).toEqual([reason]);
    expect(submitted).toBe(false);
  });

  it('joins unawaited commands and closes admission before waiting for them', async () => {
    let resolve!: (result: AgentCommandResult) => void;
    const pending = new Promise<AgentCommandResult>((done) => { resolve = done; });
    const group = new AgentCommandGroup(() => pending);
    void group.context.executeProcess(options);
    let finished = false;
    const finishing = group.finish().then((failures) => { finished = true; return failures; });
    await expect(group.context.executeProcess(options)).rejects.toThrow('context is closed');
    expect(finished).toBe(false);
    resolve(succeeded);
    expect(await finishing).toEqual([]);
  });

  it('retains synchronous admission errors even when the adapter catches them', async () => {
    const failure = new Error('admission rejected');
    const group = new AgentCommandGroup(() => { throw failure; });
    await expect(group.context.executeProcess(options)).rejects.toBe(failure);
    expect(await group.finish()).toEqual([failure]);
  });

  it('keeps ordinary nonzero exits as inspectable results, not transport failures', async () => {
    const result = { ...succeeded, status: 'failed' as const, exitCode: 2 };
    const group = new AgentCommandGroup(async () => result);
    expect(await group.context.executeProcess(options)).toBe(result);
    expect(await group.finish()).toEqual([]);
  });

  it('makes indeterminate outcomes block the checkpoint and preserves their reason', async () => {
    const result: AgentCommandResult = {
      kind: 'indeterminate', status: 'indeterminate', reason: 'descendant still alive',
      recoveryGuidance: 'inspect operation', durationMs: 1, completedAt: succeeded.completedAt,
    };
    const group = new AgentCommandGroup(async () => result);
    expect(await group.context.executeProcess(options)).toBe(result);
    const failures = await group.finish();
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('descendant still alive');
  });
});
