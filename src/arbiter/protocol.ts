import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ArbiterManifest {
  protocol: 'xio-arbiter/1';
  pid: number;
  workspaceRoot: string;
  domainPath: string;
  socketPath: string;
  sessionKey: string;
  capabilityId: string;
  epoch: number;
  startedAt: string;
}

export function arbiterManifestPath(domainPath: string): string {
  return path.join(domainPath, 'arbiter.json');
}

export function arbiterBootLockPath(domainPath: string): string {
  return path.join(domainPath, 'arbiter.boot.lock');
}

/**
 * Resolve a safe owner-only Unix Domain Socket path within the 100-byte sun_path limit.
 * Falls back to `~/.xioflow/run/<hash>.sock` when `domainPath` is deep (e.g. macOS `/var/folders/...`).
 */
export function resolveArbiterSocketPath(domainPath: string): string {
  const realDomain = path.resolve(domainPath);
  fs.mkdirSync(realDomain, { recursive: true, mode: 0o700 });
  try {
    const st = fs.statSync(realDomain);
    if ((st.mode & 0o022) !== 0) {
      fs.chmodSync(realDomain, 0o700);
    }
  } catch {}

  const candidate = path.join(realDomain, 'arb.sock');
  let safeInDomain = Buffer.byteLength(candidate, 'utf8') <= 96;
  if (safeInDomain) {
    try {
      const st = fs.statSync(realDomain);
      if ((st.mode & 0o022) !== 0) safeInDomain = false;
    } catch {
      safeInDomain = false;
    }
  }
  if (safeInDomain) return candidate;

  const runRoot = path.join(os.homedir(), '.xioflow', 'run');
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runRoot, 0o700);
  } catch {}
  const hash = crypto.createHash('sha256').update(realDomain).digest('hex').slice(0, 16);
  return path.join(runRoot, `${hash}.sock`);
}

export function readArbiterManifest(domainPath: string): ArbiterManifest | null {
  const file = arbiterManifestPath(domainPath);
  try {
    if (!fs.existsSync(file)) return null;
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ArbiterManifest;
    if (parsed?.protocol !== 'xio-arbiter/1' || !parsed.socketPath || !parsed.sessionKey) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}
