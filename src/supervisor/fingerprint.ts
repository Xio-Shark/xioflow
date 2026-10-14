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

const WORKSPACE_PLACEHOLDER = '<workspace>';

function normalizeWorkspaceString(value: string, roots: readonly string[]): string {
  let out = value;
  for (const root of roots) {
    if (root.length > 0) {
      out = out.split(root).join(WORKSPACE_PLACEHOLDER);
    }
  }
  return out;
}

/**
 * 计算绑定工作区目录树哈希（treeFingerprint）且与物理分叉路径无关的命令输入指纹。
 * 不同事务分叉（如 /tmp/fork-a 与 /tmp/fork-b）只要文件树哈希一致且执行相同相对命令，
 * 即产出相同的 SHA-256 指纹，从而直接复用 joinInFlight 与 replayRecorded。
 */
export function computeTreeCommandFingerprint(options: {
  treeFingerprint: string;
  command: ExecuteProcessOptions['command'];
  workspaceRoot?: string;
  timeoutMs?: number;
  resourceBudget?: ExecuteProcessOptions['resourceBudget'];
  capabilityId?: string;
}): string {
  const roots: string[] = [];
  if (options.workspaceRoot) {
    const resolved = path.resolve(options.workspaceRoot);
    roots.push(resolved);
    try {
      const real = fs.realpathSync(resolved);
      if (real !== resolved) roots.push(real);
    } catch {
      // workspaceRoot may be virtual in unit tests
    }
    roots.sort((a, b) => b.length - a.length);
  }

  const cmd = options.command;
  let stdinHash: string | null = null;
  if (cmd.stdin !== undefined && cmd.stdin !== null) {
    stdinHash = crypto.createHash('sha256').update(cmd.stdin).digest('hex');
  }

  let envSorted: [string, string][] | null = null;
  if (cmd.envWhiteList) {
    const keys = Object.keys(cmd.envWhiteList).sort();
    envSorted = keys.map((k) => [k, normalizeWorkspaceString(cmd.envWhiteList![k], roots)]);
  }

  const canonical = {
    treeFingerprint: options.treeFingerprint,
    args: (cmd.args || []).map((arg) => normalizeWorkspaceString(arg, roots)),
    cwd: normalizeWorkspaceString(cmd.cwd || '', roots),
    envWhiteList: envSorted,
    execPath: normalizeWorkspaceString(cmd.execPath || '', roots),
    inheritEnv: cmd.inheritEnv ?? null,
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

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
