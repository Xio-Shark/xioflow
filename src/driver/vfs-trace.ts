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
  /** Constructor sentinel ('S') observed in the trace file. */
  shimLoaded?: boolean;
  /** Unobserved exec targets ('U': static ELF without PT_INTERP, setuid/setgid/AT_SECURE, or stripped LD_PRELOAD). */
  unobservedExecs?: string[];
}

export function parseVfsTraceContent(content: string): VfsSyscallEvents {
  const reads = new Set<string>();
  const listedDirs = new Set<string>();
  const writes = new Set<string>();
  const deletes = new Set<string>();
  const denials = new Set<string>();
  const shellExecs = new Set<string>();
  const unobservedExecs = new Set<string>();
  let shimLoaded = false;

  for (const rawLine of content.split('\n')) {
    if (rawLine.length < 3 || rawLine[1] !== '\t') continue;
    const op = rawLine[0];
    const detail = rawLine.slice(2).trim();
    if (!detail) continue;
    const target = op === 'S' || op === 'U' ? detail : path.normalize(detail);
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
      case 'S':
        shimLoaded = true;
        break;
      case 'U':
        unobservedExecs.add(target);
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
    ...(shimLoaded ? { shimLoaded: true } : {}),
    ...(unobservedExecs.size > 0 ? { unobservedExecs: [...unobservedExecs].sort() } : {}),
  };
}

export function parseVfsTraceFile(tracePath: string): VfsSyscallEvents | undefined {
  try {
    if (!fs.existsSync(tracePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(tracePath, 'utf8');
    const parsed = parseVfsTraceContent(raw);
    return {
      ...parsed,
      shimLoaded: parsed.shimLoaded === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Inspect an executable before spawn (following up to 4 `#!` shebang hops) and
 * return its resolved path if Linux will omit or strip `LD_PRELOAD` (static ELF
 * lacking `PT_INTERP`, setuid/setgid bit, or unreadable binary header).
 */
export function inspectElfPreloadRisk(execPath: string): string | null {
  let cur = execPath;
  for (let hop = 0; hop < 4; hop++) {
    let st: fs.Stats;
    try {
      st = fs.statSync(cur);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    if ((st.mode & 0o6000) !== 0) return cur;

    let fd: number | undefined;
    try {
      fd = fs.openSync(cur, 'r');
      const hdr = Buffer.alloc(256);
      const n = fs.readSync(fd, hdr, 0, hdr.length, 0);
      if (n >= 2 && hdr[0] === 0x23 && hdr[1] === 0x21) {
        const lineEnd = hdr.subarray(0, n).indexOf(0x0a);
        const rawLine = hdr.subarray(2, lineEnd >= 0 ? lineEnd : n).toString('utf8').trimStart();
        const interp = rawLine.split(/[\s\r\n]/, 1)[0];
        if (!interp) return null;
        cur = path.isAbsolute(interp) ? interp : path.resolve(path.dirname(cur), interp);
        continue;
      }
      if (n >= 52 && hdr[0] === 0x7f && hdr[1] === 0x45 && hdr[2] === 0x4c && hdr[3] === 0x46) {
        const eiClass = hdr[4];
        const eiData = hdr[5];
        if (eiData !== 1) return cur; // non-little-endian unsupported -> fail closed
        let eType = 0;
        let phoff = 0;
        let phentsize = 0;
        let phnum = 0;
        if (eiClass === 2 && n >= 64) {
          eType = hdr.readUInt16LE(16);
          phoff = Number(hdr.readBigUInt64LE(32));
          phentsize = hdr.readUInt16LE(54);
          phnum = hdr.readUInt16LE(56);
        } else if (eiClass === 1 && n >= 52) {
          eType = hdr.readUInt16LE(16);
          phoff = hdr.readUInt32LE(28);
          phentsize = hdr.readUInt16LE(42);
          phnum = hdr.readUInt16LE(44);
        } else {
          return cur;
        }
        if ((eType === 2 || eType === 3) && phentsize >= 4 && phnum > 0) {
          const limit = Math.min(phnum, 256);
          const typeBuf = Buffer.alloc(4);
          for (let i = 0; i < limit; i++) {
            const read = fs.readSync(fd, typeBuf, 0, 4, phoff + i * phentsize);
            if (read === 4 && typeBuf.readUInt32LE(0) === 3) return null; // PT_INTERP present
          }
          return cur;
        }
      }
      return null;
    } catch {
      return cur;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }
  return cur;
}
