import fs from 'node:fs';
import { ConfinementDriver } from '../types.js';
import { StructuredCommand } from '../driver/types.js';
import { resolveRealPath } from '../capability/path-utils.js';

export class SandboxExecConfinementDriver implements ConfinementDriver {
  public readonly name = 'sandbox-exec';

  public static isAvailable(): boolean {
    return process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
  }

  public wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand {
    if (!SandboxExecConfinementDriver.isAvailable()) {
      throw new Error("Confinement driver 'sandbox-exec' is not available on this platform");
    }

    const realRoots = writableRoots.map((r) => resolveRealPath(r));
    const profileLines: string[] = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (subpath "/dev"))',
    ];

    for (const root of realRoots) {
      profileLines.push(`(allow file-write* (subpath ${JSON.stringify(root)}))`);
    }

    const profile = profileLines.join('\n');

    return {
      ...command,
      execPath: '/usr/bin/sandbox-exec',
      args: ['-p', profile, command.execPath, ...command.args],
    };
  }
}
