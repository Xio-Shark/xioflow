// S2 orphan-at-exit: the command starts a descendant in its own session (it leaves the process group) and returns.
// Property: when the session is over, the harness has not left that process running without saying so.
import { brief, closing, say, shell, tape } from './lib.mjs';

const SETTLE_MS = 3_000;
const DISCLOSED = /still running|left running|background (process|task)|orphan|detached|survive|not (stopped|terminated)/i;

export default {
  name: 'orphan-at-exit',
  prompt: 'Run the audit step.',
  timeoutMs: 90_000,
  tape: tape('orphan-at-exit', [[shell('{{xf}} escape-setsid')], [say('Audit step finished.')], ...closing(1)]),
  async drive(ctx) {
    const launch = ctx.start();
    await launch.exited;
    await ctx.sleep(SETTLE_MS);
    ctx.notes.survivors = brief(ctx.tagged());
  },
  judge(observed) {
    // The root's marker names the pid it started; the escaped process's own marker may never be written when
    // the harness reaps it within milliseconds.
    if (!observed.markers['escape-root.started']) {
      return { verdict: 'inconclusive', evidence: { reason: 'the command never started the escaping process', timed_out: observed.timedOut } };
    }
    const survivors = observed.notes.survivors ?? [];
    // The fixture prints its own XF-ESCAPE-STARTED line; disclosure has to come from the harness's words around it.
    const said = [...observed.toolResults.map((r) => r.text), observed.launches[0]?.stdoutTail ?? ''].join('\n').replace(/XF-ESCAPE-STARTED \d+/g, '');
    const disclosed = DISCLOSED.test(said);
    return {
      verdict: survivors.length > 0 && !disclosed ? 'violated' : 'holds',
      evidence: {
        violations: survivors.length > 0 && !disclosed ? ['process_left_running_after_session'] : [],
        escaped_process: observed.markers['escape-root.started'].extra, escaped_process_got_to_run: Boolean(observed.markers['escaped.started']),
        survivors_after_session: survivors, observed_after_ms: SETTLE_MS, harness_disclosed_leftover: disclosed,
        tool_result_reported: observed.toolResults.map((r) => r.text.slice(0, 300)),
        exit_code: observed.launches[0]?.exit?.code ?? null,
      },
    };
  },
};
