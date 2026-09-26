# Example: LangGraph Checkpoint Resume with Idempotent Command Execution

This example demonstrates how to integrate `@xioflow/kernel` with **LangGraph.js** to guarantee that tool-use nodes executing command-line processes (e.g. running unit tests, executing git commands, modifying files) never duplicate their side effects when resuming from a checkpoint.

## The Problem in LangGraph Nodes

LangGraph persists state transitions across steps into checkpointers (e.g., `MemorySaver`, `SqliteSaver`, Postgres, Redis). When an error, crash, or human-in-the-loop interruption occurs midway through a graph execution:
- LangGraph re-runs graph nodes from the last persisted checkpoint.
- If a node executed a subprocess command (e.g. `npm run build`, `git tag`, or filesystem edits), re-invoking the node causes that command to **execute again**.

## How `@xioflow/kernel` Solves This

LangGraph passes execution configuration to each node:
- `config.configurable.thread_id`: Unique persistent identifier for the thread/conversation.
- Node name: Deterministic node name in the graph (`executeCommandNode`).
- State step: Current step counter (`state.step`).

Together, `${thread_id}:${nodeName}:step-${step}` forms a stable, unique `opId`.

```ts
async function executeCommandNode(state, config) {
  const threadId = config?.configurable?.thread_id;
  const opId = `${threadId}:executeCommand:step-${state.step}`;

  // Execute with at-most-once semantics
  const result = await quickRun(command, { opId });
  return { replayed: result.replayed ?? false, output: result.stdout };
}
```

When LangGraph resumes from a checkpoint:
- If the command succeeded during the earlier attempt, `quickRun` immediately returns the recorded result (`replayed: true`), skipping subprocess execution entirely.
- The command side effect occurs **exactly once**.

## Running the Example

```bash
cd examples/langgraph-node
node run-langgraph-checkpoint.mjs
```

### Expected Output

```text
================================================================
LangGraph Checkpoint Recovery Idempotency Demonstration
================================================================

--- Run 1: Starting Graph with thread_id: session-1727339891823 ---
[Node: executeCommandNode] Invoking command with opId: session-1727339891823:executeCommandNode:step-1
[Node: unreliableFollowupNode] Simulating unhandled crash / network failure after command execution!
Run 1 failed as expected: Midway worker failure: process crashed before workflow finalized
Lines in effects.log after Run 1: 1

--- Run 2: Resuming Graph from checkpoint (thread_id: session-1727339891823) ---
[Node: executeCommandNode] Invoking command with opId: session-1727339891823:executeCommandNode:step-1
[Node: unreliableFollowupNode] Followup completed successfully on resumed attempt.
Lines in effects.log after Run 2: 1
Final graph status: completed
Was command replayed from journal? true

================================================================
Verification:
================================================================
Command side-effect executed exactly once: true
Replayed flag captured in state: true
SUCCESS: LangGraph resumed from checkpoint without duplicating command side effect.
```
