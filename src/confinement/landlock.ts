import { execFileSync } from 'node:child_process';
import { ConfinementDriver } from '../types.js';
import { StructuredCommand } from '../driver/types.js';
import { locateReaperHelper } from '../driver/reaper-driver.js';
import { resolveRealPath } from '../capability/path-utils.js';

/**
 * Linux Landlock LSM unprivileged filesystem confinement driver (Linux 5.13+).
 *
 * Enforces read-only access on `/` and read-write access strictly beneath `writableRoots`
 * (plus `/dev/null`, `/dev/zero`, `/dev/tty`) directly in the kernel via `xioflow-reaper --landlock-exec`.
 * Requires zero root privileges, zero SUID binaries, and zero external packages (`bwrap`).
 */
export class LandlockConfinementDriver implements ConfinementDriver {
  public readonly name = 'landlock';
  private static readonly abiCache = new Map<string, number>();

  public static getAbiVersion(customHelperPath?: string): number {
    if (process.platform !== 'linux') return 0;
    const helper = customHelperPath ?? locateReaperHelper();
    if (!helper) return 0;
    const cached = LandlockConfinementDriver.abiCache.get(helper);
    if (cached !== undefined) return cached;
    try {
      const out = execFileSync(helper, ['--check-landlock'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
      const match = /^landlock-abi (\d+)$/.exec(out);
      const abi = match ? Number(match[1]) : 0;
      LandlockConfinementDriver.abiCache.set(helper, abi);
      return abi;
    } catch {
      LandlockConfinementDriver.abiCache.set(helper, 0);
      return 0;
    }
  }

  public static isAvailable(): boolean {
    return LandlockConfinementDriver.getAbiVersion() >= 1;
  }

  public wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand {
    const helper = locateReaperHelper();
    if (process.platform !== 'linux' || !helper || LandlockConfinementDriver.getAbiVersion(helper) < 1) {
      throw new Error("Confinement driver 'landlock' is not available on this platform");
    }

    const realRoots = writableRoots.map((r) => resolveRealPath(r));
    return {
      ...command,
      execPath: helper,
      args: ['--landlock-exec', realRoots.join(':'), '--', command.execPath, ...command.args],
    };
  }
}
