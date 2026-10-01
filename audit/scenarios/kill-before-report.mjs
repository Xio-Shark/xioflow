// S5 kill-before-report: the command completes its side effect and the harness sends the result to the model;
// the harness is SIGKILLed while that request is pending (the model never answers), then resumed.
// Properties: (a) the side effect is not performed again; (b) the resumed history still contains the completed call.
import { closing, exitOrKill, mainRequestsOf, resumedAccount, say, shell, tape } from './lib.mjs';

export default {
  name: 'kill-before-report',
  prompt: 'Run the audit step.',
  timeoutMs: 150_000,
  tape: tape('kill-before-report', [
    [shell('{{xf}} effect B')],
    [{ type: 'barrier', id: 'report' }, say('Acknowledged.')],
    ...closing(4),
  ]),
  async drive(ctx) {
    const reported = new Promise((resolve) => ctx.endpoint.events.once('barrier', resolve));
    const first = ctx.start();
    await Promise.race([reported, first.exited]);
    if (first.exit) return; // the harness ended before reporting: judge() says inconclusive
    ctx.notes.killedAt = Date.now();
    ctx.notes.killed = ctx.signalHarness(first, 'SIGKILL');
    await exitOrKill(ctx, first, 5_000);
    ctx.endpoint.release('report');
    if (!ctx.canResume) return;
    const second = ctx.start('resume', 'Continue.');
    ctx.notes.resumeExitedOnItsOwn = await exitOrKill(ctx, second, 60_000);
  },
  judge(observed) {
    const { notes } = observed;
    const executions = observed.effects.counts.B ?? 0;
    if (executions === 0 || !notes.killedAt) return { verdict: 'inconclusive', evidence: { reason: 'the command did not run or the harness never reported it', effect_executions: executions, timed_out: observed.timedOut } };
    if (observed.launches.length < 2) return { verdict: 'not_applicable', evidence: { reason: 'harness has no resume command' } };
    const resumeRequests = mainRequestsOf(observed, 1);
    const account = resumedAccount(resumeRequests, observed.toolCalls[0]?.id);
    const evidence = {
      effect_executions: executions,
      reported_before_kill: mainRequestsOf(observed, 0).at(-1)?.toolResults?.map((r) => r.text.slice(0, 200)),
      resume_exit_code: observed.launches[1]?.exit?.code ?? null, resume_exited_on_its_own: notes.resumeExitedOnItsOwn,
      resume_main_requests: resumeRequests.length,
      resumed_account_of_the_call: account,
      resume_stderr_tail: (observed.launches[1]?.stderrTail ?? '').slice(-300),
    };
    if (account.state === 'no_request_after_resume') {
      return { verdict: 'inconclusive', evidence: { reason: 'the resumed harness never contacted the model', ...evidence } };
    }
    const violations = [];
    if (executions > 1) violations.push('effect_repeated');
    if (account.state === 'call_absent') violations.push('completed_effect_not_in_resumed_history');
    return { verdict: violations.length > 0 ? 'violated' : 'holds', evidence: { violations, ...evidence } };
  },
};
