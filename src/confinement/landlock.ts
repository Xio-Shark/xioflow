import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfinementDriver } from '../types.js';
import { StructuredCommand } from '../driver/types.js';
import { locateReaperHelper } from '../driver/reaper-driver.js';
import { resolveRealPath } from '../capability/path-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Linux Landlock LSM unprivileged filesystem confinement driver (Linux 5.13+).
 *
 * Enforces read-only access on `/` and read-write access strictly beneath `writableRoots`
 * (plus `/dev/null`, `/dev/zero`, `/dev/tty`) directly in the kernel via `xioflow-reaper --landlock-exec`.
 * Requires zero root privileges, zero SUID binaries, and zero external packages (`bwrap`).
 *
 * The ABI version can only be learned by asking the helper, and src/ is under a
 * zero-synchronous-subprocess gate (P0-8), so the probe is asynchronous and cached:
 * call {@link LandlockConfinementDriver.probe} once at startup, then the synchronous
 * getters below answer from the cache.
 */
export class LandlockConfinementDriver implements ConfinementDriver {
  public readonly name = 'landlock';
  private static readonly abiCache = new Map<string, number>();
  private static readonly probed = new Set<string>();
  private static pending: Promise<void> = Promise.resolve();

  /**
   * Probe the reaper helper's Landlock ABI version once and cache it.
   * Idempotent and safe to call concurrently; the probe never rejects.
   */
  public static probe(customHelperPath?: string): Promise<void> {
    if (process.platform !== 'linux') return Promise.resolve();
    const helper = customHelperPath ?? locateReaperHelper();
    if (!helper || LandlockConfinementDriver.probed.has(helper)) return Promise.resolve();

    LandlockConfinementDriver.pending = LandlockConfinementDriver.pending.then(async () => {
      if (LandlockConfinementDriver.probed.has(helper)) return;
      let abi = 0;
      try {
        const { stdout } = await execFileAsync(helper, ['--check-landlock'], {
          encoding: 'utf8',
          timeout: 2000,
        });
        const match = /^landlock-abi (\d+)$/.exec(stdout.trim());
        abi = match ? Number(match[1]) : 0;
      } catch {
        // Helper missing, non-executable, or built without Landlock support.
        abi = 0;
      }
      LandlockConfinementDriver.abiCache.set(helper, abi);
      LandlockConfinementDriver.probed.add(helper);
    });
    return LandlockConfinementDriver.pending;
  }

  /** Cached ABI version; 0 when unprobed or unsupported. Call {@link probe} first. */
  public static getAbiVersion(customHelperPath?: string): number {
    if (process.platform !== 'linux') return 0;
    const helper = customHelperPath ?? locateReaperHelper();
    if (!helper) return 0;
    return LandlockConfinementDriver.abiCache.get(helper) ?? 0;
  }

  public static isAvailable(): boolean {
    return LandlockConfinementDriver.getAbiVersion() >= 1;
  }

  public wrap(command: StructuredCommand, writableRoots: string[]): StructuredCommand {
    const helper = locateReaperHelper();
    if (process.platform !== 'linux' || !helper) {
      throw new Error("Confinement driver 'landlock' is not available on this platform");
    }
    if (!LandlockConfinementDriver.probed.has(helper)) {
      throw new Error(
        "Confinement driver 'landlock' has not been probed; await LandlockConfinementDriver.probe() before wrapping a command"
      );
    }
    if (LandlockConfinementDriver.getAbiVersion(helper) < 1) {
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
