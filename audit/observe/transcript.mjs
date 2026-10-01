// The endpoint's transcript is the harness's own account: every tool result it sent back to the "model".
import fs from 'node:fs';

export function readTranscript(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Requests in order, without the (large, sensitive) bodies. */
export function requestSummaries(entries) {
  return entries.filter((e) => e.method).map(({ body, ...rest }) => rest);
}

/**
 * What the harness told the model about each tool call: the text of every tool result, taken from the last
 * main request (conversations are cumulative, so the last one holds all of them).
 */
export function toolResultsReported(entries) {
  const mains = entries.filter((e) => e.kind === 'main');
  return mains.length > 0 ? mains[mains.length - 1].toolResults : [];
}

/** Tool calls the endpoint issued, in order: [{ turn, id, name, args }]. */
export function toolCallsIssued(entries) {
  return entries.filter((e) => e.kind === 'response').flatMap((e) => e.served
    .filter((s) => s && typeof s === 'object' && s.tool_call)
    .map((s) => ({ turn: e.turn, id: s.id, name: s.tool_call, args: s.args })));
}
