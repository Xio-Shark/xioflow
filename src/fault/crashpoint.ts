import fs from 'node:fs';

/**
 * 崩溃点故障注入（测试专用）。
 *
 * 只在设置了以下环境变量之一时生效，否则 crashpoint() 是一次布尔判断：
 * - XIOFLOW_TEST_CRASHPOINT_TRACE=<file>：把经过的每个崩溃点 id 逐行追加到文件（发现阶段）；
 * - XIOFLOW_TEST_CRASHPOINT=<id>：到达该 id 时向自身发送 SIGKILL（注入阶段）。
 *
 * id 形如 `<label>#<第几次到达>`。SIGKILL 不执行任何 finally / exit 钩子，与真实崩溃等价；
 * 故障注入矩阵见 tests/fault/crash-matrix.test.ts。
 */
const target = process.env.XIOFLOW_TEST_CRASHPOINT;
const tracePath = process.env.XIOFLOW_TEST_CRASHPOINT_TRACE;
const seen = new Map<string, number>();

export const crashpointsEnabled = Boolean(target || tracePath);

export function crashpoint(label: string): void {
  if (!crashpointsEnabled) return;
  const n = (seen.get(label) ?? 0) + 1;
  seen.set(label, n);
  const id = `${label}#${n}`;
  if (tracePath) fs.appendFileSync(tracePath, `${id}\n`);
  if (id === target) process.kill(process.pid, 'SIGKILL');
}

/**
 * 以调用栈里开启事务的函数名作为崩溃点标签（仅在启用时解析调用栈）。
 * 例如 `SqliteStore.recordOperationResult`、`captureSnapshot`。
 */
export function callerLabel(depth: number): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const frame = frames[depth] ?? '';
  const match = /at (?:async )?([^\s(]+)/.exec(frame);
  return match ? match[1] : 'unknown';
}
