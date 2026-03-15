# Nexus — AI Agent 终端面板

**版本**: v1.0.0  
**状态**: Draft  
**最后更新**: 2026-03-15

---

## 一句话定义

Nexus 是 ttyd 的极简替代：一个 WebSocket 桥接 tmux，加一个解决移动端交互问题的自定义前端。

---

## 解决的两个核心问题

1. **统一入口**：一个 URL 访问 tmux 里所有 Agent，浏览器关掉后 Agent 继续运行
2. **按键可用**：PC 和移动端都能可靠发送 Esc / Ctrl+C / Ctrl+B 等控制字符；移动端滑动屏幕即可浏览历史

---

## 不做什么

- 不替换 tmux（Session 管理、持久化、scrollback 全部由 tmux 负责）
- 不做 Session 注册或数据库（v1）
- 不修改 `run-claude.sh`
- 不引入 Docker socket 或 node-pty 以外的系统依赖

---

## Session 模型

Nexus 挂载一个宿主机根目录（`WORKSPACE_ROOT`，通常是 `/home/librae` 这类大目录）。开一个 Session 就是在该目录的某个子目录下启动进程。

**命名规则**：子目录相对路径，`/` 替换为 `-`：

```
WORKSPACE_ROOT = /home/librae

相对路径              Session 名（= tmux window 名）
vault             →   vault
projects/blog     →   projects-blog
work/alpha/v2     →   work-alpha-v2
```

**启动命令（两阶段迭代）**：

```bash
# 阶段一：先跑 bash，验证终端交互、工具栏、滚动全部正常
tmux new-window -t main -c "$WORKSPACE_ROOT/$rel_path" -n "$session_name" "bash"

# 阶段二：bash 验证通过后，直接换成 claude，其余不变
tmux new-window -t main -c "$WORKSPACE_ROOT/$rel_path" -n "$session_name" \
  "bash ~/scripts/run-claude.sh"
```

两行只有末尾命令不同，Session 管理逻辑零改动。

---

## 架构

```
Browser（任意设备）
    ↕  WSS /ws?token=<jwt>
Nexus Server（Node.js，单进程）
    ↕  node-pty  →  tmux attach-session -t main
tmux session "main"
    ├── window vault           （cwd: $WORKSPACE_ROOT/vault）
    ├── window projects-blog   （cwd: $WORKSPACE_ROOT/projects/blog）
    └── window work-alpha-v2   （cwd: $WORKSPACE_ROOT/work/alpha/v2）
```

**为什么不用 ttyd：** ttyd = WebSocket 桥 + hterm 前端。我们要替换前端（才能加工具栏、控制触摸事件），桥自己写只需 50 行，ttyd 就彻底多余了。

**浏览器关闭后的行为：** WebSocket 断开 → node-pty detach tmux → tmux 和所有 Claude Code 继续运行。重新打开浏览器 → 重新 attach → 接续输出。与手动 `Ctrl+B d` detach 完全等价。

---

## 扩展性设计

v1 极简，但架构分层保留接缝，后续功能可以叠加而不需要重写：

```
┌─────────────────────────────────────────────┐
│  前端层   xterm.js + Toolbar                │  ← v2 可加：动态 Tab Bar、Agent 状态卡片
├─────────────────────────────────────────────┤
│  API 层   REST /api/* + WS /ws             │  ← v2 可加：Session 路由、claude -p 派发
├─────────────────────────────────────────────┤
│  桥接层   node-pty ↔ tmux                  │  ← v2 可加：多 window 路由（Map 结构）
├─────────────────────────────────────────────┤
│  数据层   （v1 无）                         │  ← v2 可加：SQLite 存任务历史、Agent 配置
└─────────────────────────────────────────────┘
```

v1 每一层都是独立模块，加功能是在层内扩展或在层间增加接口，不触动已有代码。具体扩展路径见文末。

---

## 功能需求

### 1. WebSocket 桥（后端核心）

**FR-B-01** 服务启动时通过 `node-pty` 执行 `tmux attach-session -t <TMUX_SESSION>`，`TMUX_SESSION` 通过环境变量配置（默认 `main`）。

