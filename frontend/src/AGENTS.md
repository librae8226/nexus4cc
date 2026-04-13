# AGENTS.md — Frontend Source

**Parent:** `./AGENTS.md`

## OVERVIEW

React 18 PWA 前端，xterm.js 终端 + 触摸交互 + i18n。

## STRUCTURE

```
frontend/src/
├── Terminal.tsx        # 主终端（~2000行），WebSocket+双Effect
├── Toolbar.tsx         # 可配置软键盘（固定行+展开区）
├── TabBar.tsx          # tmux window标签导航
├── SessionManager*.tsx # Project/Channel管理面板
├── Workspace*.tsx      # 文件浏览器/目录选择器
├── i18n/ + locales/    # 国际化（zh-CN/en）
└── toolbarDefaults.ts  # 工具栏按键定义
```

## WHERE TO LOOK

| 任务 | 文件 |
|------|------|
| 终端渲染/输入 | `Terminal.tsx` (lines 758-1252: Effect A/B) |
| WebSocket连接/重连 | `Terminal.tsx` (lines 1155-1251) |
| 触摸手势/滑动 | `Terminal.tsx` (lines 945-1073) |
| 工具栏配置 | `Toolbar.tsx` + `toolbarDefaults.ts` |
| 窗口切换UI | `TabBar.tsx` |
| Project列表 | `SessionManagerV2.tsx` (~1200行) |
| 文件浏览 | `WorkspaceBrowser.tsx`, `FilePanel.tsx` |

## CONVENTIONS

- **双Effect模式**: Effect A创建xterm实例，Effect B管理WebSocket连接
- **ref同步**: 状态变更立即同步到ref（如 `activeTmuxSessionRef.current = activeTmuxSession`）
- **触摸阈值**: `TAP_THRESHOLD = 8`, 水平滑动 `>60px`
- **localStorage缓存**: session/window/theme/fontSize
- **PWA ServiceWorker**: `public/sw.js` cache-first

## ANTI-PATTERNS

- **禁止** 在 Effect A/B 外直接操作 xterm 实例
- **禁止** localStorage 存储无效session名（如 `~`）
- **禁止** 状态更新后不同步ref（会导致 WebSocket 重连失败）

## NOTES

- iOS键盘: 用隐藏input触发，非xterm textarea
- 窗口切换: swipe horizontal 或 TabBar click
- IME支持: keydown不拦截可打印字符，让xterm原生处理