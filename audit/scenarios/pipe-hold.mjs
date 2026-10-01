// S1 pipe-hold: the command's root process exits at once while a child in the same process group keeps the
// inherited stdout/stderr open for HOLD_SECONDS.
// Properties: (a) the tool call returns within a bound after the root exited, instead of waiting for the pipe
// holder; (b) once the session is over, the harness has not left the holder running.
const HOLD_SECONDS = 20;
const RETURN_BOUND_MS = 10_000;

export default {
  name: 'pipe-hold',
  prompt: 'Run the audit step.',
  timeoutMs: 120_000,
  tape: {
    schema_version: 'xio-agent-tape.v1',
    name: 'pipe-hold',
    turns: [
      { steps: [{ type: 'tool_call', action: 'shell', command: `{{xf}} hold-pipe-after-exit ${HOLD_SECONDS} --exit=1` }] },
      { steps: [{ type: 'delta', channel: 'text', chunks: ['Audit step finished.'] }] },
    ],
  },
  async drive(ctx) {
    const launch = ctx.start();
    await launch.exited;
    // Right after the session ended: is the holder still there?
    ctx.notes.survivorsAtExit = ctx.tagged().map(({ pid, ppid, command }) => ({ pid, ppid, command: command.replace(/--xf-run=\S+/, '--xf-run=<run>') }));
  },
  judge(observed) {
    const rootExit = observed.markers['pipe-root.exited']?.at;
    const holderStart = observed.markers['pipe-holder.started']?.at;
    const holderExit = observed.markers['pipe-holder.exited']?.at;
    const next = observed.requests.find((r) => r.kind === 'main' && r.turn === 1);
    const sessionEnd = observed.launches[0]?.exit?.at;
    if (!rootExit || !next || !sessionEnd) {
      return { verdict: 'inconclusive', evidence: { reason: 'the command did not run or the harness never reported back', root_exit: rootExit ?? null, next_request: next?.at ?? null, timed_out: observed.timedOut } };
    }
    const returnDelayMs = next.at - rootExit;
    const survivors = observed.notes.survivorsAtExit ?? [];
    const violations = [];
    if (returnDelayMs > RETURN_BOUND_MS) violations.push('tool_call_waited_for_pipe_holder');
    if (survivors.length > 0) violations.push('process_left_running_after_session');
    return {
      verdict: violations.length > 0 ? 'violated' : 'holds',
      evidence: {
        violations,
        return_delay_ms: returnDelayMs, return_bound_ms: RETURN_BOUND_MS, hold_ms: HOLD_SECONDS * 1000,
        holder_lifetime_ms: holderExit && holderStart ? holderExit - holderStart : null,
        holder_ended_by: holderExit ? 'its own timer' : 'something else (killed, or still running)',
        survivors_at_session_end: survivors,
        tool_result_reported: observed.toolResults.map((r) => r.text.slice(0, 400)),
        exit_code: observed.launches[0]?.exit?.code ?? null,
      },
    };
  },
};