**FR-B-02** 浏览器通过 `wss://host/ws?token=<jwt>` 建立连接。后端验证 Token，将该 WebSocket 与 PTY 双向绑定：PTY 输出广播给所有连接的客户端；客户端发来的数据写入 PTY stdin。

**FR-B-03** 同一时刻支持多个浏览器连接（多设备同时查看同一 tmux）。

**FR-B-04** 客户端发送 JSON 格式的 resize 消息时调用 `pty.resize(cols, rows)`；其他所有消息视为原始键盘输入写入 PTY。

**FR-B-05** 所有客户端断开后，PTY 保持运行（不 kill tmux），等待下次连接。

### 2. 认证

**FR-A-01** 单密码 JWT 认证，密码以 bcrypt hash 存环境变量 `ACC_PASSWORD_HASH`，Token 有效期 30 天。

**FR-A-02** WebSocket 握手时验证 Token（query param `?token=`）；REST API 通过 `Authorization: Bearer` 验证。

**FR-A-03** 登录页：输入密码 → `POST /api/auth/login` → 返回 Token → 存 localStorage → 跳转终端页。

### 3. 终端前端

**FR-T-01** xterm.js 渲染，连接到 `/ws?token=<jwt>`，支持 256 色 / True Color / Unicode。

**FR-T-02** 初始化：`scrollback: 10000`，字体大小默认 16px（可调，持久化 localStorage）。

**FR-T-03** 窗口 resize 时向后端发送 `{type: 'resize', cols, rows}`。

**FR-T-04** 桌面端通过 `attachCustomKeyEventHandler` 拦截浏览器默认快捷键并转发给终端：Ctrl+W、Ctrl+T、Ctrl+N、Ctrl+L、Ctrl+R。

### 4. 控制工具栏

PC 和移动端均显示，固定在终端底部，不遮挡终端主体。

**FR-K-01** 第一行：shell / tmux 通用控制键

|标签|发送序列|说明|
|---|---|---|
|`Esc`|`\x1b`|退出当前模式|
|`Tab`|`\t`|自动补全|
|`^C`|`\x03`|中断|
|`^D`|`\x04`|EOF|
|`↑`|`\x1b[A`|历史上一条|
|`↓`|`\x1b[B`|历史下一条|
|`^R`|`\x12`|历史搜索|
|`^B`|`\x02`|tmux prefix|

**FR-K-02** 第二行：Claude Code 常用键

|标签|发送序列|说明|
|---|---|---|
|`/`|`/`|slash command|
|`^O`|`\x0f`|打开文件|
|`Yes`|`yes\r`|确认提示|
|`No`|`no\r`|拒绝提示|
|`↵`|`\r`|回车|
|`↓↓`|—|滚到底部（FR-S-03）|

**FR-K-03** 第三行：tmux window 快速操作

|标签|发送序列|说明|
|---|---|---|
|`+`|`\x02 c`|新建 window|
|`←`|`\x02 p`|上一个 window|
|`→`|`\x02 n`|下一个 window|
|`☰`|`\x02 w`|window 列表|
|`✎`|`\x02 ,`|重命名当前 window|

**FR-K-04** 工具栏可折叠，折叠状态持久化 localStorage。

**FR-K-05** 工具栏按键可自定义（标签 + 发送序列），持久化 localStorage。

### 5. 移动端滚动

**FR-S-01** 在终端区域叠加一个全覆盖透明 `div`，完整接管触摸事件，xterm.js 自身触摸处理禁用。在会话页面内，滑动没有其他语义，就是浏览历史。

**FR-S-02** `touchmove` 事件根据 deltaY 调用 `terminal.scrollLines(n)`，每 20px 位移滚动 1 行，手指上划看历史，手指下划回底部。

**FR-S-03** 工具栏「↓↓」按钮调用 `terminal.scrollToBottom()`。当用户不在底部（`viewport < baseY`）时高亮，提示有新输出。

