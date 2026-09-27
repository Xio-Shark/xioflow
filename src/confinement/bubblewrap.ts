import fs from 'node:fs';
import path from 'node:path';
import { ConfinementDriver } from '../types.js';
import { StructuredCommand } from '../driver/types.js';
import { resolveRealPath } from '../capability/path-utils.js';

function findExecutable(name: string): string | null {
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate) && (fs.statSync(candidate).mode & 0o111)) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

export class BubblewrapConfinementDriver implements ConfinementDriver {
  public readonly name = 'bubblewrap';

  public static isAvailable(): boolean {
    return process.platform === 'linux' && findExecutable('bwrap') !== null;
  }

  public wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand {
    const bwrapPath = findExecutable('bwrap');
    if (!bwrapPath || process.platform !== 'linux') {
      throw new Error("Confinement driver 'bubblewrap' is not available on this platform");
    }

    const realRoots = writableRoots.map((r) => resolveRealPath(r));
    const bwrapArgs: string[] = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
    ];

    for (const root of realRoots) {
      bwrapArgs.push('--bind', root, root);
    }

    bwrapArgs.push('--', command.execPath, ...command.args);

    return {
      ...command,
      execPath: bwrapPath,
      args: bwrapArgs,
    };
  }
}
