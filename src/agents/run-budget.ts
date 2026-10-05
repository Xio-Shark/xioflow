export interface AgentRunBudget {
  maxSteps: number;
  maxAgents: number;
  /** Outstanding commands, including both resource waiters and active processes. */
  maxPendingCommands: number;
}

export interface AgentRunUsage {
  budget: AgentRunBudget;
  stepsUsed: number;
  agentsCreated: number;
  pendingCommands: number;
}

export const DEFAULT_AGENT_RUN_BUDGET: Readonly<AgentRunBudget> = Object.freeze({
  maxSteps: 10_000, maxAgents: 1_024, maxPendingCommands: 64,
});

export function validateRunBudget(budget: AgentRunBudget): AgentRunBudget {
  for (const key of ['maxSteps', 'maxAgents', 'maxPendingCommands'] as const) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1) {
      throw new Error(`Run ${key} must be a positive safe integer`);
    }
  }
  return { maxSteps: budget.maxSteps, maxAgents: budget.maxAgents, maxPendingCommands: budget.maxPendingCommands };
}
