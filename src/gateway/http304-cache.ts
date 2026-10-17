import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionDomain } from '../domain.js';
import { WorkspaceCausalGraph } from '../workspace/causal-graph.js';
import { computeDiscoverySetCutoff, computeSymbolSliceCutoffHash } from '../workspace/observation-replay.js';
import type {
  Http304CacheAdapter,
  Http304LookupResult,
  ParsedWireRequest,
  RecordedGatewayTurn,
} from './wire-proxy.js';

export interface FileObservationStamp {
  relPath: string;
  rawHash: string;
  cutoffHash: string;
  symbols?: string[];
  /** Snapshot of file content (up to 16 KiB) for generating stale-read diff notices on cache miss. */
  excerpt?: string;
}

export interface DiscoveryStamp {
  callId?: string;
  command: string;
  recordedOutput: string;
}

export interface CachedTurnEntry {
  turnIndex: number;
  wire: RecordedGatewayTurn['wire'];
  model: string;
  prefixDigest: string;
  etag: string;
  readStamps: FileObservationStamp[];
  discoveryStamps: DiscoveryStamp[];
  causalNodeSeq?: number;
  turn: RecordedGatewayTurn;
}

export interface Http304CacheOptions {
  domain?: ExecutionDomain;
  domainPath?: string;
  workspaceRoot?: string;
  /** Optional symbol hints per relative file path for fine-grained AST/symbol-slice Early Cutoff. */
  symbolHints?: Record<string, string[]>;
}

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeRelPath(workspaceRoot: string, candidate: string): string | undefined {
  const trimmed = candidate.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || trimmed.startsWith('-') || trimmed.includes('\0')) return undefined;
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workspaceRoot, trimmed);
  const rel = path.relative(workspaceRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('.git') || rel.startsWith('.xioflow')) {
    return undefined;
  }
  return rel.split(path.sep).join('/');
}

/**
 * Extract candidate workspace file paths and symbol names from tool call arguments and shell commands.
 */
export function extractFilesAndSymbolsFromRequest(
  parsed: ParsedWireRequest,
  workspaceRoot: string
): { files: Set<string>; symbolsByFile: Map<string, Set<string>> } {
  const files = new Set<string>();
  const symbolsByFile = new Map<string, Set<string>>();

  const addFile = (rawPath: string, symbols?: string[]) => {
    const rel = normalizeRelPath(workspaceRoot, rawPath);
    if (!rel) return;
    const abs = path.join(workspaceRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.add(rel);
      if (symbols && symbols.length > 0) {
        const set = symbolsByFile.get(rel) ?? new Set<string>();
        for (const s of symbols) if (s) set.add(s);
        symbolsByFile.set(rel, set);
      }
    }
  };

  for (const tc of parsed.toolCalls) {
    const args = tc.args ?? {};
    const explicitSymbols: string[] = [];
    if (typeof args.symbol === 'string') explicitSymbols.push(args.symbol);
    if (Array.isArray(args.symbols)) {
      for (const s of args.symbols) if (typeof s === 'string') explicitSymbols.push(s);
    }

    for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file', 'filename']) {
      const val = args[key];
      if (typeof val === 'string') {
        addFile(val, explicitSymbols);
      }
    }

    const cmd = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : undefined;
    if (cmd) {
      // Extract potential file tokens from shell command
      const tokens = cmd.split(/[\s;|&><()"'`]+/).filter(Boolean);
      for (const tok of tokens) {
        if (tok.includes('.') || tok.includes('/')) {
          addFile(tok, explicitSymbols);
        }
      }
    }
  }

  return { files, symbolsByFile };
}

function computeFileStamp(
  workspaceRoot: string,
  relPath: string,
  symbols?: string[]
): FileObservationStamp {
  const abs = path.join(workspaceRoot, relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return {
      relPath,
      rawHash: '__MISSING__',
      cutoffHash: '__MISSING__',
      symbols,
    };
  }
  const buf = fs.readFileSync(abs);
  const rawHash = sha256Hex(buf).slice(0, 24);
  const text = buf.toString('utf8');
  const cutoffHash = computeSymbolSliceCutoffHash(text, symbols);
  return {
    relPath,
    rawHash,
    cutoffHash,
    symbols: symbols && symbols.length > 0 ? symbols : undefined,
    excerpt: text.slice(0, 16384),
  };
}

function buildCompactLineDiff(oldText: string | undefined, newText: string, relPath: string): string {
  if (oldText === undefined) {
    return `[xioflow: context stale — ${relPath} was modified externally]`;
  }
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const removed: string[] = [];
  const added: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o !== n) {
      if (o !== undefined) removed.push(`- L${i + 1}: ${o.trim()}`);
      if (n !== undefined) added.push(`+ L${i + 1}: ${n.trim()}`);
    }
    if (removed.length + added.length >= 8) break;
  }
  const diffPreview = [...removed.slice(0, 4), ...added.slice(0, 4)].join('\n');
  return `[xioflow: context stale — "${relPath}" changed since earlier observation:\n${diffPreview}\n]`;
}

