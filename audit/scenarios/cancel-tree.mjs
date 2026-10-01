// S7 cancel-tree: the command starts a chain of three sleeping processes; the user then presses Ctrl-C
// (SIGINT to the harness's foreground process group; a second one if the first only cancelled the turn).
// Property: after the harness has exited, none of the processes the command started is left.
import { brief, closing, shell, tape } from './lib.mjs';

export default {
  name: 'cancel-tree',
  prompt: 'Run the audit step.',
  timeoutMs: 120_000,
  tape: tape('cancel-tree', [[shell('{{xf}} spawn-tree 3')], ...closing(3)]),
  async drive(ctx) {
    const launch = ctx.start();
    await ctx.waitForFile('tree-1.started', 60_000);
    ctx.notes.treeBefore = ctx.tagged().length;
    const exitedWithin = (ms) => Promise.race([launch.exited.then(() => true), ctx.sleep(ms).then(() => false)]);
    ctx.notes.interrupts = 1;
    ctx.interruptGroup(launch);
    if (!(await exitedWithin(5_000))) {
      ctx.notes.interrupts = 2;
      ctx.interruptGroup(launch);
    }
    ctx.notes.exitedAfterInterrupt = await exitedWithin(15_000);
    if (!ctx.notes.exitedAfterInterrupt) {
      ctx.signalHarness(launch, 'SIGKILL');
      await launch.exited;
    }
    await ctx.sleep(2_000);
    ctx.notes.survivors = brief(ctx.tagged());
  },
  judge(observed) {
    const { notes } = observed;
    if (!observed.markers['tree-1.started']) return { verdict: 'inconclusive', evidence: { reason: 'the process tree never started', timed_out: observed.timedOut } };
    const violations = [];
    if (!notes.exitedAfterInterrupt) violations.push('harness_did_not_exit_on_interrupt');
    if ((notes.survivors ?? []).length > 0) violations.push('tree_survived_cancel');
    return {
      verdict: violations.length > 0 ? 'violated' : 'holds',
      evidence: {
        violations, tree_processes_before: notes.treeBefore, interrupts_sent: notes.interrupts,
        harness_exited_after_interrupt: notes.exitedAfterInterrupt, exit: observed.launches[0]?.exit,
        survivors_after_cancel: notes.survivors,
      },
    };
  },
};
