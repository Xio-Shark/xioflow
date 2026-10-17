import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { ProcessSupervisor } from '../supervisor/supervisor.js';
import { computeSymbolSliceCutoffHash } from '../workspace/observation-replay.js';
import { normalizeAccessTimes } from '../workspace/read-tracking.js';
import type {
  CommitResult,
  ObservationEntry,
  ObservationValidation,
  TransactionConflict,
  WriteEntry,
} from '../workspace/transactions.js';
import { resolveDriver, wrapAgent, WrapAgentOptions, WrapAgentResult } from './shell-shim.js';

export interface VirtualWorkspaceOptions extends Omit<WrapAgentOptions, 'cwd'> {
  workspaceRoot?: string;
  /** Optional verification gate command (e.g. `pnpm test` or `node --test`). Deduplicated by treeFingerprint. */
  gateCommand?: string;
  gateTimeoutMs?: number;
  /** Optional symbol hints per relative file path for Early Cutoff during OCC commit reconciliation. */
  symbolHints?: Record<string, string[]>;
  /** Existing baseSnapshotId to fork from (used by `xio race` so all candidates share an identical baseline). */
  baseSnapshotId?: string;
}

export interface VirtualWorkspaceResult {
  status: 'committed' | 'gate_rejected' | 'agent_failed' | 'conflict';
  txId: string;
  runId: string;
  baseSnapshotId: string;
  agentResult: WrapAgentResult;
  gateResult?: {
    passed: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    treeFingerprint: string;
    treeCommandFingerprint: string;
    deduplicated: boolean;
  };
  commitResult?: CommitResult;
  conflicts?: TransactionConflict[];
  writeSet: WriteEntry[];
  readSet: string[] | null;
}

export interface RaceCandidateSpec {
  id?: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  symbolHints?: Record<string, string[]>;
}

export interface RaceAgentsOptions {
  workspaceRoot?: string;
  domain?: ExecutionDomain;
  domainPath?: string;
  domainId?: string;
  candidates: RaceCandidateSpec[];
  gateCommand?: string;
  gateTimeoutMs?: number;
  /**
   * - `'winner'`: Commit the first candidate that passes the gate and abort the rest.
   * - `'merge'`: Reconcile and commit all gate-passing candidates in order using OCC + Early Cutoff.
   * Defaults to `'merge'`.
   */
  mode?: 'winner' | 'merge';
}

export interface RaceAgentsResult {
  baseSnapshotId: string;
  committedCandidateIds: string[];
  rejectedCandidateIds: Array<{ id: string; reason: VirtualWorkspaceResult['status'] }>;
  results: Array<{ id: string } & VirtualWorkspaceResult>;
  gateExecutionsSaved: number;
}

function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Build an `ObservationValidation` object for `commitWorkspaceTransaction` so that
 * `read_write` conflicts on shared files can be automatically resolved via Early Cutoff
 * (`computeSymbolSliceCutoffHash`) without re-running the agent.
 */
