# Quick Start — 从零开始运行 Nexus

> 预计时间：10-15 分钟  
> 适用平台：Linux / WSL2 / macOS

---

## 前置要求

| 依赖 | 版本/说明 | 安装检查 |
|------|----------|----------|
| Node.js | 20+ | `node --version` |
| tmux | 任意近期版本 | `tmux -V` |
| Claude CLI | 官方命令行工具 | `claude --version` |
| Git | 任意版本 | `git --version` |

**安装 Claude CLI（如果还没有）:**

```bash
# 需要 Node.js 20+
npm install -g @anthropic-ai/claude-code

# 登录（会打开浏览器授权）
claude login
```

---

## 第一步：克隆与安装

```bash
# 1. 克隆仓库
git clone https://github.com/user/nexus4cc.git
cd nexus4cc

# 2. 安装依赖
npm install
cd frontend && npm install && npm run build && cd ..
```

---

## 第二步：配置环境变量

```bash
# 复制示例配置（已内置默认值，可直接使用）
cp .env.example .env
```

`.env.example` 已预填了默认值，**复制后无需编辑即可启动**：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `JWT_SECRET` | 已预填 | JWT 签名密钥 |
| `ACC_PASSWORD_HASH` | 已预填 | 默认密码：**`nexus123`** |
| `TMUX_SESSION` | `main` | tmux 会话名 |
| `WORKSPACE_ROOT` | `/home` | Claude 能访问的目录根 |
| `PORT` | `59000` | 服务端口 |

**常用调整（可选）：**

```bash
# 改为你的实际工作目录（让 Claude 只访问特定目录）
WORKSPACE_ROOT=/home/yourname/work

# 如需通过代理访问 Anthropic API
CLAUDE_PROXY=http://127.0.0.1:6789
```

> ⚠️ **生产环境**请修改密码和 JWT_SECRET。生成新密码 hash：
> ```bash
> node -e "const b=require('bcrypt');b.hash('yourpassword',12).then(h=>console.log(h))"
> ```

---

## 第三步：创建 Claude Profile（关键步骤）

**这是新用户最容易遗漏的一步。** Nexus 通过 `data/configs/` 下的 JSON 文件来管理不同的 Claude API 配置（官方 API、Kimi、OpenRouter 等）。

### 3.1 创建 configs 目录

```bash
mkdir -p data/configs
```

### 3.2 选择模板创建 Profile

**模板 A：Anthropic 官方 API（推荐）**

创建 `data/configs/anthropic.json`：

```json
{
  "label": "Anthropic Claude",
  "BASE_URL": "",
  "AUTH_TOKEN": "",
  "API_KEY": "",
  "DEFAULT_MODEL": "claude-sonnet-4-6",
  "THINK_MODEL": "claude-opus-4-6",
  "LONG_CONTEXT_MODEL": "claude-opus-4-6",
  "DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
  "API_TIMEOUT_MS": "3000000"
}
```

> 留空表示使用 Claude CLI 默认凭证（从 `claude login` 获取）。

**模板 B：Kimi（Moonshot 国内服务）**

创建 `data/configs/kimi.json`：

```json
{
  "label": "Kimi",
  "BASE_URL": "https://api.kimi.com/coding",
  "AUTH_TOKEN": "sk-kimi-your-token-here",
  "API_KEY": "",
  "DEFAULT_MODEL": "kimi-for-coding",
  "THINK_MODEL": "kimi-for-coding",
  "LONG_CONTEXT_MODEL": "kimi-for-coding",
  "DEFAULT_HAIKU_MODEL": "kimi-for-coding",
  "API_TIMEOUT_MS": "3000000"
}
```

**模板 C：OpenRouter（第三方聚合）**

创建 `data/configs/openrouter.json`：

