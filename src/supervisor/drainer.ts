import * as crypto from 'node:crypto';
import fs from 'node:fs';

export function trimToValidUtf8(buf: Buffer): Buffer {
  const len = buf.length;
  for (let i = 1; i <= Math.min(3, len); i++) {
    const b = buf[len - i];
    if ((b & 0xc0) === 0xc0) {
      const needed = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
      if (i < needed) {
        return Buffer.from(buf.subarray(0, len - i));
      }
      break;
    } else if ((b & 0x80) === 0) {
      break;
    }
  }
  return buf;
}

export function trimStartToValidUtf8(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return Buffer.from(buf.subarray(start));
}

export interface StreamDrainerResult {
  content: string;
  isTruncated: boolean;
  outputRef?: string;
  outputHash?: string;
  bytesSeen: number;
  spillError?: string;
}

export interface StreamDrainer {
  getResult: () => StreamDrainerResult;
  finishPromise: Promise<void>;
  forceFinalize: () => void;
}

export function setupStreamDrainer(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  spillFilePath?: string,
  onChunk?: (bytes: number) => void,
  onData?: (chunk: Buffer) => void,
  spillInitError?: string
): StreamDrainer {
  const overhead = maxBytes >= 80 ? Math.min(64, Math.floor(maxBytes / 4)) : 0;
  const effectiveMax = maxBytes - overhead;
  const headMaxBytes = overhead > 0 ? Math.floor(effectiveMax * 0.75) : maxBytes;
  const tailMaxBytes = overhead > 0 ? Math.max(0, effectiveMax - headMaxBytes) : 0;

  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let bytesSeen = 0;
  let isTruncated = false;
  let spillFd: number | null = null;
  let spillError: string | undefined = spillInitError;
  const hash = crypto.createHash('sha256');
  let isFinalized = false;
  let outputHash: string | undefined = undefined;

  const tailRing = tailMaxBytes > 0 ? Buffer.alloc(tailMaxBytes) : null;
  let tailHead = 0;
  let tailCount = 0;

  if (spillFilePath && !spillError) {
    try {
      spillFd = fs.openSync(spillFilePath, 'w');
    } catch (openErr: any) {
      spillError = openErr.message || String(openErr);
      spillFd = null;
    }
  }

  const doFinalize = () => {
    if (isFinalized) return;
    isFinalized = true;
    if (spillFd !== null) {
      try {
        fs.fsyncSync(spillFd);
        fs.closeSync(spillFd);
      } catch (syncErr: any) {
        spillError = spillError || syncErr.message || String(syncErr);
      }
      spillFd = null;
    }
    if (!spillError) {
      try {
        outputHash = hash.digest('hex');
      } catch {}
    } else {
      outputHash = undefined;
    }
  };

  const finishPromise = new Promise<void>((resolve) => {
    const finalize = () => {
      doFinalize();
      resolve();
    };

    stream.on('data', (chunk: Buffer | string) => {
      if (isFinalized) {
        // finalize 之后，流继续读走数据避免堵塞或 SIGPIPE，但跳过 hash、落盘和转发
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesSeen += buf.length;
      if (onChunk) {
        try {
          onChunk(buf.length);
        } catch {}
      }

      // 持续落盘转储全部流与写盘同链哈希 (P0-9)
      if (spillFd !== null) {
        try {
          fs.writeSync(spillFd, buf);
          hash.update(buf);
        } catch (writeErr: any) {
          spillError = spillError || writeErr.message || String(writeErr);
          try {
            fs.closeSync(spillFd);
          } catch {}
          spillFd = null;
        }
      } else if (!spillFilePath && !spillError) {
        try {
          hash.update(buf);
        } catch {}
      }

      if (onData) {
        onData(buf);
      }

      // Head 内存有界保留
      if (headBytes < headMaxBytes) {
        if (headBytes + buf.length <= headMaxBytes) {
          headChunks.push(buf);
          headBytes += buf.length;
        } else {
          const remaining = headMaxBytes - headBytes;
          if (remaining > 0) {
            headChunks.push(buf.subarray(0, remaining));
            headBytes += remaining;
          }
          isTruncated = true;
        }
      } else {
        isTruncated = true;
      }

      if (bytesSeen > maxBytes) {
        isTruncated = true;
      }

      // Tail 环形缓冲保留
      if (tailRing !== null && tailMaxBytes > 0) {
        if (buf.length >= tailMaxBytes) {
          buf.copy(tailRing, 0, buf.length - tailMaxBytes);
          tailHead = 0;
          tailCount = tailMaxBytes;
        } else {
          for (let i = 0; i < buf.length; i++) {
            tailRing[tailHead] = buf[i];
            tailHead = (tailHead + 1) % tailMaxBytes;
          }
          tailCount = Math.min(tailMaxBytes, tailCount + buf.length);
        }
      }
    });

    stream.on('end', finalize);
    stream.on('close', finalize);
    stream.on('error', finalize);
  });

  return {
    getResult: () => {
      doFinalize();
      let content: string;
      if (bytesSeen <= maxBytes) {
        content = Buffer.concat(headChunks).toString('utf8');
      } else {
        const rawHead = trimToValidUtf8(Buffer.concat(headChunks));
        let cleanTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        if (tailRing !== null && tailCount > 0) {
          const rawTail = Buffer.alloc(tailCount);
          if (tailCount < tailMaxBytes) {
            tailRing.copy(rawTail, 0, 0, tailCount);
          } else {
            const part1 = tailRing.subarray(tailHead, tailMaxBytes);
            const part2 = tailRing.subarray(0, tailHead);
            part1.copy(rawTail, 0);
            part2.copy(rawTail, part1.length);
          }
          cleanTail = trimStartToValidUtf8(rawTail);
        }
        const truncatedBytes = Math.max(0, bytesSeen - rawHead.length - cleanTail.length);
        const marker = `\n[... truncated ${truncatedBytes} bytes ...]\n`;
        content = rawHead.toString('utf8') + marker + cleanTail.toString('utf8');
      }

      return {
        content,
        isTruncated,
        outputRef: isTruncated && spillFilePath && !spillError ? spillFilePath : undefined,
        outputHash: !spillError ? outputHash : undefined,
        bytesSeen,
        spillError,
      };
    },
    finishPromise,
    forceFinalize: doFinalize,
  };
}
