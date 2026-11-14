export interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: JsonSchemaProperty | Record<string, unknown>;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface SurfaceToolSchema {
  name: 'run' | 'edit' | 'inspect' | 'branch';
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const MUTATION_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: 'Single file mutation within the atomic transaction.',
  properties: {
    kind: {
      type: 'string',
      enum: ['write', 'patch', 'delete'],
      description: 'Mutation kind: full write, exact text patch, or file delete.',
    },
    path: {
      type: 'string',
      description: 'Workspace-relative file path.',
    },
    content: {
      type: 'string',
      description: 'Full UTF-8 content when kind="write".',
    },
    oldText: {
      type: 'string',
      description: 'Exact text to replace when kind="patch".',
    },
    newText: {
      type: 'string',
      description: 'Replacement text when kind="patch".',
    },
    replaceAll: {
      type: 'boolean',
      description: 'Replace every occurrence of oldText when kind="patch".',
    },
    expectedRev: {
      type: 'string',
      description: 'Optional expected 16-hex file revision from inspect.',
    },
  },
  required: ['kind', 'path'],
  additionalProperties: false,
};

export const GOLDEN_SURFACE_SCHEMAS: readonly SurfaceToolSchema[] = [
  {
    name: 'run',
    title: 'Run command or manage background process',
    description:
      'Execute a foreground command, launch a supervised background process with inline readiness waiting (waitPort / waitHttpUrl / waitOutputPattern, short-circuiting immediately if the process exits early), or stop a background process tree via stopOpId. Oversized stdout/stderr automatically spills to a paged blobRef (head+tail summary). Always reports causal staleReads.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Shell command to execute (via /bin/sh -c). Omit when using execPath or stopOpId.',
        },
        execPath: {
          type: 'string',
          description: 'Direct executable path bypassing the shell.',
        },
        args: {
          type: 'array',
          description: 'Arguments passed to execPath.',
          items: { type: 'string', description: 'Command argument.' },
        },
        cwd: {
          type: 'string',
          description: 'Working directory relative to workspace root.',
        },
        stdin: {
          type: 'string',
          description: 'Optional UTF-8 input piped to stdin.',
        },
        opId: {
          type: 'string',
          description: 'Optional deterministic operation ID for idempotent retry without re-execution.',
        },
        background: {
          type: 'boolean',
          description: 'Keep the process running in the background held by the reaper tree.',
        },
        waitPort: {
          type: 'integer',
          minimum: 1,
          maximum: 65535,
          description: 'When background=true, wait until TCP 127.0.0.1:<waitPort> accepts connections (or fail immediately if process exits).',
        },
        waitHttpUrl: {
          type: 'string',
          description: 'When background=true, wait until HTTP GET returns 2xx/3xx (or fail immediately if process exits).',
        },
        waitOutputPattern: {
          type: 'string',
          description: 'When background=true, wait until stdout/stderr matches this regex (or fail immediately if process exits).',
        },
        stopOpId: {
          type: 'string',
          description: 'Deterministically stop an active background process tree by its opId.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'Execution or readiness timeout in milliseconds (default 60000).',
        },
        confinement: {
          type: 'boolean',
          description: 'Restrict writes to workspace + /tmp via OS kernel confinement (sandbox-exec on macOS, Landlock/bubblewrap/srt on Linux).',
        },
        trackReads: {
          type: 'boolean',
          description: 'Capture file read evidence (zero-scan VFS trace on Linux, atime fallback elsewhere).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'edit',
    title: 'Atomic causal file edit with optional gate rollback',
    description:
      'Create, patch, or delete one or more workspace files atomically. Automatically enforces SessionView causal dirty-read protection (rejecting stale overwrites with a compact diff) and optionally runs gateCmd, rolling back every touched file if gateCmd exits non-zero.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path for single-file edit.',
        },
        content: {
          type: 'string',
          description: 'Full file content to write (single-file write mode).',
        },
        oldText: {
          type: 'string',
          description: 'Exact existing substring to replace (single-file patch mode).',
        },
        newText: {
          type: 'string',
          description: 'Replacement string for oldText (single-file patch mode).',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace all occurrences of oldText when patching.',
        },
        delete: {
          type: 'boolean',
          description: 'Delete path when true.',
        },
        expectedRev: {
          type: 'string',
          description: 'Optional expected 16-hex revision returned by inspect/edit.',
        },
        mutations: {
          type: 'array',
          description: 'Multi-file atomic mutations (used instead of single-file path fields).',
          items: MUTATION_ITEM_SCHEMA,
        },
        gateCmd: {
          type: 'string',
          description: 'Optional verification shell command (e.g. "pnpm typecheck"). Non-zero exit atomically rolls back all edits.',
        },
        gateTimeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'Timeout in ms for gateCmd (default 60000).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'inspect',
    title: 'Paged file/blob slice, grep, readiness await, or workspace status',
    description:
      'Read line-numbered slices of workspace files (recording causal SessionView baseline and optional symbols for Early Cutoff) or spilled blobRef outputs, search files/blobs by regex/text, await an active process/port/HTTP condition, or view live workspace git & background process status.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['slice', 'grep', 'status', 'await'],
          description: 'Inspection mode: "slice" (default when target given), "grep" (when pattern given), "status" (workspace & process summary), or "await" (wait on process/port/HTTP/file).',
        },
        target: {
          type: 'string',
          description: 'Workspace file/directory path or spilled "blob:..." reference.',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          description: '1-based inclusive start line for slice mode (default 1).',
        },
        endLine: {
          type: 'integer',
          minimum: 1,
          description: '1-based inclusive end line for slice mode (default startLine + 199).',
        },
        symbols: {
          type: 'array',
          description: 'Optional symbol names observed in this file so edits outside these symbols trigger Early Cutoff instead of stale-read alerts.',
          items: { type: 'string', description: 'Identifier/symbol name.' },
        },
        pattern: {
          type: 'string',
          description: 'Search pattern for grep mode.',
        },
        isRegex: {
          type: 'boolean',
          description: 'Interpret pattern as regular expression in grep mode.',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search in grep mode (default true).',
        },
        contextLines: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          description: 'Surrounding context lines per match in grep mode.',
        },
        maxMatches: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Max matches returned in grep mode (default 50).',
        },
        waitOpId: {
          type: 'string',
          description: 'Background process opId for mode="await".',
        },
        waitPort: {
          type: 'integer',
          minimum: 1,
          maximum: 65535,
          description: 'TCP port to await in mode="await".',
        },
        waitHttpUrl: {
          type: 'string',
          description: 'HTTP URL to await in mode="await".',
        },
        waitOutputPattern: {
          type: 'string',
          description: 'Regex output pattern on waitOpId to await in mode="await".',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'Timeout in ms for mode="await" (default 15000).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'branch',
    title: 'Isolated git-shadow speculative execution with OCC merge',
    description:
      'Materialize an isolated git-shadow worktree fork, apply optional mutations, run cmd and/or gateCmd inside the isolated fork, and atomically merge back into the main workspace via optimistic concurrency control (OCC) if and only if all commands exit 0. Failed or dry-run branches leave zero residue in the main workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Command to run inside the isolated shadow worktree.',
        },
        gateCmd: {
          type: 'string',
          description: 'Verification gate command run inside the isolated shadow worktree before merging.',
        },
        mutations: {
          type: 'array',
          description: 'Optional file mutations applied inside the isolated shadow worktree before cmd/gateCmd.',
          items: MUTATION_ITEM_SCHEMA,
        },
        commit: {
          type: 'boolean',
          description: 'Merge changes into the main workspace when cmd/gateCmd succeed (default true; set false for dry-run inspection).',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'Per-command timeout in ms (default 60000).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
] as const;

export function toMcpTools() {
  return GOLDEN_SURFACE_SCHEMAS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

export function toOpenAiTools() {
  return GOLDEN_SURFACE_SCHEMAS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export function toAnthropicTools() {
  return GOLDEN_SURFACE_SCHEMAS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function toGeminiTools() {
  return [
    {
      functionDeclarations: GOLDEN_SURFACE_SCHEMAS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}
