# xioflow (中文文档)

> **AI Agent 工作流与 DAG 任务编排引擎**  
> 专为 Claude Code、Cursor、OpenCode、Codex、Devin、DSH 打造的高内聚 AI 开发基础设施。

[English Documentation](./README.md) | 中文文档

---

## 💡 为什么需要 xioflow？

在使用 AI 辅助复杂工程开发时，开发者普遍面临四个系统性痛点：

1. **上下文漂移 (Context Drift)**：对话轮次增多后，大模型逐渐遗忘系统架构约束与业务边界。
2. **缺乏 DAG 调度 (No DAG Scheduling)**：多任务、多模块并行开发时缺少依赖图谱，造成代码互相踩踏与死锁。
3. **跨会话失忆 (Session Amnesia)**：关闭终端或新开会话后，无法迅速找回前序会话的调试日志与关键决策。
4. **规范与落地脱节 (Spec Desync)**：开发规约散落各处，模型往往按默认概率随意生成代码，破坏既有工程规范。

**xioflow** 将架构规约、DAG 任务状态机与跨会话记忆封装为开箱即用的工程底座，让 AI Agent 在清晰的轨道上自主推进、步步可溯。

---

## ⚡️ 核心特性

- 🌳 **DAG 任务与波次编排 (DAG Task Orchestration)**
  - 声明式依赖：支持 `depends_on` 依赖图构建与就绪状态拓扑计算。
  - 并发与隔离模式：原生支持 `worktree`（Git 独立工作树）与 `shared` 共享模式，避免多任务并发写冲突。
  - 规范三阶段推进：`Plan (规划需求与工件) -> Execute (靶向实施与质检) -> Finish (反思与规约沉淀)`。

- 📐 **架构规约按需注入 (Spec-Driven Architecture)**
  - 规约分级分层：按包（Package）与层级（Layer）组织指导文档与 Pre-dev Checklist。
  - 上下文自动化注入：在 Agent 编写代码前自动注入所属模块的规范，杜绝架构腐蚀。

- 🧠 **持久化记忆与跨会话回溯 (Persistent Memory & Session Journaling)**
  - 开发者独立 Workspace：按开发者自动记录会话日志（Journal）与索引。
  - 历史记忆检索：`xioflow mem` 支持对 Claude Code、Codex 等宿主的历史对话进行多维搜索与上下文提取。

- 🤝 **多 Agent 通信与协作通道 (Channel Runtime)**
  - 基于持久化事件日志的轻量 Channel 运行时，支持对 Worker Agent 的派生（Spawn）、监听（Watch）、中断（Interrupt）与状态同步。

- 🔌 **主流 AI 宿主原生适配**
  - 支持 **Claude Code**、**Cursor**、**OpenCode**、**Codex**、**Devin**、**DSH**，自动安装原生适配的命令与自动化 Hook。

---

## 📦 目录布局规范

```text
your-repo/
├── .xioflow/               # 工作流核心目录
│   ├── config.yaml         # 项目级配置
│   ├── spec/               # 架构与领域规范（分包/分层）
│   ├── tasks/              # 任务与 DAG 依赖编排节点
│   │   └── MM-DD-task-name/
│   │       ├── task.json   # 任务元数据（状态、depends_on、isolation）
│   │       ├── prd.md      # 需求与验收标准 (Acceptance Criteria)
│   │       ├── design.md   # 技术设计（复杂任务必备）
│   │       └── implement.md# 实施计划与验证门禁
│   ├── workspace/          # 开发者私有会话日志与索引
│   └── scripts/            # 状态流转与自动化辅助工具
└── packages/               # 业务代码
```

---

## 🚀 快速上手

### 1. 安装 CLI

```bash
# 全局安装 xioflow CLI (提供 xioflow 与 xf 双命令)
npm install -g xioflow

# 或通过本地源码构建
pnpm install && pnpm build
```

### 2. 初始化项目

在项目根目录下执行：

```bash
# 交互式初始化
xioflow init -u <your-name>

# 为指定工具生成配置
xioflow init --claude --cursor -u <your-name>
```

### 3. 任务管理流程

```bash
# 创建新任务（自动添加日期前缀）
python3 .xioflow/scripts/task.py create "用户权限体系重构" --slug auth-refactor

# 查看当前任务与状态
python3 .xioflow/scripts/task.py current

# 规划完成后启动任务（状态变更为 in_progress）
python3 .xioflow/scripts/task.py start auth-refactor

# 完成实施、验证后归档
python3 .xioflow/scripts/task.py archive auth-refactor
```

### 4. 声明 DAG 依赖

在任务的 `task.json` 中定义依赖：

```json
{
  "id": "order-api",
  "status": "planning",
  "depends_on": ["09-17-auth-refactor"],
  "isolation": "worktree",
  "priority": "P1"
}
```

在 `prd.md` 中双写记录：

```markdown
## Dependencies
- depends_on: `09-17-auth-refactor`
- isolation: `worktree`
```

---

## 🛠 本地开发构建

```bash
# 安装依赖
pnpm install

# 构建全量模块 (@xioflow/core + xioflow CLI)
pnpm build

# 执行自动化测试
pnpm test

# 静态类型检查
pnpm typecheck
```

---

## 📄 开源许可证

AGPL-3.0
