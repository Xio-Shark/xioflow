import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionDomain } from '../domain.js';
import { JournalEvent, Operation, OperationResult } from '../types.js';

/**
 * journal → OpenTelemetry traces（OTLP/HTTP JSON 编码），零依赖。
 *
 * - 一个 Run 是一条 trace（traceId 由 domainId + runId 派生），其中每个已结清的操作是一个 span：
 *   从 OPERATION_INTENT_REGISTERED 到 OPERATION_RESULT_RECORDED，状态迁移、重放、capability 使用、
 *   裁决记为 span event；indeterminate / failed 为 ERROR，cancelled 为 UNSET。
 * - 每个结束的工作区事务也是一个 span（TX_BEGUN → TX_COMMITTED / TX_CONFLICTED / TX_ABORTED）。
 * - id 均为确定性派生：同一段 journal 重复导出得到同样的 traceId / spanId，便于去重与关联。
 * - 只导出已结束的对象；尚未结清的操作在之后的导出中出现（按 journal seq 游标增量导出）。
 */

type AttrValue = string | number | boolean | undefined | null;

interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events: Array<{ timeUnixNano: string; name: string; attributes: OtlpAttribute[] }>;
  status: { code: number; message?: string };
}

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

function hexId(bytes: number, ...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, bytes * 2);
}

function nanos(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

function attributes(values: Record<string, AttrValue>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } });
    else if (typeof v === 'number' && Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } });
    else if (typeof v === 'number') out.push({ key, value: { doubleValue: v } });
    else out.push({ key, value: { stringValue: v } });
  }
  return out;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function kernelVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function operationStatus(result: OperationResult | undefined): { code: number; message?: string } {
  switch (result?.status) {
    case 'succeeded':
    case 'restored':
      return { code: STATUS_OK };
    case 'cancelled':
      return { code: STATUS_UNSET };
    case 'indeterminate':
      return { code: STATUS_ERROR, message: (result as { reason?: string }).reason ?? 'indeterminate' };
    default:
      return { code: STATUS_ERROR, message: result?.status ?? 'unknown' };
  }
}

function eventName(e: JournalEvent): string | undefined {
  switch (e.type) {
    case 'OPERATION_STATUS_TRANSITION':
      return `status.${String(e.payload.status)}`;
    case 'OPERATION_REPLAYED':
      return 'replayed';
    case 'CAPABILITY_USED':
      return 'capability.used';
    case 'OPERATION_ADJUDICATED':
      return 'adjudicated';
    case 'RESOURCES_RELEASED':
      return 'resources.released';
    default:
      return undefined;
  }
}

function operationSpan(domainId: string, op: Operation, events: JournalEvent[]): OtlpSpan | undefined {
  const start = events.find((e) => e.type === 'OPERATION_INTENT_REGISTERED') ?? events[0];
  const end = events.find((e) => e.type === 'OPERATION_RESULT_RECORDED');
  if (!start || !end) return undefined;
  const result = op.result as (OperationResult & Record<string, any>) | undefined;
  return {
    traceId: hexId(16, domainId, op.runId),
    spanId: hexId(8, domainId, 'op', op.id),
    name: `xioflow.${op.kind} ${op.name}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start.timestamp),
    endTimeUnixNano: nanos(end.timestamp),
    attributes: attributes({
      'xioflow.domain.id': domainId,
      'xioflow.run.id': op.runId,
      'xioflow.op.id': op.id,
      'xioflow.op.kind': op.kind,
      'xioflow.op.status': result?.status,
      'process.exit_code': typeof result?.exitCode === 'number' ? result.exitCode : undefined,
      'xioflow.termination_reason': result?.terminationReason,
      'xioflow.identity_verification': result?.identityVerification,
      'xioflow.residual_processes_reaped': result?.residualProcessesReaped,
      'xioflow.output.truncated': result?.isTruncated,
      'xioflow.capability.id': op.capabilityId,
      'xioflow.confined': result?.confined,
      'xioflow.confinement.driver': result?.confinementDriver,
      'xioflow.rollback.coverage': result?.coverage,
      'xioflow.resources': op.requiredResources.length > 0 ? op.requiredResources.join(',') : undefined,
    }),
    events: events.flatMap((e) => {
      const name = eventName(e);
      return name ? [{ timeUnixNano: nanos(e.timestamp), name, attributes: attributes({ 'xioflow.journal.seq': e.seq }) }] : [];
    }),
    status: operationStatus(result),
  };
}

function transactionSpan(domainId: string, events: JournalEvent[]): OtlpSpan | undefined {
  const begun = events.find((e) => e.type === 'TX_BEGUN');
  const end = events.find((e) => ['TX_COMMITTED', 'TX_CONFLICTED', 'TX_ABORTED'].includes(e.type));
  if (!begun || !end) return undefined;
  const txId = String(begun.payload.txId);
  const writeSet = (end.payload.writeSet as unknown[] | undefined) ?? [];
  const readSet = end.payload.readSet as unknown[] | null | undefined;
  const conflicts = (end.payload.conflicts as Array<{ path: string; kind: string }> | undefined) ?? [];
  const outcome = end.type === 'TX_COMMITTED' ? 'committed' : end.type === 'TX_CONFLICTED' ? 'conflict' : 'aborted';
  return {
    traceId: hexId(16, domainId, begun.runId ?? ''),
    spanId: hexId(8, domainId, 'tx', txId),
    name: `xioflow.transaction ${txId}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(begun.timestamp),
    endTimeUnixNano: nanos(end.timestamp),
    attributes: attributes({
      'xioflow.domain.id': domainId,
      'xioflow.run.id': begun.runId,
      'xioflow.tx.id': txId,
      'xioflow.tx.outcome': outcome,
      'xioflow.tx.root': String(begun.payload.root),
      'xioflow.tx.read_tracking': String(begun.payload.readTracking),
      'xioflow.tx.write_set.size': end.type === 'TX_COMMITTED' ? writeSet.length : undefined,
      'xioflow.tx.read_set.size': Array.isArray(readSet) ? readSet.length : undefined,
      'xioflow.tx.conflicts': conflicts.length > 0 ? conflicts.map((c) => `${c.kind}:${c.path}`).join(',') : undefined,
    }),
    events: [],
    status: outcome === 'committed' ? { code: STATUS_OK } : { code: STATUS_ERROR, message: outcome },
  };
}

