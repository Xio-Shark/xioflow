import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import { quickRun } from '@xioflow/kernel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const effectsLogPath = path.join(__dirname, 'effects.log');

/**
 * Temporal Activity 执行受管副作用命令
 *
 * 核心设计：
 * 从 Context.current().info 提取 workflowId 与 activityId。
 * 两者在 Temporal 重试间保持稳定，天然构成 xioflow 的幂等 opId。
 */
export async function executeAppendActivity(customMessage = 'temporal-effect') {
  let workflowId = 'mock-wf';
  let activityId = 'mock-act';

  try {
    const info = Context.current().info;
    workflowId = info.workflowExecution.workflowId;
    activityId = info.activityId;
  } catch {
    // When called outside Temporal worker runtime (e.g. simulation or test)
  }

  const opId = `${workflowId}:${activityId}`;
  const domainPath = path.join(__dirname, '.xioflow-kernel');

  // 待执行的真实外部副作用命令（例如向 effects.log 追加一行）
  const script = `
    const fs = require('fs');
    fs.appendFileSync(process.argv[1], process.argv[2] + '\\n');
    console.log('Appended to effects.log successfully');
  `;

  const result = await quickRun(
    {
      execPath: process.execPath,
      args: ['-e', script, effectsLogPath, customMessage],
      cwd: __dirname,
    },
    {
      opId,
      domainPath,
      name: `temporal-activity-${activityId}`,
    }
  );

  return {
    opId,
    status: result.status,
    replayed: result.replayed ?? false,
    durationMs: result.durationMs,
  };
}
