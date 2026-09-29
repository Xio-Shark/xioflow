import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** execPath + args 的 sha256；JSON 编码保证参数边界（空格、冒号）不会造成碰撞。 */
export function computeCommandFingerprint(execPath: string, args: string[]): string {
  return createHash('sha256').update(JSON.stringify([execPath, ...args])).digest('hex');
}

export function resolveExecutable(bin: string, envPath?: string): string | null {
  if (bin.includes(path.sep)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const dirs = (envPath || process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}
