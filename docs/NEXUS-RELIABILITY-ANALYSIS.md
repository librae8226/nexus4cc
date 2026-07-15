# Nexus 高可用与 Claude Profile 启动流程分析

> **注意**: 本文撰写于 2026-04-02，其中引用的行号基于旧版 server.js（当时约 1775 行，现已缩减至 1573 行），大部分行号引用已失效。建议的 `process.on('uncaughtException')`、`process.on('unhandledRejection')`、PM2 `max_restarts`/`max_memory_restart` 等防护措施截至 2026-07-15 尚未实施。CLAUDE_CONFIG_DIR 已清空解决 profile 混用问题。

**日期**: 2026-04-02 | **更新**: 2026-07-15
**分析范围**: nexus 服务防挂/自恢复机制 + nexus 目录下 Claude profile 启动链路

---

## 1. 执行摘要

1. **nexus 服务已重启 102 次**，PM2 配置过弱，且 `server.js` 缺少全局异常捕获和端口占用处理。
2. **nexus 目录下启动 "anthropic" profile 仍走 kimi 模型**的根因：
   - `CLAUDE_CONFIG_DIR=/mnt/c/Users/libra/work/nexus/.claude-data` 被注入到 nexus → tmux → claude 的完整链路中
   - `.claude-data` 目录下**没有 Anthropic 登录凭证**（`.credentials.json` 缺失）
   - `data/configs/anthropic.json` 的 `API_KEY` 和 `AUTH_TOKEN` 为空
   - claude CLI 读不到官方 API 凭证，只能回退/复用本地历史中残留的 kimi 配置
3. 存在**三条完全不同的 claude 启动路径**，每条路径使用的脚本和配置来源不同。

---

## 2. Nexus 服务启动链路与脆弱性分析

### 2.1 启动链路（从系统到进程）

```
systemd (pm2-<user>.service)
  └── PM2 God Daemon
        └── nexus (node server.js, pid 72736)
              └── tmux server
                    └── tmux windows (zsh / claude instances)
```

### 2.2 Layer 1 — systemd

- **文件**: `/etc/systemd/system/pm2-<user>.service`
- **配置**:
  - `Type=forking`
  - `Restart=on-failure`
  - `ExecStart=pm2 resurrect`（从 `~/.pm2/dump.pm2` 恢复进程）
- **现状**: 当前状态为 `inactive(dead)`。PM2 daemon 更可能来自**交互式 shell 会话启动**，而非 systemd 开机自启。这意味着如果 WSL2 彻底关机或用户会话退出，nexus **不会自动恢复**。

### 2.3 Layer 2 — PM2

- **文件**: `/mnt/c/Users/libra/work/nexus/ecosystem.config.cjs`
- **当前配置**:
  ```js
  module.exports = {
    apps: [{
      name: 'nexus',
      cwd: '/mnt/c/Users/libra/work/nexus',
      script: 'server.js',
      env: { PORT: 59000, NODE_ENV: 'production' },
    }],
  };
  ```
- **问题**:
  - 未显式配置 `max_restarts`、`min_uptime`、`max_memory_restart`、`kill_timeout` 等关键防护参数
  - 102 次重启主要是手动 `pm2 restart` 或 WSL 休眠恢复，而非 PM2 自动救活崩溃
- **现状评估**: PM2 是目前唯一的自动恢复层，但缺乏退避策略和内存泄漏保护。

### 2.4 Layer 3 — server.js 自身稳定性

- **优点**:
  - 启动时清理孤儿任务（把上次 `running` 状态标记为 `error`）
  - API endpoint 有 try/catch；WebSocket 有 `ws.on('error')`；断线后 5 分钟空闲清理 PTY
- **致命缺陷**:
  - **无全局 `process.on('uncaughtException')` / `process.on('unhandledRejection')`**
    - 如果 pty/ws 内部抛出未捕获异常，Node.js 进程会直接崩溃
  - **`server.listen()` 没有 error handler**
    - 端口 `59000` 被临时占用时，会抛 `EADDRINUSE` 并直接退出

### 2.5 Layer 4 — 独立生命线（ttyd Web 终端）

- **服务**: `claude-host-mnt-c-Users-libra-work-nexus.service`
- **特点**:
  - **完全独立于 PM2/nexus**
  - 运行 `ttyd` 提供 Web Terminal，直连 tmux 中的 claude
  - 配置了 `Restart=always`，`RestartSec=5`
- **意义**: 即使 nexus 完全挂掉，仍可通过浏览器访问 `55001` 端口的终端。

---

