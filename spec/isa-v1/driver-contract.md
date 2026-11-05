# XIO-ISA v1 driver contract

**Contract schema:** `xio/driver/1`  
**Status:** D-01 implementation contract, 2026-11-02

一个 driver 只能声明自己能观察、停止或回滚的事实。不能证明的事实必须
进入 `unknown`，不能用当前宿主配置、替换 driver 或单个 PID 推断。运行时
可通过 `src/driver/contract.ts` 的描述器得到同一份四段证据：

- `observation`：driver 能直接观察的身份、树、资源、快照或文件事实；
- `stop`：停止对象、确认范围和变成 `cannot_determine` 的条件；
- `rollback`：补偿或恢复的覆盖范围，及其不适用边界；
- `crashRecovery`：写入 SQLite/journal 的事实、宿主崩溃后仍能证明的结论和明确不能证明的结论。

`capabilityVersion` 使用独立的 `<driver-name>/<major>.<minor>` 版本域。能力
变弱、移除证据或改变 unknown 语义必须升 major；换一个更强的 driver 不会
为旧 intent 补造证据。

## 进程 driver

`PlatformDriver` 的固定接口是 `spawn`、`verifyIdentity`、`terminate`，以及
按能力可选的 `terminateGroup`、`settleTree`、`readLimitEvents`、
`sampleMetrics`、`readBootId` 和 `getGroupEvidence`。`spawn` 返回的 identity
和 `RecoveryEvidence` 在 intent 之后、执行放行之前落盘；`terminate` 的
`confirmed_stopped` 只表示它返回的 scope 已被该 driver 证明为空。

| Driver | observation | stop / containment | 回滚 | host crash 后可证明什么 |
| --- | --- | --- | --- | --- |
| `NodePlatformDriver` | PID、OS start time、boot id、进程组和可用的进程表/资源采样 | POSIX 进程组；树枚举失败、PID 复用、逃逸后代或观察失败返回 `cannot_determine` | 不可回滚进程副作用 | 可用原始 intent、identity 和 capability 判定已登记事实；gated intent 且无 identity 可证明命令未放行；不能证明 identity-less 命令没有短暂执行，也不能证明外部副作用 |
| `ReaperPlatformDriver` | Node 的身份事实，加上 helper 持有的树和 root/tree exit | Linux `subreaper_tree`；macOS `tracked_tree`；helper/control channel 丢失时回到 OS 事实并保守隔离 | 不可回滚进程副作用 | Linux 可用 helper/subreaper 的树空事实；macOS 只能证明已跟踪树，未被看到的 `setsid` 逃逸仍为 unknown；helper 丢失不产生伪造退出码 |
| `CgroupPlatformDriver` | Node 身份事实、专属 cgroup 成员、`cgroup.events`、限制命中和 cgroup 采样 | `containment_cgroup`；`populated=0` 才能确认树空，cgroup 不可读/删除失败/残留成员为 unknown | 不可回滚进程副作用 | 可用持久化 cgroup path 与原始能力证明 containment 范围；恢复 driver 没有同等 cgroup 观察能力时不能升级结论；不能证明外部服务或业务副作用 |

硬限制是 admission 能力：`memoryHardLimit`、`pidsLimit` 或其他限制为
`false` 时，声明 `hard` 必须拒绝，不能降级成 `soft`。`observe`/`soft` 的
采样失败记录 unknown 或 `observation_failed`，不能当作零使用量。

## filesystem driver

当前 artifact writer 仍由 `src/artifacts.ts` 和 `SqliteStore` 组成，尚未
拆成独立 class；它使用 `describeFilesystemDriver` 表达 D-01 contract。固定
事实是：

1. 创建必须是 exclusive、no-follow，并把 owner operation、creating
   instruction、path identity、hash、size、TTL、sensitivity、encryption
   和 deletion state 写入 durable manifest；
2. 删除必须重新核对 path identity；inode 被替换、owner 不明、状态不明或
   operation 未结算时保留文件；
3. filesystem driver 不负责进程 stop；它只能对 identity-checked cleanup
   或已声明的 artifact rollback 给出有限覆盖，不能把文件删除当作业务回滚。

host crash 后，如果 manifest 和 identity 均已落盘，可以证明某个路径是否
仍是原 artifact；不能证明 unknown-owner 文件属于本域，也不能证明外部 writer
没有在 manifest 之外改写内容。

## workspace / snapshot driver

