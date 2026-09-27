import { ConfinementDriver } from '../types.js';
import { SandboxExecConfinementDriver } from './sandbox-exec.js';
import { BubblewrapConfinementDriver } from './bubblewrap.js';
import { SrtConfinementDriver } from './srt.js';

export function detectAvailableConfinementDrivers(): string[] {
  const drivers: string[] = [];
  if (SrtConfinementDriver.isAvailable()) {
    drivers.push('srt');
  }
  if (SandboxExecConfinementDriver.isAvailable()) {
    drivers.push('sandbox-exec');
  }
  if (BubblewrapConfinementDriver.isAvailable()) {
    drivers.push('bubblewrap');
  }
  return drivers;
}

export function createConfinementDriver(name?: string): ConfinementDriver | null {
  if (name === 'sandbox-exec') return new SandboxExecConfinementDriver();
  if (name === 'bubblewrap') return new BubblewrapConfinementDriver();
  if (name === 'srt') return new SrtConfinementDriver();

  if (!name) {
    if (SandboxExecConfinementDriver.isAvailable()) return new SandboxExecConfinementDriver();
    if (BubblewrapConfinementDriver.isAvailable()) return new BubblewrapConfinementDriver();
    if (SrtConfinementDriver.isAvailable()) return new SrtConfinementDriver();
    return null;
  }

  throw new Error(`Unknown confinement driver: '${name}'`);
}
