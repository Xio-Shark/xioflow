import crypto from 'node:crypto';
import type { ObservationStepOutcome, ObservationValidation } from './transactions.js';

export type ObservationReplayResult =
  | {
      status: 'matched';
      matchedSteps: number;
      /** Number of steps where raw resultHash drifted but Early Cutoff proved downstream invariants held. */
      cutoffSteps?: number;
      cutoffIndices?: number[];
    }
  | {
      status: 'diverged';
      matchedSteps: number;
      divergedAt: number;
      reason: 'observation_changed' | 'mutation_not_applicable';
      /** Execution failures are not reusable evidence of a deterministic result change. */
      error?: string;
      cutoffSteps?: number;
      cutoffIndices?: number[];
    };

function normalizeStepOutcome(raw: string | void | ObservationStepOutcome): {
  resultHash?: string;
  cutoffHash?: string;
  cutoff: boolean;
} {
  if (typeof raw === 'string') return { resultHash: raw, cutoffHash: undefined, cutoff: false };
  if (!raw) return { resultHash: undefined, cutoffHash: undefined, cutoff: false };
  return {
    resultHash: raw.resultHash,
    cutoffHash: raw.cutoffHash,
    cutoff: raw.cutoff === true,
  };
}

/**
 * Revalidate a recorded prefix on a disposable fork, not on the live workspace.
 * Supports Early Cutoff: when a step's raw `resultHash` drifts (e.g., shifted line numbers,
 * comments in unrelated regions, or additive file discovery during prefix recovery) but its
 * semantic projection (`cutoffHash` or `canCutoff`) holds, replay records the cutoff and
 * continues verifying all dependent reads and mutations on the fork.
 */
export async function replayObservationLog(
  observations: Pick<ObservationValidation, 'log' | 'replay' | 'canCutoff'>,
  root: string
): Promise<ObservationReplayResult> {
  const cutoffIndices: number[] = [];
  for (let i = 0; i < observations.log.length; i++) {
    const entry = observations.log[i];
    try {
      const raw = await observations.replay(entry, root);
      const { resultHash: seen, cutoffHash: seenCutoff, cutoff: explicitCutoff } = normalizeStepOutcome(raw);
      if ((entry.kind === 'observe' || entry.resultHash !== undefined) && seen !== entry.resultHash) {
        const hashCutoff =
          entry.cutoffHash !== undefined &&
          seenCutoff !== undefined &&
          seenCutoff === entry.cutoffHash;
        const callbackCutoff =
          !explicitCutoff &&
          !hashCutoff &&
          observations.canCutoff !== undefined &&
          (await observations.canCutoff(entry, { resultHash: seen, cutoffHash: seenCutoff, index: i }, root)) === true;

        if (explicitCutoff || hashCutoff || callbackCutoff) {
          cutoffIndices.push(i);
          continue;
        }
        return {
          status: 'diverged',
          matchedSteps: i,
          divergedAt: i,
          reason: 'observation_changed',
          ...(cutoffIndices.length > 0 ? { cutoffSteps: cutoffIndices.length, cutoffIndices } : {}),
        };
      }
    } catch (error) {
      return {
        status: 'diverged',
        matchedSteps: i,
        divergedAt: i,
        reason: entry.kind === 'mutate' ? 'mutation_not_applicable' : 'observation_changed',
        error: error instanceof Error ? error.message : String(error),
        ...(cutoffIndices.length > 0 ? { cutoffSteps: cutoffIndices.length, cutoffIndices } : {}),
      };
    }
  }
  return {
    status: 'matched',
    matchedSteps: observations.log.length,
    ...(cutoffIndices.length > 0 ? { cutoffSteps: cutoffIndices.length, cutoffIndices } : {}),
  };
}

/**
 * Strip single-line (`//`) and multi-line (`/* ... *\/`) comments while preserving string literals,
 * then collapse whitespace so comment-only or formatting-only edits produce an identical cutoff hash.
 * When `symbols` are provided, extracts brace-balanced blocks and statements referencing those symbols.
 */
export function computeSymbolSliceCutoffHash(source: string, symbols?: readonly string[]): string {
  const unnumbered = source
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\|/, ''))
    .join('\n');
  const uncommented = stripCommentsPreservingStrings(unnumbered);
  const lines = uncommented
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!symbols || symbols.length === 0) {
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  }

  const patterns = symbols.map((sym) => new RegExp(`\\b${escapeRegExp(sym)}\\b`));
  const relevant: string[] = [];
  let braceDepth = 0;
  let capturingBlock = false;
  let blockStartDepth = 0;

  for (const line of lines) {
    const matchesSymbol = patterns.some((re) => re.test(line));
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    if (matchesSymbol && !capturingBlock) {
      capturingBlock = true;
      blockStartDepth = braceDepth;
    }
    if (capturingBlock || matchesSymbol) {
      relevant.push(line.replace(/\s+/g, ' '));
    }
    braceDepth += openBraces - closeBraces;
    if (capturingBlock && braceDepth <= blockStartDepth) {
      capturingBlock = false;
    }
  }

  return crypto.createHash('sha256').update(relevant.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Compare two newline-delimited discovery outputs (e.g., `glob` file lists or `grep` match sets)
 * to determine whether the current workspace is a pure additive superset of the recorded observation.
 */
export function computeDiscoverySetCutoff(
  recordedOutput: string,
  currentOutput: string
): { isSuperset: boolean; unchanged: string[]; added: string[]; removed: string[] } {
  const toSet = (text: string) =>
    new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    );
  const recordedSet = toSet(recordedOutput);
  const currentSet = toSet(currentOutput);
  const unchanged = [...recordedSet].filter((item) => currentSet.has(item)).sort();
  const removed = [...recordedSet].filter((item) => !currentSet.has(item)).sort();
  const added = [...currentSet].filter((item) => !recordedSet.has(item)).sort();
  return {
    isSuperset: removed.length === 0 && unchanged.length === recordedSet.size,
    unchanged,
    added,
    removed,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCommentsPreservingStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i++;
        if (c === '\\' && i < source.length) {
          out += source[i];
          i++;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
