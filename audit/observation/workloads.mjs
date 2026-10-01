// Frozen workloads for E2 / E3 (observation-validated workspace transactions).
// Repository under edit: a clean clone of xiocode at PINNED_COMMIT. Each group runs its tasks as parallel workers.
// Categories:
//   unrelated  tasks that touch different code but each search the whole repository
//   semantic   one task changes a name or signature, another adds a new use of it (git would merge cleanly)
//   same-file  tasks that edit different functions of the same file
export const PINNED_COMMIT = '90e7cba';

const everywhere = 'Search the whole repository (src/ and extensions/) for every reference, including tests, and update all of them.';

export const WORKLOADS = [
  {
    id: 'U1', category: 'unrelated',
    tasks: [
      { name: 'rename-tokenize', instruction: `Rename the exported function \`tokenizeProvenSafe\` (defined in src/runtime/command-risk.ts) to \`tokenizeSafeCommand\`. ${everywhere}` },
      { name: 'doc-followup', instruction: 'In src/runtime/steer.ts, add a one-line JSDoc comment above the exported function `formatFollowUpUserMessage` saying what it returns. First search the whole repository for where it is called, so the comment matches how it is used. Change nothing else.' },
    ],
  },
  {
    id: 'U2', category: 'unrelated',
    tasks: [
      { name: 'rename-domain-root', instruction: `Rename the exported function \`kernelDomainRoot\` to \`kernelDomainBase\`. ${everywhere}` },
      { name: 'rename-retained', instruction: `Rename the exported constant \`DEFAULT_RETAINED_TURNS\` to \`DEFAULT_RETAINED_TURN_COUNT\`. ${everywhere}` },
    ],
  },
  {
    id: 'U3', category: 'unrelated',
    tasks: [
      { name: 'rename-guidance', instruction: `Rename the function \`withProviderGuidance\` to \`addProviderGuidance\`. ${everywhere}` },
      { name: 'rename-acceptance', instruction: `Rename the exported function \`toKernelAcceptance\` to \`asKernelAcceptance\`. ${everywhere}` },
      { name: 'doc-max-tasks', instruction: 'In src/runtime/parallel-edit.ts, add a one-line comment above the constant `MAX_PARALLEL_TASKS` that says where the limit is enforced. First search the whole repository for uses of the constant. Change nothing else.' },
    ],
  },
  {
    id: 'U4', category: 'unrelated',
    tasks: [
      { name: 'rename-hash', instruction: `Rename the exported function \`hashContent\` to \`contentHash\`. ${everywhere}` },
      { name: 'rename-command-args', instruction: `Rename the exported function \`commandFromToolArgs\` to \`bashCommandFromArgs\`. ${everywhere}` },
    ],
  },
  {
    id: 'S1', category: 'semantic',
    tasks: [
      { name: 'rename-proven-safe', instruction: `Rename the exported function \`isProvenSafeCommand\` to \`isAllowlistedCommand\`. ${everywhere}` },
      { name: 'use-proven-safe', instruction: 'In src/runtime/tools/builtin.ts, inside the function `runCommand`, replace the expression `classifyCommandExecution(command, homedir()).kind === "safe"` with a call to `isProvenSafeCommand(command, homedir())`, and import `isProvenSafeCommand` from "../command-risk.ts" (keep the existing imports that are still used). Change nothing else.' },
    ],
  },
  {
    id: 'S2', category: 'semantic',
    tasks: [
      { name: 'rename-describe-risk', instruction: `Rename the exported function \`describeCommandRisk\` to \`formatCommandRisk\`. ${everywhere}` },
      { name: 'add-risk-brief', instruction: 'Create a new file src/runtime/command-risk-brief.ts that exports a function `describeRiskBrief(risk, command)` returning the first line of `describeCommandRisk(risk, command)`. Import `describeCommandRisk` and the `CommandRisk` type from "./command-risk.ts". Change no other file.' },
    ],
  },
  {
    id: 'S3', category: 'semantic',
    tasks: [
      { name: 'rename-steer-mode', instruction: `Rename the exported function \`resolveSteerMode\` to \`pickSteerMode\`. ${everywhere}` },
      { name: 'test-steer-mode', instruction: 'Create a new test file src/runtime/steer-mode.test.ts (vitest) that imports `resolveSteerMode` from "./steer.ts" and checks two cases of its behaviour. Read src/runtime/steer.ts first to see what it returns. Change no other file.' },
    ],
  },
  {
    id: 'F1', category: 'same-file',
    tasks: [
      { name: 'allow-whoami', instruction: 'In src/runtime/command-risk.ts, extend the function `matchAllowlist` so that the command `whoami` with no arguments is allowed (return the rule name "whoami"), next to the existing `pwd` / `true` / `false` cases. Change nothing else.' },
      { name: 'doc-classify', instruction: 'In src/runtime/command-risk.ts, add a two-line JSDoc comment above the exported function `classifyCommandRisk` describing what it returns and when it returns undefined. Read the function first. Change nothing else.' },
    ],
  },
  {
    id: 'F2', category: 'same-file',
    tasks: [
      { name: 'longer-summary', instruction: 'In src/runtime/parallel-edit.ts, the helper `indent` cuts a summary at 600 characters. Raise the limit to 800 characters (both numbers that implement it). Change nothing else.' },
      { name: 'reword-cancelled', instruction: 'In src/runtime/parallel-edit.ts, in `formatParallelEditReport`, change the text for a cancelled task from "cancelled; nothing applied." to "cancelled before it finished; nothing applied.". Change nothing else.' },
    ],
  },
  {
    id: 'F3', category: 'same-file',
    tasks: [
      { name: 'doc-steer-mode', instruction: 'In src/runtime/steer.ts, add a one-line JSDoc comment above the exported function `resolveSteerMode` explaining the difference between "hard" and "soft". Read the function first. Change nothing else.' },
      { name: 'doc-steer-message', instruction: 'In src/runtime/steer.ts, add a one-line JSDoc comment above the exported function `formatSteerUserMessage` saying what the returned text is used for. Read the function first. Change nothing else.' },
    ],
  },
];
