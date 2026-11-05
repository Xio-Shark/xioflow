import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceIncrementalIndex,
  mergeWorkspaceIncrementalIndex,
  parseWorkspaceIncrementalIndex,
} from '../../src/workspace/incremental-index.js';

describe('workspace incremental index', () => {
  it('keeps read, write, discovery, symbol, ignored and path evidence separate', () => {
    const index = buildWorkspaceIncrementalIndex({
      root: '/workspace',
      readSet: ['src/a.ts', 'src/'],
      writeSet: [{ status: 'M', path: 'src/a.ts' }],
      discoverySet: ['src/', 'src/a.ts'],
      symbolSlice: { 'src/a.ts#foo': 'slice-hash' },
      ignoredManifest: 'ignored-digest',
      pathDependencies: ['src/input'],
    });

    expect(index.coverage).toBe('complete');
    expect(index.readSet).toEqual(['src/', 'src/a.ts']);
    expect(index.discoverySet).toEqual(['src/', 'src/a.ts']);
    expect(index.symbolSlice).toEqual({ 'src/a.ts#foo': 'slice-hash' });
    expect(index.ignoredManifest).toBe('ignored-digest');
    expect(index.pathDependencies).toEqual(['src/input']);
    expect(parseWorkspaceIncrementalIndex(index)).toEqual(index);
  });

  it('downgrades coverage when any observation set is unavailable', () => {
    const index = buildWorkspaceIncrementalIndex({
      root: '/workspace',
      readSet: null,
      writeSet: [],
      discoverySet: ['src/'],
      pathDependencies: [],
    });
    expect(index.coverage).toBe('unknown');
    expect(index.coverageBasis).toContain('read_set_unobserved');
    expect(index.ignoredManifest).toBeNull();
    expect(parseWorkspaceIncrementalIndex({ ...index, digest: 'tampered' })).toBeUndefined();
  });

  it('merges incremental observations without retaining stale writes', () => {
    const previous = buildWorkspaceIncrementalIndex({
      root: '/workspace',
      readSet: ['a.ts'],
      writeSet: [{ status: 'M', path: 'old.ts' }],
      discoverySet: ['a.ts'],
      symbolSlice: { 'a.ts#foo': 'old-slice' },
      ignoredManifest: 'ignored-digest',
      pathDependencies: [],
    });
    const current = buildWorkspaceIncrementalIndex({
      root: '/workspace',
      readSet: ['b.ts'],
      writeSet: [{ status: 'A', path: 'new.ts' }],
      discoverySet: ['b.ts'],
      symbolSlice: { 'b.ts#bar': 'new-slice' },
      pathDependencies: [],
    });
    const merged = mergeWorkspaceIncrementalIndex(previous, current);
    expect(merged.readSet).toEqual(['a.ts', 'b.ts']);
    expect(merged.discoverySet).toEqual(['a.ts', 'b.ts']);
    expect(merged.writeSet).toEqual([{ status: 'A', path: 'new.ts' }]);
    expect(merged.symbolSlice).toEqual({ 'a.ts#foo': 'old-slice' });
    expect(merged.ignoredManifest).toBe('ignored-digest');
  });
});
