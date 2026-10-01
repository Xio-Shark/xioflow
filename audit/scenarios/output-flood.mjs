// S6 output-flood: the command prints FLOOD_BYTES and ends with a marker line.
// Properties: (a) if the harness does not pass the whole output to the model, it says so; (b) if the harness
// stopped the command because of its output, the result says the harness did that, instead of presenting the
// exit code as the command's own. Also recorded: whether the tail survived and where the full output is.
import { closing, say, shell, tape } from './lib.mjs';

const FLOOD_BYTES = 50 * 1024 * 1024;
const NOTICE = /truncat|omitted|elided|spilled|more (chars|characters|bytes|lines)|exceed|too (large|long|big)|output limit|clipped|shortened|\bcut\b|saved to|written to|full output|showing (first|last|only)|\d+ (bytes|chars|characters|lines|tokens) (were |was )?(removed|dropped|skipped|hidden)/i;
const STOPPED = /output (limit|cap)|hard cap|limited|killed|terminated|stopped|aborted|exceeded/i;
const LOCATION = /(saved|written|stored|full output|spill|available|see)[^\n/]{0,80}(\/\S+)/i;

export default {
  name: 'output-flood',
  prompt: 'Run the audit step.',
  timeoutMs: 240_000,
  tape: tape('output-flood', [[shell(`{{xf}} flood-output ${FLOOD_BYTES} --tail=XF-TAIL-{{tag}}`)], [say('Audit step finished.')], ...closing(1)]),
  judge(observed) {
    const result = observed.toolResults[0]?.text;
    const produced = Number(/bytes=(\d+)/.exec(observed.markers['flood.done']?.extra ?? '')?.[1] ?? NaN);
    if (result === undefined) {
      return { verdict: 'inconclusive', evidence: { reason: 'the harness never reported a result for the command', produced_bytes: produced || null, flood_finished: Boolean(observed.markers['flood.done']), timed_out: observed.timedOut, exit_code: observed.launches[0]?.exit?.code ?? null, stderr_tail: (observed.launches[0]?.stderrTail ?? '').slice(-300) } };
    }
    const tailRetained = /(^|\n)XF-TAIL-\w+/.test(result);
    const headRetained = result.includes('XF-HEAD');
    const complete = Number.isFinite(produced) && result.length >= produced;
    const notice = NOTICE.exec(result.replace(/x{20,}/g, ''));
    const location = LOCATION.exec(result.replace(/x{20,}/g, ''));
    const stoppedEarly = !observed.markers['flood.done'];
    const saysStopped = STOPPED.test(result.replace(/x{20,}/g, ''));
    const violations = [];
    if (!complete && !notice) violations.push('silent_truncation');
    if (stoppedEarly && !saysStopped) violations.push('command_stopped_by_harness_not_disclosed');
    return {
      verdict: violations.length > 0 ? 'violated' : 'holds',
      evidence: {
        violations, produced_bytes: Number.isFinite(produced) ? produced : null, command_ran_to_completion: !stoppedEarly,
        result_says_command_was_stopped: saysStopped,
        reported_chars: result.length, head_retained: headRetained, tail_retained: tailRetained,
        truncation_notice: notice ? result.replace(/x{20,}/g, '').slice(Math.max(0, notice.index - 60), notice.index + 140) : null,
        full_output_location: location ? location[2] : null,
        reported_start: result.slice(0, 160), reported_end: result.replace(/x{20,}\n?/g, '<x-line>').slice(-260),
        exit_code: observed.launches[0]?.exit?.code ?? null,
      },
    };
  },
};
