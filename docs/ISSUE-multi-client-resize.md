# Issue: 多客户端 Resize 导致 tmux 布局混乱

**日期**: 2026-04-13  
**发现场景**: PC 端打开多 pane 布局后，手机端连入导致 PC 布局破坏，手机也显示异常

---

## 问题描述

PC 上在 tmux window 中创建多个 pane（如 4×4 网格）后：

1. 手机打开同一 channel → 手机端显示混乱（pane 极窄，文字换行错乱）
2. 手机操作后再切回 PC → PC 端布局也被破坏

截图存于：`data/uploads/2026-04-13/pane-pc.png`、`pane-mobile.jpg`

---

## 根因分析

### 架构现状

```
ptyMap: "session:windowIndex" → { pty, clients: Set<ws>, clientSizes: Map }
```

每个 tmux window 对应**一个共享 PTY 进程**（`tmux attach-session -t session:N`），所有 WebSocket 客户端共用同一个 PTY entry。

### 问题触发链

1. PC 连接 → PTY spawn，resize 到 PC 尺寸（如 220×50）
2. tmux 按 220 列排布多 pane 的 layout
3. 手机连接 → 复用同一 PTY entry，发送 resize `{cols: 80, rows: 35}`
4. **`server.js:1751` 直接执行** `ent.pty.resize(80, 35)` → 发 SIGWINCH 给 tmux
5. tmux 收到终端变小 → 按比例重新计算所有 pane 的绝对尺寸 → layout 破坏
6. PC 也收到 tmux 重绘后的输出 → PC 看到乱掉的布局

手机断开时，on-close 逻辑（`server.js:1768`）按 **min size** resize，比连接时更糟。

### 核心矛盾

> **一个 tmux window 共用同一个 PTY → 所有客户端共享同一个终端尺寸 → 任何一个客户端 resize 都影响全局 tmux layout。**

---

## tmux Linked Session 机制说明

`tmux new-session -t base` 创建的 linked session 特性：

| 特性 | 说明 |
|---|---|
| 共享 windows | 同一批 window/pane 内容、运行中的程序 |
| **各自独立的终端尺寸** | ✅ resize 互不干扰 ← 解决问题的核心 |
| **各自独立的 pane 布局尺寸** | ✅ 布局按各自 session 的终端尺寸独立计算 |
| **各自独立的 active pane 焦点** | ✅ 各客户端可以独立切换 pane 焦点 |
| 各自独立的激活 window | ✅ 各客户端可以独立切换 tab |
| zoom 状态共享 | ⚠️ `C-b z` 是 window 级别属性，会影响所有 session |
| pane 分割结构共享 | pane 的增删、内容是全局共享的 |

**关键约束**：`tmux attach-session` 永远显示整个 window（含所有 pane），无法只 attach 到单个 pane。

**关于布局独立性的验证**：

```
PC   linked session（220×50）→ window 3 的 4 个 pane 各约 53 列
手机 linked session（80×35）  → 同一 window 3，4 个 pane 各约 19 列
```

两者的布局计算独立进行，互不影响。这是 linked session 的根本价值。

---

## 方案分析

### 方案 A：改 resize 策略为"最大客户端尺寸"（已排除）

- ✅ 改动极小（~5 行），PC 布局完全不受手机影响
- ❌ 手机看到的终端宽度超出屏幕，右侧内容被截断，接力场景体验差

### 方案 B：每个 WebSocket 连接独立 tmux linked session

#### B1：Linked Session，Mobile 照显所有 pane

- ✅ PC 完全不受手机影响
- ❌ 手机多 pane 时每个 pane 宽度极小（约 19 列），基本不可用

#### B2：Linked Session + Mobile 端 pane 选择 + 自动最大化（推荐）

在手机的 linked session 里，服务端对活跃 pane 执行 resize，使其占据手机屏幕 ~90% 宽度，其余 pane 压缩为细条：

```bash
# 仅在手机的 linked session 里执行，不影响 PC
tmux resize-pane -t nx-mobile-uuid:{window}.{pane} -x 72   # 80列中的72
```