async function buildObservationValidationForShadowTx(params: {
  snapshotDriver: GitShadowSnapshotDriver;
  workspaceRoot: string;
  baseTreeFingerprint: string;
  forkRoot: string;
  readSet: string[] | null;
  writeSet: WriteEntry[];
  symbolHints?: Record<string, string[]>;
}): Promise<ObservationValidation | undefined> {
  const { snapshotDriver, workspaceRoot, baseTreeFingerprint, forkRoot, readSet, writeSet, symbolHints } = params;
  if (!readSet) return undefined;

  const fileReads = readSet.filter((p) => !p.endsWith('/') && p !== '.');
  const baseBlobs = await snapshotDriver.batchReadBlobs(workspaceRoot, baseTreeFingerprint, fileReads);

  // Snapshot the candidate's mutated files in memory before forkRoot is dematerialized or replayed
  const mutatedPayloads = new Map<
    string,
    { status: WriteEntry['status']; content?: Buffer; mode?: number; symlinkTarget?: string }
  >();
  for (const w of writeSet) {
    const abs = path.join(forkRoot, w.path);
    if (w.status === 'D' || !fs.existsSync(abs)) {
      mutatedPayloads.set(w.path, { status: 'D' });
      continue;
    }
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      mutatedPayloads.set(w.path, { status: w.status, symlinkTarget: fs.readlinkSync(abs) });
    } else {
      mutatedPayloads.set(w.path, {
        status: w.status,
        content: fs.readFileSync(abs),
        mode: st.mode & 0o777,
      });
    }
  }

  const log: ObservationEntry[] = [];
  for (const relPath of fileReads) {
    const baseText = baseBlobs.get(relPath);
    if (baseText === undefined) continue;
    const hints = symbolHints?.[relPath];
    const resultHash = sha256Hex(baseText).slice(0, 24);
    const cutoffHash = computeSymbolSliceCutoffHash(baseText, hints);
    log.push({
      kind: 'observe',
      call: { tool: 'read_file', args: { path: relPath, symbols: hints } },
      resultHash,
      cutoffHash,
    });
  }

  for (const w of writeSet) {
    const payload = mutatedPayloads.get(w.path);
    const hash = payload?.content ? sha256Hex(payload.content).slice(0, 24) : w.status;
    log.push({
      kind: 'mutate',
      call: { tool: 'write_file', args: { path: w.path, status: w.status } },
      resultHash: hash,
    });
  }

  return {
    log,
    closedWorld: true,
    async replay(entry, replayRoot) {
      if (entry.kind === 'observe') {
        const relPath = entry.call.args.path as string;
        const symbols = entry.call.args.symbols as string[] | undefined;
        const abs = path.join(replayRoot, relPath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return { resultHash: '__MISSING__', cutoffHash: '__MISSING__' };
        }
        const text = fs.readFileSync(abs, 'utf8');
        return {
          resultHash: sha256Hex(text).slice(0, 24),
          cutoffHash: computeSymbolSliceCutoffHash(text, symbols),
        };
      }
      // Apply mutation onto replayRoot
      const relPath = entry.call.args.path as string;
      const payload = mutatedPayloads.get(relPath);
      if (!payload) throw new Error(`Missing mutation payload for ${relPath}`);
      const dst = path.join(replayRoot, relPath);
      if (payload.status === 'D') {
        fs.rmSync(dst, { force: true });
        return { resultHash: 'D' };
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.rmSync(dst, { force: true });
      if (payload.symlinkTarget !== undefined) {
        fs.symlinkSync(payload.symlinkTarget, dst);
        return { resultHash: payload.status };
      }
      fs.writeFileSync(dst, payload.content!);
      if (payload.mode !== undefined) {
        fs.chmodSync(dst, payload.mode);
      }
      return { resultHash: sha256Hex(payload.content!).slice(0, 24) };
    },
  };
}

/**
 * Execute a wrapped agent inside an isolated Git shadow worktree transaction (`--shadow`),
 * optionally gated by `--gate "<cmd>"` (deduplicated via `executeWorkspaceCommand`),
 * and atomically commit its writeSet back to the host workspace only if both agent and gate succeed.
 */
