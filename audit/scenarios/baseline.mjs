// Baseline: the harness runs one command through its shell tool, exactly once, and tells the model what it printed.
// This is the bench's own sanity check: if it does not hold, the harness is not being driven and no fault
// scenario on it means anything.
export default {
  name: 'baseline',
  prompt: 'Run the audit step.',
  timeoutMs: 90_000,
  tape: {
    schema_version: 'xio-agent-tape.v1',
    name: 'baseline',
    turns: [
      { steps: [{ type: 'tool_call', action: 'shell', command: '{{xf}} effect A' }] },
      { steps: [{ type: 'delta', channel: 'text', chunks: ['Audit step finished.'] }] },
      // A spare turn: some harnesses follow the session with a second agent (memory extraction) that also offers tools.
      { steps: [{ type: 'delta', channel: 'text', chunks: ['Acknowledged.'] }] },
    ],
  },
  judge(observed) {
    const executions = observed.effects.counts.A ?? 0;
    const reported = observed.toolResults.some((r) => r.text.includes('XF-EFFECT-DONE A'));
    const { exit, cleanExit } = observed.launches[0] ?? {};
    const evidence = {
      effect_executions: executions,
      tool_result_has_fixture_output: reported,
      exit_code: exit?.code ?? null, exit_signal: exit?.signal ?? null, timed_out: observed.timedOut,
      main_requests: observed.endpoint.mainRequests, tape_exhausted: observed.endpoint.tapeExhausted,
      survivors: observed.survivors.length,
    };
    const ok = executions === 1 && reported && cleanExit && !observed.timedOut && !observed.endpoint.tapeExhausted && observed.survivors.length === 0;
    return { verdict: ok ? 'holds' : 'inconclusive', evidence };
  },
};
