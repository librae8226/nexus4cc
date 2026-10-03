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
git clone https://github.com/librae8226/nexus4cc.git
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
| `CONTEXT_TOKENS` | 模型上下文窗口（tokens），可选。映射为 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，用于第三方模型（如 DeepSeek V4）避免 Claude Code 按默认 200k 提前 auto-compact |
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

### 4. 三种 Shell 类型

新建 Project / Channel 时可以选三种：

| 类型 | 启动什么 | 说明 |
|---|---|---|
| **Claude** | `nexus-run-claude.sh`（claude CLI） | 默认。profile 决定 API key 与模型 |
| **Pi** | `nexus-run-pi.sh`（[pi](https://pi.dev)） | 第三方 endpoint 走 `data/configs/*.json`，与 Claude 共用同一套 profile |
| **Zsh** | 本地交互 shell | 不用 AI 时开一个普通终端 |

**Pi 的安装**（可选，不装则 Pi 类型不可用）：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi 的配置目录固定在 **`~/.pi/agent-nexus`**（由 `nexus-run-pi.sh` 生成 `models.json`），
**与手工使用的 `~/.pi/agent` 完全隔离**，两边互不影响。密钥不落盘：启动时以环境变量注入。

**profile 怎么变成 pi 的 provider**：如果 profile 的 `BASE_URL` 指向的 endpoint 是 pi 本来就认识的
（按 host 匹配，如 DeepSeek / Moonshot / OpenRouter），生成器就**只写一条 `apiKey`**，
provider 的地址、协议、模型清单与全部能力字段都交给 pi 自带的那份用 ——
所以 `pi --list-models` 里的 `context` / `max-out` / `thinking` / `images` 与官方目录逐字段一致，
pi 升级加字段也自动跟上。catalog 里没有的 endpoint（公司网关、自建反代）才回退成自建的 provider，
那时要在 `nexus-run-pi.sh` 的兜底分支里自己写全能力字段（脚本内有注释说明为什么必须写全）。

**改完 `models.json` 怎么让开着的窗口生效**：不用重启 —— 在那个 pi 窗口里敲 `/model` 再直接回车
（选回原来那个模型）即可，页脚会出现思考档位。漏这一步，窗口会用着启动时读进内存的旧配置。
会话里按 `Shift+Tab` 循环思考档位，`/thinking` 看/选完整列表。

**续接旧会话**：`nexus-run-pi.sh` 起窗口时总会显式带上 `--provider` 和 `--model`，所以即使某个
provider 换了名字（如 `kimi` → `moonshotai-cn`），续接也会平滑接上原来那段对话（实测对话内容不丢，
会话记录里的 provider 也跟着迁移）。

**但手工跑 `pi -c` 要注意**：不带 `--provider/--model` 时，pi 按会话里记的模型去解析；那个 provider
若已改名，它**不报错，而是静默换成另一个可用模型**，然后很可能在请求时超时/失败 —— 看起来像网络问题，
其实是模型被换掉了。手工续接请带上 `--provider <新 id> --model <模型>`，或直接开新会话。

### 4. 移动端访问（同一 WiFi 下）

```bash
# 查看本机 IP
ip addr show | grep "inet " | head -1

# 手机浏览器访问
http://192.168.x.x:59000
```

**远程访问建议：** 使用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) 或 [Tailscale](https://tailscale.com/)，避免暴露端口。

---

## Android App（开发中）

> 需求与技术方案见 [ANDROID-APP.md](ANDROID-APP.md)。当前处于 M0（全链路打通），
> 尚未发布，构建产物仅供本地验证。

### 服务端必须先放行

APK 里的 WebView 与服务器**不同源**，浏览器那条同源路径不需要的 CORS 在这里是必须的。
在 `.env` 里加一行再重启服务：

```bash
CORS_ORIGINS=http://localhost,https://localhost
```

两个 origin 分别对应 `capacitor.config.json` 里 `androidScheme` 的两种取值。留空 =
不发任何 CORS 头（浏览器/PWA 与改造前完全一致），但也意味着 APK 连不上。

### 构建

需要 Docker（Android SDK 跑在容器里，不装到宿主机）：

```bash
cd frontend && npm run build    # 必须先有前端产物
cd .. && android/build-apk.sh   # 默认 assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（约 4.4 MB）。
首次构建会拉 Gradle 发行版和依赖，之后走 `android/.gradle-home/` 缓存。

### 安装

```bash
# 用 adb（需自行安装 android-tools-adb）
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

也可以直接把 APK 传到手机上点击安装（需允许「安装未知来源应用」）。

### 首次启动要配服务器地址

APK 里没有「同源」这回事，**登录请求本身就发给某个地址**，所以地址必须先于登录存在。
首次启动时登录页会直接展开服务器地址编辑器，填 `主机IP:59000` 即可（会自动补 `http://`）。

以 `http://` 开头的地址会在界面上标注「未加密」——局域网/Tailscale 路径是明文传输，
这是自托管场景的已知取舍。

### 国产 ROM 要手动放行后台

息屏后能否收到通知，取决于系统是否允许 App 常驻，这一项**代码无法完全解决**：

- **vivo / OriginOS 6**：设置 → 电池 → 更多设置 → **智能后台冻结** → 把 Nexus 加入
  「不受冻结影响」，**改完需重启手机生效**。只开自启动和白名单不够，闲置约 3 分钟照样休眠。
- **一加 / ColorOS 16**：自启动管理里允许 Nexus，并在多任务界面给 Nexus 加锁。
- 两台机器都建议：电池优化 → 不优化。

保活失败也不影响 Agent 继续跑（tmux 在服务端），只是通知会延迟或丢失。

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

---

*有问题？提交 [Issue](https://github.com/librae8226/nexus4cc/issues)*