## 3. Claude Profile 启动流程（三条路径）

### 路径 A：Nexus Web UI / 终端内新建窗口（最常见）

**触发点**: 前端调用 `POST /api/windows` 或 `POST /api/sessions`

**后端处理** (`server.js:100-161`):
1. 收集代理变量（`CLAUDE_PROXY=http://127.0.0.1:6789`）
2. 构建 `shellCmd`:
   - **带 profile**: `bash "/mnt/c/Users/libra/work/nexus/nexus-run-claude.sh" <profile> <cwd>`
   - **不带 profile**: `claude --dangerously-skip-permissions; exec zsh -i`
3. 通过 `tmux new-window` 执行

**脚本** (`nexus-run-claude.sh`):
1. 读取 `/mnt/c/Users/libra/work/nexus/data/configs/${PROFILE}.json`
2. 提取 `BASE_URL`, `AUTH_TOKEN`, `API_KEY`, `DEFAULT_MODEL` 等字段
3. **仅当字段非空时才导出**对应的 `ANTHROPIC_*` 环境变量
4. 设置代理变量，执行 `claude --dangerously-skip-permissions`

**现有 profile 文件**:
| 文件 | 说明 |
|------|------|
| `data/configs/anthropic.json` | `DEFAULT_MODEL: claude-sonnet-4-6`，但 `BASE_URL`/`AUTH_TOKEN`/`API_KEY` 均为空字符串 |
| `data/configs/kimi.json` | 完整的 kimi 配置 |
| `data/configs/openrouter-grok.json` | 完整的 openrouter 配置 |
| `data/configs/openrouter-qwen.json` | 完整的 openrouter 配置 |

### 路径 B：TaskPanel / Telegram Bot（后台异步任务）

**触发点**: `POST /api/tasks` 或 Telegram webhook

**后端处理** (`server.js:1013-1052`):
```js
const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions']
if (profile) claudeArgs.push('--profile', profile)
spawn('claude', claudeArgs, {
  cwd,
  env: { ...process.env, ...proxyEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
})
```
- 使用 claude CLI 原生 `-p`（single-shot）模式
- `--profile` 直接传给 claude CLI
- 环境变量直接继承 `server.js` 的 `process.env`

### 路径 C：ttyd Web 终端（备用入口）

**触发点**: `claude-host-mnt-c-Users-libra-work-nexus.service`

**启动命令链**:
```
systemd
  └── ttyd -p 55001 ...
        └── tmux new-session ...
              └── zsh ~/scripts/run-claude-host-anthropic.sh
```

**脚本** (`run-claude-host-anthropic.sh`):
1. 初始化 fnm 环境
2. 尝试加载 `env.anthropic.example`
3. 硬编码默认模型回退: `DEFAULT_MODEL="${ANTHROPIC_MODEL:-kimi-for-coding}"`
4. 执行 `claude -c --dangerously-skip-permissions`

**注意**: 即使脚本名叫 "anthropic"，默认模型仍回退到 `kimi-for-coding`。

---

## 4. 根因分析：为什么 "anthropic profile" 实际成了 kimi

### 4.1 核心问题：`CLAUDE_CONFIG_DIR` 被污染式传递

**污染链路**:

```
交互式 shell (带 CLAUDE_CONFIG_DIR=/mnt/c/Users/libra/work/nexus/.claude-data)
  └── pm2 start/restart nexus
        └── nexus 进程 (pid 72736，环境变量中已证实包含 CLAUDE_CONFIG_DIR)
              └── tmux new-window
                    └── tmux 窗口内的 claude 进程
                          └── 强制读取 /mnt/c/Users/libra/work/nexus/.claude-data/ 作为配置根目录
```

### 4.2 凭证断层

| 配置目录 | `.credentials.json` | 使用情况 |
|---------|---------------------|---------|
| `~/.claude/` | **存在**，含 Anthropic pro OAuth token (`sk-ant-oat01-...`) | 全局默认登录 |
| `/mnt/c/Users/libra/work/nexus/.claude-data/` | **缺失** | nexus 目录下被强制使用 |

### 4.3 命令执行脚本不补全凭证

`nexus-run-claude.sh` 对 `anthropic.json` 的处理逻辑:
```bash
AUTH_TOKEN=$(cfg AUTH_TOKEN)  # 值为空字符串
if [ -n "$AUTH_TOKEN" ]; then
    export ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN"
fi
# 空字符串 → 不会导出环境变量
```

### 4.4 结果

