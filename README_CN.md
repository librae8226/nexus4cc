# Nexus4CC

### 你的 Claude Code，随身携带。

[![Node](https://img.shields.io/badge/node-20+-brightgreen?style=flat-square)](https://nodejs.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20商业授权-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/librae8226/nexus4cc?style=flat-square)](https://github.com/librae8226/nexus4cc/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-欢迎-brightgreen?style=flat-square)](CONTRIBUTING.md)

[English](README.md)

---

### 演示

<p>
  <video src="https://github.com/user-attachments/assets/083495f7-d840-4733-9307-eaa815c2756f" width="45%" controls muted align="center">
    Your browser does not support the video tag.
  </video>
</p>

---

## 这是什么？

Nexus4CC 把任何浏览器变成 **Claude Code** 的指挥中心——同时也支持 Codex、Gemini CLI 等任何终端 AI Agent。它直连你电脑上的 tmux 会话，让你随时随地监控、切换和指挥你的 AI 军团。

手机、折叠屏、平板、PC —— 一个界面，全设备适配。没有云服务，没有订阅费，没有复杂的 SSH 配置。你的终端，如影随形。

---

## 功能

| | |
|---|---|
| 🔌 **WebSocket ↔ tmux 桥接** | 每个窗口独立 PTY，实时双向 I/O。关掉浏览器，Agent 继续跑。 |
| 📱 **全设备终端** | xterm.js + 滑动导航 + 双指缩放 + 可配置软键盘。手机上触控操作，PC 上键盘操作——一个界面全适配。 |
| 📂 **嵌入式文件浏览器** | 可拖拽调整宽度的侧栏。浏览、编辑、Markdown 预览。按名称/日期/大小排序，支持右键菜单。 |
| 🗂️ **项目与频道管理** | 以目录为单位组织项目，多个频道式会话。像 Slack 频道一样即时切换——专属于你的终端工作流。 |
| 💾 **会话持久化** | tmux-resurrect 保活。服务器重启后，所有会话原样恢复，无缝接续。 |
| 🔀 **多会话管理** | 同时跑多个 tmux session，在浏览器里秒切，不用离开页面。 |
| 🎨 **PWA** | iOS/Android 可安装到主屏幕。深色/浅色主题。用起来像原生 App，离线也能打开。 |

---

## 为什么选 Nexus4CC？

|                              | Anthropic Remote Control | Happy Coder | Omnara  | **Nexus4CC** |
|------------------------------|:---:|:---:|:---:|:---:|
| 自托管                       | ❌ | ❌ | ⚠️ | ✅ |
| 无需订阅                     | ❌ | ✅ | ❌ | ✅ |
| 数据留在本地                 | ❌ | ❌ | ❌ | ✅ |
| 真实终端（xterm）            | ❌ | ❌ | ❌ | ✅ |
| 项目与频道管理               | ❌ | ⚠️ | ⚠️ | ✅ |
| 发射后不管                   | ⚠️ | ✅ | ✅ | ✅ (纯 tmux) |
| PWA / 可安装                 | ❌ | ✅ | ✅ | ✅ |
| 开源                         | ❌ | ⚠️ | ✅ | ✅ |

> **项目与频道管理：** 以目录为单位组织项目，每个项目下有多个频道式会话——像 Slack 频道一样即时切换，专属于你的终端工作流。

---

## 快速开始

```bash
git clone https://github.com/librae8226/nexus4cc.git && cd nexus4cc
cp .env.example .env          # 设置 JWT_SECRET、ACC_PASSWORD_HASH、WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# 在任意设备打开 http://localhost:59000 🚀
```

> 完整配置指南（Claude Profile、PM2、移动端访问）：**[QUICKSTART.md →](docs/QUICKSTART.md)**

---

> 💡 **致人类用户：** 按上方「快速开始」操作即可。以下内容写给帮你安装的 AI 助手看。

### 致 AI 助手

如果你是正在帮用户安装 Nexus 的 AI 助手，按以下步骤执行：

1. 克隆本仓库并 `cd` 进入目录
2. 运行 `node scripts/setup.js` — 自动处理依赖安装、前端构建、PM2 启动和 tmux 会话创建
3. 验证：`pm2 status` 显示 `nexus` 在线 → 打开 `http://localhost:59000`

前置要求：Node.js 20+、tmux。PM2 不存在时会自动全局安装。  
默认登录密码：`nexus123`（安装完成后可在 `.env` 中修改）。

---

## 部署建议

通过 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 或 [Tailscale](https://tailscale.com/) 安全暴露服务，无需端口转发。

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 20+ | |
| tmux | 任意近期版本 | |
| PM2 | 任意近期版本 | `setup.js` 自动安装 |
| 操作系统 | Linux / WSL2 | |

> 💡 搭配语音输入法 [Milo Input](https://miloinput.fay.wang/) 使用体验更佳。

---

## 安全说明

Nexus 是**单用户自托管工具**，不是多租户平台。

- 🔒 bcrypt（12 轮）密码哈希 + JWT（30天）
- ⚠️ WebSocket token 通过 query string 传递 — 生产环境请启用 TLS
- 🛡️ 在防火墙、VPN 或隧道后运行，不要直接暴露在公网

---

## 文档

| 文档 | 说明 |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | 手把手配置指南 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构与 API 参考 |
| [PRD.md](docs/PRD.md) | 功能规格说明 |
| [ROADMAP.md](docs/ROADMAP.md) | 未来规划 |
| [📖 Nexus 的故事](docs/story.md) | 为什么造了这个东西 |

---

## 社区

<p>
  <img src="https://github.com/user-attachments/assets/6960ca95-f26d-484b-aa66-56b5315e39d3" width="225" />
</p>

欢迎加微信（librae8226）深入交流。

---

## 关于作者

我是 Librae——软件工程师、创业者、早期科技 VC 投资人。

这三个角色有一个共同点：**最好的想法，从来不在办公桌前产生。**

Nexus4CC 诞生于我自己的真实需求：在机场、出租车、会议间隙，随时能指挥和管理我的 AI 军团在电脑上工作。现在，它是开源的，也是你的。

---

## 贡献

欢迎 PR 和 Issue。见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解本地开发环境和贡献规范。

---

## 许可证

双重授权：**[GPL v3](LICENSE.md)**（开源使用）· **商业授权**（用于商业/SaaS 产品）— 联系 [librae8226](https://github.com/librae8226) 或 [faywong](https://github.com/faywong)

---

*为 **Claude Code** 深度优化。同时支持任何能在终端里跑的 AI Agent。*
