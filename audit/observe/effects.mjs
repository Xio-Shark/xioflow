// Side-effect ledger written by the fixture: one line per execution, `<id> <pid> <ms>`.
import fs from 'node:fs';
import path from 'node:path';

export function readEffects(runDir) {
  const file = path.join(runDir, 'effects.log');
  const counts = {};
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const [id] = line.split(' ');
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return { counts, lines };
}

/** Marker files the fixture leaves (`<name>.started` etc.): { name: { pid, at, extra } }. */
export function readMarkers(runDir) {
  const markers = {};
  for (const name of fs.readdirSync(runDir)) {
    if (name === 'effects.log' || name === 'signals.log') continue;
    const [pid, at, ...extra] = fs.readFileSync(path.join(runDir, name), 'utf8').trim().split(' ');
    markers[name] = { pid: Number(pid), at: Number(at), extra: extra.join(' ') };
  }
  return markers;
}
