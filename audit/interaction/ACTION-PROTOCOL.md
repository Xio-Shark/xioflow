# 受限配置操作闭环

action-v1，2026-11-03，P3 协议。复用 process-v1 的真实服务、身份与状态观察；动作只影响实验实例，配置的 setting 为唯一可修改业务字段。

## 对照与任务

object 组调用 set_config、reload；command 组通过真实 Node CLI 子进程提供 config-set/config-reload 的 argv。CLI 只解析命令，再通过 IPC 使用同一个协调器；不是任意 shell，子进程启动开销计入总耗时。两组观察工具、可写对象、版本保护和最终检查相同，不将命令组故意置于无保护环境。

每次写入要求目标当前 instanceId 与 expectedRevision，协调器串行化自己的所有写操作。错误环境、旧实例、旧版本及非法 setting 拒绝；重复提交旧版本也拒绝。这不是跨任意外部写者的原子事务，也不承诺任意命令安全。

六类任务为 normal、conflict、replacement、exit、reload-reject、reload-noop，各有开发与保留变体。故障在首次有效观察后触发；conflict 和 replacement 应刷新后继续。进程退出、明确拒绝 reload 或接受后未生效则报告 blocked；不能把文件已写或 accepted 回执当作 applied。

目标是将指定名称、环境的当前实例 setting 调整为给定值并确认真实加载。submitted outcome 为 applied 或 blocked，并携带真实状态 evidenceId。独立检查器重新读配置和 HTTP 状态：applied 要求当前实例、真实就绪、文件和加载版本及值一致、值等于用户目标；blocked 要有实际退出或真实 reload 尝试未生效证据。错误结果一次性拒绝，不在同一 episode 内给答案重试。

## 验收与恢复

先验证 12 类变体 × 2 接口的确定性闭环以及错误对象、旧版本、实例替换、重复写、reload 假成功和资源清理。每次运行保留协调器动作与实际后置条件；无效写实际生效数量必须为 0。关闭前对存活的 owned 目标恢复初始 setting 并核对实际加载；已退出进程记录无需恢复运行态，随后统一关闭 CLI、服务和目录。

模型 pilot 3 个开发任务 × 2 组 = 6，正式 (6 dev + 6 heldout) × 2组 × 3重复 = 72；pilot 单列。模型、temperature、max_tokens、12模型轮、24工具调用、45秒请求与180秒 episode 上限沿用 P2。两组顺序轮换。公共进程代码沿用 P2 冻结版本，新增动作文件单独保存源码身份。

进入付费阶段前先分析 P2 实际余额，记录 P3 累计停止线；只使用原 $5 可写账本，不自动扩大 P2 的 $1 批次额度。跨模型、缓存与固定观察预算另列 P4，不混入本次两个接口的对照。
