import path from 'node:path';
import xio from './xio.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';
import gemini from './gemini.mjs';
import claude from './claude.mjs';
import qwen from './qwen.mjs';

export const HARNESSES = { xio, codex, opencode, gemini, claude, qwen };
const WRAP_BIN = path.join(import.meta.dirname, 'wrap-bin.mjs');

function wrapHarnessAdapter(base) {
  const wrapCall = (fn) => (ctx) => {
    const inner = fn(ctx);
    const domainDir = path.join(ctx.home, '.xioflow-wrap-domain');
    return {
      ...inner,
      args: ['--xf-domain', domainDir, '--', base.bin, ...(inner.args ?? [])],
    };
  };
  return {
    ...base,
    name: `${base.name}:wrap`,
    bin: WRAP_BIN,
    versionArgs: ['--xf-wrap-version', base.bin, ...(base.versionArgs ?? [])],
    launch: wrapCall(base.launch),
    resume: base.resume ? wrapCall(base.resume) : undefined,
  };
}

/** "xio", "xio:node", or "<harness>:wrap" (runs any harness under `xio wrap`). */
export function resolveHarness(spec) {
  const [name, variant] = spec.split(':');
  const harness = HARNESSES[name];
  if (!harness) throw new Error(`unknown harness "${name}" (known: ${Object.keys(HARNESSES).join(', ')})`);
  if (variant === 'wrap') {
    return { harness: wrapHarnessAdapter(harness), label: spec, variantEnv: {} };
  }
  if (variant && !harness.variants?.[variant]) throw new Error(`harness ${name} has no variant "${variant}"`);
  return { harness, label: spec, variantEnv: variant ? harness.variants[variant] : {} };
}
