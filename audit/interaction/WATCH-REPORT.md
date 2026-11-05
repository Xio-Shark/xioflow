# 关注状态订阅实验结果

2026-11-03。18 个场景运行，每个同时比较三组，共 54 个观察器运行。每个场景重复三次并轮换初始化顺序。

假设与对照在 [WATCH-PROTOCOL.md](WATCH-PROTOCOL.md) 中预先记录。以下为三个重复的观测范围，包含初始读取与初始通知。

| 场景 | 模式 | 真实读取次数 | 调用方通知数 | 通知字节 |
| --- | --- | ---: | ---: | ---: |
| idle | agent-poll | 23 | 23 | 6181 |
| idle | server-poll | 23 | 1 | 271 |
| idle | watch-view | 6 | 1 | 271 |
| irrelevant-writes | agent-poll | 24 | 24 | 6450 |
| irrelevant-writes | server-poll | 24 | 1 | 271 |
| irrelevant-writes | watch-view | 11 | 1 | 271 |
| relevant-writes | agent-poll | 24 | 24 | 6439 |
| relevant-writes | server-poll | 24 | 7 | 1876 |
| relevant-writes | watch-view | 11 | 7 | 1882 |
| replacement-burst | agent-poll | 13 | 13 | 3483 |
| replacement-burst | server-poll | 13 | 4 | 1073 |
| replacement-burst | watch-view | 8 | 4 | 1076 |
| dropped-hints | agent-poll | 18 | 18 | 4824 |
| dropped-hints | server-poll | 17–18 | 4 | 1073 |
| dropped-hints | watch-view | 4 | 4 | 1088 |
| noise-slow-poll | agent-poll | 7 | 7 | 1879 |
| noise-slow-poll | server-poll | 7 | 1 | 271 |
| noise-slow-poll | watch-view | 12 | 1 | 271 |

## 结果判读

系统侧去重轮询与事件订阅都能避免把未变化的查询结果反复发给调用方。因此不能将消息减少全部归因于 OS 事件。事件订阅的独立作用是改变何时扫描，收益随更新频率、轮询间隔和重同步周期变化。noise-slow-poll 特意采用低频轮询与高频无关变化，检验事件方案增加扫描的可能。

本轮轮询与定期核对的间隔不同，没有在相同发现延迟或新鲜度要求下比较成本，也没有测量逐次变化的发现延迟。较少读取不能直接解释为同等服务质量下更高效；下一轮需要联合报告延迟、遗漏与开销。

所有阶段末的投影视图与独立文件读取相符。人为丢弃提示时通过定期核对恢复。数据无效、恢复、原子替换与关闭行为另由测试覆盖。每个观察器已关闭，关闭后检查没有新增读取或消息；所有临时文件已清理。

这些是本机文件系统上的确定性兴趣声明实验，没有模型决策收益证据。订阅维护当前状态，不保证看到每个短暂中间状态；这里每次重算视图，也不是 Differential Dataflow 的实现。原始轨迹、参数、环境和源码哈希在 [watch.json](results/watch.json)。

## 复现

`node --test audit/interaction/view-watch.test.mjs`

`node audit/interaction/watch-benchmark.mjs`
