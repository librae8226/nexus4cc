# 对讲机模式（F-24，实验特性）

> **交互已经按 [`WALKIE-V2.md`](WALKIE-V2.md) 重做过**（旋钮下移、圆心即说话/发送、
> 动作流、文件浏览器）。本文讲的是底层机制（ASR / 投递 / 回复追踪），那些没有变。

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

**两个圈各自有颜色**：外圈 PROJECT 是琥珀，内圈 CHANNEL 是蓝。旋钮上的齿纹、刻度、
选中标记，以及上方读数前面的小色块，全用同一套色 —— 这是"哪个是外圈哪个是内圈"的答案。
名字只在**上方**显示：中文绕在圆周上必然被截断，而且两个圈的字混在一起根本分不清。
圈上只留刻度，旋钮自己靠**齿纹转动**表达"它在转"（静止的刻度看不出动）。

**手感**：每过一格合成一声"咔"（WebAudio，噪声瞬态 + 三个不同衰减的谐振，每声有微扰，
不是循环同一个采样）+ 一次 `Haptics.selectionChanged()`；松手吸附时一声低沉的"咚" +
`Haptics.impact(Medium)`。

> 震动**不能**用 `navigator.vibrate`：它在 Android WebView 里存在、调用还返回 `true`，
> 但 Chromium 的 WebView 没实现 VibrationManager，是静默空转。必须走 Capacitor 的
> Haptics，那才是真的在驱动马达。

用 HTML + CSS transform 而不是 SVG：标签要始终正着，而
`rotate(θ) translateY(-R) rotate(-θ)` 正好把刻度摆到圆周上并保持水平。半径必须写成
`calc(var(--walkie-dial) * k)` 的**绝对量** —— `translateY` 的百分比是相对元素自身高度算的，
拿它当半径会把刻度全堆到圆心。

### 2. 说话 → 文字（按住说话的实时转写）

**不是 Android 的 `SpeechRecognizer`。** 真机实测过：权限给了、按下去也进了"松手结束"
状态，但**一个字都不吐** —— 国产 ROM 上没有可用的 Google 语音服务，而那个插件出错是
静默的（`partialResults` 模式下 `onError` 的 `reject()` 打在了一个已 resolve 的 call 上，
JS 侧什么都收不到，`listeningState` 也不发）。按住说话于是变成按住没反应，且没有任何提示。

现在走的是：

```
按住 → getUserMedia（带 AEC/降噪）→ AudioContext → ScriptProcessor → Float32 样本
     → 按静音切段（最简 VAD）→ 每段编成 WAV 单独 POST
     → Nexus 转给本机 intake（:59011）→ sherpa-onnx SenseVoice-small-int8 转写
     → 文本按段落顺序拼起来，边说边冒出来
松手 → 只等最后一段落地（约 1.5 秒）→ 全文
```

**为什么能"边说边出字"**：本机 ASR 的耗时几乎全是模型加载的固定开销 —— 实测
1 秒的片段 1364ms，3 秒的片段 1402ms。所以切成小段分别转几乎不额外花钱。切段只发生在
**能量低谷**（静音持续 420ms 之后），段尾天然落在自然停顿上，不会把词切坏。

**两道防幻觉的门**（都踩过）：
- 阈值自适应。底噪高的设备上固定阈值会永远不"静音"，只能靠上限硬切；
- 一段里"有声"的部分不足 0.25 秒就整段丢掉。只按长度过滤的话，**纯噪声会被送去转写，
  而 SenseVoice 会一本正经地为它编出一句话**（模拟器上静音输入转出过 6 个字的幻觉）。

**为什么不用 MediaRecorder**：它只能整段拿走音频，中间插不进去，想要边说边出字就必须
能按段切。顺带也省掉了 MediaRecorder 那套容器格式协商（不同 WebView 支持的 MIME 不一样，
是个静默的坑）。代价是 `ScriptProcessorNode` 是废弃 API 且跑在主线程 —— 但它到处都有，
而 AudioWorklet 要单独加载模块文件，在 WebView 里多一层不确定性。

> 音频不出本机：转写跑在 `~/work/intake`，与会议录音共用同一套 ASR，只有一份实现。
> 首次按下会弹系统的麦克风权限框，界面会先显示「正在打开麦克风…」（权限框期间
> getUserMedia 还没 resolve，不提示的话就是一个看起来按了没反应的死按钮）。


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
| `WALKIE_ASR_URL` | `http://127.0.0.1:59011` | 本机转写服务（`~/work/intake`）的地址 |

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