**FR-S-04** 有新输出时自动滚到底部，除非用户正在向上浏览（`viewport < baseY`），此时不打断阅读。

### 6. PWA

**FR-P-01** `manifest.json`，`display: standalone`，支持 iOS Safari / Android Chrome 添加主屏幕。

**FR-P-02** Service Worker 缓存静态资源，不缓存 WebSocket 和 API 请求。

---

## 后端核心实现

完整后端约 150 行，供参考：

```javascript
// server.js

import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'http';

const app = express();
app.use(express.json());
app.use(express.static('frontend/dist'));

const {
  JWT_SECRET, ACC_PASSWORD_HASH,
  TMUX_SESSION = 'main',
  WORKSPACE_ROOT = '/workspace',   // 挂载进来的宿主机根目录
  PORT = 3000
} = process.env;

// 相对路径 → Session 名：'projects/blog' → 'projects-blog'
function toSessionName(relPath) {
  return relPath.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'default';
}

// Auth
app.post('/api/auth/login', async (req, res) => {
  if (!await bcrypt.compare(req.body.password, ACC_PASSWORD_HASH))
    return res.status(401).json({ error: 'unauthorized' });
  res.json({ token: jwt.sign({}, JWT_SECRET, { expiresIn: '30d' }) });
});

// Session 管理（v2 扩展点：现在只有创建，列表由 tmux 提供）
app.post('/api/sessions', authMiddleware, (req, res) => {
  const { rel_path, command = 'bash' } = req.body;
  // command 由调用方传入：
  //   阶段一传 'bash'
  //   阶段二传 'bash ~/scripts/run-claude.sh'
  const name = toSessionName(rel_path);
  const cwd  = `${WORKSPACE_ROOT}/${rel_path}`;
  require('child_process').exec(
    `tmux new-window -t ${TMUX_SESSION} -c "${cwd}" -n "${name}" "${command}"`,
    (err) => err ? res.status(500).json({ error: err.message })
                 : res.json({ name, cwd, command })
  );
});

// PTY 单实例，attach 到 tmux session
let ptyProc = null;
const clients = new Set();

function ensurePty() {
  if (ptyProc) return;
  ptyProc = pty.spawn('tmux', ['attach-session', '-t', TMUX_SESSION], {
    name: 'xterm-256color', cols: 220, rows: 50,
    env: { ...process.env, LANG: 'C.UTF-8' },
  });
  ptyProc.onData(data => clients.forEach(ws => ws.readyState === 1 && ws.send(data)));
  ptyProc.onExit(() => { ptyProc = null; });
}

// WebSocket
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  try { jwt.verify(token, JWT_SECRET); } catch { ws.close(4001, 'unauthorized'); return; }

  ensurePty();
  clients.add(ws);

  ws.on('message', msg => {
    if (!ptyProc) return;
    try {
      const { type, cols, rows } = JSON.parse(msg);
      if (type === 'resize') ptyProc.resize(cols, rows);
    } catch {
      ptyProc.write(typeof msg === 'string' ? msg : msg.toString());
    }
  });

  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => console.log(`Nexus :${PORT}`));
```

---

## 部署

### 目录结构

```
nexus/
├── server.js
├── package.json
├── frontend/
│   └── src/
│       ├── App.tsx          # 登录页 + 路由
│       ├── Terminal.tsx     # xterm.js + WebSocket
│       ├── Toolbar.tsx      # 工具栏
│       └── TouchScroll.tsx  # 移动端滚动覆盖层
├── public/manifest.json
├── Dockerfile
├── docker-compose.yml
├── nginx/nginx.conf
└── .env.example
```

### docker-compose.yml

```yaml
version: "3.9"
services:
  nexus:
    build: .
    container_name: nexus
    restart: unless-stopped
    environment:
      JWT_SECRET: ${JWT_SECRET}
      ACC_PASSWORD_HASH: ${ACC_PASSWORD_HASH}
      TMUX_SESSION: ${TMUX_SESSION:-main}
      WORKSPACE_ROOT: ${WORKSPACE_ROOT:-/workspace}
      PORT: 3000
    volumes:
      - ${WORKSPACE_ROOT:-/home/librae}:/workspace  # 宿主机工作区目录，只读即可
    network_mode: host   # 需要访问宿主机 tmux PTY（/dev/pts/*）

  nginx:
    image: nginx:1.25-alpine
    container_name: nexus-nginx
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
```