export async function runInVirtualWorkspace(
  options: VirtualWorkspaceOptions,
  sharedSeenGateFingerprints?: Set<string>
): Promise<VirtualWorkspaceResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const ownsDomain = !options.domain;
  const domainPath = path.resolve(
    options.domain?.domainPath ?? options.domainPath ?? path.join(workspaceRoot, '.xioflow-kernel')
  );
  const domainId = options.domain?.domainId ?? options.domainId ?? 'default';
  const domain = options.domain ?? ExecutionDomain.acquire(domainPath, domainId);
  const driver = resolveDriver(options.driver ?? 'auto');
  const snapshotDriver = new GitShadowSnapshotDriver();
  const supervisor = new ProcessSupervisor(domain, driver, snapshotDriver);

  const runId = options.runId ?? `shadow-run-${crypto.randomUUID().slice(0, 8)}`;
  const txId = `tx-${runId}`;
  const store = domain.getStore();
  const taskId = 'shadow-task';
  if (!store.getTask(taskId)) {
    store.saveTask({
      id: taskId,
      domainId: domain.domainId,
      name: 'Virtual Workspace Task',
      createdAt: new Date().toISOString(),
    });
  }
  if (!store.getRun(runId)) {
    store.saveRun({
      id: runId,
      taskId,
      domainId: domain.domainId,
      owner: 'xio-shadow',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }

  const forkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-shadow-fork-'));
  const forkPath = path.join(forkParent, 'worktree');

  let txClosed = false;
  try {
    const tx = await supervisor.beginWorkspaceTransaction({
      txId,
      runId,
      root: workspaceRoot,
      forkPath,
      baseSnapshotId: options.baseSnapshotId,
    });

    const baseSnap = store.getSnapshot(tx.baseSnapshotId)!;

    // Run the wrapped agent with cwd set to tx.forkRoot!
    // Use an isolated sub-domain for the inner wrapAgent's tool process journal so that
    // tool executions inside tx.forkRoot do not taint `processInFork(tx)` in the outer transaction manager.
    const innerDomainPath = path.join(domainPath, 'shadow-runs', runId);
    const agentResult = await wrapAgent({
      ...options,
      cwd: tx.forkRoot,
      domain: undefined,
      domainPath: innerDomainPath,
      domainId: `${domainId}:${runId}`,
      runId,
    });

    const inspected = await supervisor.inspectWorkspaceTransaction(txId);

    if (agentResult.exitCode !== 0) {
      await supervisor.abortWorkspaceTransaction(txId, 'agent_failed');
      txClosed = true;
      domain.reportRunFailed(runId);
      return {
        status: 'agent_failed',
        txId,
        runId,
        baseSnapshotId: tx.baseSnapshotId,
        agentResult,
        writeSet: inspected.writeSet,
        readSet: inspected.readSet,
      };
    }

    let gateResult: VirtualWorkspaceResult['gateResult'];
    if (options.gateCommand) {
      const treeFingerprint = await snapshotDriver.fingerprint([tx.forkRoot], { against: baseSnap });
      const gateRes = await supervisor.executeWorkspaceCommand({
        runId,
        opIdPrefix: 'shadow-gate',
        name: `gate:${options.gateCommand}`,
        workspaceRoot: tx.forkRoot,
        treeFingerprint,
        command: {
          execPath: '/bin/sh',
          args: ['-c', options.gateCommand],
          cwd: tx.forkRoot,
          envWhiteList: { ...(process.env as Record<string, string>) },
        },
        timeoutMs: options.gateTimeoutMs ?? 30_000,
      });

      const deduplicated = sharedSeenGateFingerprints
        ? sharedSeenGateFingerprints.has(gateRes.treeCommandFingerprint)
        : false;
      sharedSeenGateFingerprints?.add(gateRes.treeCommandFingerprint);

      const passed = gateRes.status === 'succeeded' && gateRes.exitCode === 0;
      gateResult = {
        passed,
        exitCode: gateRes.status === 'indeterminate' ? 137 : gateRes.exitCode,
        stdout: gateRes.status === 'indeterminate' ? '' : gateRes.stdout,
        stderr: gateRes.status === 'indeterminate' ? gateRes.reason : gateRes.stderr,
        treeFingerprint: gateRes.treeFingerprint,
        treeCommandFingerprint: gateRes.treeCommandFingerprint,
        deduplicated,
      };

      if (!passed) {
        await supervisor.abortWorkspaceTransaction(txId, 'gate_rejected');
        txClosed = true;
        domain.reportRunFailed(runId);
        return {
          status: 'gate_rejected',
          txId,
          runId,
          baseSnapshotId: tx.baseSnapshotId,
          agentResult,
          gateResult,
          writeSet: inspected.writeSet,
          readSet: inspected.readSet,
        };
      }
    }

    const observations = await buildObservationValidationForShadowTx({
      snapshotDriver,
      workspaceRoot,
      baseTreeFingerprint: baseSnap.treeFingerprint,
      forkRoot: tx.forkRoot,
      readSet: inspected.readSet,
      writeSet: inspected.writeSet,
      symbolHints: options.symbolHints,
    });
    normalizeAccessTimes(tx.forkRoot);

    const commitResult = await supervisor.commitWorkspaceTransaction(
      txId,
      observations ? { observations } : undefined
    );
    txClosed = commitResult.status === 'committed';

    if (commitResult.status === 'conflict') {
      await supervisor.abortWorkspaceTransaction(txId, 'conflict');
      txClosed = true;
      domain.reportRunFailed(runId);
      return {
        status: 'conflict',
        txId,
        runId,
        baseSnapshotId: tx.baseSnapshotId,
        agentResult,
        gateResult,
        commitResult,
        conflicts: commitResult.conflicts,
        writeSet: inspected.writeSet,
        readSet: inspected.readSet,
      };
    }

    domain.reportRunSucceeded(runId);
    return {
      status: 'committed',
      txId,
      runId,
      baseSnapshotId: tx.baseSnapshotId,
      agentResult,
      gateResult,
      commitResult,
      writeSet: commitResult.writeSet,
      readSet: commitResult.readSet,
    };
  } finally {
    if (!txClosed) {
      try {
        await supervisor.abortWorkspaceTransaction(txId, 'unhandled_abort');
      } catch {}
    }
    fs.rmSync(forkParent, { recursive: true, force: true });
    if (ownsDomain) {
      domain.close();
    }
  }
}

/**
 * Multi-agent speculative execution & reconciliation (`xio race`):
 * Captures a single shared base snapshot of `workspaceRoot`, runs all candidates in parallel
 * isolated shadow worktrees, evaluates `--gate` (deduplicating identical tree states via `treeFingerprint`),
 * and reconciles passing candidates onto the host workspace via OCC + Early Cutoff.
 */
export async function raceAgentsInVirtualWorkspaces(options: RaceAgentsOptions): Promise<RaceAgentsResult> {
  if (options.candidates.length === 0) {
    throw new Error('raceAgentsInVirtualWorkspaces requires at least one candidate');
  }
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const ownsDomain = !options.domain;
  const domainPath = path.resolve(
    options.domain?.domainPath ?? options.domainPath ?? path.join(workspaceRoot, '.xioflow-kernel')
  );
  const domainId = options.domain?.domainId ?? options.domainId ?? 'default';
  const domain = options.domain ?? ExecutionDomain.acquire(domainPath, domainId);
  const driver = resolveDriver('auto');
  const snapshotDriver = new GitShadowSnapshotDriver();
  const supervisor = new ProcessSupervisor(domain, driver, snapshotDriver);
  const mode = options.mode ?? 'merge';

  const coordRunId = `race-coord-${crypto.randomUUID().slice(0, 8)}`;
  const store = domain.getStore();
  const taskId = 'shadow-task';
  if (!store.getTask(taskId)) {
    store.saveTask({
      id: taskId,
      domainId: domain.domainId,
      name: 'Virtual Workspace Task',
      createdAt: new Date().toISOString(),
    });
  }
  store.saveRun({
    id: coordRunId,
    taskId,
    domainId: domain.domainId,
    owner: 'xio-race',
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  try {
    // 1. Capture one shared baseline snapshot before any candidate starts
    const baseSnapRes = await supervisor.captureSnapshot({
      runId: coordRunId,
      opId: `${coordRunId}-base-snap`,
      roots: [workspaceRoot],
    });
    if (baseSnapRes.status !== 'succeeded' || !baseSnapRes.snapshot) {
      throw new Error(`Failed to capture race baseline snapshot: ${baseSnapRes.errorMessage ?? baseSnapRes.status}`);
    }
    const baseSnapshotId = baseSnapRes.snapshot.id;
    const baseTreeFingerprint = baseSnapRes.snapshot.treeFingerprint;

    // 2. Open all candidate shadow transactions against `baseSnapshotId` upfront
    const prepared = await Promise.all(
      options.candidates.map(async (cand, idx) => {
        const id = cand.id ?? `candidate-${idx + 1}`;
        const runId = `${coordRunId}-${id}`;
        const txId = `tx-${runId}`;
        store.saveRun({
          id: runId,
          taskId,
          domainId: domain.domainId,
          owner: 'xio-race',
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        const forkParent = fs.mkdtempSync(path.join(os.tmpdir(), `xio-race-${id}-`));
        const forkPath = path.join(forkParent, 'worktree');
        const tx = await supervisor.beginWorkspaceTransaction({
          txId,
          runId,
          root: workspaceRoot,
          forkPath,
          baseSnapshotId,
        });
        return { id, cand, runId, txId, forkParent, tx };
      })
    );

    const seenGateFingerprints = new Set<string>();
    let gateExecutionsSaved = 0;

    // 3. Execute all candidate agents in parallel inside their respective shadow worktrees
    const executed = await Promise.all(
      prepared.map(async (item) => {
        const innerDomainPath = path.join(domainPath, 'race-runs', item.runId);
        const agentResult = await wrapAgent({
          command: item.cand.command,
          args: item.cand.args,
          env: item.cand.env,
          cwd: item.tx.forkRoot,
          domainPath: innerDomainPath,
          domainId: `${domainId}:${item.runId}`,
          runId: item.runId,
        });
        const inspected = await supervisor.inspectWorkspaceTransaction(item.txId);

        let gateResult: VirtualWorkspaceResult['gateResult'];
        if (agentResult.exitCode === 0 && options.gateCommand) {
          const treeFingerprint = await snapshotDriver.fingerprint([item.tx.forkRoot], {
            against: baseSnapRes.snapshot!,
          });
          const gateRes = await supervisor.executeWorkspaceCommand({
            runId: coordRunId,
            opIdPrefix: 'race-gate',
            name: `gate:${options.gateCommand}`,
            workspaceRoot: item.tx.forkRoot,
            treeFingerprint,
            command: {
              execPath: '/bin/sh',
              args: ['-c', options.gateCommand],
              cwd: item.tx.forkRoot,
              envWhiteList: { ...(process.env as Record<string, string>) },
            },
            timeoutMs: options.gateTimeoutMs ?? 30_000,
          });
          const deduplicated = seenGateFingerprints.has(gateRes.treeCommandFingerprint);
          if (deduplicated) gateExecutionsSaved++;
          seenGateFingerprints.add(gateRes.treeCommandFingerprint);

          const passed = gateRes.status === 'succeeded' && gateRes.exitCode === 0;
          gateResult = {
            passed,
            exitCode: gateRes.status === 'indeterminate' ? 137 : gateRes.exitCode,
            stdout: gateRes.status === 'indeterminate' ? '' : gateRes.stdout,
            stderr: gateRes.status === 'indeterminate' ? gateRes.reason : gateRes.stderr,
            treeFingerprint: gateRes.treeFingerprint,
            treeCommandFingerprint: gateRes.treeCommandFingerprint,
            deduplicated,
          };
        }

        return { ...item, agentResult, inspected, gateResult };
      })
    );

    // 4. Reconcile & commit passing candidates in deterministic order
    const committedCandidateIds: string[] = [];
    const rejectedCandidateIds: Array<{ id: string; reason: VirtualWorkspaceResult['status'] }> = [];
    const results: Array<{ id: string } & VirtualWorkspaceResult> = [];

    for (const item of executed) {
      try {
        if (item.agentResult.exitCode !== 0) {
          await supervisor.abortWorkspaceTransaction(item.txId, 'agent_failed');
          domain.reportRunFailed(item.runId);
          rejectedCandidateIds.push({ id: item.id, reason: 'agent_failed' });
          results.push({
            id: item.id,
            status: 'agent_failed',
            txId: item.txId,
            runId: item.runId,
            baseSnapshotId,
            agentResult: item.agentResult,
            writeSet: item.inspected.writeSet,
            readSet: item.inspected.readSet,
          });
          continue;
        }

        if (item.gateResult && !item.gateResult.passed) {
          await supervisor.abortWorkspaceTransaction(item.txId, 'gate_rejected');
          domain.reportRunFailed(item.runId);
          rejectedCandidateIds.push({ id: item.id, reason: 'gate_rejected' });
          results.push({
            id: item.id,
            status: 'gate_rejected',
            txId: item.txId,
            runId: item.runId,
            baseSnapshotId,
            agentResult: item.agentResult,
            gateResult: item.gateResult,
            writeSet: item.inspected.writeSet,
            readSet: item.inspected.readSet,
          });
          continue;
        }

        if (mode === 'winner' && committedCandidateIds.length >= 1) {
          await supervisor.abortWorkspaceTransaction(item.txId, 'race_loser');
          domain.reportRunFailed(item.runId);
          rejectedCandidateIds.push({ id: item.id, reason: 'conflict' });
          results.push({
            id: item.id,
            status: 'conflict',
            txId: item.txId,
            runId: item.runId,
            baseSnapshotId,
            agentResult: item.agentResult,
            gateResult: item.gateResult,
            writeSet: item.inspected.writeSet,
            readSet: item.inspected.readSet,
          });
          continue;
        }

        const observations = await buildObservationValidationForShadowTx({
          snapshotDriver,
          workspaceRoot,
          baseTreeFingerprint,
          forkRoot: item.tx.forkRoot,
          readSet: item.inspected.readSet,
          writeSet: item.inspected.writeSet,
          symbolHints: item.cand.symbolHints,
        });
        normalizeAccessTimes(item.tx.forkRoot);

        const commitResult = await supervisor.commitWorkspaceTransaction(
          item.txId,
          observations ? { observations } : undefined
        );

        if (commitResult.status === 'conflict') {
          await supervisor.abortWorkspaceTransaction(item.txId, 'conflict');
          domain.reportRunFailed(item.runId);
          rejectedCandidateIds.push({ id: item.id, reason: 'conflict' });
          results.push({
            id: item.id,
            status: 'conflict',
            txId: item.txId,
            runId: item.runId,
            baseSnapshotId,
            agentResult: item.agentResult,
            gateResult: item.gateResult,
            commitResult,
            conflicts: commitResult.conflicts,
            writeSet: item.inspected.writeSet,
            readSet: item.inspected.readSet,
          });
          continue;
        }

        domain.reportRunSucceeded(item.runId);
        committedCandidateIds.push(item.id);
        results.push({
          id: item.id,
          status: 'committed',
          txId: item.txId,
          runId: item.runId,
          baseSnapshotId,
          agentResult: item.agentResult,
          gateResult: item.gateResult,
          commitResult,
          writeSet: commitResult.writeSet,
          readSet: commitResult.readSet,
        });
      } finally {
        fs.rmSync(item.forkParent, { recursive: true, force: true });
      }
    }

    domain.reportRunSucceeded(coordRunId);
    return {
      baseSnapshotId,
      committedCandidateIds,
      rejectedCandidateIds,
      results,
      gateExecutionsSaved,
    };
  } finally {
    if (ownsDomain) {
      domain.close();
    }
  }
}
