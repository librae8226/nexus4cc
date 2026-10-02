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
set -g history-limit 10000                     # 回滚历史行数（tmux 默认仅 2000）；只对新窗口生效，见下
run-shell ~/.tmux/plugins/tmux-resurrect/resurrect.tmux   # 必须先于 continuum
run-shell ~/.tmux/plugins/tmux-continuum/continuum.tmux
```

该配置在**下次 tmux 服务器启动时**生效。注意 `@continuum-restore` 设为 `off`——
恢复不走 continuum 的开机自动恢复（在本环境不可靠，见 §6.1），而由 Nexus 启动时确定性触发（§4.4）。

`history-limit` 的语义与上面各项**不同**（man tmux：*applies only to new windows — existing
window histories are not resized*）：**已存在的窗口不会扩容**，必须重建窗口才拿得到新上限；
对旧窗口显式 `set-option -w history-limit` 同样无效（2026-10-01 实测：灌 3000 行后仍封顶 ~2000）。
本机该值由 tmux 内置默认 2000 提升到 10000。

### 4.3 线上运行中服务器的即时激活（安全处理）

当前线上 tmux 服务器（运行着所有真实 session）是**热加载**插件的，处理上格外小心：

- 线上服务器显式设置 `@continuum-restore 'off'`——**禁止在活着的服务器上触发任何恢复/重建**，
  避免误覆盖正在运行的会话。开机自动恢复只由 `~/.tmux.conf` 在**全新服务器启动**时提供。
- 手动注入 continuum 的定时保存钩子到 `status-right`（因为热加载时 continuum 的「多客户端」
  启发式误判，跳过了自动注入）。已端到端验证：时间戳每个保存周期自行推进。
- 全程**未对线上服务器执行任何 kill / restart**，5 个 session 始终在线。
- **2026-10-01**：写入全局选项 `set -g history-limit 10000`。属**纯选项写入**——未 kill、
  未重建任何 session / window / pane，无进程受影响，与本文件一贯的"不碰活着的会话"原则一致。
  但同样只对**此后新建**的窗口生效：当时在线的 14 个 pane 仍保持 2000，需各自重建才拿到新上限
  （语义与实测见 §4.2）。内存开销实测约 1.5MB / 灌满 1 万行的 pane。

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

## 10. 事故记录 — 2026-07-25 启动竞态导致恢复静默失败

宿主机重启后，Nexus 启动时 `nexus-restore-tmux.sh` 被调用 6 次（10:09–10:12），
**全部失败**，错误均为 `no server running on /tmp/tmux-1000/default`。

**根因**：WSL2 刚启动时的竞态。多个进程同时争抢 default tmux socket：
- `nexus-restore-tmux.sh` 的 `tmux start-server`
- ttyd 的 `tmux new-session -A -s claude-host-*`
- server.js 的 `tmux new-session -d -s main`

脚本的 `tmux start-server 2>/dev/null || true` 静默吞掉了启动失败，
导致后续 `tmux run-shell restore.sh` 找不到 server。6 次尝试全在 ~3 分钟内发生，
每次都以「无 server → 跳过恢复 → 创建全新 main session」结束，
没有任何一次恢复成功。

**恶化因素**：恢复失败后 continuum 继续每 5 分钟自动保存，`last` 链接被覆盖为
几乎为空的快照（只有新创建的 3 个 session），导致后续即使手动恢复也会读到空快照。
好在本案中重启前的完整快照（`tmux_resurrect_20260725T091845.txt`，3415 bytes，
含 5 session + 13 window）仍在磁盘上，未被删除。

**恢复**：重新 `ln -sf` 指向重启前快照 → 手动 `restore.sh` → 全部 5 session 找回。
对照快照 `pane_full_command` 列确认 `nexus-run-claude.sh` 启动的频道均正确还原了
cwd 与 profile。

**修复**（已实施）：`scripts/nexus-restore-tmux.sh` 中 `tmux start-server` 改为
带重试循环（最多 10 次、每次间隔 1s），并用 `tmux info` 验证 server 确实就绪后才继续恢复。
同时加了兜底：若 10 次后仍无 server，脚本以 `exit 0` 主动退出（不阻塞 Nexus 启动）。

**教训**：① 不要在启动路径中静默吞掉 server 创建失败；② `tmux start-server` 成功 ≠
server 能稳定服务后续命令，需用 `tmux info` 等验证就绪；③ `last` 链接被 POST-故障快照
覆盖是一个设计弱点——理想情况应在恢复成功后才更新 `last`（或保留最近 N 个快照的硬链接）。

## 11. 手动/一键恢复（Chrome-style）— 2026-09-04

Nexus 启动时自动恢复（§4.4）在 WSL2 启动竞态下可能失败（2026-09-03 事故即如此），
且 continuum 会把 `last` 覆盖为崩溃后的近空快照。为此新增：

- **快照选择器**：`nexus-restore-tmux.sh` 不再盲信 `last`，改为挑「最新一份含
  `nexus-run-claude.sh` 频道」的快照（近空快照被拒绝），并把它指为 `last` 再恢复。
  2026-10-02 补强：优先「≥2 条频道」的健康快照，只含单条频道的近空快照降级为兜底（§12）。
- **手动触发**：`nexus-restore-tmux.sh --manual` 绕过 fresh-server 标记门，可在活服务器上
  随时幂等恢复（已存在 session/window 跳过、不覆盖在跑进程），打印 `RESTORE_OK` 结果行。
- **API**：`GET /api/restore/status`（`pending` + `available`、快照丰富度、busy、freeMem）、
  `POST /api/restore`（一键恢复，in-flight 锁，返回恢复计数）。
- **严格 gating**：boot 检测到全新 tmux 服务器（=上次崩溃/重启）时写
  `data/restore-pending.json`，全部快照 session 恢复完成后清除；`available = pending && 有富快照`。
  「恢复」按钮只有崩溃后且仍有缺失时才可点，平时置灰。
- **前端**：「恢复会话」入口在 **Settings → 会话恢复**（按钮 disabled 态 + hover title +
  行内说明，移动端无 hover 靠行内说明）；项目列表为空且有待恢复标记时，SessionManagerV2
  显示 Chrome 式横幅「检测到上次会话，一键恢复？」作为快捷入口。
- 对话接续仍由 `nexus-resume-claude.sh` 完成（pane 标题 ↔ `~/.claude/projects/*.jsonl` 模糊匹配）。

设计见 `docs/superpowers/specs/2026-09-04-nexus-restore-design.md`（gitignored 工作文档）。

## 12. 事故记录 — 2026-10-02 重启后 Nexus 起不来（stale `$TMUX` 进 PM2 env）

**症状**：宿主机重启后 Nexus 进程在跑、面板能打开，但**一个 session 都恢复不出来**，
「恢复会话」按了只回 `[restore-manual] failed: tmux 不可用`。`~/.pm2/logs/nexus-error.log`：

```
[nexus-restore] tmux 服务器启动失败，跳过恢复（将在无历史状态下启动）
error creating /tmp/tmux-1000/default (No such file or directory)
error connecting to /tmp/tmux-1000/default (No such file or directory)
```

这一次卡了 **21 分钟**（11:47 开机 → 12:08:52 才出现 tmux server），全程 Nexus 等于废掉。

**根因**：PM2 曾在某个 tmux pane 里执行 `pm2 save`，pane 的会话变量被写进
`~/.pm2/dump.pm2`：`nexus` / `dsh-web` / `wechat-agent` 三个 app 的 env 里都带着
`TMUX=/tmp/tmux-1000/default,<旧 pid>,<idx>`、`TMUX_PANE`、`TMUX_SESSION`、
`TERM_PROGRAM=tmux`、`TERM=screen-256color`。开机 `pm2 resurrect` 会把它们原样注入。

而 **`$TMUX` 等价于 `tmux -S <socket>`：显式指定 socket 路径时 tmux 不会创建 socket 目录**
（只有隐式路径 `$TMPDIR/tmux-$UID` 才会自动建）。`/tmp` 是 tmpfs，每次开机都是空的，
`/tmp/tmux-1000` 不存在 → nexus 的每个 tmux 调用都以那句 `error creating …` 失败：

```bash
# 复现（宿主机重启后的状态）
TMUX=/tmp/tmux-1000/default,999,0 tmux new-session -d -s x
# error creating /tmp/tmux-1000/default (No such file or directory)
```

**自愈条件**：只要有任何**不带** stale `$TMUX` 的进程先建出 `/tmp/tmux-1000`（当天的
DSH 探针脚本、或用户自己开 tmux），nexus 后续调用就立刻恢复正常 —— 所以表现为
「随机卡一段时间后自己好了」。

**修复**（双保险）：
1. `server.js` 启动最前面（**.env 加载之前**，好让 .env 的 `TMUX_SESSION` 优先）摘掉
   `TMUX` / `TMUX_PANE` / `TMUX_SESSION`。这是根治点：只要 nexus 自己不吃这口毒，
   dump.pm2 里有没有脏变量都无所谓。
2. `nexus-restore-tmux.sh` 开头 `unset TMUX*` 并 `mkdir -p $TMPDIR/tmux-$UID`（0700），
   让 boot 与手动一键恢复都不再依赖「tmux 自己会建目录」。

**重启验证（2026-10-02 当天实测）**：`pm2 restart nexus` 后启动日志出现
`[Nexus] tmux global env sanitized: TERM_PROGRAM, TMUX, TMUX_PANE, TMUX_SESSION`；
tmux global env 里的 `TMUX=/tmp/tmux-1000/default,90240,6`（已死的旧 server pid）等全部清除；
nexus 子进程 env 与新建 pane 的 env 里 `NODE_CHANNEL_FD` / `PM2_*` / `pm_id` 均已消失。
另记两个 tmux 行为，排查时别被误导：
- **socket 目录建不出来时 `tmux` 仍 exit 0**（只在 stderr 报 error creating），
  所以「命令返回成功」不能当健康判据，要看 `has-session` / `show-environment`。
- `/proc/<pid>/environ` 是 **exec 时的初始 env 块**，进程内 `delete process.env.X`
  不会反映在它上面 —— 验证 env 清理要看该进程**派生出的子进程**的 environ。

**运维注意**：
- **不要在有 `$TMUX` 的 shell 里 `pm2 save`**；确需如此用
  `env -u TMUX -u TMUX_PANE -u TMUX_SESSION pm2 save`。
- 存量脏变量还在 `dump.pm2` 里（`dsh-web` / `wechat-agent` 也中招），要彻底清掉需在干净
  shell 里 `pm2 restart <app> --update-env` 后 `pm2 save`。
- 同类事故史：§10（2026-07-25 WSL2 启动竞态）、以及 2026-10-02 上午刚修掉的
  `NODE_CHANNEL_FD` 注入（PM2 变量进 tmux global env，pane 里 node 直接 SIGABRT）。
  同一族问题：**PM2 的 env 会被冻进 tmux**。
- 同一天还踩到选择器误判：崩溃后重建的 `main` 里已跑着 claude，continuum 存下**只含这一条
  频道**的近空快照并成为最新 → 被当成「有频道的快照」选中，恢复出来仍是空的。已改为
  优先 ≥2 条频道的快照（见 §11）。

## 13. 权威划分：tmux server 归 systemd（2026-10-02 重构）

**一句话**：以前「谁先调用 tmux 谁顺手把 server 建出来」，于是 server 带着那个调用者的环境
出生（PM2 的 `NODE_CHANNEL_FD`、`$TMUX`、pane 的会话变量、甚至 `JWT_SECRET` 全被冻进 tmux 的
global env，所有 pane 继承）；现在 **server 是一个 systemd 服务**，环境由 unit 显式写死。

| 事物 | 归属 | 保证 |
|---|---|---|
| tmux server 存在 / socket 目录 / server 的环境 | `nexus-tmux.service`（`deploy/systemd/nexus-tmux.service`，系统级，`User=librae`） | `After=tmp.mount` + `ExecStartPre` 建 `/tmp/tmux-1000`(0700)；`Restart=always/2s`，server 死了自动拉起 |
| 会话结构 + claude 接续 | 同一 unit 的 `ExecStartPost` → `scripts/tmux-server-ready.sh` → 后台跑 `scripts/nexus-restore-tmux.sh` | 服务器（重）启动就恢复；**中途 server 死亡也能自愈**（Nexus 启动钩子做不到） |
| 停机前的最后一张快照 | unit 的 `ExecStop`（先 `run-shell save.sh` 再 `kill-server`） | 干净关机最多丢几分钟 |
| 面板 / 就绪判定 / 救援 | Nexus（纯消费者） | 起服务后异步探测 tmux；不可用/有 session 没恢复 → 面板亮救援横幅 + 微信推送 |
| 4 个 PM2 服务 | `pm2-librae.service`（`Before=` 关系把它排在 tmux 之后；drop-in 把 `Restart` 收紧为 `always`） | 一次开机全回来 |

**Nexus 不再做的事**（这些代码已删）：自己起 server、清 tmux global env、触发恢复、拿「全新服务器」
启发式判断该不该恢复。改判据为事实：**快照里有、线上没有 → 可恢复**（`missing_sessions()`）。

**为什么 unit 的 ExecStart 是 `scripts/tmux-server-supervise.sh` 而不是 `tmux -D`**：
`tmux -D` 不许带命令（等价于「起会话并显示」），systemd 没有 tty → 报
`open terminal failed: not a terminal`（隔离演练实测）。`Type=forking` + `new-session -d` 则只能
靠猜 MainPID，server 死掉未必触发 `Restart=`。监督脚本起 server（detached，不需要 tty）后前台
盯住它，server 一没就以非零退出 → systemd 重启整个 unit → ExecStartPost 再恢复一次。

**运维铁律（血泪版）**
- **不要在任何地方 ad-hoc 起 tmux server**（`tmux new-session`）：socket 目录/server 缺席时它会造出
  一个不受 systemd 管的野生 server，环境随调用者而定。Nexus 的建 session 接口已加
  `tmuxServerUp()` 守卫（缺席返回 503 + `rescue:true`），新代码请沿用。
- **tmux 的 socket 只认 `$TMUX` 和 `$TMUX_TMPDIR`；它不认 `TMPDIR`**。所以：
  - 凡是「隔离/演练」，必须 `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=<dir>`；只设 `TMPDIR` 会静默打在
    线上 socket 上（2026-10-02 我用它清空过全机 session，第 3 次同类事故）。
  - 拆一个隔离 server 一律用显式 `tmux -S <path> kill-server`，**任何情况下都不要在带 `$TMUX` 的
    shell 里敲 `kill-server`**。
- **不要在 tmux pane 里 `pm2 save`**：pane 的会话变量会被冻进 `dump.pm2`，每次 resurrect 都注入。
- `/proc/<pid>/environ` 是 exec 时的初始 env，进程内 `delete process.env.X` 不体现在上面 —— 验证要看
  **子进程**的 environ。

**验证状态（2026-10-02）**
- 已验证：隔离演练（unit 的确切 env + 真实 ExecStartPost 帮手 + dry-run 恢复）——server 无 tty 起得来、
  **global env 干净**（无 PM2/claude/密钥污染）、快照 5 个 session 都恢复进隔离 socket、线上会话与快照
  文件数未变、server 被杀后监督脚本以非零退出 ✓。
- 未验证（首次真重启即验收）：unit 在真机上被 systemd 启动（`Type=exec` + `Before=pm2-librae.service`）、
  `ExecStop` 的快照、以及「开机 → 会话自动回来」的端到端。
- 观察点：开机后看 `systemctl status nexus-tmux`、`journalctl -u nexus-tmux`、
  `tail logs/tmux-restore.log`、`tmux ls`（应 ≥5 session）。
- 已知未解释：隔离演练里 resume 那步偶尔报「session 不存在」（同一份代码在线上默认 socket 下多次实测
  正常）。首次真重启时留意 `logs/tmux-restore.log` 里 resume 是否真的接上 claude。

**救援模式（最坏情况的兜底，用户硬要求）**
- 只要 Nexus 能起（它**永不 exit**，探测失败也照常监听），面板就可用，并亮「救援模式」横幅。
- 三条自救路径：**救援 Shell**（`/ws?rescue=1`，node-pty 直起 zsh，**不依赖 tmux**）、
  **Recovery Agent**（`/ws?rescue=1&agent=1`，同一裸 PTY 里拉起 claude 并带预置任务：
  先跑 `scripts/nexus-rescue.sh`、再按输出处置）、**一键救援**（`POST /api/rescue/run`）。
- `scripts/nexus-rescue.sh` 零 root：补 socket 目录 → server 不在就手起 → 跑 manual 恢复 → 打印诊断。
- 进救援模式会经 wechat-agent 推一条微信（30 分钟去重）。

## 14. 操作审计：谁在什么时候动了什么（2026-10-02）

**动机**：当天排查时最费劲的不是技术，而是「这个 session 是谁删的」——面板操作、shell 里
直接敲 tmux、系统自动行为混在一起，而 pm2 日志连时间戳都没有。事后问用户才知道是他删的。

**两层记账**（都在 `server.js`，落盘 `data/audit.log`，1MB 单代轮转，同时打 stdout）：
1. **API 审计**：凡经 Nexus 的变更逐条记 actor：
   `login-ok/login-fail`、`session-created`、`session-deleted`、`session-renamed`、
   `channel-created`、`channel-renamed`、`history-cleared`、`fs-deleted`、`restore`、`rescue`。
   例：`{"action":"session-deleted","target":"tmp","result":"ok","actor":{"ip":"127.0.0.1","device":"脚本(curl/8.14.1)"}}`
   —— **有 actor 就是经接口/面板/脚本干的**。
2. **状态对账**：每 60s 比对 tmux 的 session/窗口清单，发现增减就记 `session-added` /
   `session-removed` / `session-windows-changed`，并标注 `via`：
   `via=api`（10 秒内有对应 API 调用）或 **`via=unknown(命令行/外部)`** —— 后者就是
   「有人绕过 Nexus、直接在 shell 里动了 tmux」。
外加 `tmux-ready` / `tmux-broken` 两个生命周期事件（带当时的 session 清单）。
**入口**：Settings → 操作日志（`GET /api/audit?lines=N`），也是排查时该看的第一现场。

**排查口径**：先看 `data/audit.log` —— 有 API 记录 = 面板/脚本；只有 `via=unknown` = 命令行；
两者都没有 = 不是 Nexus 也不是 tmux 层面的事（去 `journalctl -u nexus-tmux` / 内核日志）。

## 15. 健壮性审查：又发现 4 个缝隙（2026-10-02 晚）

架构换成 systemd 权威之后，我拿「断电/重启」当假想敌又审了一遍，实测挖出 4 个真缝隙
（前 3 个已修，第 4 个只是可见性，改动是刻意的）：

1. **保存端不可靠（最严重，已修）**：continuum 的「每 5 分钟自动快照」挂在 `status-right` 上，
   靠状态栏重绘触发 —— 没人看/不活跃就不存。当天快照时间线实测出现 `13:37→13:47`、
   `14:03→15:08`（**65 分钟**）的空档。断电时「恢复出来的是最长一小时前的结构」。
   修法：新增 `nexus-tmux-snapshot.timer`（每 5 分钟，`OnCalendar=*:2/5`，`Persistent=true`）
   + `scripts/tmux-snapshot.sh`（`tmux run-shell save.sh`；顺带 `last` 悬空自愈；
   保存后最新快照仍 >12 分钟就以非零退出，让 `journalctl -u nexus-tmux-snapshot` 上能看见）。
   **保存从此与有没有人看无关。**
2. **接续 claude 早于代理（已修）**：所有 profile 的 BASE_URL 都在墙外（deepseek/moonshot/
   openrouter/官方），claude 频道都要经本机 mihomo（7890）。而 tmux unit 排在 pm2 之前
   → 恢复脚本接续 claude 时代理可能还没起来，claude 首次请求失败、pane 掉回 zsh。
   修法：`nexus-restore-tmux.sh` 里接续前 `wait_proxy`（探 `127.0.0.1:7890`，最多 60s）。
3. **恢复后无人核对结果（已修）**：以前 `RESTORE_OK` 只表示「脚本跑完了」。现在脚本收尾做闭环：
   核 `missing_sessions` 与「实际在跑的频道数 vs 快照里的频道数」，不齐就写审计
   （`restore-incomplete`）+ 推微信；齐了写 `restore-ok`。首次接续 0 个频道时还会隔 5s 重试一次
   （防 session 瞬时不可见的竞态）。
4. **「session 在、频道丢了」看不见（已修，但只做可见性）**：判据原来只到 session 级。
   今天 home-librae 正是这种半残状态（session 被面板重建为空壳）。现在 `/api/restore/status`
   与 `/api/rescue/status` 多返回 `missingChannels` / `missingChannelsList`，面板横幅会显示
   「有 N 个频道没恢复回来」并可一键恢复。**但自动恢复的闸门故意仍留在 session 级** ——
   否则「你故意删掉的频道」会在每次重启时复活。想要频道级自动恢复的话，改
   `nexus-restore-tmux.sh` 的闸门一行即可（`missing_sessions` → 再加 `missing_channels`）。

**审查结论**：结构层（谁拥有 server、环境、开机顺序、自愈）已经稳；这次补的是**保存端的
确定性**与**结果闭环**。仍然未验证的是「真机重启」那一次（下一次重启即验收）。

## 16. 底线保证：页面可达 + 页内能起 recovery agent（2026-10-02）

**用户的定义（比「会话能恢复」严）**：无论任何情况宕机，都要能 ① 通过 tailscale 打开 Nexus
页面，② 在页面里启动至少一个 recovery 用途的 AI agent。据此又查了一遍，补了三处会破功的地方：

1. **recovery agent 曾经连不上模型**：nexus 自己的 env 带着 `HTTP_PROXY=127.0.0.1:7890`，
   而最坏情况正是 PM2 挂了 → mihomo 也没了 → agent「连模型都连不上」。
   修：`spawnRescuePty` 给 agent **摘掉全部 proxy 变量走直连**，并把默认 profile 从
   `anthropic`（官方接口本来就得靠代理）换成墙内直连可达的 `deepseek`；预置任务里补一句
   「若还有服务没起来：`pm2 resurrect` / `pm2 start ecosystem.config.cjs`，mihomo 不在就先起它」。
2. **页面本身没人看门**：新增 `nexus-watchdog.timer`（开机 3 分钟后、每分钟）+ `scripts/nexus-watchdog.sh`：
   只关心 59000 在不在 —— 连续 3 次探活失败 → `pm2 restart nexus`；**nexus 不在 PM2 列表**
   （dump.pm2 被断电写坏时 resurrect 会一个都拉不起来）→ 从 `ecosystem.config.cjs` 重新拉起。
   动作写审计 + 微信。带 `NEXUS_WATCHDOG_DRY_RUN=1` 演练开关（已实测故障判定路径，线上未受影响）。
3. **pane 崩溃产生 core 转储**（38MB/个，今天在仓库里攒了 116MB）：tmux unit 加 `LimitCORE=0`。

**已实测（本机）**：页面在 tailnet IP（100.117.237.10:59000）与 LAN IP（192.168.3.243:59000）
都是 200；iptables 无拦截；`sshd` active（tailnet 上还有一条不依赖网页的兜底：ssh 进去手起）。
GRUB `TIMEOUT=5`（引导菜单不会卡着等人）。Nexus 永不 exit（探测失败照常监听）。

**唯一无法从 Linux 侧保证的**：**断电后机器自己不开机** —— 取决于 BIOS/UEFI 的
「AC Power Recovery / Restore on AC Power Loss」是否为 Power On，以及有没有 UPS。
最近三次开机日志看不出问题，但这一条只能到 BIOS 里确认（或加 UPS）。**这是「任何情况」定义下
的头号待办。**
