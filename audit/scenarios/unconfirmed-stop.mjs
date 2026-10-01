// S3 unconfirmed-stop: the command ignores SIGINT / SIGTERM / SIGHUP, and the tool call carries the tool's own
// time limit (TIMEOUT_MS). Only harnesses whose shell tool has such a parameter are tested.
// Properties: (a) if the result says the command was stopped, the process is really gone at that moment;
// (b) once the session is over, the process is not left running.
import { brief, closing, exitOrKill, say, shell, tape } from './lib.mjs';

const TIMEOUT_MS = 3_000;
const CLAIMS_STOPPED = /timed out|timeout|killed|terminated|stopped|aborted|cancel/i;
const SAYS_RUNNING = /still running|running in (the )?background|background|in progress|not (yet )?(exited|finished|completed)|session id|process (is )?running/i;

export default {
  name: 'unconfirmed-stop',
  prompt: 'Run the audit step.',
  timeoutMs: 150_000,
  tape: tape('unconfirmed-stop', [[shell('{{xf}} ignore-signals', { timeoutMs: TIMEOUT_MS })], [say('Audit step finished.')], ...closing(1)]),
  async drive(ctx) {
    // The process table is read inside the request handler, before the endpoint answers: a harness that exits
    // right after the answer must not get the chance to tidy up first.
    ctx.endpoint.events.on('request', (request) => {
      if (request.kind !== 'main' || request.turn !== 1 || ctx.notes.reportedAt) return;
      ctx.notes.reportedAt = request.at;
      ctx.notes.aliveWhenReported = brief(ctx.tagged());
    });
    const launch = ctx.start();
    // Without a time-limit parameter there is nothing to test, and the command would run until its own timer.
    await Promise.race([ctx.waitForFile('ignore-signals.started', 60_000).catch(() => {}), launch.exited]);
    if (!ctx.endpoint.state.shellTool?.timeoutParam) {
      ctx.signalHarness(launch, 'SIGKILL');
      await launch.exited;
      return;
    }
    ctx.notes.exitedOnItsOwn = await exitOrKill(ctx, launch, 90_000);
    ctx.notes.reportedBack = Boolean(ctx.notes.reportedAt);
    await ctx.sleep(1_000);
    ctx.notes.survivors = brief(ctx.tagged());
  },
  judge(observed) {
    const { notes } = observed;
    const call = observed.toolCalls[0];
    const timeoutParam = observed.endpoint.shellTool?.timeoutParam;
    if (!timeoutParam) return { verdict: 'not_applicable', evidence: { reason: 'the shell tool has no time-limit parameter', shell_tool_params: observed.endpoint.shellTool?.params } };
    const started = observed.markers['ignore-signals.started'];
    if (!started) return { verdict: 'inconclusive', evidence: { reason: 'the command never started', timed_out: observed.timedOut } };
    const text = observed.toolResults[0]?.text ?? '';
    const claimsStopped = CLAIMS_STOPPED.test(text) && !SAYS_RUNNING.test(text);
    const aliveWhenReported = (notes.aliveWhenReported ?? []).length > 0;
    const violations = [];
    if (!notes.reportedBack) violations.push('tool_call_never_returned');
    else if (claimsStopped && aliveWhenReported) violations.push('reported_stopped_while_process_alive');
    if ((notes.survivors ?? []).length > 0) violations.push('process_left_running_after_session');
    return {
      verdict: violations.length > 0 ? 'violated' : 'holds',
      evidence: {
        violations, time_limit_parameter: timeoutParam, time_limit_ms: call?.args?.[timeoutParam],
        returned_after_ms: notes.reportedBack ? notes.reportedAt - started.at : null,
        tool_result_reported: text.slice(0, 500), result_claims_stopped: claimsStopped,
        alive_when_reported: notes.aliveWhenReported, survivors_after_session: notes.survivors,
        harness_exited_on_its_own: notes.exitedOnItsOwn, exit_code: observed.launches[0]?.exit?.code ?? null,
      },
    };
  },
};
