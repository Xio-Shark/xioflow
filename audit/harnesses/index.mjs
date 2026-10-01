import xio from './xio.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';
import gemini from './gemini.mjs';
import claude from './claude.mjs';
import qwen from './qwen.mjs';

export const HARNESSES = { xio, codex, opencode, gemini, claude, qwen };

/** "xio" or "xio:node" (a named variant of the same harness, selected by environment). */
export function resolveHarness(spec) {
  const [name, variant] = spec.split(':');
  const harness = HARNESSES[name];
  if (!harness) throw new Error(`unknown harness "${name}" (known: ${Object.keys(HARNESSES).join(', ')})`);
  if (variant && !harness.variants?.[variant]) throw new Error(`harness ${name} has no variant "${variant}"`);
  return { harness, label: spec, variantEnv: variant ? harness.variants[variant] : {} };
}
