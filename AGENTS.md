# AGENTS.md — Nexus4cc 知识库

**Generated:** 2026-04-13
**Commit:** 50c795f
**Branch:** feat/fiexed

## OVERVIEW

WebSocket/tmux 桥接服务，让 Claude Code 可从任意设备远程控制。Node.js ESM 后端 + React PWA 前端。

## STRUCTURE

```
nexus4cc/
├── server.js           # 单文件后端入口（~1775行），Express+WS+PTY+Tasks
├── src/                # 后端模块化拆分（routes/services/middleware）
├── frontend/src/       # React PWA 前端，xterm.js 终端 + 触摸交互
├── tests/              # Jest 单测（ESM 模式）
├── scripts/setup.js    # 自动化部署脚本（PM2+tmux）
├── docs/               # 架构文档，锚点 NORTH-STAR.md
└── data/               # 持久化（toolbar config、claude profiles、tasks）
```

## WHERE TO LOOK

| 任务 | 位置 | 说明 |
|------|------|------|
| 添加 API endpoint | `src/routes/*.js` 或 `server.js` | 路由层分离进行中，新API优先放routes |
| 修改 PTY/WebSocket | `src/pty/ptyManager.js` + `wsHandler.js` | 多PTY架构，每session:window独立实例 |
| 认证逻辑 | `src/middleware/auth.js` | JWT + bcrypt，支持Bearer和cookie |
| 前端终端交互 | `frontend/src/Terminal.tsx` | xterm.js + 双Effect模式 + 触摸手势 |
| tmux 操作 | `src/services/tmuxService.js` | 安全execFile封装，session名验证 |
| 工具栏配置 | `frontend/src/Toolbar.tsx` + `toolbarDefaults.ts` | 可配置软键盘 |
| 添加测试 | `tests/unit/*.test.js` | Jest + setup.js 环境注入 |

## CODE MAP

| 模块 | 文件 | 行数 | 角色 |
|------|------|------|------|
| Terminal | frontend/src/Terminal.tsx | ~2000 | 主终端组件，WebSocket+PTY交互 |
| TmuxService | src/services/tmuxService.js | 264 | tmux命令安全封装 |
| PtyManager | src/pty/ptyManager.js | 174 | PTY实例管理，idle清理 |
| AuthMiddleware | src/middleware/auth.js | 97 | JWT验证，cookie支持 |

## AI INTERACTION

- **全程使用中文回复**: AI 智能体与用户交互时必须使用中文，包括解释、说明、状态报告等所有输出
- **代码注释**: 代码中的注释可以使用中文或英文，但面向用户的说明必须是中文

## CONVENTIONS

- **ESM everywhere**: `"type": "module"`，import/export 语法
- **手动 .env 加载**: server.js 直接解析，src/config/env.js 使用 dotenv
- **安全 shell 执行**: 禁止 shell interpolation，用 execFile(args array)
- **tmux session名验证**: `SESSION_NAME_REGEX = /^[A-Za-z0-9._~-]+$/`
- **React组件 PascalCase**: `Terminal.tsx`, `WorkspaceSelector.tsx`
- **后端模块 camelCase**: `tmuxService.js`, `authMiddleware`

## ANTI-PATTERNS

- `TMUX_SESSION` 默认值 **禁止用 `~`**（tmux特殊字符，会创建僵尸会话）
- **禁止** `as any`, `@ts-ignore`, `@ts-expect-error`
- **禁止** 空 catch块 `catch(e) {}`
- **禁止** shell interpolation: `exec('tmux ' + session)` → 必须用 `execFile('tmux', [args])`

## COMMANDS

```bash
# 开发
npm run dev           # node --watch server.js

# 前端
cd frontend && npm run build

# 测试
npm test              # Jest + ESM experimental-vm-modules

# 部署
node scripts/setup.js # 自动安装+构建+PM2启动

# 重启服务
pm2 restart nexus
```

## NOTES

- 部署后必须重启 nexus 服务并验证可访问性
- 默认密码 nexus123，生产环境务必修改 `.env`
- 前端 dist 由 Vite 构建，server.js 静态伺服
- 无数据库：会话状态从 tmux 实时读取，持久化用 JSON 文件

## Deployment Constraints

- Deployments require a service restart: restart the **nexus** service after deploying code changes.
- After restart, verify the service is accessible. If the service becomes unreachable after deployment, **rollback** the deployed code to the previous version immediately.
