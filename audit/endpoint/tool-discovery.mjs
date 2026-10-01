// Finds the harness's shell tool in the tool list it sent, so tapes can say "run this command" without
// knowing whether the tool is bash(command), exec_command(cmd), shell(command), run_shell_command(command) ...
const SHELL_NAME = /bash|shell|exec|command|terminal/i;
const COMMAND_PARAMS = ['command', 'cmd'];
// Parameters that bound how long the call may run, with the unit the harness documents.
const TIMEOUT_PARAMS = [
  { name: 'timeout', unit: 'ms' },
  { name: 'timeout_ms', unit: 'ms' },
  { name: 'yield_time_ms', unit: 'ms' },
];

/** tools: [{ name, properties: { <param>: { type } } }] as normalised by a wire module. */
export function discoverShellTool(tools) {
  for (const tool of tools) {
    if (!SHELL_NAME.test(tool.name)) continue;
    const commandParam = COMMAND_PARAMS.find((p) => tool.properties?.[p]?.type?.toLowerCase() === 'string');
    if (!commandParam) continue;
    const timeout = TIMEOUT_PARAMS.find((p) => tool.properties?.[p.name]);
    return { name: tool.name, commandParam, timeoutParam: timeout?.name, params: Object.keys(tool.properties ?? {}) };
  }
  return undefined;
}

/** Turns an abstract shell action into the concrete tool call for this harness. */
export function resolveToolCall(step, shellTool) {
  if (step.action !== 'shell') return { name: step.name, args: step.arguments };
  if (!shellTool) return undefined; // caller reports adapter_needed
  const args = { [shellTool.commandParam]: step.command };
  if (step.timeoutMs !== undefined && shellTool.timeoutParam) args[shellTool.timeoutParam] = step.timeoutMs;
  // Some tools require a free-text description next to the command.
  if (shellTool.params.includes('description')) args.description = 'audit step';
  return { name: shellTool.name, args: { ...args, ...(step.extraArgs ?? {}) } };
}