## 回复为什么不会再"卡住"

第一版真机上栽过一次：**内容发出去了、界面显示"AI 在干活"，然后永远没有结果**。根因是
追踪器是内存态 —— 进程重启或超过 `KEEP_DONE_MS` 被回收之后，`/reply` 返回一个空的
`{state:'idle'}`，前端就一直转到自己 10 分钟超时。真机上就是这么栽的。

现在三道防线：

1. **没有活跃追踪时一律回看该频道上一次的回复**（读 `data/walkie-sessions.json` 记下的
   transcript 文件），而不是只在 `peek=1` 时回看；
2. **认领会话靠位置，不靠文本**：发送前记下 transcript 文件的大小，之后**追加的第一条
   人类发言**就是我们发的那句。文本对得上只是更强的确认，不是必要条件 —— 早先版本要求
   文本前缀匹配，真机上被多敲进一个字符就失效，于是永远等不到结果。60 秒还认不出就明确
   报「这条消息没有出现在会话记录里」，不让界面干转到超时；
3. **把过程摊开**：等待时透出目标 pane 的当前几行（`● Bash(sleep 5) ⎿ Running…`），
   认领失败时给出具体提示（比如"这个频道的目录还没被 Claude 信任，它在等确认"）。

第 3 条是**"不知道它在干嘛"本身就是 bug** 这个判断的落地：看不见的过程等于没有过程。

---

## 已验证 / 未验证（2026-10-03，v4.9.1）

测试环境见 [`DEV-TESTENV.md`](DEV-TESTENV.md)（无头模拟器 + WebView devtools）。

### 在 Android 模拟器上真跑过

| 项 | 怎么验的 |
|---|---|
| App 起来、旋钮转、读数跟着变 | CDP 派发**可信触摸**划弧，读数从 APK 换到对讲机测试 |
| 按住说话 → 录音状态 / 走秒 / 音量条 | 真实触摸长按，`录音中 1.2s · 松手结束` |
| 麦克风权限流程 | 首次按下弹系统权限框，界面显示「正在打开麦克风…」 |
| 录音 → 上传 → 本机转写 | `audit.log` 里的 `walkie-transcribe`，字节数非零 |
| 噪声不被误转写 | 模拟器静音输入 → 不给幻觉文字，给「没识别出内容」的明确提示 |
| 发送 → 直达输入框 → 回复 | 走完 `已发出 → 已投递，等它开口… → AI 回复` |
| **等待过程可见** | 等待卡里出现 `● Bash(sleep 5) ⎿ Running… ✻ Accomplishing…` |
| TTS 播报 | logcat 里 `TextToSpeech.speak` 被调用，`AudioTrack` 输出 148 万帧音频 |
| 震动链路 | logcat 里每格一次 `Haptics.selectionChanged`、吸附一次 `impact MEDIUM` |
| 非 claude 频道拒发 | `main:0`（shell）返回 409 |

### 在桌面 Chrome 里真跑过（喂真实语音音频）

| 项 | 怎么验的 |
|---|---|
| **边说边出字** | `--use-file-for-fake-audio-capture` 喂一段中文语音，第 9 秒文字冒出来 |
| 音量条是真实音量 | 条高随注入音频起伏，静音段回落 |
| 多段拼接 | 两段音频 → 原文完整包含两句（`开饭时间…。开放时间…。`） |
| 精炼 | 松手后约 0.7 秒替换成精炼稿，可「还原原文」 |
| 浏览器里的模式往返 | `?ui=walkie` / 点「经典」/ 点浮标回来 |

### 只有真机能验的

- **咔嗒声的音色**：模拟器没有扬声器。`AudioContext` 确实进到了 `running`（
  在用户手势里创建、可 resume），但好不好听得你自己听。要调就改
  `frontend/src/walkie/feedback.ts` 里 `tick()` 的三个谐振频率（1250/2500/4300Hz）和
  噪声带通中心（1650–2200Hz）。
- **震动的力度**：模拟器没有马达。要调就改 `ChannelDial.tsx` 里 `hapticTick()` /
  `hapticSnap()` 的调用点，或 `feedback.ts` 里的 `ImpactStyle`。
- **转写的识别准确率**：模拟器麦克风是静音的，只验了通路。要单独验 ASR 就拿音频文件直接打
  `POST /api/walkie/transcribe`。
