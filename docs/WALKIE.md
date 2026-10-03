# 对讲机模式（F-24，实验特性）

> **一句话**：把「打开 Nexus → 切 project → 切 channel → 点焦点 → 敲字 → 回车」压成
> 「转旋钮选频道 → 按住说话 → 按发送」。

---

## 为什么做

移动端操作 Nexus 的摩擦太高。真正要的是**在走路/开车/手上有事的时候，把一句话交给某个
Claude 会话**，而不是去操作一个终端面板。

对讲机模式把一次交互固定成三个动作：

```
转旋钮选频道  →  按住说话（边说边转写）  →  松手自动精炼  →  按发送
```

发出去之后，AI 的回复会显示在屏幕上，并**自动朗读一句摘要**；想听细节就点「▶ 全文」。

---

## 它是怎么工作的

```
┌── APK（风味包 walkie）───────────────────────────────┐
│  WalkieApp.tsx                                       │
│    ├─ ChannelDial.tsx   双旋钮：外圈 project / 内圈 channel │
│    ├─ speech.ts         按住说话 → 转写（三条路，见下）    │
│    ├─ api.ts            → /api/walkie/*              │
│    └─ tts.ts            回复 → 语音播报                │
└──────────────────────────────────────────────────────┘
                        │ HTTP（同一份 bundle，浏览器里也跑得起来）
┌── Nexus 后端 walkie.js ──────────────────────────────┐
│  GET  /api/walkie/channels     频道清单（含"是不是 claude"）│
│  POST /api/walkie/send         paste + Enter 落到输入框   │
│  POST /api/walkie/refine       口语 → 精确指令（LLM）     │
│  POST /api/walkie/summarize    回复 → 一句口播摘要（LLM）  │
│  GET  /api/walkie/reply        这一轮的回复（追踪中/回看）  │
└──────────────────────────────────────────────────────┘
                        │ tmux
              project(session) : channel(window)
```

### 1. 选频道 —— 双旋钮，不是列表

外圈是 project（tmux session），内圈是 channel（tmux window）。手指在圈上划圈，**刻度跟着
手指走**（物理旋钮的心智模型），松手吸附到最近一格并震一下；直接点某个标签就是跳过去。

用 HTML + CSS transform 而不是 SVG 画的：标签必须始终正着（中文倒着没法读），而
`rotate(θ) translateY(-R) rotate(-θ)` 这组变换正好把标签摆到圆周上并保持水平。半径必须写成
`calc(var(--walkie-dial) * k)` 的**绝对量** —— `translateY` 的百分比是相对元素自身高度算的，
拿它当半径会把标签全堆到圆心。

### 2. 说话 → 文字（v2：录音 + 本机转写）

**v1 走的是 Android 原生 `SpeechRecognizer`，真机上废了。** 症状：权限给了、按下去也进了
"松手结束"状态，但**一个字都不吐**。原因是国产 ROM 上没有可用的 Google 语音服务，而该插件
`partialResults: true` 时 `start()` 立即 resolve，之后 `onError` 里的 `call.reject()` 打在
一个已 resolve 的 call 上 —— **JS 侧收不到任何错误**，`listeningState` 也不发。于是按住说话
变成按住没反应，且没有任何提示。

现在改成：

```
按住 → MediaRecorder 录音（WebView 内）
松手 → POST /api/walkie/transcribe（音频 blob）
     → Nexus 转发给本机 intake（:59011）
     → sherpa-onnx SenseVoice-small-int8 转写
     → 文本回到 App
```

好处：

- **不依赖任何云端语音服务**，国产 ROM / 无 Google 服务 / 离线都能用；
- **音频不出本机** —— 转写跑在 `~/work/intake`，与会议录音共用同一套 ASR，只有一份实现；
- 出错能报：录不到、权限被拒、转写服务没起，各有明确文案（v1 全是静默）。

代价：**失去"边说边出字"的实时预览**，松手后约 1.5–2 秒出结果。对讲机本来就是"说完再看到"，
这个取舍可以接受；界面用一条随时间起伏的波形表示"确实在录"，而不是让你对着静止文字猜。