`SnapshotDriver` 固定提供 `capture`、`restore`、`fingerprint`、`prune`，并
可选提供 ignored listing 和 materialize/dematerialize。`SnapshotRef` 的
`roots`、`coverage`、`treeFingerprint`、`commitHash` 和 operation journal
是恢复事实。

快照 ID（含 ISA 的 `op:...`）是不透明键，不是 Git ref 或文件路径组件。
普通安全旧 ID 继续使用 `refs/xioflow/snapshots/<id>`；含冒号、路径分隔符、
空白或其他非法 ref 形态的 ID 使用
`refs/xioflow/encoded-snapshots/<sha256-of-utf16le-id>`。两者命名空间分离，
`capture`、`materialize` 和 `prune` 使用同一映射，公开 `SnapshotRef.id`
保持原值。ignored manifest 始终经 artifact 路径编码和 ownership manifest
管理；例如 `../snapshot` 可以成功捕获，但不能读写或删除 artifacts 目录外的
同名文件。安全性不能依赖 Git 拒绝某个 ID。

`worktree_non_ignored` 只覆盖声明根内的非 ignored 树；`full_tree` 才能把
ignored 内容纳入快照。`restore` 后必须用同一 driver 的 fingerprint 核验，
部分恢复或核验失败返回失败/不确定事实；driver 不得把根外内容纳入 rollback。

host crash 后可以重新读取 snapshot ref、比较 tree fingerprint，并在同一
根范围内继续恢复；不能推断应用层语义、根外副作用或未捕获 ignored 文件的
状态。外部 writer 破坏校验时保持冲突/unknown。

## confinement driver

`ConfinementDriver.wrap(command, writableRoots)` 只负责把一个已声明的命令
包装成写入限制形式。`bubblewrap`、`sandbox-exec`、`landlock` 和 `srt` 在
不可用时必须抛错，不能返回原命令假装已限制。它协助 workspace rollback 的
`outOfScopeEffects`/`coverage` 证明，但不是 hostile-code sandbox，也不负责
stop 或 rollback。

host crash 后只能证明 admission 选择了哪个 wrapper 及其声明的 writable roots；
不能证明 wrapper 在宿主策略变化或外部工具被替换后仍已生效，也不能证明
恶意程序绕过宿主安全边界时没有越界写入。

## 统一失败规则

- driver 返回 `unknown`、`cannot_determine`、helper/channel 丢失或观察失败时，
  operation 保持 `indeterminate` 并保留 lease；
- 恢复只使用 intent 时持久化的 driver name、capability snapshot、identity、
  containment 和 config snapshot；替换 driver 不能增强历史结论；
- `succeeded` 需要真实执行事实、可观察的结果和适用 driver evidence；
  driver 失败不能生成假成功；
- filesystem/workspace/confinement 的 contract 描述可以被宿主读取，但业务
  成功、模型验收和外部副作用永远不属于 driver。

机器可读描述器见 [`src/driver/contract.ts`](../../src/driver/contract.ts)，
其边界测试见 [`tests/driver/contracts.test.ts`](../../tests/driver/contracts.test.ts)。

## 容器内已停止但尚未被回收的 PID

`confirmed_stopped` 证明所声明 scope 内的可执行进程已经停止，不等于所有
PID 条目已由父进程 `waitpid` 回收。Linux 容器的 PID 1 可能不收割孤儿；
此时 `kill(pid, 0)` 对 `Z` 状态仍成功，但该进程已经不能执行代码、派生后代
或持有输出管道。Node driver 使用新鲜进程表区分这些事实。

- `residualPids` 保留仍可执行或无法确认停止的残留；这类结果仍是
  `cannot_determine`，不得释放 lease。
- `unreapedPids` 单列操作系统已观察为 `Z` 的 PID；它们已停止，但父进程尚未
  回收条目。停止结果及最终 process result 都保留这一事实。
- 兼容字段 `residualProcessesReaped` 和 `treeSettlement: 'reaped'` 表示残留经过
  停止流水线收口，不能单独充当 `waitpid` 成功证据；必须同时查看
  `unreapedPids`。只有 subreaper 的 `ECHILD` 或其他已声明的 containment
  证据才能增强为整棵树已空。
- 进程表失败，或 `kill(pid, 0)` 显示存在但进程表未包含该 PID，仍是观察失败；
  不能因为没有看到条目就报告停止。

测试必须独立查询 OS 状态，区分 `ESRCH`、`Z` 和仍可执行的进程，不把容器
init 未回收条目伪装成 PID 已消失，也不把真实活进程当作已停止。