claude CLI 在 `.claude-data` 目录下:
- 读不到官方 API 的 OAuth 凭证（`.credentials.json` 缺失）
- 读不到由环境变量注入的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
- 只能回退/复用 `.claude-data` 历史中的模型使用记录（大量 `kimi-for-coding`）
- 最终表现为：用户选择了 "anthropic" profile，实际运行的却是 kimi 配置

---

## 5. 修复方案

### 5.1 Nexus 服务高可用

1. **增强 `ecosystem.config.cjs`**
   ```js
   module.exports = {
     apps: [{
       name: 'nexus',
       cwd: '/mnt/c/Users/libra/work/nexus',
       script: 'server.js',
       autorestart: true,
       max_restarts: 10,
       min_uptime: '10s',
       max_memory_restart: '512M',
       kill_timeout: 5000,
       env: {
         PORT: 59000,
         NODE_ENV: 'production',
       },
     }],
   };
   ```

2. **`server.js` 增加全局异常捕获**
   - 在文件末尾、业务代码之后添加:
     ```js
     process.on('uncaughtException', (err) => {
       console.error('Uncaught Exception:', err);
       process.exit(1); // 让 PM2 安全重启
     });
     process.on('unhandledRejection', (reason) => {
       console.error('Unhandled Rejection:', reason);
       process.exit(1);
     });
     ```
   - 在 `server.listen()` 上加 error handler:
     ```js
     server.listen(Number(PORT), '0.0.0.0', () => { ... });
     server.on('error', (err) => {
       console.error('Server error:', err);
       process.exit(1);
     });
     ```

3. **确保 systemd 真正托管 PM2**
   - 验证 `pm2-<user>.service` 状态为 `active (running)`
   - 运行 `pm2 save` 确保 `dump.pm2` 包含 nexus
   - 如有需要，重新执行:
     ```bash
     sudo systemctl enable pm2-<user>
     sudo systemctl restart pm2-<user>
     ```

### 5.2 修复 nexus 目录下 Anthropic profile 启动

**推荐方案 A（最简单，立竿见影）**

在 `nexus-run-claude.sh` 开头增加:
```bash
unset CLAUDE_CONFIG_DIR
```
- 效果：强制所有 profile 使用默认的 `~/.claude/` 目录，那里已有有效的 Anthropic OAuth 凭证
- 副作用：会丢失 `.claude-data` 中项目级的 `MEMORY.md` 自动加载（但全局项目的 memory 仍可正常使用）

**推荐方案 B（保留本地配置根目录）**

将 `~/.claude/.credentials.json` **复制或软链接**到 `/mnt/c/Users/libra/work/nexus/.claude-data/`:
```bash
cp ~/.claude/.credentials.json /mnt/c/Users/libra/work/nexus/.claude-data/
```
- 效果：`.claude-data` 目录能使用 Anthropic 官方登录
- 风险：官方 OAuth token 刷新时，全局 `.claude/.credentials.json` 会更新，但副本不会自动同步

**长期方案（推荐执行一次）**

执行之前编写的 `MIGRATION_PLAN.md`：
1. 将 `.claude-data` 里的 nexus project memory、file history、session 合并到 `~/.claude/projects/...`
2. 彻底弃用 `CLAUDE_CONFIG_DIR` 的本地注入
3. 在启动 nexus 的 shell wrapper 中确保 `CLAUDE_CONFIG_DIR` 不被写入环境变量

---

## 6. 附录：关键文件路径

| 用途 | 路径 |
|------|------|
| nexus 后端入口 | `/mnt/c/Users/libra/work/nexus/server.js` |
| PM2 配置文件 | `/mnt/c/Users/libra/work/nexus/ecosystem.config.cjs` |
| nexus profile 启动脚本 | `/mnt/c/Users/libra/work/nexus/nexus-run-claude.sh` |
| nexus profile JSON 目录 | `/mnt/c/Users/libra/work/nexus/data/configs/` |
| systemd PM2 服务 | `/etc/systemd/system/pm2-<user>.service` |
| ttyd 备用终端服务 | `/etc/systemd/system/claude-host-mnt-c-Users-libra-work-nexus.service` |
| ttyd 启动脚本 | `~/scripts/run-claude-host-anthropic.sh` |
| 全局 Claude 配置 | `~/.claude/` |
| 全局 Anthropic 凭证 | `~/.claude/.credentials.json` |
| nexus 本地 Claude 配置 | `/mnt/c/Users/libra/work/nexus/.claude-data/` |
| 迁移计划文档 | `/mnt/c/Users/libra/work/nexus/.claude-data/MIGRATION_PLAN.md` |
