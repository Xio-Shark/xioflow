# 真实进程任务协议

process-v1，2026-11-03。P1 实现前冻结任务语义；运行参数、源码身份和时序另存每轮 manifest。服务是受控实验程序，结果不外推到任意生产服务。

## 事实与任务

每次运行创建独占临时目录、真实 Node 子进程、loopback 动态端口、配置文件和日志。实例由随机 runId、子进程句柄和启动时间共同识别；名称、环境是查询属性，不是进程身份。目标为指定名称与环境的当前实例，同名干扰实例使用另一环境。

HTTP `/state` 返回进程身份、ready、加载配置版本及实际 setting；`/ready` 用 200/503 区分就绪。配置文件携带 revision 和 setting。日志可在探针就绪前声称 ready；进程存活、文件写入成功或 reload 回执不证明目标完成。

六类任务为 delayed、misleading-log、config-change、exit、replacement、lost-hints。每类有 dev 与 heldout 变体，名称、环境、初始值和相对首次观察的时序不同。控制器知道场景和目标；观察实现只接受运行实例及调用者查询，不接受正确谓词或正确答案。

## 终局与证据

调用方提交 outcome、instanceId、evidenceId。每份实际观察保存完整返回行和状态指纹；独立检查器重新通过 HTTP、配置文件和父进程持有的退出事实核对，不复用观察器计算出的 ready 或 configCurrent。

- ready：是目标当前实例，进程仍存在，真实探针就绪，实际加载 revision 与文件一致，setting 一致；证据中的实例与这些事实一致。
- exited：目标当前实例实际退出，且证据记录该事实；不能把 HTTP 失败猜成退出。
- timeout：任务 deadline 已过、实例仍存在、目标未就绪，证据真实；不是忽略错误的通用成功。
- unavailable：探针当前不可访问但进程仍存在，证据明确不可用；不是空成功或进程退出。

预期 exit 场景以 exited 为正确终局，其余正常场景以 ready 为正确终局。timeout 与 unavailable 的专项测试使用对应预期场景。提交一次即终止评分；失败不提供正确答案供同一 episode 重试。无提交、超时或取消保留未完成状态。

## 生命周期与权限

只创建和管理本实验持有句柄的子进程；child 不继承 provider 凭证环境。父进程 IPC 断开时 child 退出，child 另有最长生存期限。关闭时取消场景定时器、停止监听、关闭观察器、终止 owned children、等待 close、验证监听失效，再删除独占目录。启动中失败同样进入清理，不能仅把 killed 标志当作退出。

本层不是恶意代码的安全沙箱。配置写入将由同一控制器串行化；跨任意外部写者的原子 CAS 不在本协议保证内。

## P1 验收

所有 12 个正常任务可由正确客户端到达预期终局；提前 ready、错误环境、旧实例、旧配置证据、未采样提交和未达 deadline 的 timeout 均被拒绝。启动失败、取消、探针不可用、漏提示、关闭幂等和资源释放有独立测试。模型请求数为 0。

依据：Node 的 [child process 生命周期](https://nodejs.org/api/child_process.html)、[HTTP 服务](https://nodejs.org/api/http.html) 与 [fs.watch 限制](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)。文件事件只提示重新采样，周期核对负责漏提示后的收敛，不保证完整事件历史。
