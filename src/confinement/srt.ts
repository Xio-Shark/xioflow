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

export class SrtConfinementDriver implements ConfinementDriver {
  public readonly name = 'srt';

  public static isAvailable(): boolean {
    return findExecutable('srt') !== null;
  }

  public wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand {
    const srtPath = findExecutable('srt');
    if (!srtPath) {
      throw new Error("Confinement driver 'srt' is not available on this system");
    }

    const realRoots = writableRoots.map((r) => resolveRealPath(r));
    const srtArgs: string[] = [];
    for (const root of realRoots) {
      srtArgs.push('-w', root);
    }
    srtArgs.push('--', command.execPath, ...command.args);

    return {
      ...command,
      execPath: srtPath,
      args: srtArgs,
    };
  }
}