/**
 * Normalize a conversation array for prefix hashing by stripping earlier injected notices
 * so that prefix digests stay stable across retries.
 */
function normalizeConversationForDigest(conversation: unknown[]): string {
  const raw = JSON.stringify(conversation);
  const cleaned = raw.replace(/\\n\\n\[xioflow: [^\]]*\]/g, '');
  return sha256Hex(cleaned).slice(0, 32);
}

export class Http304CausalCache implements Http304CacheAdapter {
  private readonly cacheFilePath?: string;
  private readonly causalGraph?: WorkspaceCausalGraph;
  private readonly txId: string;
  private entries: CachedTurnEntry[] = [];
  private readonly observedFiles = new Map<string, Set<string>>(); // relPath -> symbols
  private readonly pendingDiscoveries: Array<{
    turnIndex: number;
    callId?: string;
    command: string;
    output: string;
  }> = [];
  private lastCausalSeq?: number;
  private readonly symbolHints: Record<string, string[]>;

  constructor(private readonly options: Http304CacheOptions = {}) {
    const domainPath = options.domain?.domainPath ?? options.domainPath;
    if (domainPath) {
      fs.mkdirSync(domainPath, { recursive: true });
      this.cacheFilePath = path.join(domainPath, 'http304-cache.json');
      this.loadFromDisk();
    }
    if (options.domain) {
      this.causalGraph = new WorkspaceCausalGraph(options.domain);
    }
    this.txId = `gateway:${options.domain?.domainId ?? 'default'}`;
    this.symbolHints = options.symbolHints ?? {};
  }

  private loadFromDisk(): void {
    if (!this.cacheFilePath || !fs.existsSync(this.cacheFilePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf8'));
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries;
      }
    } catch {}
  }

  private saveToDisk(): void {
    if (!this.cacheFilePath) return;
    try {
      fs.writeFileSync(this.cacheFilePath, JSON.stringify({ entries: this.entries }, null, 2));
    } catch {}
  }

  public getEntries(): readonly CachedTurnEntry[] {
    return this.entries;
  }

  public getCausalGraph(): WorkspaceCausalGraph | undefined {
    return this.causalGraph;
  }

  public recordToolExecution(params: {
    turnIndex: number;
    callId?: string;
    command: string;
    readFiles: string[];
    writeFiles: string[];
    output: string;
  }): void {
    for (const rel of params.readFiles) {
      const normalized = rel.split(path.sep).join('/');
      if (!this.observedFiles.has(normalized)) {
        this.observedFiles.set(normalized, new Set(this.symbolHints[normalized] ?? []));
      }
    }
    // Check if command is a file discovery command (ls, find, rg --files, git ls-files)
    const isDiscovery = /^\s*(ls|find|rg\s+--files|git\s+ls-files)\b/.test(params.command);
    if (isDiscovery) {
      this.pendingDiscoveries.push({
        turnIndex: params.turnIndex,
        callId: params.callId,
        command: params.command,
        output: params.output,
      });
    }
    // Also attach newly discovered readFiles to the turn entry that spawned this tool call
    const entry = this.entries.find((e) => e.turnIndex === params.turnIndex);
    if (entry) {
      if (this.options.workspaceRoot) {
        for (const rel of params.readFiles) {
          const normalized = rel.split(path.sep).join('/');
          if (!entry.readStamps.some((s) => s.relPath === normalized)) {
            const syms = [...(this.observedFiles.get(normalized) ?? [])];
            entry.readStamps.push(computeFileStamp(this.options.workspaceRoot, normalized, syms));
          }
        }
        entry.etag = this.computeEtag(entry.prefixDigest, entry.readStamps);
      }
      if (isDiscovery && !entry.discoveryStamps.some((d) => d.command === params.command)) {
        entry.discoveryStamps.push({
          callId: params.callId,
          command: params.command,
          recordedOutput: params.output,
        });
      }
      this.saveToDisk();
    }
  }

  private computeEtag(prefixDigest: string, stamps: FileObservationStamp[]): string {
    const sorted = [...stamps].sort((a, b) => a.relPath.localeCompare(b.relPath));
    const rawPart = sorted.map((s) => `${s.relPath}:${s.rawHash}`).join('|');
    const hash = sha256Hex(`${prefixDigest}::${rawPart}`).slice(0, 20);
    return `W/"xio-${hash}"`;
  }

