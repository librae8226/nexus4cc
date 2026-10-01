# 微信通道（iLink / ClawBot）运维文档

**先读这一条：一个微信号同时只能有一个 bot 在线，新扫码会立刻顶掉旧的。
非必要不重扫 —— 重扫会把正在工作的会话杀掉。**

---

## 它是什么

腾讯官方开放的微信个人账号 Bot 能力（官方名「微信 ClawBot 插件」，底层协议 **iLink**，
域 `ilinkai.weixin.qq.com`）。微信私聊消息 → headless `claude -p` → 回复回微信。

| 组件 | 位置 |
|---|---|
| worker 进程 | `channels/wechat-worker.mjs`，PM2 名 `nexus-wechat`（`autorestart: true`） |
| 开机自启 | `pm2-librae.service`（systemd，已 `enabled`）+ `~/.pm2/dump.pm2` 含本应用 |
| 凭证 | `data/channels/wechat.json`（0600，`data/*` 已在 `.gitignore`） |
| 对话日志 | `data/channels/wechat.log`（5MB 轮转，供 tmux `tail -F` 观看） |
| 媒体落盘 | `data/channels/inbox/<日期>/`（**暂无清理策略**） |

### 看实时活动：tmux 窗口 `home-librae:wechat`

窗口里跑 `tail -n 200 -F data/channels/wechat.log`，在 Nexus UI 里直接可见：
收到的消息、agent 的每次工具调用、回复正文、耗时与费用。**消息有没有送达、
agent 在干什么，看这个窗口即可。**

**worker 不放进 tmux，只留 PM2 监督。** 反过来做的话，机器重启后
`scripts/nexus-match-panes.js` 只认标题含 `nexus-run-claude.sh` 的 pane，
worker 不会被拉起。tmux 只负责「看」，PM2 负责「活」。

该窗口能被 `tmux-resurrect` 自动恢复，因为它满足两个条件：进程名是 `tail`
（在 resurrect 的默认恢复列表里），且命令来自 pane 的子进程 —— 所以**必须
先开 shell 再 `send-keys` 输入命令**，不能把命令直接交给 `tmux new-window`
（那样 pane 进程就是 `tail` 本身，没有子进程，保存下来命令是空的，恢复时只开个空 shell）。
误关了就这样重建：

```sh
tmux new-window -t home-librae -n wechat -c ~/work/nexus
tmux send-keys -t home-librae:wechat "tail -n 200 -F ~/work/nexus/data/channels/wechat.log" Enter
```

## 支持的消息类型

入站 5 类**全部支持**，2026-10-01 均以真实微信消息实测通过：

| type | 类型 | 处理方式 |
|---|---|---|
| 1 | 文本 | 原样交给 agent |
| 2 | 图片 | CDN 下载 → AES-128-ECB 解密 → 落盘，路径交给 agent |
| 3 | 语音 | 优先用微信自带转写 `voice_item.text`；**同时**用 `silk-wasm` 解成 WAV 落盘（ffmpeg 无 SILK 解码器） |
| 4 | 文件 | 下载 → 解密 → **校验 `md5`** → 落盘 |
| 5 | 视频 | 下载 → 解密 → **校验 `video_md5`** → 落盘 |

- 媒体上限 **100 MB**（官方常量 `WEIXIN_MEDIA_MAX_BYTES`）
- 解密：AES-128-ECB + PKCS7，key 为 `media.aes_key`(base64 的 32 位 hex) 或 `image_item.aeskey`(明文 hex)
- agent 通过本地路径访问媒体，自身有完整 Bash/读文件权限

## ⚠️ 会话模型：一个微信号只能有一个 bot

**2026-10-01 实测确认**：iLink 无续期接口，但会话**不会自己到期**。真正杀死会话的是
**重新扫码** —— 每次扫码签发新的 `ilink_bot_id`，旧 bot 立即返回 `-14 session timeout`。

### 事件链证据（当天四次绑定，全部自洽）

| 时间 | 事件 |
|---|---|
| （前一日） | dsh 插件绑定 `d31840382c34` |
| 01:03:22 | nexus 绑定 `c80bf5d706a0` → 顶掉 dsh 的（dsh 记「会话已过期」后休眠至今） |
| 01:04 – 21:17 | `c80bf5d706a0` **正常工作约 20 小时**，期间正常收发消息与文件 |
| 21:38:21 | 手工重绑出 `49cebbca5a40` → **13 秒后** `c80bf5d706a0` 报 `-14` |
| 21:40:12 | nexus 重绑 `f8a8f9a5138c` → 事后探测确认 `49cebbca5a40` 已死，`f8a8f9a5138c` 活着 |

结论：**20 小时那次不是「到期」，是被自己人的重扫顶掉的。**
只要没人重扫，会话就应该一直活着（当前尚无自然死亡的观测样本）。

### 因此的运维铁律

1. **不要重扫。** 除非确认 `-14` 且确认没有任何其他绑定存在。
2. **不要删 `data/channels/wechat.json`。** 删掉 = worker 会走扫码流程 = 新 bot = 顶掉。
   worker 自身的逻辑是安全的：只有文件不存在时才扫码，`-14` 时**不会**自动重扫。
3. **不要启用第二个绑定。** 任何其它工具/插件/agent 对同一微信号扫码，都会杀死本通道。
4. 历史坑：`~/.dsh/clawbot/`（dsh 插件）曾持有第二个绑定，已于 2026-10-01 停用
   （`listenEnabled: false`，备份 `state.json.bak-*`）。

## 故障处理

| 现象 | 含义 | 处置 |
|---|---|---|
| 日志出现 `❌ 会话已过期（ret=-14）` | 本 bot 被顶掉了 | **先确认没有其他绑定在跑**，再决定是否重扫 |
| 进程存活但不回消息 | 多半是上面的情况 | 看 `data/channels/wechat.log` 末尾 |
| 需要主动推消息给用户 | 缓存 `context_token` **实测可用** | 见下 |

### 主动推送

worker 只在「回复入站消息」时发送。若要 nexus 侧主动推送，可复用
`data/channels/wechat.json` 里的 `contextTokens[<peer>]` + `token` 调
`ilink/bot/sendmessage`。**注意**：worker 源码头部注释称「缓存旧值会静默不投递」，
但 2026-10-01 实测**该说法不成立** —— 用缓存 token 主动推送返回了 `message_id`
且用户确认收到。判据仍是「响应含 `message_id`」。

## 重新绑定（仅在确认必须时）

```sh
# 1) 先确认没有别的绑定在跑，否则白扫
# 2) 移走凭证（不要直接删，留备份）
mv data/channels/wechat.json data/channels/wechat.json.bak-$(date +%Y%m%d-%H%M%S)
# 3) 重启，worker 会打印二维码链接到 data/channels/wechat.log
pm2 restart nexus-wechat
```

二维码是**链接**（`https://liteapp.weixin.qq.com/q/...`），需在微信内打开扫码。
