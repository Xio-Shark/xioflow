// S4 kill-mid-tool: the command performs its side effect at once and keeps running; the harness is SIGKILLed
// while the call is in flight, then resumed.
// Properties: (a) the side effect is not performed again; (b) the resumed session's history still contains the
// call (the model must be able to know something ran); (c) the process the dead harness left behind is either
// gone or mentioned once the resumed session is over.
import { brief, closing, exitOrKill, mainRequestsOf, resumedAccount, shell, tape } from './lib.mjs';

const EFFECT_RUNS_MS = 30_000;
const MENTIONS_LEFTOVER = /still running|left running|may (still )?be running|orphan|process .*(alive|running)|pid \d+/i;

export default {
  name: 'kill-mid-tool',
  prompt: 'Run the audit step.',
  timeoutMs: 150_000,
  tape: tape('kill-mid-tool', [[shell(`{{xf}} slow-effect A ${EFFECT_RUNS_MS}`)], ...closing(4)]),
  async drive(ctx) {
    const first = ctx.start();
    await ctx.waitForFile('effect-A.started', 60_000);
    ctx.notes.killedAt = Date.now();
    ctx.notes.killed = ctx.signalHarness(first, 'SIGKILL');
    await exitOrKill(ctx, first, 5_000);
    await ctx.sleep(1_000);
    ctx.notes.survivorsAfterKill = brief(ctx.tagged());
    if (!ctx.canResume) return;
    const second = ctx.start('resume', 'Continue.');
    ctx.notes.resumeExitedOnItsOwn = await exitOrKill(ctx, second, 60_000);
    ctx.notes.survivorsAfterResume = brief(ctx.tagged());
    ctx.notes.resumedAt = Date.now();
  },
  judge(observed) {
    const { notes } = observed;
    if (!observed.markers['effect-A.started']) return { verdict: 'inconclusive', evidence: { reason: 'the command never started', timed_out: observed.timedOut } };
    if (observed.launches.length < 2) return { verdict: 'not_applicable', evidence: { reason: 'harness has no resume command', survivors_after_kill: notes.survivorsAfterKill } };
    const resumeRequests = mainRequestsOf(observed, 1);
    const callId = observed.toolCalls[0]?.id;
    const account = resumedAccount(resumeRequests, callId);
    const executions = observed.effects.counts.A ?? 0;
    const survivorsAfterResume = notes.survivorsAfterResume ?? [];
    const told = resumeRequests.flatMap((r) => r.toolResults ?? []).map((r) => r.text).join('\n');
    const evidence = {
      effect_executions: executions,
      killed_processes: notes.killed,
      survivors_after_kill: notes.survivorsAfterKill,
      resume_exit_code: observed.launches[1]?.exit?.code ?? null, resume_exited_on_its_own: notes.resumeExitedOnItsOwn,
      resume_main_requests: resumeRequests.length,
      resumed_account_of_the_call: account,
      survivors_after_resume: survivorsAfterResume,
      effect_still_running_ms_after_kill: notes.resumedAt - notes.killedAt,
      resume_stderr_tail: (observed.launches[1]?.stderrTail ?? '').slice(-300),
    };
    if (account.state === 'no_request_after_resume') {
      return { verdict: 'inconclusive', evidence: { reason: 'the resumed harness never contacted the model', ...evidence } };
    }
    const violations = [];
    if (executions > 1) violations.push('effect_repeated');
    if (account.state === 'call_absent') violations.push('effect_not_in_resumed_history');
    if (survivorsAfterResume.length > 0 && !MENTIONS_LEFTOVER.test(told)) violations.push('orphan_unaccounted_after_resume');
    return { verdict: violations.length > 0 ? 'violated' : 'holds', evidence: { violations, ...evidence } };
  },
};
