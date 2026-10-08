# 历史 checkpoint 分叉重放

`forkAgentCheckpoint` 把历史 agent 上下文与它的文件世界重建到新分支，供时间旅行调试。它使用 checkpoint 当时绑定的事务基线快照，顺序重放宿主提供的完整操作前缀，并核对每步结果哈希（包括写操作的返回值）。全部匹配后，才在原 Run 内创建具有相同上下文和 causal heads 的新 agent。

```ts
import { forkAgentCheckpoint } from '@xioflow/kernel';

const result = await forkAgentCheckpoint(agents, supervisor, {
  sourceAgentId: 'researcher',
  checkpointSeq: historicalCheckpoint.seq,
  agentId: 'researcher-debug',
  txId: 'debug-transaction',
  forkPath: '/tmp/researcher-debug',
  maxSteps: 10,
  replayPolicy: 'deterministic',
  observations: (saved) => ({
    closedWorld: true,
    // From saved.workspace's baseline through saved.seq; include all mutations.
    log: loadRecordedOperationPrefix(saved),
    replay: (entry, root) => deterministicTools.execute(entry.call, root),
  }),
});

if (result.status === 'forked') {
  console.log(result.agent.checkpoint, result.transaction.forkRoot);
  // Inspect or modify the new branch, then explicitly schedule it with agents.drain().
} else {
  console.log(result.replay.divergedAt, result.replay.reason, result.replay.error);
}
```

上例的日志存取和工具适配器由宿主提供。日志必须覆盖指定基线到 checkpoint 的完整操作序列；因果祖先集合可能跨事务，不能直接当作同一工作区的重放脚本。`closedWorld` 和 `deterministic` 是宿主声明，内核不会证明工具确定性、依赖完整性或外部副作用可重放。适配器只能操作传入的 fork，必须使用稳定的结果哈希；此入口不重放模型请求。

- 指定的历史 checkpoint 必须记录 workspace 和显式 causal heads；`[]` 有效，未跟踪上下文被拒绝。源 agent 可以继续存在或已终止，只要 Run 仍可创建 agent。
- 主工作区后续变化不影响基线选择；源 fork 可以已删除。历史快照缺失时直接失败，不退回当前世界。
- 成功的新 agent 为 `ready`，此函数自身不调用 `drain`。若宿主已在调度，需由宿主协调调度时机。新 agent 的局部步数为零，原 Run 已消耗的步数保留，创建计入同一 Run 的 agent 限额。
- 首次哈希分歧或适配器异常返回 `diverged`，含位置和错误；不创建 agent，清理可能已被修改的 fork。创建失败也清理 fork，清理异常会报告。共享的历史基线不会被此函数 prune。
- 成功事务保持 open，后续提交仍走普通 OCC。重放匹配只说明指定历史前缀可复现，不代表结果可直接提交到今天的主工作区。
- `AGENT_CHECKPOINT_FORK_PREPARED` 持久记录来源 agent、checkpoint、目标 agent / 事务、基线与重放步数。它表示重建已匹配；实际绑定以随后 `AGENT_STATE` 的 `created` 事件为准。进程在两事件之间崩溃时可能只留下准备好的事务，宿主需检查 journal 后回收。

重建后可用 [`compareAgentCheckpoints`](checkpoint-comparison.md) 对照源分支与 debug 分支的历史上下文、因果证据和工作区绑定。

这是 checkpoint 粒度的历史分叉，尚不提供任意 journal 序号的完整系统回滚、实际文件内容 diff 或外部系统重放。
