import { Transform, type Readable } from 'node:stream';
import type { SecretRef } from '../isa/types.js';
import type { SecretResolutionContext, SecretResolver, StructuredCommand } from './types.js';

export class SecretResolutionError extends Error {
  public readonly ref?: SecretRef;

  constructor(message: string, ref?: SecretRef) {
    super(message);
    this.name = 'SecretResolutionError';
    this.ref = ref;
  }
}

function safeRef(ref: unknown): ref is SecretRef {
  return typeof ref === 'string' && /^secret:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(ref);
}

function redactText(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

/**
 * Redacts values at the driver boundary. A carry buffer handles a secret split
 * across two OS stream chunks without exposing it to the supervisor.
 */
class SecretRedactionTransform extends Transform {
  private carry = Buffer.alloc(0);
  private readonly keepBytes: number;

  constructor(private readonly secrets: readonly string[]) {
    super();
    // Keep a full maximum-length secret suffix: a secret may begin at the last
    // byte of one chunk and finish in the next chunk.
    this.keepBytes = Math.max(0, ...secrets.map((secret) => Buffer.byteLength(secret, 'utf8') + 4));
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const input = Buffer.concat([this.carry, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const splitAt = Math.max(0, input.length - this.keepBytes);
      const visible = input.subarray(0, splitAt).toString('utf8');
      this.carry = input.subarray(splitAt);
      this.push(redactText(visible, this.secrets));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.push(redactText(this.carry.toString('utf8'), this.secrets));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export interface ResolvedCommandEnvironment {
  env: NodeJS.ProcessEnv;
  secretValues: string[];
}

/** Resolve ordinary env and SecretRef values without exposing secret values to callers. */
export async function resolveCommandEnvironment(
  command: StructuredCommand,
  resolver: SecretResolver | undefined,
  context: SecretResolutionContext = {},
): Promise<ResolvedCommandEnvironment> {
  const env: NodeJS.ProcessEnv = command.envWhiteList
    ? { ...command.envWhiteList }
    : command.inheritEnv === true
      ? { ...process.env }
      : {};
  const entries = Object.entries(command.secretEnv ?? {});
  if (entries.length === 0) return { env, secretValues: [] };
  if (!resolver) {
    throw new SecretResolutionError('SecretRef resolution is unavailable for this platform driver');
  }

  const secretValues: string[] = [];
  for (const [key, refValue] of entries) {
    const ref = refValue as SecretRef;
    if (!safeRef(ref)) {
      throw new SecretResolutionError(`Invalid SecretRef for environment key '${key}'`, ref);
    }
    if (Object.hasOwn(env, key)) {
      throw new SecretResolutionError(`SecretRef environment key '${key}' conflicts with envWhiteList`);
    }
    let value: string;
    try {
      value = await resolver(ref, context);
    } catch {
      // Resolver implementations may handle credentials; never copy their error text.
      throw new SecretResolutionError(`SecretRef '${ref}' could not be resolved`, ref);
    }
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      throw new SecretResolutionError(`SecretRef '${ref}' resolved to an invalid environment value`, ref);
    }
    env[key] = value;
    secretValues.push(value);
  }
  return { env, secretValues };
}

export function redactSecretStream(stream: Readable, secretValues: readonly string[]): Readable {
  if (secretValues.length === 0) return stream;
  const transform = new SecretRedactionTransform(secretValues);
  stream.pipe(transform);
  return transform;
}