export interface OtlpTraces {
  /** ExportTraceServiceRequest 的 JSON 编码，可直接 POST 到 `<endpoint>/v1/traces`。 */
  payload: { resourceSpans: unknown[] };
  spanCount: number;
  /** 下次增量导出的游标：传回 fromSeq 即只导出之后结束的对象。 */
  nextSeq: number;
}

/**
 * 把 journal 中在 fromSeq（含）之后结束的操作与事务转换为 OTLP traces。
 * `lookupOperation` 通常是 `store.getOperation`。
 */
export function journalToOtlpTraces(options: {
  domainId: string;
  events: JournalEvent[];
  lookupOperation: (opId: string) => Operation | null | undefined;
  fromSeq?: number;
  serviceName?: string;
}): OtlpTraces {
  const fromSeq = options.fromSeq ?? 0;
  const byOp = new Map<string, JournalEvent[]>();
  const byTx = new Map<string, JournalEvent[]>();
  let lastSeq = fromSeq - 1;
  for (const e of options.events) {
    lastSeq = Math.max(lastSeq, e.seq);
    if (e.operationId) push(byOp, e.operationId, e);
    if (e.type.startsWith('TX_') && typeof e.payload.txId === 'string') push(byTx, e.payload.txId, e);
  }

  const endedAfter = (events: JournalEvent[], types: string[]) =>
    events.some((e) => types.includes(e.type) && e.seq >= fromSeq);
  const spans: OtlpSpan[] = [];
  for (const [opId, events] of byOp) {
    if (!endedAfter(events, ['OPERATION_RESULT_RECORDED'])) continue;
    const op = options.lookupOperation(opId);
    const span = op ? operationSpan(options.domainId, op, events) : undefined;
    if (span) spans.push(span);
  }
  for (const events of byTx.values()) {
    if (!endedAfter(events, ['TX_COMMITTED', 'TX_CONFLICTED', 'TX_ABORTED'])) continue;
    const span = transactionSpan(options.domainId, events);
    if (span) spans.push(span);
  }

  return {
    payload: {
      resourceSpans: [
        {
          resource: {
            attributes: attributes({
              'service.name': options.serviceName ?? 'xioflow-kernel',
              'xioflow.domain.id': options.domainId,
            }),
          },
          scopeSpans: [{ scope: { name: '@xioflow/kernel', version: kernelVersion() }, spans }],
        },
      ],
    },
    spanCount: spans.length,
    nextSeq: lastSeq + 1,
  };
}

/**
 * 读取域 journal 并 POST 到 OTLP/HTTP 端点（`<endpoint>/v1/traces`，JSON 编码）。
 * 非 2xx 响应抛错，游标不前进，调用方可原样重试（span id 确定，不会产生语义重复）。
 */
export async function exportJournalToOtlp(
  domain: Pick<ExecutionDomain, 'domainId' | 'getStore'>,
  options: { endpoint: string; headers?: Record<string, string>; fromSeq?: number; serviceName?: string; timeoutMs?: number }
): Promise<{ spanCount: number; nextSeq: number }> {
  const store = domain.getStore();
  const traces = journalToOtlpTraces({
    domainId: domain.domainId,
    events: store.getJournalEvents(domain.domainId),
    lookupOperation: (opId) => store.getOperation(opId),
    fromSeq: options.fromSeq,
    serviceName: options.serviceName,
  });
  if (traces.spanCount === 0) return { spanCount: 0, nextSeq: traces.nextSeq };

  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/traces`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(traces.payload),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OTLP export to ${url} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  return { spanCount: traces.spanCount, nextSeq: traces.nextSeq };
}
