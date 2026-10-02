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

### 2. 说话 → 文字

三条路按可用性依次退让：

| 环境 | 走哪条 |
|---|---|
| APK | Android 原生 `SpeechRecognizer`（`@capacitor-community/speech-recognition`） |
| Chrome 桌面 | Web Speech API（方便在电脑上验证整条链路） |
| 都没有 | 退化成 ⌨ 按钮，调起输入法用它自带的语音键 |

**Android 侧的两个坑**（读插件源码得到的，不是猜的）：
- 该插件 `partialResults: true` 时 `start()` 立即 resolve，之后所有结果都从
  `partialResults` 事件来。反过来讲，识别出错时 `onError` 里的 `call.reject()` 打在了一个
  已 resolve 的 call 上 —— **JS 侧什么都收不到**；而 `onError` 又不像 `onEndOfSpeech` 那样
  发 `listeningState` 事件。合起来的后果是：用户按住不吭声（SPEECH_TIMEOUT）或说了句识别
  不出来的话（NO_MATCH），识别器就悄悄死了，按住说话变成按住没反应。
- 该插件**不会自动重启**识别。Android 的识别器一次只吃一段（说完静音就结束），所以
  「按住 = 一直听」必须自己实现成「不断重启 + 把每段拼起来」。

`speech.ts` 因此不依赖插件事件的完整性：按住期间超过 2.2 秒没有任何事件，就当作一段结束，
commit + 重启。正常分段结束（`onEndOfSpeech`）走同一套收尾逻辑，两条路都收敛到
`finishSegment()`，不会互相打架。

> **v2 可以更好**：本机已有完全本地的 ASR（`~/work/intake`，SenseVoice-small-int8 via
> sherpa-onnx，`py/asr.py` 有 CLI 入口）。把录音上传到 Nexus、在服务端转写，可以做到
> 音频不出本机、且不受 Google 语音服务的可用性影响。代价是要在 WebView 里录
> （MediaRecorder）并加一段服务端转写，属于另一次改动的量级，这一版没做。

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
- **识别靠系统语音服务**：Android 上默认走 Google/系统服务，可能联网。要全本地见上面 v2。
- **回复的粒度是「这一轮的文字输出」**：只调工具不说话的那一轮会显示「（这一轮没有说话，
  可能只动了文件）」。想看完整过程还是回经典界面。
- **`turn_duration` 拿不到时**（老版本 Claude Code / 被中断）退化成「认领成功 + 有正文 +
  文件静默 6 秒」判定，界面上会标「（靠静默判定结束）」。
