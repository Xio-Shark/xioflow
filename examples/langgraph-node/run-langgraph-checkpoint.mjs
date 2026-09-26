import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateGraph, Annotation, MemorySaver, START, END } from '@langchain/langgraph';
import { quickRun } from '@xioflow/kernel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const effectsLogPath = path.join(__dirname, 'langgraph-effects.log');
const kernelDomainDir = path.join(__dirname, '.xioflow-kernel');

// Clean up previous runs
if (fs.existsSync(effectsLogPath)) fs.unlinkSync(effectsLogPath);
if (fs.existsSync(kernelDomainDir)) fs.rmSync(kernelDomainDir, { recursive: true, force: true });

console.log('================================================================');
console.log('LangGraph Checkpoint Recovery Idempotency Demonstration');
console.log('================================================================\n');

// 1. Define Graph State
const AgentState = Annotation.Root({
  step: Annotation({ reducer: (x, y) => y ?? x, default: () => 1 }),
  commandOutput: Annotation({ reducer: (x, y) => y ?? x, default: () => '' }),
  replayed: Annotation({ reducer: (x, y) => y ?? x, default: () => false }),
  status: Annotation({ reducer: (x, y) => y ?? x, default: () => 'init' }),
});

// 2. Node that executes a real subprocess command
async function executeCommandNode(state, config) {
  const threadId = config?.configurable?.thread_id || 'default-thread';
  const nodeName = 'executeCommandNode';
  const step = state.step || 1;

  // opId: thread_id + node_name + step
  const opId = `${threadId}:${nodeName}:step-${step}`;

  console.log(`[Node: ${nodeName}] Invoking command with opId: ${opId}`);

  const script = `
    const fs = require('fs');
    fs.appendFileSync(process.argv[1], 'side-effect-recorded\\n');
    console.log('Command executed');
  `;

  const result = await quickRun(
    {
      execPath: process.execPath,
      args: ['-e', script, effectsLogPath],
      cwd: __dirname,
    },
    {
      opId,
      domainPath: kernelDomainDir,
      name: `lg-${nodeName}`,
    }
  );

  return {
    commandOutput: result.stdout,
    replayed: result.replayed ?? false,
    status: 'command_finished',
  };
}

// 3. Node that simulates a mid-graph failure on first attempt
let firstAttemptFailed = false;
async function unreliableFollowupNode(state, config) {
  if (!firstAttemptFailed) {
    firstAttemptFailed = true;
    console.log('[Node: unreliableFollowupNode] Simulating unhandled crash / network failure after command execution!');
    throw new Error('Midway worker failure: process crashed before workflow finalized');
  }
  console.log('[Node: unreliableFollowupNode] Followup completed successfully on resumed attempt.');
  return { status: 'completed' };
}

// 4. Build StateGraph with Checkpointer
const checkpointer = new MemorySaver();
const workflow = new StateGraph(AgentState)
  .addNode('executeCommand', executeCommandNode)
  .addNode('followup', unreliableFollowupNode)
  .addEdge(START, 'executeCommand')
  .addEdge('executeCommand', 'followup')
  .addEdge('followup', END);

const app = workflow.compile({ checkpointer });

const threadId = 'session-' + Date.now();
const config = { configurable: { thread_id: threadId } };

// 5. First execution attempt
console.log(`--- Run 1: Executing graph node with thread_id: ${threadId} ---`);
try {
  await app.invoke({ step: 1 }, config);
} catch (err) {
  console.log(`Run 1 interrupted as expected: ${err.message}`);
}

let linesAfterRun1 = fs.readFileSync(effectsLogPath, 'utf8').trim().split('\n');
console.log(`Lines in effects.log after Run 1: ${linesAfterRun1.length}`);

// 6. Simulate worker crash / checkpoint rewind / node retry with identical thread_id
console.log(`\n--- Run 2: Re-executing command node with identical thread_id & step (checkpoint retry) ---`);
const replayResult = await executeCommandNode({ step: 1 }, config);

let linesAfterRun2 = fs.readFileSync(effectsLogPath, 'utf8').trim().split('\n');
console.log(`Lines in effects.log after Run 2: ${linesAfterRun2.length}`);
console.log(`Run 2 replayed: ${replayResult.replayed}`);

console.log('\n================================================================');
console.log('Verification:');
console.log('================================================================');
console.log(`Command side-effect executed exactly once: ${linesAfterRun2.length === 1}`);
console.log(`Replayed flag confirmed on retry: ${replayResult.replayed === true}`);

if (linesAfterRun2.length !== 1 || replayResult.replayed !== true) {
  console.error('FAIL: Idempotency was violated in LangGraph checkpoint resume!');
  process.exit(1);
} else {
  console.log('SUCCESS: LangGraph node replayed from journal without duplicating command side effect.');
}
