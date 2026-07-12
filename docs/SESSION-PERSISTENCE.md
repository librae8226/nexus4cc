# SESSION-PERSISTENCE — 宕机后会话状态自动恢复

**创建**: 2026-06-29  **锚点**: `docs/NORTH-STAR.md`
**关联**: `docs/NEXUS-RELIABILITY-ANALYSIS.md`（保活 Nexus 进程，互补的另一层）

> 目标：宿主机重启/断电/WSL2 关闭后，打开 Nexus 能无缝看到上一次的项目、频道和对话上下文。

---

## 1. 背景与问题

宿主机经常无预警重启/断电，或 WSL2 被关闭。恢复后 Nexus 服务（PM2）能起来，
但**所有项目、频道、对话内容全没了**——每次都要从零重建，体验极差。

## 2. 根因分析

Nexus 对「项目 / 频道」是**无状态**的，它们只存在于 **tmux 服务器进程的内存**里：

- **项目 = tmux session**，**频道 = tmux window**（`server.js` 注释明确：`Project = tmux session, Channel = tmux window`）
- 列表全靠 `tmux list-sessions` / `tmux list-windows` **实时读取**，磁盘上没有任何拷贝
- `data/` 里持久化的只有：API 配置（`configs/`）、工具栏、上传文件、`tasks.json`——**没有一项是项目或频道本身**

所以一旦宿主机重启/断电/WSL2 关闭 → tmux 服务器进程死亡 → 内存中的所有 session、window、
以及每个 pane 的滚动历史**全部蒸发**。PM2 把 Node 进程拉起来没问题，但 tmux 是空的，
Nexus 自然读到空列表。

> 用户提到的「docker 服务停了」其实是 PM2 跑在 WSL2 宿主机上（非 Docker），
> 但失效机制完全相同：**tmux 服务器进程没了**。

### 好消息：对话内容其实没真正丢

Claude Code 自己会把每段对话落盘为 `~/.claude/projects/<编码后的目录>/*.jsonl`
（本机当前有 400+ 个）。丢掉的只是三样：

1. tmux 的**结构**（有哪些项目、哪些频道、各自的工作目录和名字）
2. 每个 pane 的**可见滚动文字**
3. 「哪个窗口对应哪段 claude 对话」的映射

对话本体可用 `claude --continue` / `--resume` 在对应目录里捞回来。这让「自动恢复」可行。

### 锚点对齐

NORTH-STAR「明确不做的事」第一条：**不替换 tmux——Session 持久化、scrollback 全部由 tmux 负责**。
因此用 **tmux 原生持久化插件**正是这条原则的标准答案，增强了轴三（极致 Agent 管理 / 抗宕机），
不引入多用户复杂度，不违反任何 Out-of-Scope。

---

## 3. 方案对比

| 方案 | 机制 | 能恢复 | 改动 | 取舍 |
|---|---|---|---|---|
| **A（已实施）** | tmux-resurrect + tmux-continuum（保存）+ Nexus 启动确定性恢复 | 项目/频道结构、cwd、最后可见屏文字 | 装插件 + 改 `~/.tmux.conf` + 一脚本 + server.js 一处启动钩子 | 最小侵入；不自动重启 claude 进程（恢复后落 shell，见 §6.2） |
| **B（待定）** | Nexus 自带快照/恢复 + `claude --continue` | A 的全部 + **对话进程自动接续** | server.js 定时 dump `data/sessions-snapshot.json`，启动时回放 | 体验最好（重启后能直接继续聊）；需写代码 + PTY 行为变更 |
| **C** | A + B 结合 | 最完整 | 最大 | continuum 管文字、Nexus 快照管结构与对话续接 |

**结论**：先上 A（无代码、零数据丢失保障），把 B 作为「真正无缝接续对话」的加固项。

---

## 4. 已实施：方案 A 详情

### 4.1 安装的插件

```
~/.tmux/plugins/tmux-resurrect    # 保存/恢复 session 结构、cwd、pane 内容
~/.tmux/plugins/tmux-continuum    # 定时自动保存 + 开机自动恢复
```

（直接 git clone，不依赖 TPM，便于服务器环境复现。）

### 4.2 `~/.tmux.conf` 追加配置

```tmux
set -g @resurrect-dir '~/.tmux/resurrect'
set -g @resurrect-capture-pane-contents 'on'   # 还原每个 pane 的可见滚动文字
set -g @continuum-save-interval '5'            # 每 5 分钟自动快照一次
set -g @continuum-restore 'off'                # 关闭 continuum 自动恢复，改由 Nexus 确定性触发（见 §4.4 / §6.1）
run-shell ~/.tmux/plugins/tmux-resurrect/resurrect.tmux   # 必须先于 continuum
run-shell ~/.tmux/plugins/tmux-continuum/continuum.tmux
```

