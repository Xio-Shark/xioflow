import crypto from 'node:crypto';
import type {
  AwaitCondition,
  OsMedium,
  VfsMutation,
} from '../kernel/syscalls.js';
import { GOLDEN_SURFACE_SCHEMAS, type SurfaceToolSchema } from './schemas.js';

export class SurfaceValidationError extends Error {
  public readonly tool: string;
  public readonly fieldPath: string;

  constructor(tool: string, fieldPath: string, message: string) {
    super(`${tool}: ${fieldPath} ${message}`);
    this.name = 'SurfaceValidationError';
    this.tool = tool;
    this.fieldPath = fieldPath;
  }
}

function assertPlainObject(val: unknown, tool: string, fieldPath: string): asserts val is Record<string, any> {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    throw new SurfaceValidationError(tool, fieldPath, 'must be an object');
  }
}

function validateAgainstSchema(tool: string, schema: SurfaceToolSchema, rawArgs: unknown): Record<string, any> {
  assertPlainObject(rawArgs, tool, 'arguments');
  const props = schema.inputSchema.properties;
  for (const reqKey of schema.inputSchema.required) {
    if (!Object.hasOwn(rawArgs, reqKey) || rawArgs[reqKey] === undefined) {
      throw new SurfaceValidationError(tool, `arguments.${reqKey}`, `missing required field "${reqKey}"`);
    }
  }
  for (const [key, val] of Object.entries(rawArgs)) {
    if (val === undefined) continue;
    if (!Object.hasOwn(props, key)) {
      throw new SurfaceValidationError(tool, `arguments.${key}`, 'unknown argument');
    }
    const prop = props[key]!;
    switch (prop.type) {
      case 'string':
        if (typeof val !== 'string') {
          throw new SurfaceValidationError(tool, `arguments.${key}`, 'must be a string');
        }
        if (val.includes('\0')) {
          throw new SurfaceValidationError(tool, `arguments.${key}`, 'must not contain null bytes');
        }
        if (prop.enum && !prop.enum.includes(val)) {
          throw new SurfaceValidationError(tool, `arguments.${key}`, `must be one of: ${prop.enum.join(', ')}`);
        }
        break;
      case 'boolean':
        if (typeof val !== 'boolean') {
          throw new SurfaceValidationError(tool, `arguments.${key}`, 'must be a boolean');
        }
        break;
      case 'integer':
        if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
          throw new SurfaceValidationError(tool, `arguments.${key}`, 'must be a safe integer');
        }
        if (prop.minimum !== undefined && val < prop.minimum) {
          throw new SurfaceValidationError(tool, `arguments.${key}`, `must be >= ${prop.minimum}`);
        }
        if (prop.maximum !== undefined && val > prop.maximum) {
          throw new SurfaceValidationError(tool, `arguments.${key}`, `must be <= ${prop.maximum}`);
        }
        break;
      case 'array':
        if (!Array.isArray(val)) {
          throw new SurfaceValidationError(tool, `arguments.${key}`, 'must be an array');
        }
        if (prop.items && (prop.items as any).type === 'string') {
          for (let i = 0; i < val.length; i++) {
            if (typeof val[i] !== 'string') {
              throw new SurfaceValidationError(tool, `arguments.${key}[${i}]`, 'must be a string');
            }
            if ((val[i] as string).includes('\0')) {
              throw new SurfaceValidationError(tool, `arguments.${key}[${i}]`, 'must not contain null bytes');
            }
          }
        }
        break;
      default:
        break;
    }
  }
  return rawArgs;
}

function parseMutationsArray(tool: string, raw: unknown[]): VfsMutation[] {
  return raw.map((item, idx) => {
    assertPlainObject(item, tool, `arguments.mutations[${idx}]`);
    const kind = item.kind;
    const filePath = item.path;
    if (typeof filePath !== 'string' || !filePath) {
      throw new SurfaceValidationError(tool, `arguments.mutations[${idx}].path`, 'must be a non-empty string');
    }
    if (kind === 'write') {
      if (typeof item.content !== 'string') {
        throw new SurfaceValidationError(tool, `arguments.mutations[${idx}].content`, 'must be a string when kind="write"');
      }
      return {
        kind: 'write',
        path: filePath,
        content: item.content,
        ...(typeof item.expectedRev === 'string' ? { expectedRev: item.expectedRev } : {}),
      };
    }
    if (kind === 'patch') {
      if (typeof item.oldText !== 'string' || typeof item.newText !== 'string') {
        throw new SurfaceValidationError(tool, `arguments.mutations[${idx}]`, 'patch requires oldText and newText strings');
      }
      return {
        kind: 'patch',
        path: filePath,
        oldText: item.oldText,
        newText: item.newText,
        ...(typeof item.replaceAll === 'boolean' ? { replaceAll: item.replaceAll } : {}),
        ...(typeof item.expectedRev === 'string' ? { expectedRev: item.expectedRev } : {}),
      };
    }
    if (kind === 'delete') {
      return {
        kind: 'delete',
        path: filePath,
        ...(typeof item.expectedRev === 'string' ? { expectedRev: item.expectedRev } : {}),
      };
    }
    throw new SurfaceValidationError(tool, `arguments.mutations[${idx}].kind`, 'must be write, patch, or delete');
  });
}

