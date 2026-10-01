// Tape format: xio-agent-tape.v1 (same as xiocode's scripted provider), plus one abstract tool action so a
// single tape can drive every harness:
//   { "type": "tool_call", "action": "shell", "command": "...", "timeoutMs": 5000 }
// The endpoint rewrites it to whatever shell tool the harness offered in its request (see tool-discovery.mjs).
// A concrete call ({ "type": "tool_call", "name": "...", "arguments": {...} }) is passed through unchanged.
export const TAPE_SCHEMA_VERSION = 'xio-agent-tape.v1';

const STEP_TYPES = new Set(['delta', 'tool_call', 'usage', 'error', 'hang', 'barrier', 'done']);

export function validateTape(tape) {
  if (tape?.schema_version !== TAPE_SCHEMA_VERSION) {
    throw new Error(`tape: schema_version must be "${TAPE_SCHEMA_VERSION}", got ${JSON.stringify(tape?.schema_version)}`);
  }
  if (typeof tape.name !== 'string' || !Array.isArray(tape.turns)) throw new Error('tape: needs a name and a turns array');
  tape.turns.forEach((turn, t) => {
    if (!Array.isArray(turn?.steps)) throw new Error(`tape: turn ${t} has no steps array`);
    turn.steps.forEach((step, s) => {
      const where = `tape: turn ${t} step ${s}`;
      if (!STEP_TYPES.has(step?.type)) throw new Error(`${where}: unknown step type ${JSON.stringify(step?.type)}`);
      if (step.type === 'delta' && !Array.isArray(step.chunks)) throw new Error(`${where}: delta needs chunks`);
      if (step.type === 'barrier' && typeof step.id !== 'string') throw new Error(`${where}: barrier needs an id`);
      if (step.type === 'hang' && typeof step.ms !== 'number') throw new Error(`${where}: hang needs ms`);
      if (step.type === 'tool_call') {
        const abstract = step.action === 'shell' && typeof step.command === 'string';
        const concrete = typeof step.name === 'string' && typeof step.arguments === 'object';
        if (!abstract && !concrete) throw new Error(`${where}: tool_call needs action "shell" + command, or name + arguments`);
      }
    });
  });
  return tape;
}

/** Replace {{name}} placeholders in every string of the tape (commands, text chunks). */
export function renderTape(tape, vars) {
  const render = (value) => {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
        if (!(key in vars)) throw new Error(`tape: no value for placeholder {{${key}}}`);
        return vars[key];
      });
    }
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v)]));
    return value;
  };
  return validateTape(render(tape));
}
