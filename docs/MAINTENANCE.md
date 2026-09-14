# Nexus Maintenance Guide

> 所有维护流程的**唯一参考文档**。新增流程后同步更新本文。

---

## 目录

1. [Node 版本升级（fnm）](#1-node-版本升级fnm)
2. [Claude Code 更新](#2-claude-code-更新)
3. [Nexus 版本发布](#3-nexus-版本发布)
4. [Nexus 部署 / Redeploy](#4-nexus-部署--redeploy)
5. [PM2 服务管理](#5-pm2-服务管理)
6. [宕机恢复](#6-宕机恢复)
7. [依赖更新](#7-依赖更新)
8. [Profile / Config 管理](#8-profile--config-管理)
9. [Git 工作流](#9-git-工作流)

---

## 1. Node 版本升级（fnm）

**触发条件**：安装新 Node 版本并设为 default 时。

### 1.1 背景

`~/.local/bin/` 下的 4 个二进制文件直接 symlink 到 fnm 的版本特定路径：

```
~/.local/bin/node    → .../fnm/.../v<version>/installation/bin/node
~/.local/bin/npm     → .../fnm/.../v<version>/installation/bin/npm
~/.local/bin/npx     → .../fnm/.../v<version>/installation/bin/npx
~/.local/bin/claude  → .../fnm/.../v<version>/installation/bin/claude
```

这些路径包含版本号（如 `v24.14.0`），切换 Node 版本后必须更新。

### 1.2 操作步骤

```bash
# 1. 安装新版本并设为默认
fnm install v<NEW_VERSION>
fnm default v<NEW_VERSION>

# 2. 重新安装全局包（在新版本下）
fnm exec --using=v<NEW_VERSION> npm install -g @anthropic-ai/claude-code pm2 pnpm

# 3. 更新 ~/.local/bin/ 下的 symlink
FNM_BIN="/home/librae/.local/share/fnm/node-versions/v<NEW_VERSION>/installation/bin"
ln -sf "$FNM_BIN/node"    /home/librae/.local/bin/node
ln -sf "$FNM_BIN/npm"     /home/librae/.local/bin/npm
ln -sf "$FNM_BIN/npx"     /home/librae/.local/bin/npx
ln -sf "$FNM_BIN/claude"  /home/librae/.local/bin/claude

# 4. 验证
for cmd in node npm npx claude; do
  echo "$cmd: $(/home/librae/.local/bin/$cmd --version 2>&1 | head -1)"
done
```

### 1.3 验证清单

- [ ] `node --version` 显示新版本
- [ ] `claude --version` 正常工作
- [ ] `pm2 status` 正常（PM2 在新 node 版本下运行）
- [ ] Nexus 新建 Claude 对话正常启动

---

## 2. Claude Code 更新

**触发条件**：Claude Code 有新版本可用时。

### 2.1 背景

自 2026-07-24 起，claude 采用与其他 bin 一致的 fnm symlink 方案，只有一个安装实例。`claude update` 直接生效，无需额外操作。

```bash
# 检查当前版本
claude --version

# 更新
claude update
# 或等价命令：
npm install -g @anthropic-ai/claude-code@latest
```

### 2.2 验证清单

- [ ] `claude --version` 显示新版本
- [ ] `/home/librae/.local/bin/claude --version` 显示相同版本
- [ ] Nexus 新建对话使用新版本

### 2.3 故障排查

如果出现之前的两份安装不同步问题（`claude update` 后 Nexus 仍是旧版）：

```bash
# 检查是否有多份安装
whereis claude
# 解析真实路径。注意别用 `readlink -f`：macOS/BSD 的 readlink 没有 -f。
# 用 node 解析（本项目一定有 node），跨 Linux/macOS 都一致。
node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(command -v claude)"

# 正常情况：只有一个安装点，symlink 直接指向 fnm
ls -la "$(command -v claude)"
# → .../fnm/.../v<version>/installation/bin/claude

# 如果 ~/.local/lib/node_modules/@anthropic-ai 仍然存在，删除它
rm -rf /home/librae/.local/lib/node_modules/@anthropic-ai
```

---

## 3. Nexus 版本发布

**触发条件**：准备发新版本时。

> 详见 [CLAUDE.md § Version Management](../CLAUDE.md#version-management)

```bash
# 1. 确认工作区干净
git status

# 2. 更新版本号（两个文件）
#    - package.json → "version"
#    - frontend/package.json → "version"

# 3. 提交
git add package.json frontend/package.json
git commit -m "chore: bump version to X.Y.Z"

# 4. 打 tag 并推送
git tag vX.Y.Z
git push && git push --tags
```

**注意**：不要在 i18n 文件或代码里硬编码版本号。Settings > About 通过 `/api/version` 动态读取 git tag。

### 3.1 验证清单

- [ ] `git describe --tags --abbrev=0` 返回正确版本
- [ ] `curl http://localhost:59000/api/version` 返回正确版本
- [ ] Settings > About 页面显示正确版本

---

## 4. Nexus 部署 / Redeploy

**触发条件**：代码变更需要上线时。

### 4.1 常规 Redeploy（代码改动后）

```bash
# 方式 A：通过 slash command（推荐）
/nexus-redeploy

# 方式 B：手动执行
cd /mnt/c/Users/libra/work/nexus
cd frontend && npm run build && cd ..
pm2 restart nexus
```

### 4.2 完整部署（从零开始或重建）

```bash
cd /mnt/c/Users/libra/work/nexus

# 1. 安装后端依赖
npm install

# 2. 构建前端
cd frontend && npm install && npm run build && cd ..

# 3. 启动/重启 PM2
pm2 start ecosystem.config.cjs
# 或: pm2 restart nexus

# 4. 保存 PM2 进程列表（可选，用于系统重启后自动恢复）
pm2 save
```

### 4.3 回滚

```bash
# 如果部署后服务不可访问
git checkout <previous-version-tag>
cd frontend && npm run build && cd ..
pm2 restart nexus
```

### 4.4 验证清单

- [ ] `pm2 status nexus` 显示 `online`
- [ ] 浏览器访问 `http://localhost:59000` 正常加载
- [ ] 能正常登录并创建 Claude 对话

---

## 5. PM2 服务管理

**触发条件**：日常运维。

### 5.1 常用命令

```bash
pm2 status              # 查看状态
pm2 logs nexus          # 查看日志（或 /pm2-logs）
pm2 restart nexus       # 重启（或 /pm2-restart）
pm2 stop nexus          # 停止（或 /pm2-stop）
pm2 start ecosystem.config.cjs  # 启动（或 /pm2-start）
pm2 delete nexus        # 删除进程（需重建时）
pm2 save                # 保存当前进程列表
pm2 env nexus           # 查看环境变量
```

### 5.2 日志位置

| 日志 | 路径 |
|---|---|
| 错误日志 | `./logs/nexus-error.log` |
| 标准输出 | `./logs/nexus-out.log` |
| 合并日志 | `./logs/nexus-combined.log` |

### 5.3 从零重建 PM2 进程

```bash
pm2 stop nexus
pm2 delete nexus
pm2 start ecosystem.config.cjs
pm2 save
pm2 status nexus
```

### 5.4 已知改进项（待实施）

来自 `docs/NEXUS-RELIABILITY-ANALYSIS.md` 的建议，当前未配置：

```js
// ecosystem.config.cjs 建议添加：
autorestart: true,
max_restarts: 10,
min_uptime: '10s',
max_memory_restart: '512M',
kill_timeout: 5000,
```

### 5.5 验证清单

- [ ] `pm2 status` 显示 `online`，restarts 没有异常增长
- [ ] `curl http://localhost:59000/api/version` 响应正常

---

## 6. 宕机恢复

**触发条件**：WSL2 重启、tmux server 崩溃等。

### 6.1 自动恢复（正常流程）

Nexus 启动时自动执行恢复链：

1. `server.js` → `server.listen` 回调
2. → `scripts/nexus-restore-tmux.sh`（恢复 tmux window/pane 结构）
3. → `scripts/nexus-resume-claude.sh`（恢复 Claude 会话）

### 6.2 手动恢复

```bash
# 手动触发 tmux 结构恢复
bash scripts/nexus-restore-tmux.sh

# 手动保存当前 tmux 状态（创建恢复快照）
tmux run-shell ~/.tmux/plugins/tmux-resurrect/scripts/save.sh

# 手动恢复（不使用 Nexus 脚本）
~/.tmux/plugins/tmux-resurrect/scripts/restore.sh
```

### 6.3 诊断命令

```bash
# 检查上次快照时间
readlink ~/.tmux/resurrect/last

# 检查 continuum 保存间隔
tmux show-option -gqv @continuum-save-interval  # 应为 5（分钟）

# 检查 continuum 是否在运行
tmux show-option -gv status-right

# 列出所有 tmux session
tmux list-sessions
```

### 6.4 已知限制

- 最大数据丢失窗口：**5 分钟**（continuum 保存间隔）
- 只保存可见屏幕内容，不保存完整 scrollback
- Resurrect 并发保存可能导致 `last` symlink 损坏（脚本已内置自愈逻辑）
- Kimi API 的 pane 会跳过 Claude resume（Kimi 不支持会话恢复）

### 6.5 验证清单

- [ ] `tmux list-sessions` 显示预期的 session 和 window
- [ ] `pm2 status nexus` 显示 `online`
- [ ] 各 Claude 会话 pane 已恢复到崩溃前的对话

---

## 7. 依赖更新

**触发条件**：需要更新 npm 依赖时。

### 7.1 后端依赖

```bash
cd /mnt/c/Users/libra/work/nexus
npm update              # 在 semver 范围内更新
npm outdated            # 查看可更新的包
npm install <pkg>@latest  # 更新特定包
```

### 7.2 前端依赖

```bash
cd /mnt/c/Users/libra/work/nexus/frontend
npm update
npm outdated
npm install <pkg>@latest
cd .. && cd frontend && npm run build  # 重新构建
```

### 7.3 全局依赖

```bash
npm -g list --depth=0   # 查看当前全局包
# 当前全局包（2026-07-24）：
#   @anthropic-ai/claude-code
#   pm2
#   pnpm

npm install -g <pkg>@latest
```

### 7.4 验证清单

- [ ] `npm start`（或 `npm run dev`）正常启动
- [ ] 前端构建 `cd frontend && npm run build` 无错误
- [ ] PM2 重启后服务正常

---

## 8. Profile / Config 管理

**触发条件**：添加/修改/删除 Claude 配置 profile 时。

### 8.1 配置文件位置

```
data/configs/
  ├── anthropic.json    # Anthropic 官方 API
  ├── kimi.json         # Kimi API
  └── openrouter.json   # OpenRouter
```

### 8.2 配置模板

```json
{
  "name": "显示名称",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-4-6",
  "thinkModel": "claude-opus-4-6"
}
```

支持的字段（均非必填，由 `nexus-run-claude.sh` 按需 export）：

| 字段 | 环境变量 |
|---|---|
| `baseUrl` | `ANTHROPIC_BASE_URL` |
| `apiKey` | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` |
| `model` | `ANTHROPIC_MODEL` |
| `thinkModel` | `ANTHROPIC_THINK_MODEL` |
| `haikuModel` | `ANTHROPIC_HAIKU_MODEL` |
| `apiKeyId` | `ANTHROPIC_API_KEY_ID` |

### 8.3 验证清单

- [ ] 新 profile 文件格式为合法 JSON
- [ ] 在 Nexus UI 中能选择新 profile
- [ ] 使用新 profile 创建对话能正常连接 API

---

## 9. Git 工作流

> 详见 [CLAUDE.md § Git Commit Standard](../CLAUDE.md#git-commit-standard)

### 9.1 提交格式

```
type(scope): imperative subject ≤ 72 chars

Body (optional, any language): explain why, not what.
Bug fixes: explain root cause.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

### 9.2 文档联动

| 改动类型 | 需更新的文档 |
|---|---|
| 新功能 / 接口变更 | `README.md` + `docs/PRD.md` |
| Roadmap / 范围变更 | `docs/ROADMAP.md` |
| 架构变更 | `docs/ARCHITECTURE.md` |
| 流程 / 规范变更 | `CLAUDE.md` + `docs/MAINTENANCE.md`（本文） |
| 新增环境变量 | `.env.example` + commit body |
| Bug fix | commit body 注明根因 |
| Session / 持久化变更 | `docs/SESSION-PERSISTENCE.md` |

### 9.3 验证清单

- [ ] Commit message 符合格式
- [ ] 包含 `Co-Authored-By:` trailer
- [ ] 相关文档已同步更新
- [ ] `.env` 未被提交

---

## 维护速查表

| 场景 | 关键命令 |
|---|---|
| 升级 Node | `fnm install vXX && fnm default vXX` → 更新 4 个 symlink + 重装全局包 |
| 升级 Claude Code | `claude update`（一个命令，自动生效） |
| 发布新版本 | 改两个 `package.json` → commit → tag → push |
| 部署代码 | `/nexus-redeploy` 或 `pm2 restart nexus` |
| 查看日志 | `/pm2-logs` 或 `pm2 logs nexus` |
| 宕机恢复 | 重启 Nexus（自动恢复），或手动运行 restore 脚本 |
| 回滚 | `git checkout <tag>` → 重建前端 → `pm2 restart nexus` |
