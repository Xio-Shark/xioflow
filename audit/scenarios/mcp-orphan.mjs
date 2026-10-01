// S8 mcp-orphan: a stdio MCP server (the fixture; it does not exit when its stdin closes) is registered in the
// harness's sandboxed configuration.
// Property: when the session ends, the MCP server the harness started is not left running.
// Two variants: the session ends normally (mcp-orphan-exit), or the harness is SIGKILLed (mcp-orphan-kill).
import { brief, closing, exitOrKill, say, tape } from './lib.mjs';

const SETTLE_MS = 3_000;

function scenario(name, end) {
  return {
    name,
    prompt: 'Say hello.',
    timeoutMs: 120_000,
    mcpServer: true,
    tape: tape(name, [[{ type: 'barrier', id: 'mcp-up' }, say('Hello.')], ...closing(2)]),
    async drive(ctx) {
      const launch = ctx.start();
      // Hold the model's answer until the server is up (or clearly is not going to be), so every harness is
      // observed with the server running.
      ctx.notes.serverStarted = await Promise.race([
        ctx.waitForFile('mcp-server.started', 30_000).then(() => true, () => false),
        launch.exited.then(() => false),
      ]);
      if (end === 'kill' && ctx.notes.serverStarted) {
        ctx.notes.killed = ctx.signalHarness(launch, 'SIGKILL');
        await exitOrKill(ctx, launch, 5_000);
        ctx.endpoint.release('mcp-up');
      } else {
        ctx.endpoint.release('mcp-up');
        ctx.notes.exitedOnItsOwn = await exitOrKill(ctx, launch, 60_000);
      }
      await ctx.sleep(SETTLE_MS);
      ctx.notes.survivors = brief(ctx.tagged());
    },
    judge(observed) {
      const { notes } = observed;
      if (!notes.serverStarted) {
        return { verdict: 'not_applicable', evidence: { reason: 'the harness did not start the registered MCP server in this mode', stderr_tail: (observed.launches[0]?.stderrTail ?? '').slice(-300) } };
      }
      const survivors = notes.survivors ?? [];
      return {
        verdict: survivors.length > 0 ? 'violated' : 'holds',
        evidence: {
          violations: survivors.length > 0 ? ['mcp_server_left_running'] : [],
          session_end: end === 'kill' ? 'harness SIGKILLed' : 'normal exit', observed_after_ms: SETTLE_MS,
          stdin_closed_for_server: Boolean(observed.markers['mcp-server.stdin-closed']),
          survivors_after_session: survivors,
          harness_exited_on_its_own: notes.exitedOnItsOwn, exit_code: observed.launches[0]?.exit?.code ?? null,
        },
      };
    },
  };
}

export const mcpOrphanExit = scenario('mcp-orphan-exit', 'exit');
export const mcpOrphanKill = scenario('mcp-orphan-kill', 'kill');
