import * as crypto from 'node:crypto';
import fs from 'node:fs';
import { createArtifact, OwnedArtifact, removeOwnedArtifact, ArtifactFacts } from '../artifacts.js';

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

const MAX_PENDING_WRITE_BYTES = 1024 * 1024;

function writeChunk(fd: number, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let offset = 0;
    const writeNext = () => {
      fs.write(fd, chunk, offset, chunk.length - offset, null, (error, written) => {
        if (error) {
          reject(error);
          return;
        }
        if (!written) {
          reject(new Error('Artifact writer made no progress'));
          return;
        }
        offset += written;
        if (offset < chunk.length) writeNext();
        else resolve();
      });
    };
    writeNext();
  });
}

export function setupStreamDrainer(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  spillFilePath?: string,
  onChunk?: (bytes: number) => void,
  onData?: (chunk: Buffer) => void,
  spillInitError?: string,
  onArtifactCreated?: (artifact: OwnedArtifact) => void,
  onArtifactFinalized?: (artifact: OwnedArtifact, facts: ArtifactFacts) => void,
  onArtifactDeleted?: (artifact: OwnedArtifact, reason: string) => void,
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
  let ownedSpill: OwnedArtifact | undefined;
  let spillError: string | undefined = spillInitError;
  const hash = crypto.createHash('sha256');
  let isFinalized = false;
  let outputHash: string | undefined = undefined;
  let pendingWriteBytes = 0;
  let writeTail = Promise.resolve();
  let finalizationPromise: Promise<void> | undefined;
  let resolveFinish!: () => void;
  let streamPausedForWriter = false;

  const tailRing = tailMaxBytes > 0 ? Buffer.alloc(tailMaxBytes) : null;
  let tailHead = 0;
  let tailCount = 0;

  if (spillFilePath && !spillError) {
    try {
      const created = createArtifact(spillFilePath, onArtifactCreated);
      spillFd = created.fd;
      ownedSpill = created.artifact;
    } catch (openErr: any) {
      spillError = openErr.message || String(openErr);
      spillFd = null;
    }
  }

  const setSpillError = (error: unknown): void => {
    spillError ??= error instanceof Error ? error.message : String(error);
  };

  const resumeAfterWrite = () => {
    if (streamPausedForWriter && pendingWriteBytes <= MAX_PENDING_WRITE_BYTES / 2 && !isFinalized) {
      streamPausedForWriter = false;
      (stream as any).resume?.();
    }
  };

  const enqueueWrite = (buf: Buffer): void => {
    if (spillFd === null || spillError) return;
    pendingWriteBytes += buf.length;
    if (pendingWriteBytes > MAX_PENDING_WRITE_BYTES && !streamPausedForWriter) {
      streamPausedForWriter = true;
      (stream as any).pause?.();
    }
    const fd = spillFd;
    writeTail = writeTail.then(async () => {
      if (spillError || spillFd !== fd) return;
      await writeChunk(fd, buf);
      // Hash only after the corresponding bytes have reached the file.
      hash.update(buf);
    }).catch((error) => {
      setSpillError(error);
    }).finally(() => {
      pendingWriteBytes -= buf.length;
      resumeAfterWrite();
    });
  };

  const doFinalize = (): Promise<void> => {
    if (finalizationPromise) return finalizationPromise;
    isFinalized = true;
    streamPausedForWriter = false;
    (stream as any).resume?.();
    finalizationPromise = (async () => {
      await writeTail;
      if (spillFd !== null) {
        const fd = spillFd;
        try {
          await new Promise<void>((resolve, reject) => fs.fsync(fd, (error) => error ? reject(error) : resolve()));
        } catch (syncErr) {
          setSpillError(syncErr);
        } finally {
          try {
            await new Promise<void>((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve()));
          } catch (closeErr) {
            setSpillError(closeErr);
          }
          spillFd = null;
        }
      }
      if (!spillError) {
        outputHash = hash.digest('hex');
      } else {
        outputHash = undefined;
      }
      if (ownedSpill && outputHash) {
        try {
          onArtifactFinalized?.(ownedSpill, { sha256: outputHash, sizeBytes: bytesSeen });
        } catch (finalizeErr) {
          setSpillError(finalizeErr);
        }
      }
      // Only the drainer knows which file it created; failed opens never authorize deletion.
      if (ownedSpill && (!isTruncated || spillError)) {
        try {
          removeOwnedArtifact(ownedSpill);
          onArtifactDeleted?.(ownedSpill, spillError ? 'spill_failed' : 'untruncated');
        } catch (cleanupErr) {
          setSpillError(cleanupErr);
        }
      }
    })();
    return finalizationPromise;
  };

  const finishPromise = new Promise<void>((resolve) => {
    resolveFinish = resolve;
    const finalize = () => {
      void doFinalize().finally(resolve);
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
        enqueueWrite(buf);
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
    forceFinalize: () => {
      void doFinalize().finally(resolveFinish);
    },
  };
}
