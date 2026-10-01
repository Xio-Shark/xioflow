import assert from 'node:assert/strict';
import path from 'node:path';
import { loadXiocode } from '../lib/xiocode.mjs';

const { runAgentLoop } = await loadXiocode('src/runtime/agent-loop.ts');
const { ExtensionHost } = await loadXiocode('src/runtime/extension-host.ts');
const { createBuiltinTools } = await loadXiocode('src/runtime/tools/builtin.ts');
const { FileReadSet } = await loadXiocode('src/runtime/file-read-set.ts');
const { WorkspacePathPolicy } = await loadXiocode('src/runtime/workspace-path-policy.ts');
const { toObservationEntry } = await loadXiocode('src/runtime/parallel-observations.ts');

/** One real runner quantum; fixtures use relative tool paths and no external hooks. */
export async function runXiocodeQuantum(agent, client) {
  const root = agent.workspace?.forkRoot ?? agent.input.root;
  const readSet = new FileReadSet();
  for (const entry of agent.checkpoint.log) {
    if (!entry.isError && ['read', 'write', 'edit'].includes(entry.tool)) {
      await readSet.mark(path.resolve(root, entry.args.path.replaceAll('<root>', root)));
    }
  }
  const host = new ExtensionHost();
  const pathPolicy = await WorkspacePathPolicy.create({ cwd: root, workspaceRoot: root });
  for (const tool of createBuiltinTools({ cwd: root, workspaceRoot: root, pathPolicy, readSet, grepOutline: false })) {
    if (['read', 'write', 'edit', 'grep', 'glob'].includes(tool.name)) host.registerTool(tool);
  }
  const log = [...agent.checkpoint.log];
  const result = await runAgentLoop(agent.input.instruction, {
    host, client, model: 'fixture', systemPrompt: 'Follow the assigned file task.', maxTurns: 1,
    parallelToolCalls: false,
    ...(agent.checkpoint.snapshot ? { resumeFrom: agent.checkpoint.snapshot } : {}),
    onToolEnd(call, output) {
      const entry = toObservationEntry(call, output, root);
      assert.ok(entry);
      log.push(entry);
    },
  });
  const lastAssistant = result.messages.findLast((message) => message.role === 'assistant');
  return { status: lastAssistant.toolCalls?.length ? 'ready' : 'completed', checkpoint: {
    snapshot: { phase: 'awaiting_provider', messages: result.messages }, log,
  } };
}
