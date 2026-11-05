# 真实进程等待对照

wait-v1，2026-11-03。依赖 process-v1 的身份、事实、独立评分与清理。先做确定性时序校准，再执行模型 pilot，正式阶段只使用冻结参数。

## 对照与时序

三组为 agent-poll、server-poll、event-view，使用相同采样器、字段、目标与独立评分。Agent 组可选择 inspect 的采样前等待；其余两组增加 watch，条件由调用方给出，系统重复检查。两种系统等待返回同样的 initial/changed/condition_met/exited/timeout 语义。事件仅触发重读，没有增量算子或可靠事件历史保证。

脚本层轮询间隔和事件核对周期均为 50 ms；无额外合并延迟，目录事件可提前触发采样。预声明最终状态发现延迟上限为 200 ms，报告所有超限和 p50/p95，不把模型推理时延算作系统采样时延。事件提示全部丢失的场景仍靠 50 ms 核对收敛；相同核对频率下事件可能增加扫描，这一反例必须保留。

6 个开发 + 6 个保留任务，每组 3 次重复，共 108 个脚本 episode。时序相对首次有效观察启动，基本 tick=60 ms，保留集乘 1.25；deadline=3000 ms。记录所有中间样本、实际进程变更时间和调用方收到结果时间。发现延迟按目标最终 ready/configCurrent 或真实退出的事实时间计算；未测全事件历史覆盖率。

## 模型协议

模型只接收自然语言目标、字段说明、工具 schema 和 deadline。它自行构造 where/until，决定继续查询、等待或提交；工具实现没有正确关注谓词。每组都有 inspect、日志读取与 submit，系统等待组增加 watch；这是等待职责分配的对照，额外工具说明成本完整计入。

pilot 为 dev-01、dev-03、dev-04 × 3 组各一次，共 9 个 episode，单独评分。初始模型 tick=2000 ms，保留变体乘 1.25，最大宿主等待10秒，任务 deadline=120秒，episode总上限180秒。实际变化在首次观察后2–6秒发生，避免把模型首次读取前已就绪的情况当作等待实验；这些短任务未必需要持续等待多个模型轮次。

请求使用现有 ClinePass 的 deepseek-v4.1-flash-1017，temperature=0、max_tokens=2048、每请求45秒、最多12次模型请求和24次工具调用。正式矩阵为 (6 dev + 6 heldout) × 3组 × 3次重复 = 108；按任务区组轮换组顺序。未执行、无提交、服务错误和预算终止单列；不重试失败 episode。

## 费用与证据

与旧实验共用可写账本 results/model-20261103/budget.json、同一个 runner.lock。新批次累计上限 $1.5504097，总额仍 $5。先持久化预留，再请求；缺用量不填零。已知 HTTP 500 empty response content 保留完整预留及未完成 episode；其他未知计费、模型标签变化或配置变化停止后续模型调用。

首次新调用前冻结前541条请求账本及SHA256，旧报告通过 --historical 复现；可写账本不清零。每个新请求含 experiment、phase、taskId、arm、repetition，报告按请求ID归属，拒绝遗漏或重复归属。保存无凭证的原始请求、响应、源码快照、任务轨迹、独立判定和清理证据。

ClinePass 参考价核对于 2026-11-03：[官方说明](https://docs.cline.bot/getting-started/clinepass)，保守估价继续用峰值 input $0.30/M、output $1.20/M，忽略缓存折扣；它不是现金账单。调用格式依据[官方 Chat Completions](https://docs.cline.bot/api/chat-completions)。
