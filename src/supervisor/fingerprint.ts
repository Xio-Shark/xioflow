import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExecuteProcessOptions } from './types.js';

export function normalizeResourceName(res: string): string {
  if (res.startsWith('workspace:write:')) {
    const raw = res.slice('workspace:write:'.length);
    try {
      return `workspace:write:${fs.realpathSync(raw)}`;
    } catch {
      return `workspace:write:${path.resolve(raw)}`;
    }
  }
  return res;
}

/**
 * 规范化计算完整输入的 SHA-256 指纹 (ARCHITECTURE §2 / P0-12)
 * 覆盖 execPath, args, cwd, 键排序的 envWhiteList, inheritEnv, sha256(stdin), 排序后的 requiredResources, timeoutMs, resourceBudget.
 */
export function computeInputFingerprint(options: ExecuteProcessOptions): string {
  const cmd = options.command;
  let stdinHash: string | null = null;
  if (cmd.stdin !== undefined && cmd.stdin !== null) {
    stdinHash = crypto.createHash('sha256').update(cmd.stdin).digest('hex');
  }

  let envSorted: [string, string][] | null = null;
  if (cmd.envWhiteList) {
    const keys = Object.keys(cmd.envWhiteList).sort();
    envSorted = keys.map((k) => [k, cmd.envWhiteList![k]]);
  }

  const canonical = {
    args: cmd.args || [],
    cwd: cmd.cwd || '',
    envWhiteList: envSorted,
    execPath: cmd.execPath || '',
    inheritEnv: cmd.inheritEnv ?? null,
    requiredResources: [...(options.requiredResources || [])].sort(),
    resourceBudget: options.resourceBudget
      ? {
          enforcement: options.resourceBudget.enforcement ?? null,
          maxCpuTimeMs: options.resourceBudget.maxCpuTimeMs ?? null,
          maxMemoryBytes: options.resourceBudget.maxMemoryBytes ?? null,
          maxOutputBytes: options.resourceBudget.maxOutputBytes ?? null,
          maxPids: options.resourceBudget.maxPids ?? null,
        }
      : null,
    stdinHash,
    timeoutMs: options.timeoutMs ?? null,
    capabilityId: options.capabilityId ?? null,
  };

  const canonicalJson = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}