真机上要能录音，`AndroidManifest.xml` 必须声明 `RECORD_AUDIO` 与 `MODIFY_AUDIO_SETTINGS`
（Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 会把 WebView 的 AUDIO_CAPTURE
请求映射到这两个权限）。另外页面必须是 secure context —— Capacitor 的本地服务在
`http://localhost`，Chrome 视其为可信来源。

### 3. 口语 → 精确指令（松手即自动精炼）

纯口述必然带大量口水话。松手后**自动**把转写稿送去精炼：

> 「呃那个我想让你帮我看一下，就是说我们那个项目里面那个 README 嗯好像有点旧了，
>  就是很多那个安装步骤都不对，你帮我把它更新一下，然后呢顺便把配置那一节也补充完整一点」
>
> ↓
>
> 「更新项目 README：修正安装步骤，补充完整配置章节。」

精炼**只是替换文本框里的内容**，不是拦截：你随时能改、能「还原原文」；按发送时发的是框里
此刻的文字。精炼失败或超时（3 秒）也绝不挡发送 —— 宁可发原文。

用的是 `data/configs/<WALKIE_LLM_PROFILE>.json` 里已有的 profile（默认 `deepseek`），
不新增任何密钥。profile 缺失时 `/refine` 原样返回输入，功能自动降级。

### 4. 投递：直接落到那个频道的输入框

`POST /api/walkie/send` 走 tmux，不经过 PTY：

```
tmux load-buffer -b nexus-walkie -     ← 文本走 stdin，绕开 shell 引用和参数长度限制
tmux paste-buffer -b nexus-walkie -t <session:window> -d -p
   ↳ -p 是 bracketed paste：多行文本会原样进入输入框，而不是被拆成多次回车提交
（等 260ms，TUI 要先消化完粘贴内容，否则回车会被当成换行）
tmux send-keys -t <session:window> Enter
```

**护栏**：目标 pane 里没有 claude 就拒发（409）。`/channels` 会用一次 `ps` 做进程树 BFS
给每个频道打上 `kind: 'claude' | 'other'` 标记，前端据此禁用发送、旋钮上标 ⚠。前端拦一道、
后端再拦一道 —— 防的是绕过前端直接打 API。否则「更新一下 README」会被 zsh 当命令执行。

### 5. 回复：从 Claude Code 的 transcript 里精确取

最不显然的一块。同目录下可能并行跑着好几个 claude（vault 就有 5 个），所以「哪个
transcript 是本频道的」**不能靠 mtime 猜**。判据用内容：

1. 发送前记下 `<slug(cwd)>/` 下所有 `.jsonl` 的大小
2. 发送后轮询，找**变大且里面新出现的 human 发言文本和我们刚发的对得上**的那个文件
3. 认定后只增量读新增字节，靠 `type=system, subtype=turn_duration` 判回合结束
   —— 这是 Claude Code 自己写的「本轮答完了」标记，比在 TUI 上猜 spinner 稳得多
4. 认下来的 sessionId 落盘 `data/walkie-sessions.json`，**重启后仍能回看上一次的回复**

追踪是**按频道各自独立**的（`Map<频道, timer>`），不跟着视野走：切到别的频道看看、
甚至在那儿再问一句，原来那轮答完了照样落进缓存，切回去就还在。

---

## 两个 APK

不是为了省事才做成两个包，是因为**这是实验**：不想动每天在用的那个。但也**不该**维护第二份
Android 工程（gradle 壳子、图标、签名、Capacitor 配置都得跟着同步，迟早不一致）。所以用
Gradle product flavor，同一份代码、同一份 web 产物：

| | classic | walkie |
|---|---|---|
| applicationId | `com.librae.nexus` | `com.librae.nexus.walkie` |
| 应用名 | Nexus | Nexus 对讲机 |
| 图标底色 | 白 | 深色 `#0F172A` |
| `assets/public/ui-mode.json` | `{"default":"classic"}` | `{"default":"walkie"}` |

两个 applicationId 不同 ⇒ 可以同时装在手机上，数据互不干扰（localStorage 按包隔离，
FileProvider authority 也跟着 applicationId 派生，不会撞）。

前端启动时按 **URL 参数 → localStorage → `ui-mode.json` → classic** 的顺序定模式
（`frontend/src/walkie/mode.ts`）。浏览器里那个 probe 会命中 SPA 兜底拿到 index.html，
content-type 不是 json 就当没有这个文件 —— 所以浏览器行为与改造前逐字节一致，不需要构建
两份 bundle。

