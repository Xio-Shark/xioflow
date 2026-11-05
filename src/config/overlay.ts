import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ConfigOverlay {
  sourcePath: string;
  overlayPath: string;
  sourceSha256: string;
  overlaySha256: string;
  cleanup(): void;
}

const digest = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Write a rewritten config into a private copy-on-write directory. The source
 * file is read only; callers pass the overlay path to the child process.
 */
export function createConfigOverlay(sourcePath: string, content: string): ConfigOverlay {
  const source = fs.readFileSync(sourcePath);
  const sourceStat = fs.statSync(sourcePath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-config-overlay-'));
  const overlayPath = path.join(directory, path.basename(sourcePath));
  try {
    fs.writeFileSync(overlayPath, content, { mode: sourceStat.mode & 0o777 });
    const overlay = {
      sourcePath: path.resolve(sourcePath),
      overlayPath,
      sourceSha256: digest(source),
      overlaySha256: digest(content),
      cleanup() {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    } satisfies ConfigOverlay;
    return overlay;
  } catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

