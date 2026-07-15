# ROADMAP — Nexus

**锚点**: `docs/NORTH-STAR.md` | **PRD**: `docs/PRD.md` | **更新**: 2026-07-15

---

## v1.0 Released (2026-04-01)

F-01 to F-12, F-15, F-18 complete.（F-13/14/16/17 已移除，F-19/F-20 提前完成）

## v2.0 Backlog

---

| Open-source polish | Git history rewrite, rate limits, etc. |
| History mode redesign | In-place swap 方案（见 `docs/HISTORY_MODE_REDESIGN.md`） |
| ANSI output in file viewer | 文件内容 ANSI 渲染 |

---

## v1 Complete (F-01 to F-18)

| Feature | Commit |
|---|---|
| **F-21 独立文件上传** | `dev` — 上传到 `data/uploads/日期/` 目录；API: `POST /api/files/upload`, `GET /api/files`, `DELETE /api/files/:date/:filename`；前端: 拖拽上传+粘贴图片+文件选择+文件列表面板；终端显示上传路径 |
| WebSocket tmux 桥 + JWT 认证 | `48c13ca` |
| xterm.js + 移动端滚动/缩放 | `48c13ca` |
| 可配置工具栏（服务端持久化） | `3bf29f9` |
| Session 管理 UI + API | `9eb36fc` |
| DELETE /api/sessions/:id | `48e3725` |
| claude 配置路径修复 | `dcb4836` |
| 窗口切换/会话创建修复 | `622096a` |
| 关闭后保持窗口 | `9b9dacf` |
| claude -c 会话历史自动检测 | `e676766` |
| 移动端底导航（BottomNav.tsx） | `fb21eee` |
| 主题跟随系统 + CSS vars 修复 | 本会话 |
| 加载遮罩 + 窗口切换 race 修复 | 本会话 |
| 登录页主题适配 CSS vars | 本会话 |
| 移动端上传入口（TabBar 📎）| 本会话 |
| F-15 Agent 状态指示器（运行中绿点）| 本会话 |
| F-11 独立 Window PTY | 本会话 |
| 前端 Code-splitting（lazy load 面板）| 本会话 |
| 窗口重命名（TabBar/Sidebar/BottomNav）| 本会话 |
| WebSocket 指数退避重连 | 本会话 |
| 滚动位置记忆（窗口切换）| 本会话 |
| 点击终端聚焦输入框 | 本会话 |
| 复制终端内容按钮 | 本会话 |
| F-15 完整状态卡片 — Tab 悬浮输出预览 | 本会话 |
| 修复：窗口不存在时自动 fallback | 本会话 |
| 优化：响应式断点 1024px→768px | 本会话 |
| 修复：WebSocket 无限重连循环（intentionalClose flag）| 本会话 |
| 修复：移动端 terminal 不填满高度（display:flex）| 本会话 |
| 优化：in-place WS 重连（不刷新页面，指数退避）| 本会话 |
| 修复：初始空状态闪烁（windowsLoaded guard）| 本会话 |
| F-15 完整：动态 Agent 状态（运行/等待/shell）| 本会话 |
| TabBar 移动端 session 切换（多 session 时显示）| 本会话 |
| 动态页面标题（显示窗口名+状态图标）| 本会话 |
| 浏览器通知 | `016771b` |
| 浮动「回底部」按钮（term.onScroll 追踪）| `d2f73f6` |
| 优化：xterm/WS 双 Effect 分离（窗口切换无抖动）| `dcac810` |
| 修复：多客户端 resize 改用最小尺寸策略 | `3b56134` |
| PWA：注册 Service Worker + SVG 图标 | `793543c` |
| 跟随系统深色/浅色模式自动切换 | `3f736a0` |
| 布局：100dvh 修复 iOS Safari 高度 | `3f736a0` |
| 任务取消按钮（AbortController + SIGTERM）| `34d9f0f` |
| 工具栏新增 ^Z / ^A / ^E 快捷键 | `19e7cb1` |
| F-18 多 tmux session 支持 | 本会话 |
| 修复：窗口切换时滚动位置恢复（userScrolledRef 保持）| `aab1aaf` |
| 移动端水平滑动切换 tmux 窗口 | `5f33934` |
| fix(perf): 消除 TabBar 重复轮询（统一从 Terminal.tsx 传入） | `b754914` |
| refactor: 抽取 windowStatus.ts，消除 Terminal/TabBar 重复定义 | `044c542` |
| fix(toolbar): ctrl-a/ctrl-e/ctrl-z 加入出厂展开列表 | `a8c4e6b` |
| fix(pwa): 仅缓存静态资源，跳过 index.html（修复构建后 404） | `c31cc20` |
| fix(mobile): GhostShield 全局幽灵点击防护（所有 overlay） | `ff542a0` |