该配置在**下次 tmux 服务器启动时**生效。注意 `@continuum-restore` 设为 `off`——
恢复不走 continuum 的开机自动恢复（在本环境不可靠，见 §6.1），而由 Nexus 启动时确定性触发（§4.4）。

### 4.3 线上运行中服务器的即时激活（安全处理）

当前线上 tmux 服务器（运行着所有真实 session）是**热加载**插件的，处理上格外小心：

- 线上服务器显式设置 `@continuum-restore 'off'`——**禁止在活着的服务器上触发任何恢复/重建**，
  避免误覆盖正在运行的会话。开机自动恢复只由 `~/.tmux.conf` 在**全新服务器启动**时提供。
- 手动注入 continuum 的定时保存钩子到 `status-right`（因为热加载时 continuum 的「多客户端」
  启发式误判，跳过了自动注入）。已端到端验证：时间戳每个保存周期自行推进。
- 全程**未对线上服务器执行任何 kill / restart**，5 个 session 始终在线。

### 4.4 确定性恢复触发器（Nexus 启动时，已实施）

因 continuum 自带的开机自动恢复在本环境不可靠（§6.1），恢复改由 **Nexus 启动流程**确定性触发：

- 新增脚本 `scripts/nexus-restore-tmux.sh`：
  - 仅在「全新 tmux 服务器」（无 `NEXUS_RESTORED` 标记）时恢复一次；标记随服务器生命周期存在，
    宿主机重启后消失。**Nexus 普通重启（tmux 仍在）会因标记存在而跳过**，绝不覆盖正在运行的会话。
  - `last` 链接悬空时（resurrect 并发保存竞态 / 宕机打断保存所致）**自动回退到最新有效快照**并修复 `last`。
  - resurrect restore 本身幂等：已存在的 session/pane 只登记、不重建、不重启其中进程。
- `server.js` 在 `server.listen` 回调里、默认 session bootstrap **之前**调用该脚本一次。

恢复内容 = 项目/频道结构 + 工作目录 + 每个 pane 最后可见屏文字（**不自动重启 claude 进程**，见 §6.2）。

---

## 5. 验证结果（隔离环境，未触碰线上）

用独立 socket `tmux -L verifyboot` 模拟冷启动恢复，全程与线上 default socket 隔离：

| 验证项 | 结果 |
|---|---|
| 快照捕获 | 5 个 session、全部 window、全部 cwd、pane 内容（`pane_contents.tar.gz`）✓ |
| 结构还原 | 5 个 session + 正确 window 数（vault 5、nexus 2…）✓ |
| cwd 保真 | 每个 pane 的工作目录精确还原 ✓ |
| pane 文字还原 | 抓到上一次 Claude 会话界面（模型、输入框、git 行）✓ |
| 线上定时自动保存 | 时间戳无人干预自行推进（PASS）✓ |
| 线上零影响 | 测试前后 5 个 session 完好、attached ✓ |
| **恢复脚本端到端**（`tmux -L testrestore`，跑真实 `scripts/nexus-restore-tmux.sh`） | 全新服务器→完整恢复 5 session + 设标记；二次运行→正确跳过 ✓ |
| **悬空 last 自愈** | 复现并修复 resurrect 并发保存导致的 `last` 悬空；脚本回退到最新有效快照 ✓ |

验证后已销毁 `verifyboot` / `testrestore` 服务器并清理残留 socket，全程未触碰线上 default socket。

---

## 6. 重要边界与注意事项

1. **为什么不用 continuum 的开机自动恢复（已绕过）**
   continuum 的 `continuum_restore.sh` 有一条 guard：
   `auto_restore_enabled && ! another_tmux_server_running_on_startup`，
   后者 = 「除当前 server 外的 tmux 进程数 > 1」。
   本机开机时 **2 个 ttyd**（`tmux new-session -A`，各留一个常驻客户端进程）+ PM2/Nexus 的
   `tmux new-session -d -s main` 会同时往 default socket 抢建 session，进程数极可能 >1，
   **导致 continuum 跳过自动恢复**——在本环境不可靠。
   → 已设 `@continuum-restore off`，恢复改由 Nexus 启动时确定性触发（§4.4），continuum 只负责保存。

2. **不自动重启 claude 进程**：resurrect 默认只还原 shell + 最后可见屏文字，不会重新拉起
   `claude` / `nexus-run-claude.sh`。还原后 pane 显示上次对话文字，但落到 shell 提示符。
   要继续对话需在该目录 `claude --continue`（属方案 B，见 §8）。

