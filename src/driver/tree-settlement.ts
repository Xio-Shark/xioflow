import type { PlatformDriver, ProcessIdentity, StopProcessResult } from './types.js';

export type SettledProcessTree =
  | { status: 'settled'; treeSettlement: 'empty' | 'unverified' | 'reaped'; residualProcessesReaped: boolean }
  | { status: 'unconfirmed'; stop: StopProcessResult };

/** Root exit and drained pipes do not establish that owned descendants stopped. */
export async function settleProcessTree(
  driver: PlatformDriver,
  identity: ProcessIdentity,
  waitMs: number,
  graceMs: number
): Promise<SettledProcessTree> {
  const answer = driver.settleTree ? await driver.settleTree(identity, waitMs) : 'unknown';
  if (answer === 'empty') return { status: 'settled', treeSettlement: 'empty', residualProcessesReaped: false };
  if (answer === 'unknown') return { status: 'settled', treeSettlement: 'unverified', residualProcessesReaped: false };
  const stop = await driver.terminate(identity, graceMs);
  return stop.stopped === 'confirmed_stopped'
    ? { status: 'settled', treeSettlement: 'reaped', residualProcessesReaped: true }
    : { status: 'unconfirmed', stop };
}