export interface SurfaceCallOptions {
  sessionId?: string;
  onOpId?: (opId: string) => void;
}

export interface SurfaceToolDispatcher {
  readonly schemas: readonly SurfaceToolSchema[];
  call(name: string, rawArgs?: unknown, sessionOrOptions?: string | SurfaceCallOptions): Promise<Record<string, unknown>>;
}

/**
 * Bind the 4 Golden LLM Surface Primitives (`run`, `edit`, `inspect`, `branch`) to an `OsMedium`.
 */
export function createSurfaceDispatcher(medium: OsMedium): SurfaceToolDispatcher {
  const schemaMap = new Map(GOLDEN_SURFACE_SCHEMAS.map((s) => [s.name as string, s]));

  return {
    schemas: GOLDEN_SURFACE_SCHEMAS,
    async call(
      name: string,
      rawArgs: unknown = {},
      sessionOrOptions?: string | SurfaceCallOptions,
    ): Promise<Record<string, unknown>> {
      const sessionId = typeof sessionOrOptions === 'string' ? sessionOrOptions : sessionOrOptions?.sessionId;
      const onOpId = typeof sessionOrOptions === 'object' && sessionOrOptions !== null ? sessionOrOptions.onOpId : undefined;
      const schema = schemaMap.get(name);
      if (!schema) {
        throw new SurfaceValidationError(name, 'name', `unknown surface tool "${name}" (expected run, edit, inspect, or branch)`);
      }
      const args = validateAgainstSchema(name, schema, rawArgs ?? {});

      if (name === 'run') {
        if (!args.cmd && !args.execPath && !args.stopOpId) {
          throw new SurfaceValidationError('run', 'arguments', 'requires one of cmd, execPath, or stopOpId');
        }
        const effectiveOpId = args.stopOpId
          ? undefined
          : (args.opId ?? `run-${crypto.randomUUID().slice(0, 12)}`);
        if (effectiveOpId) {
          onOpId?.(effectiveOpId);
        }
        const waitConditions: AwaitCondition[] = [];
        if (args.waitPort !== undefined) {
          waitConditions.push({ kind: 'port_open', port: args.waitPort });
        }
        if (args.waitHttpUrl !== undefined) {
          waitConditions.push({ kind: 'http_ready', url: args.waitHttpUrl });
        }
        if (args.waitOutputPattern !== undefined) {
          waitConditions.push({
            kind: 'output_match',
            opId: effectiveOpId ?? '',
            pattern: args.waitOutputPattern,
          });
        }
        const waitUntil: AwaitCondition | undefined =
          waitConditions.length === 1
            ? waitConditions[0]
            : waitConditions.length > 1
              ? { kind: 'all', conditions: waitConditions }
              : undefined;

        const res = await medium.exec({
          sessionId,
          opId: effectiveOpId,
          cmd: args.cmd,
          execPath: args.execPath,
          args: args.args,
          cwd: args.cwd,
          stdin: args.stdin,
          timeoutMs: args.timeoutMs,
          background: args.background ?? (waitUntil !== undefined ? true : undefined),
          waitUntil,
          stopOpId: args.stopOpId,
          confinement: args.confinement,
          trackReads: args.trackReads,
        });
        return res as unknown as Record<string, unknown>;
      }

      if (name === 'edit') {
        let mutations: VfsMutation[];
        if (Array.isArray(args.mutations) && args.mutations.length > 0) {
          mutations = parseMutationsArray('edit', args.mutations);
        } else if (typeof args.path === 'string' && args.path.length > 0) {
          if (args.delete === true) {
            mutations = [{ kind: 'delete', path: args.path, expectedRev: args.expectedRev }];
          } else if (args.oldText !== undefined || args.newText !== undefined) {
            if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
              throw new SurfaceValidationError('edit', 'arguments', 'patch mode requires both oldText and newText strings');
            }
            mutations = [
              {
                kind: 'patch',
                path: args.path,
                oldText: args.oldText,
                newText: args.newText,
                replaceAll: args.replaceAll,
                expectedRev: args.expectedRev,
              },
            ];
          } else if (typeof args.content === 'string') {
            mutations = [
              {
                kind: 'write',
                path: args.path,
                content: args.content,
                expectedRev: args.expectedRev,
              },
            ];
          } else {
            throw new SurfaceValidationError(
              'edit',
              'arguments',
              'single-file edit requires content (write), oldText+newText (patch), or delete: true',
            );
          }
        } else {
          throw new SurfaceValidationError('edit', 'arguments', 'requires either path or non-empty mutations[]');
        }

        const res = await medium.vfs_tx({
          sessionId,
          mutations,
          gateCmd: args.gateCmd,
          gateTimeoutMs: args.gateTimeoutMs,
        });
        return res as unknown as Record<string, unknown>;
      }

      if (name === 'inspect') {
        const inferredMode: 'slice' | 'grep' | 'status' | 'await' =
          args.mode ??
          (args.waitOpId || args.waitPort || args.waitHttpUrl || args.waitOutputPattern
            ? 'await'
            : args.pattern !== undefined
              ? 'grep'
              : args.target !== undefined
                ? 'slice'
                : 'status');

        if (inferredMode === 'status') {
          const obs = await medium.observe({ sessionId });
          return obs as unknown as Record<string, unknown>;
        }

        if (inferredMode === 'await') {
          let condition: AwaitCondition;
          if (args.waitHttpUrl) {
            condition = { kind: 'http_ready', url: args.waitHttpUrl, opId: args.waitOpId };
          } else if (args.waitPort) {
            condition = { kind: 'port_open', port: args.waitPort, opId: args.waitOpId };
          } else if (args.waitOutputPattern) {
            if (!args.waitOpId) {
              throw new SurfaceValidationError('inspect', 'arguments.waitOpId', 'required when waitOutputPattern is specified');
            }
            condition = { kind: 'output_match', opId: args.waitOpId, pattern: args.waitOutputPattern };
          } else if (args.waitOpId) {
            condition = { kind: 'process_exit', opId: args.waitOpId };
          } else if (args.target) {
            condition = { kind: 'file_change', path: args.target };
          } else {
            throw new SurfaceValidationError('inspect', 'arguments', 'mode="await" requires waitOpId, waitPort, waitHttpUrl, or target');
          }
          const awaited = await medium.await({
            sessionId,
            condition,
            timeoutMs: args.timeoutMs,
          });
          return awaited as unknown as Record<string, unknown>;
        }

        if (inferredMode === 'grep') {
          if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
            throw new SurfaceValidationError('inspect', 'arguments.pattern', 'must be a non-empty string for grep mode');
          }
          const grepRes = await medium.blob({
            sessionId,
            op: 'grep',
            target: args.target,
            pattern: args.pattern,
            isRegex: args.isRegex,
            caseSensitive: args.caseSensitive,
            contextLines: args.contextLines,
            maxMatches: args.maxMatches,
          });
          return grepRes as unknown as Record<string, unknown>;
        }

        // slice
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new SurfaceValidationError('inspect', 'arguments.target', 'must be a non-empty file path or blobRef for slice mode');
        }
        const sliceRes = await medium.blob({
          sessionId,
          op: 'slice',
          target: args.target,
          startLine: args.startLine,
          endLine: args.endLine,
          symbols: args.symbols,
        });
        return sliceRes as unknown as Record<string, unknown>;
      }

      // branch
      const branchMutations = Array.isArray(args.mutations) ? parseMutationsArray('branch', args.mutations) : undefined;
      if (!args.cmd && !args.gateCmd && (!branchMutations || branchMutations.length === 0)) {
        throw new SurfaceValidationError('branch', 'arguments', 'requires at least one of cmd, gateCmd, or mutations[]');
      }
      const res = await medium.vfs_tx({
        sessionId,
        isolated: true,
        mutations: branchMutations,
        branchCmd: args.cmd,
        gateCmd: args.gateCmd,
        gateTimeoutMs: args.timeoutMs,
        commit: args.commit,
      });
      return res as unknown as Record<string, unknown>;
    },
  };
}
