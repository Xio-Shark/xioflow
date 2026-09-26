# Example: Temporal TS SDK Activity Idempotent Execution

This example demonstrates how to integrate `@xioflow/kernel` with the **Temporal TypeScript SDK** to make activities with real-world OS side-effects (e.g., executing shell scripts, updating package locks, or writing to filesystem logs) safe against duplicate execution when workers crash midway.

## The Problem in Temporal Activities

Temporal provides **at-least-once** execution semantics for activities. When a worker process crashes (`kill -9`, SIGSEGV, OOM, or network disconnection) while executing an activity:
1. The activity execution times out on the Temporal server (`StartToCloseTimeout`).
2. Temporal re-schedules the activity to another worker (or the restarted worker).
3. Without idempotency guards, local side-effects (e.g. `npm install`, `git commit`, file appends) **execute a second time**, leading to corrupted state or duplicate commits.

## How `@xioflow/kernel` Solves This

In Temporal activities, `Context.current().info` provides two critical identifiers:
- `workflowExecution.workflowId`: Globally unique and persistent for the workflow.
- `activityId`: Persistent across retries of the same activity execution.

Combined, `${workflowExecution.workflowId}:${activityId}` yields an exact, stable `opId`.

```ts
import { Context } from '@temporalio/activity';
import { quickRun } from '@xioflow/kernel';

export async function myActivity() {
  const { workflowExecution, activityId } = Context.current().info;
  const opId = `${workflowExecution.workflowId}:${activityId}`;

  // Executed with at-most-once semantics
  return await quickRun(command, { opId });
}
```

When Temporal retries the activity:
- If the first attempt completed and registered its result in the kernel domain: the retry immediately returns the recorded result (`replayed: true`), and the subprocess is **never run again**.
- If the first attempt was midway during execution when the worker crashed: upon domain recovery (`recover()`), if the process cannot be confirmed stopped, it is marked `indeterminate` rather than silently re-run.

## Running the Drill

```bash
cd examples/temporal-activity
bash kill-worker-midway.sh
```

### Expected Output (Succeeded Replay)

```text
================================================================
Temporal Worker Midway Crash & Recovery Drill
================================================================
Simulating Temporal Workflow: wf-demo-8491
Activity ID: act-append-file-1
Target effect file: .../effects.log

--- Attempt 1: Worker executes activity for the first time ---
Attempt 1 result: {
  opId: 'mock-wf:mock-act',
  status: 'succeeded',
  replayed: false,
  durationMs: 98
}
Lines in effects.log after Attempt 1: 1

[SIMULATED WORKER CRASH]: Worker process terminates midway / network timeout.
Temporal cluster schedules retry of the same activity with identical workflowId & activityId.

--- Attempt 2: New worker runs retry of activity ---
Attempt 2 result: {
  opId: 'mock-wf:mock-act',
  status: 'succeeded',
  replayed: true,
  durationMs: 2
}
Lines in effects.log after Attempt 2: 1

================================================================
Verification:
================================================================
Is Attempt 2 marked as replayed? true
Is effect duplicate prevented (exactly 1 line)? true
SUCCESS: Side effect executed exactly once despite Temporal activity retry.

Final effects.log content:
event-1727339891823
Total lines in effects.log: 1
```

### Explanation of `indeterminate` Outcome

If the worker host or container was abruptly destroyed while the child subprocess was actively writing to disk, the kernel cannot know with 100% certainty whether the OS completed the write before losing power. In accordance with ARCHITECTURE §3.7 / Guarantee 2, the kernel reports:
```json
{
  "status": "indeterminate",
  "reason": "Process was running when host crashed and could not be verified",
  "replayed": true
}
```
This guarantees **no blind retry**: exclusive resources remain locked, avoiding double-application of unknown side effects until human or administrative adjudication (`adjudicate()`).
