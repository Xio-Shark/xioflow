/**
 * AI Tool Types and Registry
 *
 * Defines supported AI coding tools and which command templates they can use.
 */

/**
 * Supported AI coding tools
 */
export type AITool =
  | "claude-code"
  | "cursor"
  | "opencode"
  | "codex"
  | "devin"
  | "dsh";

/**
 * Template directory categories
 */
export type TemplateDir =
  | "common"
  | "claude"
  | "cursor"
  | "opencode"
  | "codex"
  | "devin"
  | "dsh";

/**
 * CLI flag names for platform selection (e.g., --claude, --cursor, --codex)
 * Must match keys in InitOptions (src/commands/init.ts)
 */
export type CliFlag =
  | "claude"
  | "cursor"
  | "opencode"
  | "codex"
  | "devin"
  | "dsh";

/**
 * Template context for placeholder resolution.
 * Controls how common templates are rendered per platform.
 */
export interface TemplateContext {
  /** Prefix for cross-referencing other commands/skills */
  cmdRefPrefix:
    | "/trellis:"
    | "/trellis-"
    | "$"
    | "/"
    | "/skill trellis-"
    | "/skill:trellis-"
    | "trellis-";
  /** Description of AI executor actions shown in role tables */
  executorAI:
    | "Bash scripts or Task calls"
    | "Bash scripts or tool calls"
    | "Bash scripts or Agent calls"
    | "Bash scripts or file reads";
  /** Label for user-invocable actions */
  userActionLabel:
    | "Slash commands"
    | "Skills"
    | "Workflows"
    | "Prompts"
    | "Commands";
  /** Platform supports spawning sub-agents with isolated context */
  agentCapable: boolean;
  /** Platform has hook system (SessionStart, PreToolUse) */
  hasHooks: boolean;
  /**
   * CLI flag value for this platform (e.g. "claude", "codex", "kiro").
   * Substituted into template commands via {{CLI_FLAG}} so rendered skill /
   * command files can pass `--platform <flag>` to scripts that need to know
   * the invoking platform, removing the need to re-detect at runtime.
   * Duplicates the top-level `AIToolConfig.cliFlag` for convenience — the
   * invariant is maintained in `AI_TOOLS` config blocks.
   */
  cliFlag: CliFlag;
}

/**
 * Configuration for an AI tool
 */
export interface AIToolConfig {
  /** Display name of the tool */
  name: string;
  /** Command template directory names to include */
  templateDirs: TemplateDir[];
  /** Config directory name in the project root (e.g., ".claude") */
  configDir: string;
  /**
   * Whether the platform supports the shared `.agents/skills/` layer
   * (agentskills.io open standard). When true, `.agents/skills` is added
   * to the platform's managed paths automatically.
   */
  supportsAgentSkills?: boolean;
  /** Additional managed paths beyond configDir (e.g., .github/hooks for Copilot) */
  extraManagedPaths?: string[];
  /** CLI flag name for --flag options (e.g., "claude" for --claude) */
  cliFlag: CliFlag;
  /** Whether this tool is checked by default in interactive init prompt */
  defaultChecked: boolean;
  /** Whether this tool uses Python hooks (affects Windows encoding detection) */
  hasPythonHooks: boolean;
  /**
   * Optional user-global compatibility plugin for platform versions where
   * project-level integration is unavailable. Trellis may surface a manual
   * installation hint, but leaves installation and lifecycle management to
   * the platform UI.
   */
  globalHookPlugin?: {
    name: string;
    marketplaceUrl: string;
  };
  /** Template context for placeholder resolution in common templates */
  templateContext: TemplateContext;
}

/**
 * Registry of all supported AI tools and their configurations.
 * This is the single source of truth for platform data.
 *
 * When adding a new platform, add an entry here and create:
 * 1. src/configurators/{platform}.ts — configure function
 * 2. src/templates/{platform}/ — template files
 * 3. Register in src/configurators/index.ts — PLATFORM_FUNCTIONS
 * 4. Add CLI flag in src/cli/index.ts
 * 5. Add to InitOptions in src/commands/init.ts
 */
