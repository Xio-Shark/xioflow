# XIO-ISA v1 capability matrix

**Matrix schema:** `xio/capability-matrix/1`  
**Generated:** 2026-11-02  
**Checker:** `pnpm check:capability-matrix`

这份矩阵把平台前提、driver 声明和可运行证据放在同一格。`supported` 表示
默认可用，`conditional` 表示必须先满足明确的 host/helper/delegation 前提，
`unsupported` 表示构造或 admission 必须失败，不能静默换成另一个 driver。
矩阵描述的是 capability，不是业务成功；停止、恢复和回滚仍遵循
[driver contract](driver-contract.md) 的 unknown 规则。

| Platform / environment | Driver | Status | 可声明的关键能力 | 前提或 unsupported 证据 |
| --- | --- | --- | --- | --- |
| Linux / default | Node | supported | PGID、OS start time、gated spawn、外部进程表枚举；无 memory/pids hard limit | `src/driver/node-driver.ts`；identity/recovery tests |
| Linux / default | reaper | conditional | helper 持有树、`subreaper` tree settlement、gated spawn；无 cgroup hard limit | `ReaperPlatformDriver.isAvailable()`；缺 helper 构造直接失败 |
| Linux / delegated cgroup v2 | cgroup | conditional | cgroup containment、`populated=0` tree proof；memory/pids hard limit 依 delegated controllers | `CgroupPlatformDriver.unavailableReason()`；cgroup suite |
| Linux / no cgroup delegation | cgroup | unsupported | 不声明任何 cgroup capability | mount/delegation error，绝不 fallback |
| macOS / default | Node | supported | PGID、`ps lstart` start time、gated spawn；无 OS tree hard limit | identity/recovery tests |
| macOS / default | reaper | conditional | helper + tracked tree；逃逸且未被看到仍为 unknown | helper availability；reaper tests |
| macOS / default | cgroup | unsupported | 不声明 cgroup capability | Linux-only constructor error |
| Windows / unsupported platform | Node/reaper/cgroup | unsupported | Windows Job Object 方向未进入 v1 | Node 保守声明；reaper/cgroup 构造拒绝 |

每个矩阵单元的机器可读 evidence 路径保存在
[`capability-matrix.json`](capability-matrix.json)，检查器会拒绝缺少 status、
evidence、unsupported reason 或 conditional precondition 的条目。当前平台的
实际 driver 仍需以运行时 `capabilities` 和 availability probe 为准；Linux
单机 green 不外推为 macOS/cgroup delegated green。