手机端增加 pane 导航按钮（`◀ ▶`），切换后重新 maximize 新 pane。

```
PC 视图（220列）：               手机视图（80列，同一 window）：

┌──────┬──────┬──────┐           ┌───────────────────────────┬──┐
│pane0 │pane1 │pane2 │           │                           │  │
├──────┼──────┼──────┤           │   pane 2（活跃，~72列）   │p1│
│pane3 │pane4 │pane5 │           │                           │  │
└──────┴──────┴──────┘           └───────────────────────────┴──┘
各约 70 列，正常工作               ◀ Pane 2/6 ▶   （工具栏导航）
```

- ✅ PC 完全不受影响
- ✅ 手机活跃 pane 可正常使用（~72 列）
- ✅ 其他 pane 以细条形式保留（上下文感知）
- ✅ 导航按钮可切换焦点

#### 已排除方案

| 方案 | 原因 |
|---|---|
| `resize-pane -Z`（zoom）| zoom 状态 window 级共享，会影响 PC |
| `break-pane` | 会从原 window 移走 pane，破坏 PC 布局 |
| `new-window + pipe-pane` 镜像 | 只读，失去交互性 |
| `send-keys` 模拟交互 | 无法可靠处理 vim/htop 等交互程序的 escape 序列 |

---

## 推荐方案：B2（Linked Session + Mobile Pane 自动最大化）

### 设计决策

**PC 和手机是不同的交互范式：**

| 维度 | PC | 手机 |
|---|---|---|
| 注意力模型 | **空间型**（多 pane 同时可见） | **时序型**（一次聚焦一件事） |
| 适合操作 | 多进程监控、分屏比较、复杂布局 | 续接单一任务、查看输出、发指令 |

手机不需要显示完整的多 pane 布局，只需要能接力当前活跃 pane。

### 接力场景流程

```
PC 工作中 → pane 2 聚焦（window 3）
              ↓
手机连接 → 创建 linked session nx-xyz（80×35）
           继承 tmux 焦点 → 自动聚焦 pane 2
           服务端 resize-pane → pane 2 占手机屏 ~90%
           用户续接，正常打字
              ↓ （可选）
手机切换 → 工具栏 ◀ ▶ → select-pane → 重新 maximize 新 pane
              ↓
回到 PC → PC linked session 从未被动过，布局完好
          pane 2 内容已更新（同一 tmux pane 在运行）
```

### 改动范围

**Server（~60 行）：**

- `ensureWindowPty` 改为 per-connection linked session
- 连接时：`tmux new-session -d -s "nx-{uuid}" -t {base} -x {cols} -y {rows}`
- 手机连接多 pane window 时：`resize-pane` 最大化活跃 pane（仅在该 linked session 内）
- 断开时：`tmux kill-session -t "nx-{uuid}"`
- ptyMap key 改为含 clientId（per-connection）

**Frontend（~40 行）：**

- 新增 `/api/sessions/:id/panes` 接口（`tmux list-panes` 输出）
- 手机端（`window.innerWidth < 768`）工具栏新增 `◀ pane ▶` 导航按钮
- 导航触发时：调用新增的 `POST /api/pane/select` → 服务端执行 select-pane + resize-pane

**不改变的东西：**

- PC 端交互模型完全不变
- Channel 概念不变（仍是 tmux window）
- 前端路由、认证、TabBar 逻辑不变

---

## 待决事项

- [ ] 确认实施方案后开始编码
- [ ] linked session 命名冲突处理（同一用户多标签页）
- [ ] linked session 泄漏处理（ws 意外断开未 cleanup，需要定时 GC）
- [ ] 手机端 pane 检测时机（连接时查一次 + window 切换时更新）
- [ ] pane 导航 API 设计（`POST /api/sessions/:session/windows/:window/panes/:pane/select`）
- [ ] 多 pane window 下手机端 resize-pane 的触发条件（连接时 / 切换 window 时 / 切换 pane 时）
