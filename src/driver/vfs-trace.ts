import fs from 'node:fs';
import path from 'node:path';

export interface VfsSyscallEvents {
  /** Files opened for reading ('R'). */
  reads: string[];
  /** Directories opened for listing via opendir or O_DIRECTORY ('L'). */
  listedDirs: string[];
  /** Files created, truncated, or opened for writing ('W'). */
  writes: string[];
  /** Paths unlinked or renamed away ('D'). */
  deletes: string[];
  /** Paths rejected by kernel confinement / EACCES / EPERM / EROFS ('E'). */
  denials: string[];
  /** Shell exec interceptions ('X'). */
  shellExecs: string[];
}

export function parseVfsTraceContent(content: string): VfsSyscallEvents {
  const reads = new Set<string>();
  const listedDirs = new Set<string>();
  const writes = new Set<string>();
  const deletes = new Set<string>();
  const denials = new Set<string>();
  const shellExecs = new Set<string>();

  for (const rawLine of content.split('\n')) {
    if (rawLine.length < 3 || rawLine[1] !== '\t') continue;
    const op = rawLine[0];
    const target = path.normalize(rawLine.slice(2).trim());
    if (!target) continue;
    switch (op) {
      case 'R':
        reads.add(target);
        break;
      case 'L':
        listedDirs.add(target);
        break;
      case 'W':
        writes.add(target);
        break;
      case 'D':
        deletes.add(target);
        break;
      case 'E':
        denials.add(target);
        break;
      case 'X':
        shellExecs.add(target);
        break;
      default:
        break;
    }
  }

  return {
    reads: [...reads].sort(),
    listedDirs: [...listedDirs].sort(),
    writes: [...writes].sort(),
    deletes: [...deletes].sort(),
    denials: [...denials].sort(),
    shellExecs: [...shellExecs].sort(),
  };
}

export function parseVfsTraceFile(tracePath: string): VfsSyscallEvents | undefined {
  try {
    if (!fs.existsSync(tracePath)) {
      return {
        reads: [],
        listedDirs: [],
        writes: [],
        deletes: [],
        denials: [],
        shellExecs: [],
      };
    }
    const raw = fs.readFileSync(tracePath, 'utf8');
    return parseVfsTraceContent(raw);
  } catch {
    return undefined;
  }
}
