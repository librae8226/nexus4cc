# AGENTS.md — Backend Source

**Parent:** `./AGENTS.md`

## OVERVIEW

Node.js ESM 后端模块，Express路由 + 服务层 + PTY管理。

## STRUCTURE

```
src/
├── index.js           # 模块导出入口
├── config/env.js      # 环境变量加载+验证
├── routes/            # API路由（auth/config/projects/sessions/tasks/workspace/files）
├── services/          # 业务服务（tmuxService/taskService/fileService/telegramService）
├── middleware/        # 中间件（auth/validators/rateLimit）
├── pty/               # PTY管理（ptyManager/wsHandler）
└── utils/             # 工具函数（shell/logger）
```

## WHERE TO LOOK

| 任务 | 文件 |
|------|------|
| 添加API路由 | `src/routes/*.js` |
| tmux操作 | `src/services/tmuxService.js` |
| PTY管理 | `src/pty/ptyManager.js` |
| WebSocket处理 | `src/pty/wsHandler.js` |
| JWT认证 | `src/middleware/auth.js` |
| 输入验证 | `src/middleware/validators.js` |
| 环境配置 | `src/config/env.js` |
| shell安全执行 | `src/utils/shell.js` |

## CONVENTIONS

- **路由工厂模式**: `createXxxRouter(deps)` 注入依赖
- **服务类**: `class TmuxService` with async methods
- **安全execFile**: 所有shell命令用 `execFile('tmux', [args])`
- **session名验证**: `SESSION_NAME_REGEX = /^[A-Za-z0-9._~-]+$/`
- **ESM imports**: 相对路径必须包含 `.js` 后缀

## ANTI-PATTERNS

- **禁止** shell interpolation → 必须用数组参数
- **禁止** session名含 `~` 或特殊字符
- **禁止** 在服务层直接操作PTY（通过ptyManager）

## NOTES

- 依赖注入: 路由从server.js接收 `{ tmuxService, ptyManager, config }`
- 环境验证启动时执行: JWT_SECRET/ACC_PASSWORD_HASH 必须