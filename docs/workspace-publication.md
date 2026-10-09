# 工作区发布验证

`commitWorkspaceTransaction` 的可选 `publication` 将成果有效性检查接到已有串行提交队列，
是 [北极星](NORTH_STAR.md) 统一发布契约的实现切片。尚未实现 `openWorld`、独立提交 key 或跨 checkpoint 原子发布。

```ts
const base = domain.getStore().getSnapshot(tx.baseSnapshotId);
if (!base) throw new Error('Missing prepared baseline');
// 在候选准备完成时保存；不要在提交前重新计算来掩盖候选损坏。
const outputFingerprint = await supervisor.getSnapshotDriver().fingerprint(
  [tx.forkRoot], { against: base },
);
const result = await supervisor.commitWorkspaceTransaction(tx.txId, {
  observations: { closedWorld: true, log, replay },
  publication: {
    coverage: 'complete',
    outputFingerprint,
    accept: async root => verifyQuoteWithIndependentCalculator(root),
  },
});
// 仍须处理 result.status === 'conflict'；通过业务验收不能绕过 OCC。
```

宿主在准备时声明快照覆盖和观测日志包含全部依赖；无法声明时使用 `coverage: 'unknown'`。
覆盖范围沿用基线快照，不会因为声明 complete 而自动包括网络、忽略文件或隐藏读取。
内核先核对候选文件树与准备指纹，随后强制重放完整日志；即使文件 OCC 没有冲突也重放。
验收收到的是**实际将发布的重放目录**，可以按当前输入检查业务结果；不能只验原候选。
重放不是候选逐字节相同的证明，输出正确性由完整重放契约和业务验收共同承担。

验收必须只读，且仅返回 `true` 才通过。内核比较验收前后的覆盖文件树，防止验收改写
发布来源却继续使用旧写集。验收后仍检查重放基线是否改变，然后才记录 `TX_COMMITTING` 并应用。
宿主必须保持候选、重放目录静止；异步指纹不是对外部进程写入的文件系统锁。

| 情况 | 返回或证据 | 重试与资源 |
| --- | --- | --- |
| 覆盖未知 | `WorkspacePublicationError.reason = coverage_unknown` | 主目录不变，候选保留；宿主补齐证据或重算。 |
| 候选损坏 / 验收改写输出 | `output_changed` | 发布前拒绝；重放临时资源回收，候选保留。 |
| 验收不通过 | `acceptance_rejected` | 发布前拒绝；可修正候选后重新准备证据。 |
| 指纹读取或验收异常 | `validation_failed` | 发布前拒绝；修复原因后重试。 |
| 观测或 OCC 冲突 | 既有 `CommitResult.status = conflict` | 中止旧事务，从当前世界重新准备。 |
| 应用过程异常 | 既有异常，可能已有部分文件应用 | 保留 committing 事务、来源和快照；继续既有恢复协议。 |

门禁拒绝记录 `TX_PUBLICATION_REJECTED`，包含 txId 与原因，可从 domain journal 查询。
通过的发布来源指纹与重放快照身份持久存入 `TX_COMMITTING.publication`。
中断后再次 commit 即使未传回调，也先核对该指纹；来源被篡改则拒绝继续应用，保留恢复资源。
此前已应用的文件不会因此自动撤回，也不会重新执行业务验收。
缺失来源或指纹读取故障沿用抛错语义，不代表事务已回滚。

已处于 committing 的旧事务不能靠新传入 publication 升级保证；只有准备新提交时启用才会保存证据。
不传 publication 的既有调用保持原发布校验规则。本切片不提供独立 key、资源自动关闭或完整 M1/M2 验收。

## 终态提交身份与重试

事务 `txId` 是 domain 内不可复用的提交身份。成功结果携带 `commitSeq`（`TX_COMMITTED`
的 journal 序号）；同一 `txId` 再次 commit 直接返回持久结果，不重新验收、应用文件或清理资源。
即使主目录随后改变，重试仍返回历史发布事实，不能据此断言当前文件仍有效。

```ts
const receipt = supervisor.getWorkspaceCommitResult(tx.txId);
// undefined 表示没有持久成功记录，不代表没有写入：TX_COMMITTING 可能已部分应用。
if (receipt) console.log(receipt.txId, receipt.commitSeq);
```

查询只读，不依赖候选、快照或主目录仍存在，domain 关闭重开后身份不变。
已有 journal 从 TX_COMMITTED 与 TX_BEGUN 恢复原验证方式、读写集和读追踪声明。
已中止事务不能提交，已冲突事务仍需从当前世界重新准备。

| 状态 / 输入 | 返回与重试 | 资源归属 |
| --- | --- | --- |
| 尚无 TX_COMMITTED 的查询 | undefined；不得推断未发布 | 保留事务及恢复来源，按现有 committing 协议处理 |
| 已持久提交后同 txId 重试 | 原结果和相同 commitSeq；忽略新传回调 | 不再触碰文件，不自动重新清理 |
| 文件发布成功、随后清理抛错 | 首次调用仍抛清理异常；查询或重试可取成功凭据 | 遗留 fork 由宿主核对引用后回收，基线继续保留 |
| 已中止后提交 | 拒绝，不生成提交凭据 | 沿用中止后的资源记录 |

成功凭据只证明文件发布已落盘记录，不等于 checkpoint 绑定成功或资源已回收。
统一 close 的可查询清理状态与独立 key 绑定属于后续 M1 契约，不用重复文件发布补偿清理失败。