> **备选（推荐开发阶段）**：不用 Docker，直接 `node server.js` 跑在宿主机，无网络和路径映射问题，tmux socket 天然可达。

### .env.example

```bash
JWT_SECRET=           # openssl rand -hex 32
ACC_PASSWORD_HASH=    # htpasswd -bnBC 12 "" yourpassword | tr -d ':\n'
TMUX_SESSION=main     # 要 attach 的 tmux session 名
WORKSPACE_ROOT=/home/librae   # 宿主机工作区根目录
PORT=3000
```

### 启动步骤

```bash
# ── 阶段一：bash 验证（先跑通终端交互）──────────────────────

# 1. 创建 tmux session，各 window 跑 bash（用子目录相对路径命名）
tmux new-session -d -s main
tmux new-window -t main -c /home/librae/vault         -n "vault"          "bash"
tmux new-window -t main -c /home/librae/projects/blog -n "projects-blog"  "bash"

# 2. 启动 Nexus
cd ~/nexus && cp .env.example .env   # 填 JWT_SECRET 和 ACC_PASSWORD_HASH
node server.js

# 3. 打开浏览器，验证：
#    - 终端渲染正常
#    - 工具栏按键能发送控制字符
#    - 移动端触摸滚动正常
#    - 浏览器关掉后 tmux 继续运行，重开后能 attach

# ── 阶段二：换成 Claude（验证通过后）────────────────────────

# 4. kill 已有 window，改跑 run-claude.sh（命名规则不变）
tmux kill-window -t main:vault
tmux new-window -t main -c /home/librae/vault -n "vault" \
  "bash ~/scripts/run-claude.sh"
# 其余 window 同理
```

---

## 代码量估算

|模块|估算行数|
|---|---|
|后端（server.js）|~150 行|
|Terminal.tsx|~150 行|
|Toolbar.tsx|~100 行|
|TouchScroll.tsx|~50 行|
|App.tsx（登录 + 路由）|~80 行|
|配置文件（nginx / docker / manifest）|~60 行|
|**总计**|**~590 行**|

---

## 已知限制（v1 接受）

**多客户端 resize 冲突**：多个不同尺寸的浏览器窗口同时连接时，tmux 以最后收到的 resize 为准，可能导致部分客户端布局错乱。实际使用中通常只有一个活跃窗口，v2 可用"取最小尺寸"策略解决。

**tmux session 不存在时**：`tmux attach-session` 失败，PTY 立即退出，前端收到连接关闭。v1 在文档里说明需要先创建 tmux session，不做自动创建。

---

## 迭代路径

### v2：动态 Tab Bar（前端 + 一个 API）

```
GET /api/windows
→ 解析 `tmux list-windows -t main -F "#{window_index} #{window_name}"` 输出
→ 返回 window 列表，前端渲染成浏览器原生 Tab Bar
```

每个 Tab 发送对应的 `\x02 <index>` 切换 tmux window，无需多 PTY 实例。

### v3：多 Session 路由（桥接层扩展）

`ensurePty()` 改为 `ensurePty(sessionName)` 返回 Map 中的独立实例，支持 `WS /ws/:session` 连接不同 tmux session。前端路由对应改造。

### v4：消息派发（新增独立模块）

```
POST /api/tasks  { session, prompt }
→ spawn('claude', ['-p', prompt], { cwd: workspace })
→ 流式返回结果，写入 SQLite tasks 表
```

与终端 WebSocket 完全独立，不影响现有功能。

### v5：IM Bot

```
POST /api/webhooks/telegram
→ 解析消息，调用 v4 的 /api/tasks
→ 结果回传 Telegram
```

Bot 层通过内部 API 与核心解耦，可独立部署。