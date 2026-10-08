# 多策略投机工作区（实验性）

`speculateWorkspace` 将同一任务的多个策略放到共享基线快照的独立事务中并行执行。所有策略完成后，按声明顺序尝试普通事务提交；第一个通过 OCC 的候选成为胜者，其余工作区被回收。策略可以在回调中调用 AgentRuntime、工具或测试，并通过抛错拒绝不合格的结果。

```ts
import { speculateWorkspace, WorkspaceCausalGraph } from '@xioflow/kernel';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// supervisor 已关联一个 domain，runId 指向该 domain 的活动 run。
const graph = new WorkspaceCausalGraph(supervisor.getDomain());
const result = await speculateWorkspace(supervisor, {
  speculationId: 'solve-42', // domain 中唯一；候选事务为 solve-42-0、solve-42-1
  runId,
  root: '/repo',
  forkPath: '/work/solve-42',
  strategies: ['minimal', 'alternative'].map((id) => ({
    id,
    async execute(tx) {
      // 实际宿主在 tx.forkRoot 中运行策略、收集观测并验证结果。
      await writeFile(path.join(tx.forkRoot, 'answer.txt'), id);
      graph.record({
        txId: tx.txId, actorId: id, dependsOn: [],
        observation: {
          kind: 'mutate',
          call: { tool: 'write', args: { path: 'answer.txt', content: id } },
          resultHash: 'ok',
        },
        writes: [{ path: 'answer.txt', status: 'A' }],
      });
      // 若已有完整观测日志，可返回 { observations: { log, closedWorld: true, replay } }。
    },
  })),
});
console.log(result.status, result.winner, result.candidates);
```

## 提交和生命周期

- fork 创建完毕后才同时启动回调，所有候选拥有同一个 `baseSnapshotId`。完成速度不改变优先级；失败或 OCC 冲突会继续尝试后续候选。
- 返回值记录每个候选的 `failed`、`conflict`、`discarded` 或 `committed` 状态，以及实际 `CommitResult`。没有胜者时返回 `no_winner`。`discarded` 表示执行完成但未尝试提交。
- 回调返回的 `CommitOptions` 原样用于已有事务提交，包括观测重放。保留已有 `files` / `observations` / `write_only` 验证语义；获胜表示事务可提交，任务是否正确由策略自身的验证决定。
- 所有回调都必须等到子进程、工具和写入结束后才返回。当前入口不抢先取消策略，也不限制并发数；长时间不结束的回调会阻塞整个选择过程。只在隔离 fork 内执行的文件效果可被自动回收，外部效果仍由宿主管理。
- 正常完成时回收失败、冲突和落选 fork，并释放共享基线快照。journal 中的 `SPECULATION_STARTED`、`SPECULATION_FINISHED` 和既有 TX 事件保留策略与事务映射；回调记录的因果节点也保留。
- 提交抛出异常时，可能已经开始应用文件。入口停止选择其他候选，保留该事务的 fork 与基线，抛出包含事务 ID 的 `AggregateError`。宿主按已有事务恢复协议处理并重试提交；其他候选仍尝试回收。清理错误也会显式抛出。`SPECULATION_FINISHED` 记录选择结果，不代表后续清理已经完成。

这是投机执行的第一步：当前不自动重算冲突子图、不合并多个胜者、不恢复模型上下文，也不声称节省 token。下一步可将候选因果图接入观测失效驱动的局部修复，并比较整轮重跑与局部修复的实际工具调用次数。