  public async lookup(params: {
    turnIndex: number;
    parsed: ParsedWireRequest;
    body: any;
    workspaceRoot: string;
  }): Promise<Http304LookupResult> {
    const { turnIndex, parsed, workspaceRoot } = params;
    const extracted = extractFilesAndSymbolsFromRequest(parsed, workspaceRoot);
    for (const [rel, syms] of extracted.symbolsByFile.entries()) {
      const set = this.observedFiles.get(rel) ?? new Set<string>(this.symbolHints[rel] ?? []);
      for (const s of syms) set.add(s);
      this.observedFiles.set(rel, set);
    }
    for (const rel of extracted.files) {
      if (!this.observedFiles.has(rel)) {
        this.observedFiles.set(rel, new Set<string>(this.symbolHints[rel] ?? []));
      }
    }

    const prefixDigest = normalizeConversationForDigest(parsed.conversation);
    const toolCallsSig = (tcs: ParsedWireRequest['toolCalls']) =>
      JSON.stringify(tcs.map((c) => ({ id: c.id, name: c.name, args: c.args })));
    const currentSig = toolCallsSig(parsed.toolCalls);
    const candidate =
      this.entries.find(
        (e) => e.wire === parsed.wire && e.turnIndex === turnIndex && e.prefixDigest === prefixDigest
      ) ??
      this.entries.find((e) => e.wire === parsed.wire && e.prefixDigest === prefixDigest) ??
      (parsed.toolCalls.length > 0
        ? this.entries.find(
            (e) =>
              e.wire === parsed.wire &&
              e.turnIndex === turnIndex &&
              e.readStamps.length > 0 &&
              toolCallsSig(e.turn.parsedRequest.toolCalls) === currentSig
          )
        : undefined);

    if (!candidate) {
      // Even when there is no exact turn match, check if any previously observed files in this session drifted
      const staleNotices = this.collectStaleReadNotices(workspaceRoot);
      return {
        hit: false,
        etag: `W/"xio-miss-${prefixDigest.slice(0, 12)}"`,
        staleNotice: staleNotices.length > 0 ? staleNotices.join('\n') : undefined,
      };
    }

    let cutoffUsed = false;
    const staleNotices: string[] = [];

    for (const recorded of candidate.readStamps) {
      const hintSyms = this.symbolHints[recorded.relPath] ?? recorded.symbols;
      const current = computeFileStamp(workspaceRoot, recorded.relPath, hintSyms);
      if (current.rawHash === recorded.rawHash) {
        continue;
      }
      // Physical hash drifted -> check Early Cutoff (comment/whitespace/unrelated-symbol invariance)
      const recordedCutoff =
        hintSyms && recorded.excerpt !== undefined
          ? computeSymbolSliceCutoffHash(recorded.excerpt, hintSyms)
          : recorded.cutoffHash;
      if (current.cutoffHash !== '__MISSING__' && current.cutoffHash === recordedCutoff) {
        cutoffUsed = true;
        continue;
      }
      // Semantic change detected -> Stale Read!
      const abs = path.join(workspaceRoot, recorded.relPath);
      const currentText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      staleNotices.push(buildCompactLineDiff(recorded.excerpt, currentText, recorded.relPath));
    }

    if (staleNotices.length > 0) {
      return {
        hit: false,
        etag: candidate.etag,
        staleNotice: staleNotices.join('\n'),
      };
    }

    // Check discovery stamps for additive superset delta
    const deltaNotices: string[] = [];
    for (const disc of candidate.discoveryStamps) {
      const latest = [...this.pendingDiscoveries].reverse().find((d) => d.command === disc.command);
      if (latest && latest.output !== disc.recordedOutput) {
        const cmp = computeDiscoverySetCutoff(disc.recordedOutput, latest.output);
        if (!cmp.isSuperset) {
          return {
            hit: false,
            etag: candidate.etag,
            staleNotice: `[xioflow: discovery set changed — removed entries: ${cmp.removed.join(', ')}]`,
          };
        }
        if (cmp.added.length > 0) {
          cutoffUsed = true;
          deltaNotices.push(
            `[xioflow: additive workspace discovery delta — new files added since cached turn: ${cmp.added.join(', ')}]`
          );
        }
      }
    }

    return {
      hit: true,
      etag: cutoffUsed ? `${candidate.etag.slice(0, -1)}-cutoff"` : candidate.etag,
      cutoffUsed,
      cachedTurn: candidate.turn,
      deltaNotice: deltaNotices.length > 0 ? deltaNotices.join('\n') : undefined,
    };
  }

