import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelMedium } from '../../src/kernel/medium.js';
import {
  createSurfaceDispatcher,
  GOLDEN_SURFACE_SCHEMAS,
  SurfaceValidationError,
  toAnthropicTools,
  toGeminiTools,
  toMcpTools,
  toOpenAiTools,
} from '../../src/surface/index.js';

describe('4 Golden LLM Surface Primitives (run / edit / inspect / branch)', () => {
  let tmpDir: string;
  let wsDir: string;
  let medium: KernelMedium;

  beforeEach(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-surface-')));
    wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: wsDir });
    execFileSync('git', ['config', 'user.email', 'test@xioflow.local'], { cwd: wsDir });
    execFileSync('git', ['config', 'user.name', 'Xio Test'], { cwd: wsDir });
    fs.writeFileSync(
      path.join(wsDir, 'math.ts'),
      ['export function add(a: number, b: number) {', '  return a + b;', '}', '', 'export function mul(a: number, b: number) {', '  return a * b;', '}', ''].join('\n'),
    );
    execFileSync('git', ['add', '.'], { cwd: wsDir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: wsDir });

    medium = await KernelMedium.open(wsDir, {
      domainPath: path.join(tmpDir, 'domain'),
    });
  });

  afterEach(async () => {
    await medium.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports strict schemas across MCP, OpenAI, Anthropic, and Gemini tool formats', () => {
    expect(GOLDEN_SURFACE_SCHEMAS.map((s) => s.name)).toEqual(['run', 'edit', 'inspect', 'branch']);

    const mcp = toMcpTools();
    expect(mcp).toHaveLength(4);
    expect(mcp.every((t) => t.inputSchema.additionalProperties === false)).toBe(true);

    const oai = toOpenAiTools();
    expect(oai).toHaveLength(4);
    expect(oai[0]).toMatchObject({ type: 'function', function: { name: 'run' } });

    const anthropic = toAnthropicTools();
    expect(anthropic).toHaveLength(4);
    expect(anthropic[1]).toMatchObject({ name: 'edit', input_schema: { type: 'object' } });

    const gemini = toGeminiTools();
    expect(gemini[0]?.functionDeclarations.map((f) => f.name)).toEqual(['run', 'edit', 'inspect', 'branch']);
  });

  it('dispatches inspect -> edit (with gate rollback & Early Cutoff) -> run -> branch end to end', async () => {
    const surface = createSurfaceDispatcher(medium);

    // 1. inspect slice with symbol registration for Early Cutoff
    const slice = await surface.call('inspect', { target: 'math.ts', symbols: ['add'] }, 'agent-1');
    expect(slice.content).toContain('1|export function add');
    expect(typeof slice.rev).toBe('string');

    // External modification only to `mul` triggers Early Cutoff (zero staleRead noise on `add`!)
    fs.writeFileSync(
      path.join(wsDir, 'math.ts'),
      ['export function add(a: number, b: number) {', '  return a + b;', '}', '', 'export function mul(a: number, b: number) {', '  return a * b * 1;', '}', ''].join('\n'),
    );
    const obs = await surface.call('inspect', { mode: 'status' }, 'agent-1');
    expect(obs.staleReads).toEqual([]);
    expect((obs.sessionStats as any).earlyCutoffHits).toBe(1);

    // 2. edit with failing gateCmd rolls back atomically
    const badEdit = await surface.call(
      'edit',
      {
        path: 'math.ts',
        oldText: 'return a + b;',
        newText: 'return a - b;',
        gateCmd: 'exit 2',
      },
      'agent-1',
    );
    expect(badEdit.status).toBe('rolled_back');
    expect(fs.readFileSync(path.join(wsDir, 'math.ts'), 'utf8')).toContain('return a + b;');

    // 3. edit with passing gateCmd commits cleanly
    const goodEdit = await surface.call(
      'edit',
      {
        path: 'math.ts',
        oldText: 'return a + b;',
        newText: 'return a + b + 0;',
        gateCmd: 'grep -q "a + b + 0" math.ts',
      },
      'agent-1',
    );
    expect(goodEdit.status).toBe('committed');

    // 4. run with early crash short-circuits waitHttpUrl in milliseconds instead of polling timeout
    const t0 = Date.now();
    const crashSrv = await surface.call(
      'run',
      {
        cmd: `${JSON.stringify(process.execPath)} -e "console.error('EADDRINUSE_FAKE'); process.exit(1)"`,
        waitHttpUrl: 'http://127.0.0.1:65431/health',
        timeoutMs: 10_000,
      },
      'agent-1',
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect((crashSrv.waitOutcome as any)?.status).toBe('process_exited_early');

    // 5. branch dry-run (`commit: false`) leaves workspace untouched
    const dryBranch = await surface.call(
      'branch',
      {
        mutations: [{ kind: 'write', path: 'experiment.txt', content: 'try-1\n' }],
        cmd: 'cat experiment.txt',
        commit: false,
      },
      'agent-1',
    );
    expect(dryBranch.status).toBe('dry_run');
    expect(fs.existsSync(path.join(wsDir, 'experiment.txt'))).toBe(false);

    // Validation errors surface as SurfaceValidationError
    await expect(surface.call('edit', { path: 'math.ts' }, 'agent-1')).rejects.toBeInstanceOf(SurfaceValidationError);
    await expect(surface.call('branch', {}, 'agent-1')).rejects.toBeInstanceOf(SurfaceValidationError);
  });
});
