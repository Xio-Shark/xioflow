# 真实进程环境验证

2026-11-03，process-v1。12/12 个确定性客户端任务通过独立检查，模型请求为 0。

覆盖真实子进程、HTTP 就绪探针、提前 ready 日志、配置变化、进程退出、同名干扰、实例替换与无关文件事件。全部子进程、端口和临时目录清理通过。专项错误与取消测试见 process-suite.test.mjs；本报告不是模型成功率。

原始轨迹与源码哈希见 [process-v1.json](results/process-v1.json)。相同新鲜度门禁下的后续对照见[WAIT-REPORT.md](WAIT-REPORT.md)。
