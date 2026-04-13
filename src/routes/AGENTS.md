# AGENTS.md — API Routes

**Parent:** `src/AGENTS.md`

## OVERVIEW

Express API路由层，工厂模式注入依赖。

## STRUCTURE

```
src/routes/
├── auth.js        # POST /api/auth/login
├── config.js      # GET /api/config, toolbar-config
├── projects.js    # /api/projects CRUD + channels
├── sessions.js    # /api/sessions window管理
├── tasks.js       # /api/tasks SSE流式任务
├── workspace.js   # /api/workspace 文件CRUD
├── files.js       # /api/files 上传管理
```

## WHERE TO LOOK

| Endpoint | 文件 | 行号 |
|----------|------|------|
| 登录认证 | auth.js | POST /api/auth/login |
| 项目列表/创建 | projects.js | GET/POST /api/projects |
| Channel管理 | projects.js | :name/channels |
| 窗口列表/切换 | sessions.js | GET /api/sessions |
| 任务提交(SSE) | tasks.js | POST /api/tasks |
| 文件浏览 | workspace.js | GET /api/browse |

## CONVENTIONS

- **路由工厂**: `export function createXxxRouter(deps)`
- **authMiddleware**: 每个路由先 `router.use(authMiddleware)`
- **rateLimit**: 可选，API路由加 `apiLimiter`
- **async handlers**: try/catch + res.status(500).json({error})

## ANTI-PATTERNS

- **禁止** 在路由内直接调用 exec/execSync → 用 tmuxService
- **禁止** 跳过 authMiddleware

## NOTES

- deps注入: `{ tmuxService, ptyManager, taskStore, config }`
- 新API优先放routes，旧API在server.js逐步迁移