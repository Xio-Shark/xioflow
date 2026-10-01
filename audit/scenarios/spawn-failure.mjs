// S9 spawn-failure: one call names a binary that does not exist, another runs `sh -c 'exit 127'`.
// Property: the model can tell "the program could not be started" from "the program ran and exited 127".
import { closing, say, shell, tape } from './lib.mjs';

const NOT_FOUND = /not found|no such file|cannot (find|execute)|does not exist|ENOENT/i;

export default {
  name: 'spawn-failure',
  prompt: 'Run the audit step.',
  timeoutMs: 90_000,
  tape: tape('spawn-failure', [
    [shell('/nonexistent/xf-no-such-binary-{{tag}}')],
    [shell("sh -c 'exit 127'")],
    [say('Audit step finished.')],
    ...closing(1),
  ]),
  judge(observed) {
    const [missing, exited] = observed.toolResults.map((r) => r.text);
    if (missing === undefined || exited === undefined) {
      return { verdict: 'inconclusive', evidence: { reason: 'fewer than two tool results were reported', reported: observed.toolResults.length, timed_out: observed.timedOut } };
    }
    const distinguishable = NOT_FOUND.test(missing) && !NOT_FOUND.test(exited);
    return {
      verdict: distinguishable ? 'holds' : 'violated',
      evidence: {
        violations: distinguishable ? [] : ['spawn_failure_indistinguishable_from_exit_127'],
        missing_binary_result: missing.slice(0, 300), exit_127_result: exited.slice(0, 300),
      },
    };
  },
};
