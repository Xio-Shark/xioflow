import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  raceAgentsInVirtualWorkspaces,
  runInVirtualWorkspace,
} from '../../src/gateway/virtual-workspace.js';

function initGitWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-vw-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@xioflow.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Xioflow Test'], { cwd: dir, stdio: 'ignore' });
  // Ignore .xioflow-kernel so kernel SQLite files in workspaceRoot (if any) do not dirty git tree
  fs.writeFileSync(path.join(dir, '.gitignore'), '.xioflow-kernel/\n');

  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('P3: Virtual Workspace Shadow Execution, Gate Deduplication & Multi-Agent Race OCC', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('isolates broken agent edits when --gate fails and atomically commits when --gate passes', async () => {
    const workspaceRoot = initGitWorkspace({
      'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
    });
    const domainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-vw-domain-'));
    tempDirs.push(workspaceRoot, domainDir);

    // 1. Agent writes broken code into its cwd (which is transparently redirected to shadow worktree)
    const badScript = path.join(domainDir, 'bad-agent.mjs');
    fs.writeFileSync(
      badScript,
      `
      import fs from 'node:fs';
      fs.writeFileSync('src/math.ts', 'export const add = (a, b) => a - b; // bug\\n');
      fs.writeFileSync('src/untracked-garbage.tmp', 'dirty');
      `
    );

    const rejected = await runInVirtualWorkspace({
      workspaceRoot,
      domainPath: path.join(domainDir, 'kernel'),
      command: process.execPath,
      args: [badScript],
      gateCommand: `node -e "import('./src/math.ts').then(m => process.exit(m.add(2, 3) === 5 ? 0 : 1))"`,
    });

    expect(rejected.status).toBe('gate_rejected');
    expect(rejected.gateResult?.passed).toBe(false);
    // Host workspace must have ZERO dirty modifications!
    expect(fs.readFileSync(path.join(workspaceRoot, 'src/math.ts'), 'utf8')).toBe(
      'export const add = (a: number, b: number) => a + b;\n'
    );
    expect(fs.existsSync(path.join(workspaceRoot, 'src/untracked-garbage.tmp'))).toBe(false);

    // 2. Agent writes valid code that passes the gate
    const goodScript = path.join(domainDir, 'good-agent.mjs');
    fs.writeFileSync(
      goodScript,
      `
      import fs from 'node:fs';
      fs.writeFileSync('src/math.ts', 'export const add = (a, b) => a + b;\\nexport const mul = (a, b) => a * b;\\n');
      `
    );

    const committed = await runInVirtualWorkspace({
      workspaceRoot,
      domainPath: path.join(domainDir, 'kernel'),
      command: process.execPath,
      args: [goodScript],
      gateCommand: `node -e "import('./src/math.ts').then(m => process.exit(m.add(2, 3) === 5 && m.mul(2, 3) === 6 ? 0 : 1))"`,
    });

    expect(committed.status).toBe('committed');
    expect(committed.gateResult?.passed).toBe(true);
    expect(fs.readFileSync(path.join(workspaceRoot, 'src/math.ts'), 'utf8')).toContain('export const mul');
  });

  it('deduplicates identical --gate executions across parallel shadow worktrees via treeCommandFingerprint', async () => {
    const workspaceRoot = initGitWorkspace({
      'src/index.js': 'export const value = 1;\n',
    });
    const domainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-vw-dedup-'));
    tempDirs.push(workspaceRoot, domainDir);

    const counterFile = path.join(domainDir, 'gate-counter.txt');
    fs.writeFileSync(counterFile, '0', 'utf8');

    // Two candidates produce the exact same file tree change in their separate shadow worktrees
    const agentScript = path.join(domainDir, 'identical-agent.mjs');
    fs.writeFileSync(
      agentScript,
      `
      import fs from 'node:fs';
      fs.writeFileSync('src/index.js', 'export const value = 42;\\n');
      `
    );

    const gateTrackerScript = path.join(domainDir, 'gate-tracker.mjs');
    fs.writeFileSync(
      gateTrackerScript,
      `
      import fs from 'node:fs';
      const count = Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) + 1;
      fs.writeFileSync(${JSON.stringify(counterFile)}, String(count), 'utf8');
      `
    );

    const raceRes = await raceAgentsInVirtualWorkspaces({
      workspaceRoot,
      domainPath: path.join(domainDir, 'kernel'),
      mode: 'winner',
      gateCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(gateTrackerScript)}`,
      candidates: [
        { id: 'cand-a', command: process.execPath, args: [agentScript] },
        { id: 'cand-b', command: process.execPath, args: [agentScript] },
      ],
    });

    expect(raceRes.committedCandidateIds).toEqual(['cand-a']);
    expect(raceRes.results[0].gateResult?.treeCommandFingerprint).toBe(
      raceRes.results[1].gateResult?.treeCommandFingerprint
    );
    expect(raceRes.gateExecutionsSaved).toBe(1);
    // Physical gate command only executed once across both shadow worktrees!
    expect(Number(fs.readFileSync(counterFile, 'utf8'))).toBe(1);
    expect(fs.readFileSync(path.join(workspaceRoot, 'src/index.js'), 'utf8')).toBe('export const value = 42;\n');
  });

  it('reconciles parallel candidates in xio race via OCC + Early Cutoff without re-running agents', async () => {
    const workspaceRoot = initGitWorkspace({
      'src/shared.ts': [
        'export function helperA(): number {',
        '  return 1;',
        '}',
        '',
        'export function helperB(): string {',
        '  return "stable-b";',
        '}',
        '',
      ].join('\n'),
    });
    const domainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-vw-race-'));
    tempDirs.push(workspaceRoot, domainDir);

    // Candidate 1 modifies helperA and adds comments to src/shared.ts (leaving helperB untouched),
    // and creates src/featureA.ts
    const cand1Script = path.join(domainDir, 'cand1.mjs');
    fs.writeFileSync(
      cand1Script,
      `
      import fs from 'node:fs';
      fs.writeFileSync('src/shared.ts', [
        '// Refactored by candidate 1',
        'export function helperA(): number {',
        '  return 100;',
        '}',
        '',
        'export function helperB(): string {',
        '  return "stable-b";',
        '}',
        '',
      ].join('\\n'));
      fs.writeFileSync('src/featureA.ts', 'import { helperA } from "./shared.js";\\nexport const a = helperA();\\n');
      `
    );

    // Candidate 2 reads src/shared.ts (creating a file-level read_write conflict with Candidate 1!),
    // but only depends on symbol `helperB`, and writes `src/featureB.ts`.
    const cand2Script = path.join(domainDir, 'cand2.mjs');
    fs.writeFileSync(
      cand2Script,
      `
      import fs from 'node:fs';
      const shared = fs.readFileSync('src/shared.ts', 'utf8');
      if (!shared.includes('helperB')) process.exit(1);
      fs.writeFileSync('src/featureB.ts', 'import { helperB } from "./shared.js";\\nexport const b = helperB();\\n');
      `
    );

    // Candidate 3 also reads src/shared.ts, but depends on `helperA` (which Candidate 1 mutated!),
    // and writes `src/featureC.ts`. It must be rejected by OCC observation validation!
    const cand3Script = path.join(domainDir, 'cand3.mjs');
    fs.writeFileSync(
      cand3Script,
      `
      import fs from 'node:fs';
      const shared = fs.readFileSync('src/shared.ts', 'utf8');
      if (!shared.includes('helperA')) process.exit(1);
      fs.writeFileSync('src/featureC.ts', 'import { helperA } from "./shared.js";\\nexport const c = helperA();\\n');
      `
    );

    const raceRes = await raceAgentsInVirtualWorkspaces({
      workspaceRoot,
      domainPath: path.join(domainDir, 'kernel'),
      mode: 'merge',
      gateCommand: 'true',
      candidates: [
        {
          id: 'cand-1',
          command: process.execPath,
          args: [cand1Script],
        },
        {
          id: 'cand-2',
          command: process.execPath,
          args: [cand2Script],
          symbolHints: { 'src/shared.ts': ['helperB'] },
        },
        {
          id: 'cand-3',
          command: process.execPath,
          args: [cand3Script],
          symbolHints: { 'src/shared.ts': ['helperA'] },
        },
      ],
    });

    // Candidate 1 and Candidate 2 both commit; Candidate 3 conflicts because helperA's AST slice changed!
    expect(raceRes.committedCandidateIds).toEqual(['cand-1', 'cand-2']);
    expect(raceRes.rejectedCandidateIds).toEqual([{ id: 'cand-3', reason: 'conflict' }]);

    const res2 = raceRes.results.find((r) => r.id === 'cand-2')!;
    expect(res2.status).toBe('committed');
    expect(res2.commitResult?.status).toBe('committed');
    if (res2.commitResult?.status === 'committed') {
      expect(res2.commitResult.validation).toBe('observations');
    }

    // Both featureA.ts and featureB.ts (and updated shared.ts) are in the host workspace, while featureC.ts is not
    expect(fs.existsSync(path.join(workspaceRoot, 'src/featureA.ts'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, 'src/featureB.ts'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, 'src/featureC.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(workspaceRoot, 'src/shared.ts'), 'utf8')).toContain('return 100;');
  });
});