export const AI_TOOLS: Record<AITool, AIToolConfig> = {
  "claude-code": {
    name: "Claude Code",
    templateDirs: ["common", "claude"],
    configDir: ".claude",
    cliFlag: "claude",
    defaultChecked: true,
    hasPythonHooks: true,
    templateContext: {
      cmdRefPrefix: "/trellis:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      agentCapable: true,
      hasHooks: true,
      cliFlag: "claude",
    },
  },
  cursor: {
    name: "Cursor",
    templateDirs: ["common", "cursor"],
    configDir: ".cursor",
    cliFlag: "cursor",
    defaultChecked: true,
    hasPythonHooks: true,
    templateContext: {
      cmdRefPrefix: "/trellis-",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      agentCapable: true,
      hasHooks: true,
      cliFlag: "cursor",
    },
  },
  opencode: {
    name: "OpenCode",
    templateDirs: ["common", "opencode"],
    configDir: ".opencode",
    cliFlag: "opencode",
    defaultChecked: false,
    // hasHooks: false — OpenCode has no session-start hook. The pre-v0.5.0
    // `.opencode/commands/trellis/start.md` deprecation in
    // migrations/manifests/0.5.0-beta.0.json assumed a hook would replace it;
    // that never happened for OpenCode, so `resolveCommands`/`filterCommands`
    // (see configurators/shared.ts) still generate `/start` as the live
    // fallback command for this `agentCapable && !hasHooks` platform.
    hasPythonHooks: false,
    templateContext: {
      cmdRefPrefix: "/trellis:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      agentCapable: true,
      hasHooks: false,
      cliFlag: "opencode",
    },
  },
  codex: {
    name: "Codex (also writes .agents/skills/ — read by Cursor, Gemini CLI, GitHub Copilot, Amp, Kimi Code)",
    templateDirs: ["common", "codex"],
    configDir: ".codex",
    supportsAgentSkills: true,
    cliFlag: "codex",
    defaultChecked: false,
    hasPythonHooks: true,
    templateContext: {
      cmdRefPrefix: "$",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      agentCapable: true,
      hasHooks: false,
      cliFlag: "codex",
    },
  },
  devin: {
    name: "Devin",
    templateDirs: ["common", "devin"],
    configDir: ".devin/workflows",
    extraManagedPaths: [".devin/skills"],
    cliFlag: "devin",
    defaultChecked: false,
    hasPythonHooks: false,
    templateContext: {
      cmdRefPrefix: "/trellis-",
      executorAI: "Bash scripts or file reads",
      userActionLabel: "Workflows",
      agentCapable: false,
      hasHooks: false,
      cliFlag: "devin",
    },
  },
  dsh: {
    // DeepSeek Harness (dsh) is a skills-first pull-based host: it reads
    // `.agents/skills/` (agentskills.io, rank-200 project root) and its own
    // `.dsh/skills/` (rank-100 project root) natively and the agent loads
    // skills by name through its skill-loader tool. No session-start hook
    // ships in the default web/headless profiles, so `hasHooks: false` and
    // `trellis-start` stays as a user-invocable skill. Entry skills reference
    // other skills by bare name (`trellis-<name>`), hence `cmdRefPrefix:
    // "trellis-"`.
    name: "DeepSeek Harness (dsh)",
    templateDirs: ["common", "dsh"],
    configDir: ".dsh",
    supportsAgentSkills: true,
    cliFlag: "dsh",
    defaultChecked: false,
    hasPythonHooks: false,
    templateContext: {
      cmdRefPrefix: "trellis-",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      agentCapable: true,
      hasHooks: false,
      cliFlag: "dsh",
    },
  },
};

/**
 * Get the configuration for a specific AI tool
 */
export function getToolConfig(tool: AITool): AIToolConfig {
  return AI_TOOLS[tool];
}

/**
 * Get all managed paths for a specific tool.
 */
export function getManagedPaths(tool: AITool): string[] {
  const config = AI_TOOLS[tool];
  const paths = [config.configDir];
  if (config.supportsAgentSkills) {
    paths.push(".agents/skills");
  }
  if (config.extraManagedPaths) {
    paths.push(...config.extraManagedPaths);
  }
  return paths;
}

/**
 * Get template directories for a specific tool
 */
export function getTemplateDirs(tool: AITool): TemplateDir[] {
  return AI_TOOLS[tool].templateDirs;
}
