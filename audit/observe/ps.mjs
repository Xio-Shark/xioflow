// Process-table view from outside the harness: which processes still carry this run's tag or reference its sandbox.
import { spawnSync } from 'node:child_process';

export function processTable() {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout;
  const table = [];
  for (const line of out.split('\n')) {
    // pid ppid pgid <lstart: 5 tokens> command...
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
    if (match) table.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4], command: match[5] });
  }
  return table;
}

/** Every process whose command line contains `needle`, except this one. */
export function processesMatching(needle) {
  return processTable().filter((p) => p.pid !== process.pid && p.command.includes(needle));
}

/**
 * The harness itself: the launched process and its descendants, stopping at anything that carries the run's tag.
 * A launcher is often a wrapper script, and the tool's children must stay out of it: "kill the harness" means
 * the harness, not the commands it started.
 */
export function harnessProcesses(rootPid, runId) {
  const table = processTable();
  const tagged = (p) => p.command.includes(`--xf-tag=${runId}`);
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    const self = table.find((p) => p.pid === pid);
    if (!self || tagged(self)) continue;
    found.push(self);
    queue.push(...table.filter((p) => p.ppid === pid).map((p) => p.pid));
  }
  return found;
}

export const taggedProcesses = (runId) => processesMatching(`--xf-tag=${runId}`);

/** SIGKILL everything matching; returns what it had to kill. Used only for the bench's own cleanup. */
export function killMatching(needle) {
  const victims = processesMatching(needle);
  for (const { pid } of victims) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return victims;
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
