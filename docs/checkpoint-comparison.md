# 历史分支对照调试

`compareAgentCheckpoints(agents, left, right)` 对比同一 domain 中任意两个已记录的 checkpoint，包括不同 agent、不同事务和不同 Run。查询返回历史上下文、工作区绑定、JSON 字段差异，以及双方因果分支的共同节点、独有节点和分歧起点。无需历史 fork 仍然存在，也不会创建事务、读取当前文件、执行工具或消耗 Run 预算。

配合 [历史分叉](checkpoint-forks.md)，可以先重建旧状态，在 debug agent 上运行不同策略，再固定两侧 checkpoint 做对照：

```ts
import { compareAgentCheckpoints } from '@xioflow/kernel';

// agents is the existing AgentRuntime. Both IDs have recorded checkpoints.
const source = agents.checkpoints('researcher').at(-1)!;
const debug = agents.checkpoints('researcher-debug').at(-1)!;
const comparison = compareAgentCheckpoints(agents,
  { agentId: 'researcher', checkpointSeq: source.seq },
  { agentId: 'researcher-debug', checkpointSeq: debug.seq },
);

console.log(comparison.context); // e.g. [{ kind: 'changed', path: '/answer', before, after }]
console.log(comparison.left.saved.workspace, comparison.right.saved.workspace);
if (comparison.evidence.status === 'compared') {
  console.log('Divergence roots:', comparison.evidence.rightRoots);
  for (const node of comparison.evidence.rightOnly) {
    console.log(node.seq, node.actorId, node.txId, node.observation.call,
      node.observation.resultHash, node.dependsOn, node.writes);
  }
} else {
  console.log('Missing provenance:', comparison.evidence);
}
```

- `context` 按对象键排序，路径采用 JSON Pointer：根值路径为 `''`，`~` / `/` 分别转义为 `~0` / `~1`。对象递归比较，数组作为整个值比较；新增、删除、修改区分缺失字段与 `null`。对象键的插入顺序不构成差异。
- `shared` / `leftOnly` / `rightOnly` 按 journal 序号排序，包含完整节点，便于追溯 actor、工具参数、结果哈希和声明的写入来源。身份按节点序号比较：相同工具和哈希的两次执行仍是不同节点。
- `leftRoots` / `rightRoots` 是各侧独有节点中没有同侧独有父节点的节点。它们是结构上的分歧边界，可能有多个，不表示已证明语义错误或观测失效。
- 查询只包含各 checkpoint 在自身历史序号下选定的 heads 与祖先；后续节点、兄弟分支不会混入。heads 本身也返回，便于区分祖先集合相同但选定输出不同的情况。
- 缺失或 `null` heads 返回 `status: 'untracked'`，保留两侧各自已知的视图；`[]` 是可比较的显式空分支。未跟踪不能被当作证据相同。
- 返回值与 runtime、journal、调用参数隔离；修改查询结果不会改变历史。非法 checkpoint 引用直接报错，重开 domain 后仍可查询原始序号。

工作区绑定只说明当时使用哪个事务。节点 `writes` 是宿主声明的相对事务根路径，不是实际文件内容差异；跨根目录的同名路径不能直接视为同一文件。上下文字段与具体节点的因果映射、当前观测有效性、任意时刻文件 diff 仍需额外证据，本查询不推断这些结论。
