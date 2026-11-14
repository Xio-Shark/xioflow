import { describe, expect, it } from 'vitest';
import * as kernelRoot from '@xioflow/kernel';
import * as surfaceMod from '@xioflow/kernel/surface';
import * as wrapMod from '@xioflow/kernel/wrap';
import * as otelMod from '@xioflow/kernel/otel';

describe('Package export discipline (<= 15 orthogonal root symbols & clean subpath split)', () => {
  it('caps @xioflow/kernel root runtime exports at <= 15 and hides internal store & stripped AgentRuntime', () => {
    const exportedNames = Object.keys(kernelRoot).sort();
    expect(exportedNames.length).toBeLessThanOrEqual(15);
    expect(exportedNames).toContain('connectWorkspace');
    expect(exportedNames).toContain('KernelMedium');
    expect(exportedNames).toContain('SessionView');
    expect(exportedNames).toContain('ExecutionDomain');
    expect(exportedNames).toContain('ProcessSupervisor');
    expect(exportedNames).not.toContain('SqliteStore');
    expect(exportedNames).not.toContain('AgentRuntime');
    expect(exportedNames).not.toContain('wrapAgent');
    expect(exportedNames).not.toContain('journalToOtlpTraces');
  });

  it('exposes surface, wrap, and otel cleanly on dedicated subpaths', () => {
    expect(surfaceMod.GOLDEN_SURFACE_SCHEMAS.map((s) => s.name)).toEqual(['run', 'edit', 'inspect', 'branch']);
    expect(typeof surfaceMod.createSurfaceDispatcher).toBe('function');
    expect(typeof wrapMod.wrapAgent).toBe('function');
    expect(typeof wrapMod.redactTurnForPersistence).toBe('function');
    expect(typeof otelMod.exportJournalToOtlp).toBe('function');
  });
});