```bash
cd frontend && npm run build          # 先出 web 产物
./android/build-apk.sh assembleWalkieRelease    # 只出对讲机包
./android/build-apk.sh assembleClassicRelease   # 只出经典包
./android/build-apk.sh assembleRelease          # 两个都出
```

产物：`android/app/build/outputs/apk/<flavor>/release/app-<flavor>-release.apk`

在经典界面里，只有出厂默认是对讲机的那个包会多一个右下角的「🎙 对讲机」浮标用于切回；
浏览器用户从没见过对讲机，不会凭空多出按钮。

---

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `WALKIE_LLM_PROFILE` | `deepseek` | 精炼/摘要用 `data/configs/` 下哪个 profile |

不配也能用：精炼降级成「原文直发」，摘要降级成「截前 120 字」，投递与回复追踪不受影响。

## 已知边界

- **一次只认真追一轮**：同一频道重复发送会顶掉上一轮的追踪（新的一轮更重要）。
- **转写依赖本机 intake 服务**：`intake` 没在跑时按住说话会明确报「本机转写服务没在跑」，
  此时可点 ⌨ 用输入法语音键顶着。
- **回复的粒度是「这一轮的文字输出」**：只调工具不说话的那一轮会显示「（这一轮没有说话，
  可能只动了文件）」。想看完整过程还是回经典界面。
- **`turn_duration` 拿不到时**（老版本 Claude Code / 被中断）退化成「认领成功 + 有正文 +
  文件静默 6 秒」判定，界面上会标「（靠静默判定结束）」。

---

## 当前进度与待办（2026-10-03）

测试环境见 [`DEV-TESTENV.md`](DEV-TESTENV.md)（无头模拟器 + WebView devtools）。

### 已改完并在模拟器上验证

| 项 | 状态 |
|---|---|
| 按住说话能录音 | ✅ 录音状态、走秒、波形正常；`audit.log` 里有 `walkie-transcribe`，字节数非零 |
| 录音 → 上传 → 本机转写整链路 | ✅ 端到端跑通（`bytes: 12345, ms: 3347`） |
| 旋钮外观（名字移到上方、内外圈可分辨） | ✅ 桌面 Chrome + 真机 WebView 都看过 |
| 旋钮刻度跟手、选中格在指针下 | ✅ 修了旋转叠加两次的 bug，截图确认 |

### 改完了但**还没在真机/模拟器上验证**

| 项 | 怎么验 |
|---|---|
| 咔嗒声 | 模拟器**没有扬声器**，听不到。要真机，或桌面 Chrome 里手动拖旋钮 |
| 震动 | 模拟器没有马达。要真机（manifest 已补 VIBRATE） |
| 转写内容的**准确率** | 模拟器麦克风是静音的，只能验通路。要真机说话，或直接打 `intake` 的 `/transcribe` 喂音频文件 |
| **发出去之后回复能不能正常显示** | 上一轮的修复（`/reply` 无追踪时回看上次结果 + 阶段透出）**还没跑过一次完整的发送→回复**。见下 |

### 下一步（按优先级）

1. **验一次完整的发送 → 回复**：在模拟器上选一个 claude 频道，按住说话（或用 ⌨ 输入法
   输入一段文字）→ 发送 → 看等待卡片是否显示阶段（"已投领会话…" → "正在输出…"）→
   是否出现「AI 回复」卡片。这是上一轮真机上坏掉的那条路。
2. **真机回归**：装 `app-walkie-debug.apk`，说话验准确率 + 听咔嗒声 + 感受震动。
3. 若震动偏强/偏弱，调 `frontend/src/walkie/feedback.ts` 的 `haptic(ms)` 与
   `ChannelDial.tsx` 里各处毫秒数。
4. 若咔嗒声不对（太尖/太闷），调 `feedback.ts` 里 `bp.frequency`（现在 2300–2800Hz）
   与两个谐振频率（1750/3300Hz）。

### 已知取舍

- **没有"边说边出字"**：本机转写是整段转，松手后约 1.5–2 秒出结果。这是为了不依赖
  Google 语音服务而付的代价，见上面「说话 → 文字」一节。
- **转写依赖 `intake` 服务**（PM2 `intake`，:59011）。它没跑时按住说话会明确报错。
