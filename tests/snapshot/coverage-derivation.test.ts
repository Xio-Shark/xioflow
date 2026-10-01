import { describe, it, expect } from 'vitest';
import { deriveRollbackCoverage, RollbackCoverageFacts } from '../../src/supervisor/rollback.js';
import { diffIgnoredEntries, IgnoredManifestEntry, IGNORED_CHANGES_LIMIT } from '../../src/snapshot/ignored-manifest.js';

type Derived = ReturnType<typeof deriveRollbackCoverage>;
const row = (facts: RollbackCoverageFacts, expected: Derived) => ({ facts, expected });

describe('deriveRollbackCoverage 真值表', () => {
  it.each([
    row(
      { status: 'restored', effects: 'confined', snapshotCoverage: 'full_tree', ignoredManifest: 'absent' },
      { coverage: 'complete', outOfScopeEffects: 'none_possible', ignoredFiles: 'restored', coverageBasis: ['all_ops_confined', 'snapshot_full_tree'] }
    ),
    row(
      { status: 'restored', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'unchanged' },
      { coverage: 'complete', outOfScopeEffects: 'none_possible', ignoredFiles: 'unchanged_verified', coverageBasis: ['all_ops_confined', 'ignored_manifest_unchanged'] }
    ),
    row(
      { status: 'restored', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'absent' },
      { coverage: 'non_ignored', outOfScopeEffects: 'none_possible', ignoredFiles: 'not_captured', coverageBasis: ['all_ops_confined', 'ignored_not_captured'] }
    ),
    row(
      { status: 'restored', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'changed' },
      { coverage: 'non_ignored', outOfScopeEffects: 'none_possible', ignoredFiles: 'not_captured', coverageBasis: ['all_ops_confined', 'ignored_manifest_changed'] }
    ),
    row(
      { status: 'restored', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'inconclusive' },
      { coverage: 'non_ignored', outOfScopeEffects: 'none_possible', ignoredFiles: 'not_captured', coverageBasis: ['all_ops_confined', 'ignored_manifest_ctime_only'] }
    ),
    row(
      { status: 'restored', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'unreadable' },
      { coverage: 'non_ignored', outOfScopeEffects: 'none_possible', ignoredFiles: 'not_captured', coverageBasis: ['all_ops_confined', 'ignored_manifest_unreadable'] }
    ),
    row(
      { status: 'restored', effects: 'unconfined', snapshotCoverage: 'full_tree', ignoredManifest: 'absent' },
      { coverage: 'declared_roots', outOfScopeEffects: 'possible', ignoredFiles: 'restored', coverageBasis: ['unconfined_op_since_snapshot', 'snapshot_full_tree'] }
    ),
    row(
      { status: 'restored', effects: 'unconfined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'unchanged' },
      { coverage: 'declared_roots', outOfScopeEffects: 'possible', ignoredFiles: 'unchanged_verified', coverageBasis: ['unconfined_op_since_snapshot', 'ignored_manifest_unchanged'] }
    ),
    row(
      { status: 'restored', effects: 'unverified', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'absent' },
      { coverage: 'declared_roots', outOfScopeEffects: 'possible', ignoredFiles: 'not_captured', coverageBasis: ['effects_unverified', 'ignored_not_captured'] }
    ),
    row(
      { status: 'partial', effects: 'confined', snapshotCoverage: 'full_tree', ignoredManifest: 'absent' },
      { coverage: 'declared_roots', outOfScopeEffects: 'possible', ignoredFiles: 'restored', coverageBasis: ['unrestored_paths', 'snapshot_full_tree'] }
    ),
    row(
      { status: 'partial', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'absent' },
      { coverage: 'declared_roots', outOfScopeEffects: 'possible', ignoredFiles: 'not_captured', coverageBasis: ['unrestored_paths', 'ignored_not_captured'] }
    ),
    row(
      { status: 'failed', effects: 'confined', snapshotCoverage: 'full_tree', ignoredManifest: 'absent' },
      { coverage: 'none', outOfScopeEffects: 'possible', ignoredFiles: 'unverified', coverageBasis: ['fingerprint_mismatch'] }
    ),
    row(
      { status: 'failed', effects: 'confined', snapshotCoverage: 'worktree_non_ignored', ignoredManifest: 'unchanged' },
      { coverage: 'none', outOfScopeEffects: 'possible', ignoredFiles: 'unchanged_verified', coverageBasis: ['fingerprint_mismatch'] }
    ),
  ])('$facts.status / $facts.effects / $facts.snapshotCoverage / 清单 $facts.ignoredManifest ⇒ $expected.coverage', ({ facts, expected }) => {
    expect(deriveRollbackCoverage(facts)).toEqual(expected);
  });

  it('默认快照且没有「清单未变」的证据时，任何输入组合都得不到 complete', () => {
    for (const status of ['restored', 'partial', 'failed'] as const) {
      for (const effects of ['confined', 'unconfined', 'unverified'] as const) {
        for (const ignoredManifest of ['changed', 'inconclusive', 'unreadable', 'absent'] as const) {
          const derived = deriveRollbackCoverage({ status, effects, snapshotCoverage: 'worktree_non_ignored', ignoredManifest });
          expect(derived.coverage).not.toBe('complete');
        }
      }
    }
  });
});

describe('diffIgnoredEntries', () => {
  const entry = (p: string, over: Partial<IgnoredManifestEntry> = {}): IgnoredManifestEntry => ({
    path: p, size: '10', mtimeNs: '1000', ctimeNs: '1000', mode: 0o100644, ...over,
  });

  it('四项全等 ⇒ unchanged，不带 changes', () => {
    expect(diffIgnoredEntries([entry('/r/a')], [entry('/r/a')])).toEqual({ verdict: 'unchanged' });
  });

  it('增 / 删 / 改各归其类 ⇒ changed', () => {
    const { verdict, changes } = diffIgnoredEntries(
      [entry('/r/kept'), entry('/r/gone'), entry('/r/resized'), entry('/r/touched'), entry('/r/chmod')],
      [
        entry('/r/kept'),
        entry('/r/resized', { size: '11' }),
        entry('/r/touched', { mtimeNs: '2000', ctimeNs: '2000' }),
        entry('/r/chmod', { mode: 0o100755, ctimeNs: '2000' }),
        entry('/r/new'),
      ]
    );
    expect(verdict).toBe('changed');
    expect(changes).toMatchObject({
      added: ['/r/new'],
      removed: ['/r/gone'],
      modified: ['/r/resized', '/r/touched', '/r/chmod'],
      metadataOnly: [],
      truncated: false,
    });
  });

  it('只有 ctime 变了 ⇒ inconclusive：不算未变，也不列为已修改', () => {
    const { verdict, changes } = diffIgnoredEntries([entry('/r/a')], [entry('/r/a', { ctimeNs: '2000' })]);
    expect(verdict).toBe('inconclusive');
    expect(changes?.modified).toEqual([]);
    expect(changes?.metadataOnly).toEqual(['/r/a']);
  });

  it('超过上限时截断并给出总数', () => {
    const many = Array.from({ length: IGNORED_CHANGES_LIMIT + 7 }, (_, i) => entry(`/r/f${String(i).padStart(3, '0')}`));
    const { changes } = diffIgnoredEntries([], many);
    expect(changes?.added).toHaveLength(IGNORED_CHANGES_LIMIT);
    expect(changes?.truncated).toBe(true);
    expect(changes?.counts.added).toBe(IGNORED_CHANGES_LIMIT + 7);
  });
});
