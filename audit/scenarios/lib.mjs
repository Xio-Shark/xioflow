// Shared pieces for scenarios.
export const tape = (name, turns) => ({ schema_version: 'xio-agent-tape.v1', name, turns: turns.map((steps) => ({ steps })) });
export const shell = (command, extra = {}) => ({ type: 'tool_call', action: 'shell', command, ...extra });
export const say = (text) => ({ type: 'delta', channel: 'text', chunks: [text] });
/** Spare closing turns: a resumed harness may ask again, and the verdict should not hinge on the tape running out. */
export const closing = (n = 3) => Array.from({ length: n }, () => [say('Acknowledged.')]);

export const brief = (processes) => processes.map(({ pid, ppid, command }) => ({
  pid, ppid, command: command.replace(/--xf-run=\S+/, '--xf-run=<run>').replace(/^\S+node\S* \S+xf-fixture\.mjs/, 'xf-fixture').slice(0, 160),
}));

/** Waits for a launch to exit; past the deadline the harness is killed and the launch is marked as hung. */
export async function exitOrKill(ctx, launch, timeoutMs) {
  const exited = await Promise.race([launch.exited.then(() => true), ctx.sleep(timeoutMs).then(() => false)]);
  if (!exited) {
    ctx.signalHarness(launch, 'SIGKILL');
    await launch.exited;
  }
  return exited;
}

const INTERRUPTED = /interrupt|cancel|abort|kill|terminat|did not (complete|finish)|no (result|output)|unknown|lost|crash|not (completed|finished)|incomplete|never (completed|returned)/i;

/**
 * After a kill and a resume: what does the resumed harness tell the model about the call that was in flight?
 * `resumeRequests` are the main requests of the resumed launch; `callId` is the id the endpoint issued.
 */
export function resumedAccount(resumeRequests, callId) {
  const first = resumeRequests[0];
  if (!first) return { state: 'no_request_after_resume' };
  const replayed = (first.toolCalls ?? []).some((c) => c.id === callId);
  const result = (first.toolResults ?? []).find((r) => r.callId === callId);
  if (!replayed && !result) {
    // Some harnesses re-key calls; fall back to "is there any tool call at all in the resumed history".
    const any = (first.toolCalls ?? []).length > 0 || (first.toolResults ?? []).length > 0;
    return any ? { state: 'call_present_under_other_id', results: first.toolResults.map((r) => r.text.slice(0, 300)) } : { state: 'call_absent' };
  }
  if (!result) return { state: 'call_without_result' };
  return { state: INTERRUPTED.test(result.text) ? 'result_marked_interrupted' : 'result_present', text: result.text.slice(0, 400) };
}

export const mainRequestsOf = (observed, launchIndex) => {
  const launch = observed.launches[launchIndex];
  const next = observed.launches[launchIndex + 1];
  if (!launch) return [];
  return observed.requests.filter((r) => r.kind === 'main' && r.at >= launch.startedAt && (!next || r.at < next.startedAt));
};
