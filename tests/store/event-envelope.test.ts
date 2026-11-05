import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite.js';
import { createEventEnvelope } from '../../src/store/event-envelope.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('journal event envelope', () => {
  it('preserves unknown event names and strips prompt/env/secret/file content before persistence', () => {
    const envelope = createEventEnvelope({
      domainId: 'event-domain', requestId: 'request', programId: 'program', instructionId: 'step', opId: 'op:step', event: 'future.event',
      payload: { safe: 'kept', prompt: 'raw prompt', environment: { TOKEN: 'secret' }, content: 'file body', nested: { value: 1 } },
    });
    expect(envelope.event).toBe('future.event');
    expect(envelope.payload).toEqual({ safe: 'kept', nested: { value: 1 } });
  });

  it('stores and reads the full envelope while legacy journal reads remain compatible', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-event-envelope-'));
    roots.push(root);
    const store = new SqliteStore(path.join(root, 'domain.db'));
    const seq = store.recordEventEnvelope({
      domainId: 'event-domain', requestId: 'request', programId: 'program', instructionId: 'step', opId: 'op:step', event: 'future.event',
      payload: { safe: 'kept', secretValue: 'removed' }, sensitivity: 'sensitive', createdAt: '2026-11-02T00:00:00.000Z',
    });
    expect(store.getEventEnvelopes('event-domain')).toEqual([expect.objectContaining({ seq, event: 'future.event', requestId: 'request', programId: 'program', instructionId: 'step', opId: 'op:step', sensitivity: 'sensitive' })]);
    expect(store.getJournalEvent('event-domain', seq)?.type).toBe('future.event');
    expect(store.getJournalEvent('event-domain', seq)?.payload).toEqual({ safe: 'kept' });
  });
});
