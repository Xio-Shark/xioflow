import { describe, expect, it } from 'vitest';
import { journalToOtlpTraces, JournalEvent, Operation } from '@xioflow/kernel';

const at = (s: number) => new Date(Date.UTC(2026, 8, 29, 10, 0, s)).toISOString();

function ev(seq: number, type: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return { seq, domainId: 'd', runId: 'run-1', type, payload: {}, timestamp: at(seq), ...extra };
}

const op: Operation = {
  id: 'op-1',
  runId: 'run-1',
  kind: 'process',
  name: 'npm test',
  inputFingerprint: 'f',
  requiredResources: ['workspace:write:/repo'],
  status: 'done',
  result: { kind: 'indeterminate', status: 'indeterminate', reason: 'pipes held', recoveryGuidance: 'inspect' } as any,
};

const journal: JournalEvent[] = [
  ev(1, 'OPERATION_INTENT_REGISTERED', { operationId: 'op-1' }),
  ev(2, 'OPERATION_STATUS_TRANSITION', { operationId: 'op-1', payload: { status: 'active' } }),
  ev(3, 'OPERATION_RESULT_RECORDED', { operationId: 'op-1' }),
  ev(4, 'TX_BEGUN', { payload: { txId: 'tx-1', root: '/repo', readTracking: 'atime' } }),
  ev(5, 'TX_CONFLICTED', { payload: { txId: 'tx-1', conflicts: [{ path: 'a.txt', kind: 'read_write' }] } }),
  ev(6, 'OPERATION_INTENT_REGISTERED', { operationId: 'op-2' }),
];

describe('journalToOtlpTraces', () => {
  const lookup = (id: string) => (id === 'op-1' ? op : undefined);

  it('maps settled operations and transactions to spans in the run trace', () => {
    const { payload, spanCount, nextSeq } = journalToOtlpTraces({ domainId: 'd', events: journal, lookupOperation: lookup });
    expect(spanCount).toBe(2); // op-2 is not settled yet
    expect(nextSeq).toBe(7);
    const spans = (payload.resourceSpans[0] as any).scopeSpans[0].spans;
    const [opSpan, txSpan] = spans;
    expect(opSpan.traceId).toBe(txSpan.traceId); // same run, same trace
    expect(opSpan.name).toBe('xioflow.process npm test');
    expect(opSpan.startTimeUnixNano).toBe((BigInt(Date.parse(at(1))) * 1_000_000n).toString());
    expect(opSpan.status).toEqual({ code: 2, message: 'pipes held' });
    expect(opSpan.events).toEqual([expect.objectContaining({ name: 'status.active' })]);
    expect(txSpan.attributes).toContainEqual({ key: 'xioflow.tx.outcome', value: { stringValue: 'conflict' } });
    expect(txSpan.attributes).toContainEqual({ key: 'xioflow.tx.conflicts', value: { stringValue: 'read_write:a.txt' } });
  });

  it('exports incrementally from a cursor with stable ids', () => {
    const first = journalToOtlpTraces({ domainId: 'd', events: journal, lookupOperation: lookup });
    const again = journalToOtlpTraces({ domainId: 'd', events: journal, lookupOperation: lookup, fromSeq: first.nextSeq });
    expect(again.spanCount).toBe(0);
    const replay = journalToOtlpTraces({ domainId: 'd', events: journal, lookupOperation: lookup });
    expect(JSON.stringify(replay.payload)).toBe(JSON.stringify(first.payload));
  });
});