```json
{
  "label": "OpenRouter",
  "BASE_URL": "https://openrouter.ai/api/v1",
  "AUTH_TOKEN": "sk-or-v1-your-token-here",
  "API_KEY": "",
  "DEFAULT_MODEL": "anthropic/claude-sonnet-4",
  "THINK_MODEL": "anthropic/claude-opus-4",
  "LONG_CONTEXT_MODEL": "anthropic/claude-opus-4",
  "DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4",
  "API_TIMEOUT_MS": "3000000"
}
```

### 3.3 Profile 字段说明

| 字段 | 说明 |
|------|------|
| `label` | 显示名称 |
| `BASE_URL` | API 基础地址，留空使用官方 |
| `AUTH_TOKEN` | API Key（OpenAI/Anthropic/Kimi 等） |
| `API_KEY` | 备用字段，通常留空 |
| `DEFAULT_MODEL` | 默认对话模型 |
| `THINK_MODEL` | "/think" 命令使用的模型 |
| `LONG_CONTEXT_MODEL` | 长上下文模型 |
| `DEFAULT_HAIKU_MODEL"` | 快速/低成本模型 |
| `API_TIMEOUT_MS` | API 超时（毫秒） |

---

## 第四步：启动服务

### 开发模式

```bash
# 后端（热重载）
npm run dev

# 另开终端，启动前端开发服务器（可选）
cd frontend && npm run dev
```

### 生产模式

```bash
# 直接启动
npm start

# 或使用 PM2 守护进程
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status

# 查看日志
pm2 logs nexus
```

服务启动后，访问：

```
http://localhost:59000
```

---

## 第五步：首次使用

### 1. 登录

首次访问需要输入密码。如果使用默认配置，密码是 **`nexus123`**。

### 2. 创建工作区

进入后，点击左上角 **Workspace** → **New Project**：

- **Name**: 项目名（如 `my-project`）
- **Directory**: 选择一个在 `WORKSPACE_ROOT` 下的目录
- **Profile**: 选择刚才创建的 Profile（如 `anthropic` 或 `kimi`）

### 3. 启动 Claude 会话

创建 Project 后，会自动打开一个 tmux window 运行 Claude。你会看到：

```
╔══════════════════════════════════════════╗
║  Nexus · Claude Session
║  Profile : Anthropic Claude
║  Project : /home/yourname/workspace/my-project
║  API     : Anthropic (官方)
╚══════════════════════════════════════════╝
```

现在可以直接在终端里和 Claude 对话了。

### 4. 移动端访问（同一 WiFi 下）

```bash
# 查看本机 IP
ip addr show | grep "inet " | head -1

# 手机浏览器访问
http://192.168.x.x:59000
```

**远程访问建议：** 使用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) 或 [Tailscale](https://tailscale.com/)，避免暴露端口。

---

## 常见问题

### Q: 提示 "Config profile 'xxx' not found"

确认 `data/configs/xxx.json` 存在，且 JSON 格式正确（可以用 `cat data/configs/xxx.json | python3 -m json.tool` 验证）。

### Q: Claude 提示没有 API 权限

- 官方 API：运行 `claude login` 重新授权
- Kimi/OpenRouter：检查 `AUTH_TOKEN` 是否填对

### Q: 无法创建 tmux window

确保 tmux 已安装，且没有名为 `main`（或你配置的 `TMUX_SESSION`）的会话在运行冲突的命令。

### Q: 手机访问不了

- 确认手机和电脑在同一网络
- 检查防火墙：`sudo ufw allow 59000`
- 或者使用 SSH 隧道：`ssh -L 59000:localhost:59000 your-server`

---

## 下一步

- 阅读 [ARCHITECTURE.md](ARCHITECTURE.md) 了解系统架构
- 阅读 [NORTH-STAR.md](NORTH-STAR.md) 了解设计原则
- 配置 Telegram Bot 实现手机异步任务（可选）

---

*有问题？提交 [Issue](https://github.com/user/nexus4cc/issues) 或查看 [Troubleshooting](TROUBLESHOOTING.md)*