  private collectStaleReadNotices(workspaceRoot: string): string[] {
    const notices: string[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      for (const stamp of entry.readStamps) {
        if (seen.has(stamp.relPath)) continue;
        seen.add(stamp.relPath);
        const hintSyms = this.symbolHints[stamp.relPath] ?? stamp.symbols;
        const current = computeFileStamp(workspaceRoot, stamp.relPath, hintSyms);
        if (current.rawHash !== stamp.rawHash && current.cutoffHash !== stamp.cutoffHash) {
          const abs = path.join(workspaceRoot, stamp.relPath);
          const currentText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
          notices.push(buildCompactLineDiff(stamp.excerpt, currentText, stamp.relPath));
        }
      }
    }
    return notices;
  }

  public async recordTurn(turn: RecordedGatewayTurn, workspaceRoot: string): Promise<{ etag: string }> {
    const extracted = extractFilesAndSymbolsFromRequest(turn.parsedRequest, workspaceRoot);
    for (const [rel, syms] of extracted.symbolsByFile.entries()) {
      const set = this.observedFiles.get(rel) ?? new Set<string>(this.symbolHints[rel] ?? []);
      for (const s of syms) set.add(s);
      this.observedFiles.set(rel, set);
    }
    for (const rel of [...extracted.files, ...turn.readFiles]) {
      const normalized = rel.split(path.sep).join('/');
      if (!this.observedFiles.has(normalized)) {
        this.observedFiles.set(normalized, new Set<string>(this.symbolHints[normalized] ?? []));
      }
    }

    // Also inspect outgoing toolCalls in this turn's response so any file target is stamped immediately
    for (const tc of turn.parsedResponse.toolCalls) {
      const args = tc.args ?? {};
      for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file', 'filename']) {
        const val = args[key];
        if (typeof val === 'string') {
          const rel = normalizeRelPath(workspaceRoot, val);
          if (rel && !this.observedFiles.has(rel)) {
            this.observedFiles.set(rel, new Set<string>(this.symbolHints[rel] ?? []));
          }
        }
      }
      const cmd = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : undefined;
      if (cmd) {
        for (const tok of cmd.split(/[\s;|&><()"'`]+/).filter(Boolean)) {
          if (tok.includes('.') || tok.includes('/')) {
            const rel = normalizeRelPath(workspaceRoot, tok);
            if (rel && !this.observedFiles.has(rel)) {
              this.observedFiles.set(rel, new Set<string>(this.symbolHints[rel] ?? []));
            }
          }
        }
      }
    }

    const readStamps: FileObservationStamp[] = [];
    for (const [rel, syms] of this.observedFiles.entries()) {
      readStamps.push(computeFileStamp(workspaceRoot, rel, [...syms]));
    }

    const prefixDigest = normalizeConversationForDigest(turn.parsedRequest.conversation);
    const etag = this.computeEtag(prefixDigest, readStamps);

    let causalNodeSeq: number | undefined;
    if (this.causalGraph) {
      try {
        const node = this.causalGraph.record({
          txId: this.txId,
          actorId: `gateway:${turn.wire}`,
          observation: {
            kind: 'observe',
            call: { tool: `turn:${turn.turnIndex}`, args: { paths: readStamps.map((s) => s.relPath) } },
            resultHash: etag,
            cutoffHash: sha256Hex(readStamps.map((s) => `${s.relPath}:${s.cutoffHash}`).join('|')).slice(0, 16),
          },
          dependsOn: this.lastCausalSeq !== undefined ? [this.lastCausalSeq] : [],
        });
        causalNodeSeq = node.seq;
        this.lastCausalSeq = node.seq;
      } catch {}
    }

    const discoveryStamps = this.pendingDiscoveries
      .filter((d) => d.turnIndex <= turn.turnIndex)
      .map((d) => ({
        callId: d.callId,
        command: d.command,
        recordedOutput: d.output,
      }));

    const existingIdx = this.entries.findIndex(
      (e) => e.wire === turn.wire && e.turnIndex === turn.turnIndex && e.prefixDigest === prefixDigest
    );
    const entry: CachedTurnEntry = {
      turnIndex: turn.turnIndex,
      wire: turn.wire,
      model: turn.model,
      prefixDigest,
      etag,
      readStamps,
      discoveryStamps,
      causalNodeSeq,
      turn: {
        ...turn,
        etag,
      },
    };
    if (existingIdx >= 0) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.push(entry);
    }
    this.saveToDisk();
    return { etag };
  }
}