3. **最多丢 ~5 分钟**：保存间隔 5 分钟，崩溃时最坏丢失最近一次保存后的增量。

4. **只存「最后可见一屏」**：resurrect 不保存完整 scrollback（scrollback 随 tmux 服务器一起消失，
   这是 tmux 的固有限制）。

5. **resurrect 并发保存竞态（已缓解）**：多个 attached 客户端会让 status-right 几乎同时触发多个
   `continuum_save.sh`；若两次保存落在同一秒，同名快照文件会被其一 `rm`，导致 `last` 悬空。
   稳态下（save-interval 5min、单客户端锁）很少发生，且 `scripts/nexus-restore-tmux.sh`
   对悬空 `last` 会自愈（回退最新有效快照），恢复不受影响。

---

## 7. 运维手册

```bash
# 立即手动保存一次快照
tmux run-shell ~/.tmux/plugins/tmux-resurrect/scripts/save.sh

# 手动恢复上次快照（恢复进当前 tmux 服务器；已存在的 session 会被跳过）
~/.tmux/plugins/tmux-resurrect/scripts/restore.sh

# 默认键位（prefix 默认 Ctrl-b）
#   prefix + Ctrl-s  手动保存
#   prefix + Ctrl-r  手动恢复

# 查看最近快照与时间
readlink ~/.tmux/resurrect/last
tmux show-option -gqv @continuum-save-last-timestamp

# 确认线上定时自动保存在跑（status-right 应含 continuum_save.sh）
tmux show-option -gv status-right
```

---

## 8. 现状与后续

- **8.1 Nexus 启动时确定性恢复 — 已实施**（用户 2026-06-29 选定，见 §4.4）。
  `scripts/nexus-restore-tmux.sh` + `server.js` 启动钩子；隔离环境已端到端验证。
  ⚠️ 该代码在**下次 Nexus 重启/宿主机重启后生效**——首次真正生效就是一次真实恢复，
  当时请确认 `logs/nexus-out.log` 出现 `[nexus-restore] …恢复完成`。
- **8.2 真正接续对话（方案 B）— 已实施**（2026-06-29）。
  resurrect 只还原 shell + 可见文字，不会重启 claude。新增 `scripts/nexus-resume-claude.sh`：
  解析快照里由 `nexus-run-claude.sh <profile> <cwd>` 启动的 pane（快照 `pane_full_command` 列
  完整记录了 profile 与 cwd），对仍是 shell 的 pane `send-keys` 注入 `NEXUS_RESUME=1 <原命令>`，
  错峰拉起；`nexus-run-claude.sh` 收到 `NEXUS_RESUME=1` 首次启动加 `--continue` 接续对话（kimi 除外）。
  由 `nexus-restore-tmux.sh` 在结构恢复后自动调用。
  - **局限**：`claude --continue` 只接续该 cwd 的**最近一条**对话；同目录多频道（如 vault 多窗口、
    nexus 多窗口）会都落到同一条，需在其余窗口手动 `/resume` 切换（对话数据都在 `~/.claude/projects`，未丢）。
  - ttyd 管理的 `claude-host-*` 频道不在此列，由 ttyd 自行拉起 claude。

## 9. 事故记录 — 2026-06-29 默认 tmux server 死亡

实施期间 **10:56:00 默认 tmux server 进程整个死亡**：所有 PTY 同一秒 `exited code 1`，
`logs/nexus-error-0.log` 出现 `no server running on /tmp/tmux-1000/default`。
排除项：**非宿主机重启**（uptime 未变）、**非 Nexus 重启**（node 进程连续运行 34h）、
**非新恢复代码**（Nexus 未重启，代码从未执行）。未能从可得日志坐实触发因（无 dmesg 权限），
最可能是 tmux server 进程被杀（OOM 或外部信号），且发生在测试期（当时并行跑了多个测试 tmux server
+ 紧凑的 continuum save 循环，可能加剧了内存/负载压力）。
**恢复**：从 10:54 完整快照（`tmux_resurrect_*.txt`）找回全部 5 个 session，并用
`nexus-resume-claude.sh` 拉起 8 个 claude 频道、接续对话。**数据全程未丢**——这正是本持久化系统的价值。
教训：① 测试期避免制造内存/负载尖峰；② `last` 悬空时回退最新有效快照（已在脚本中实现）。

> 任何时候宕机后也可手动执行 §7 的 `restore.sh` 一行命令立即找回全部结构，
> 再 `bash scripts/nexus-resume-claude.sh <快照文件>` 拉起 claude 频道。
