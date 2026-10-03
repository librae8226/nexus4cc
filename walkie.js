// walkie.js — 「对讲机模式」后端（实验特性）
//
// 动机：手机端操作 Nexus 的摩擦太大 —— 切 project、切 channel、点焦点、敲字、回车。
// 对讲机模式把它压成三个动作：转旋钮选频道 → 按住说话 → 按发送。
//
// 本模块只做四件事，全部与前端解耦，可以被任何客户端复用：
//   1. 频道清单（project=session, channel=window 的两级结构）
//   2. 把一段文字直接送进某个频道的输入框并回车（走 tmux，不经过 PTY）
//   3. 把口语转写精炼成一条准确指令（走 LLM，profile 复用 data/configs/*.json）
//   4. 追出这条指令对应的 AI 回复（走 Claude Code 的 transcript jsonl）
//
// 4 是这个模块最不显然的部分，记录一下思路：
//   同目录下可能并行跑着好几个 claude（vault 就有 5 个），所以「哪个 jsonl 是本频道的」
//   不能靠 mtime 猜。判据用**内容**：发出去之后，哪个 jsonl 里新出现的 human 发言文本
//   和我们刚发的那段对得上，那就是它。找到文件后只增量读新增字节，靠
//   type=system/subtype=turn_duration 判定回合结束 —— 这是 Claude Code 自己写的
//   「本轮答完了」标记，比在 TUI 上猜 spinner 稳得多。
//   认下来的 sessionId 会落盘 data/walkie-sessions.json，重启后仍能回看上次的回复。

import express from 'express'
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, readdirSync, openSync, readSync, closeSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 常量 ────────────────────────────────────────────────────────────────
const POLL_MS = 1200                 // 追踪轮询间隔
const TURN_TIMEOUT_MS = 15 * 60_000  // 单轮最长追踪时间（长任务不至于把我们吊死）
const KEEP_DONE_MS = 10 * 60_000     // 完成后结果保留多久（供前端回看）
const TAIL_SCAN_BYTES = 256 * 1024   // 认领文件时只扫尾部这么多字节
const MATCH_PREFIX = 24              // 文本比对取前 N 个字符（去掉空白后）
const TMUX_BUF = 'nexus-walkie'      // 专用 paste buffer，避免和用户自己的 buffer 撞

// 流（跨会话时间线）的读取成本：每个 claude 频道读尾部这么多字节、只取最近几个回合。
// 它是被轮询的，所以这两个数直接决定"这一屏"的常驻开销。
const STREAM_TAIL_BYTES = 256 * 1024
const STREAM_TURNS_PER_CHANNEL = 4
const STREAM_MAX_EVENTS = 40
// "正在跑"的新鲜度门槛：transcript 十分钟内没动过就不算在跑（见 /stream 里的说明）
const STREAM_RUNNING_FRESH_MS = 10 * 60_000

// 本地语音转写服务（~/work/intake，PM2 `intake`）。只连本机，不对外。
const ASR_BASE = process.env.WALKIE_ASR_URL || 'http://127.0.0.1:59011'

// 频道名/session 名允许的字符。tmux 目标串是我们拼的，白名单比转义可靠。
const NAME_RE = /^[A-Za-z0-9._@-]+$/

const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim()

/** 读文件尾部若干字节（jsonl 认领用；不整读 3MB 的文件） */
function readTail(file, maxBytes) {
  return readTailAt(file, maxBytes).text
}

/**
 * 同 readTail，但把**正文第一行的绝对偏移**一并带回来。
 *
 * 为什么要这个偏移：认领靠尾部扫描（256KB），而增量读只从"文件末尾往回 4KB"起步。
 * 一旦我们发的那句话离文件末尾超过 4KB —— 很常见，一条 assistant 记录动辄几千字节 ——
 * 增量读就永远读不到它，`sawSent` 一直是 false，60 秒后报「这条消息没有出现在会话记录里」，
 * 而这句明明就在文件里、AI 甚至已经答完了。（真机上表现为：AI 答了，界面上永远没有结果。）
 */
function readTailAt(file, maxBytes) {
  const size = statSync(file).size
  const start = Math.max(0, size - maxBytes)
  const len = size - start
  if (len <= 0) return { text: '', start: 0 }
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  // 起点可能落在某行中间，丢掉第一个不完整的片段。
  // 注意：**砍掉的字节数要用 byteLength 算**，不能拿 JS 字符串下标直接加 ——
  // 中文一个字 3 字节、下标只加 1，offset 会越错越远（这个偏移是要拿去当文件位置的）。
  if (start === 0) return { text, start: 0 }
  const nl = text.indexOf('\n')
  if (nl < 0) return { text: '', start: size }      // 这一片里没有完整行
  return { text: text.slice(nl + 1), start: start + Buffer.byteLength(text.slice(0, nl + 1), 'utf8') }
}

/** 读文件的 [offset, EOF) 段，返回 { lines, offset }。用于增量解析 transcript。 */
function readFrom(file, offset) {
  let size
  try { size = statSync(file).size } catch { return { lines: [], at: [], offset } }
  if (size <= offset) return { lines: [], at: [], offset }
  const len = size - offset
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, offset) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) return { lines: [], at: [], offset }   // 半行，等下次
  const complete = text.slice(0, lastNl)
  const lines = []
  const at = []
  let cursor = offset
  for (const raw of complete.split('\n')) {
    const bytes = Buffer.byteLength(raw, 'utf8') + 1
    try { const e = JSON.parse(raw); lines.push(e); at.push(cursor) } catch { /* 坏行跳过 */ }
    cursor += bytes
  }
  return { lines, at, offset: cursor }
}

// ── LLM 调用（精炼 / 摘要）───────────────────────────────────────────────
// 复用 data/configs/<profile>.json —— 那里已经有可用的 BASE_URL / AUTH_TOKEN / 模型，
// 不为这个实验新增任何密钥。profile 由 WALKIE_LLM_PROFILE 选，默认 deepseek。
function loadLlmProfile(dataDir) {
  const name = process.env.WALKIE_LLM_PROFILE || 'deepseek'
  let p
  try { p = JSON.parse(readFileSync(join(dataDir, 'configs', `${name}.json`), 'utf8')) } catch { return null }
  const token = p.AUTH_TOKEN || p.API_KEY
  if (!token) return null
  const baseUrl = (p.BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')
  return { label: p.label || name, baseUrl, token, model: p.DEFAULT_MODEL || 'claude-haiku-4-5-20251001' }
}

async function callLlm(llm, { system, user, maxTokens = 1024, timeoutMs = 25_000 }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${llm.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': llm.token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    if (!text) throw new Error('llm returned empty text')
    return text
  } finally { clearTimeout(timer) }
}

const REFINE_SYSTEM = `你是语音指令精炼器。用户对着手机口述一段交给 AI 编程助手的工作指令，
转写文本里充满语气词、重复、自我修正和口水话。你的任务是在**不丢任何信息**的前提下把它变干净。

规则：
- 全部关键信息必须保留：文件名、路径、函数名、数值、专有名词、条件、约束、举例。一个都不能丢。
- 删掉：语气词（呃/嗯/那个/就是说）、重复、自我更正（"不对我是说…"→ 只保留更正后的意思）、寒暄。
- 保持原语言。中英混说时技术术语保留英文原形（commit、README、API 等不要翻译）。
- 把口述里隐含的意图补成明确的动词指令（"那个README有点旧了" → "更新 README"）。
- 只输出精炼后的指令本身。不要解释、不要加引号、不要任何前后缀。
- 如果原文本来就干净，原样返回，不要为了改而改。`

const SUMMARY_SYSTEM = `把下面这段 AI 编程助手的工作汇报压缩成 1-2 句中文口播摘要，用于语音播报。
要求：说人话，能听懂；先说结论/结果，再说关键动作；不要罗列文件名和代码细节；
不要用 markdown 符号、列表符号、括号补充；总长控制在 80 字以内。只输出摘要正文。`

// ── 路由器 ──────────────────────────────────────────────────────────────
export function createWalkieRouter({ authMiddleware, dataDir, tmuxSession, audit }) {
  const router = express.Router()
  const SESSIONS_FILE = join(dataDir, 'walkie-sessions.json')

  const trackers = new Map()   // "project:window" -> tracker

  // 认下来的 频道 -> 会话 映射，落盘，重启后仍能回看上一次的回复
  let sessions = {}
  try { sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) } catch { /* 首次运行 */ }
  const saveSessions = () => {
    try { writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)) } catch { /* 磁盘问题不该拖垮请求 */ }
  }

  const keyOf = (project, win) => `${project}:${win}`
  const transcriptDir = (cwd) =>
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/\//g, '-'))

  /**
   * 解析过的 transcript 缓存：`file -> {key, turns, lastAt, lastText}`。
   *
   * 为什么要它：流是**被轮询**的，每个频道每次要读最多 256KB。十几个频道 × 每 5 秒
   * 就是常驻几百 KB/s 的读 —— 对一个自用服务来说是不必要的开销。
   * 键用 `size:mtimeMs`：追加一定会改 size，所以内容变了必然失效；
   * 反过来 mtime 变了而内容没变（这个文件系统上真的会发生）只会导致多读一次，方向是安全的。
   */
  const turnCache = new Map()

  /** 这个频道的 transcript 文件在哪。认过的优先；没认过的退化成"这个目录下最新的那个"。 */
  function transcriptFor(key, cwd) {
    const remembered = sessions[key]
    if (remembered?.file) {
      try { statSync(remembered.file); return remembered.file } catch { /* 被清理了，下面重找 */ }
    }
    if (!cwd) return null
    let best = null, bestT = 0
    try {
      for (const f of readdirSync(transcriptDir(cwd))) {
        if (!f.endsWith('.jsonl')) continue
        const full = join(transcriptDir(cwd), f)
        const m = statSync(full).mtimeMs
        if (m > bestT) { bestT = m; best = full }
      }
    } catch { return null }
    return best
  }

  /**
   * 从 transcript 尾部切出"回合"：一条人类发言 + 它后面**最后一段** assistant 正文。
   *
   * 只留最后一段，理由和 lastWords() 一样：一轮里中间那些 text 是**过程叙述**，
   * 拼起来在屏上是一堵前后不搭的墙。
   *
   * done 靠 Claude Code 自己写的 turn_duration 判 —— 它没出现，就说明这一轮还在跑，
   * 于是"机器现在在干哪件事"不需要任何额外状态就能算出来。
   */
  function readTurns(file, maxTurns) {
    const seg = readTailAt(file, STREAM_TAIL_BYTES)
    const turns = []
    let cur = null
    // 文件里**内容自己的时钟**。判断"还在不在跑"要用它，不能用文件的 mtime ——
    // 实测 mtime 会在没有新内容时被刷新（一个 6 小时前就停了的会话，mtime 是"现在"），
    // 拿 mtime 当判据就会把死掉的会话报成"正在跑"。
    let lastAt = 0
    // 兜底用：这个尾巴里一条人类发言都没有时（一个回合大到把 256KB 都占满了），
    // 至少把它最后说的那句话摆出来 —— 一块安静的黑比一句"在干什么"更没用。
    let lastText = ''
    for (const line of seg.text.split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.isSidechain) continue
      const ts = Date.parse(e.timestamp) || 0
      if (ts > lastAt) lastAt = ts
      if (e.type === 'user') {
        const c = e.message?.content
        // tool_result 之类也走 user 记录，只认人类自己说的那句话
        if (typeof c !== 'string') continue
        // isMeta 是 Claude Code 自己塞进去的元信息 —— 最典型的是斜杠命令的输出
        // （`/context` 那一整张表就是这么进来的）。它不是你"说"的话，别放进流里。
        if (e.isMeta) continue
        if (e.origin && e.origin.kind !== 'human') continue
        // 还有一类**没有 isMeta 标记**的注入：斜杠命令本身和它的回显
        // （`<command-name>/goal</command-name>`、`<local-command-stdout>…`）、
        // `<system-reminder>`。它们的共同点是**整条以尖括号标签开头** ——
        // 人自己说的话几乎不会这样开头，而这些放进流里就是让你看见自己的命令行。
        if (/^\s*<[a-z][a-z-]*>/.test(c)) continue
        if (cur) turns.push(cur)
        cur = { you: humanText(c), at: ts, reply: '', repliedAt: 0, done: false }
        continue
      }
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b.type === 'text' && b.text && b.text.trim()) {
            lastText = b.text.trim()
            if (cur) { cur.reply = b.text.trim(); cur.repliedAt = ts }
          }
        }
      } else if (cur && e.type === 'system' && e.subtype === 'turn_duration') {
        cur.done = true
      }
    }
    if (cur) turns.push(cur)
    return { turns: turns.slice(-maxTurns), lastAt, lastText }
  }

  /** readTurns 的带缓存版本。文件没变就不重解析。 */
  function readTurnsCached(file, maxTurns) {
    let key = ''
    try {
      const st = statSync(file)
      key = `${st.size}:${st.mtimeMs}`
      const hit = turnCache.get(file)
      if (hit && hit.key === key) return hit.val
    } catch { return { turns: [], lastAt: 0, lastText: '' } }
    const val = readTurns(file, maxTurns)
    // 别让它无限长：只留最近 64 个文件
    if (turnCache.size > 64) turnCache.clear()
    turnCache.set(file, { key, val })
    return val
  }

  /**
   * 人类那条记录里夹着系统注入的东西。最典型的是贴图：
   * Claude Code 把图片换成一句 `[Image: original 1082x2211, displayed at …]`。
   * 原样显示在流里就是一串坐标，读的人以为坏了 —— 换成"［图片］"，那是人话。
   */
  function humanText(s) {
    return String(s).replace(/\[Image:[^\]]*\]/gi, '［图片］').trim()
  }

  // ── 1. 频道清单 ──────────────────────────────────────────────────────
  // 顺便探一下本机转写服务在不在。用户按下说话才发现转写服务没起，是最没必要的
  // 一次挫败 —— 界面上一开始就标出来，就没有这一类"按了没反应"。
  async function asrAlive() {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 1500)
    try {
      const r = await fetch(`${ASR_BASE}/health`, { signal: ac.signal })
      return r.ok
    } catch { return false } finally { clearTimeout(timer) }
  }

  async function listChannels() {
    let raw = ''
    try {
      raw = execFileSync('tmux', ['list-windows', '-a', '-F',
        '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_path}\t#{window_active}\t#{pane_pid}'],
        { encoding: 'utf8', stdio: 'pipe' })
    } catch {
      return { projects: [], tmux: false }
    }

    const claudePanes = detectClaudePanes()
    const byProject = new Map()
    for (const line of raw.split('\n').filter(Boolean)) {
      const cols = line.split('\t')
      const [proj, idx, name, cwd] = cols
      if (!proj) continue
      const panePid = Number(cols[5]) || 0
      if (!byProject.has(proj)) byProject.set(proj, [])
      // 这一格现在忙不忙。判据是"我们记得的那个 transcript 文件最近 20 秒动过没有"：
      // 不额外抓 pane，代价只有一次 stat。没聊过的频道就没有这个信息，如实报 ready。
      let status = 'ready'
      const remembered = sessions[`${proj}:${Number(idx)}`]
      if (!claudePanes.has(panePid)) status = 'offline'
      else if (remembered?.file) {
        try { status = Date.now() - statSync(remembered.file).mtimeMs < 20_000 ? 'working' : 'idle' }
        catch { status = 'ready' }          // 文件被清理了，当作没记录
      }

      byProject.get(proj).push({
        index: Number(idx), name, cwd: cwd || '',
        active: cols[4] === '1',
        // 非 claude 的频道（纯 shell / 其它进程）发过去就是直接执行 —— 前端必须据此拦住，
        // 否则「更新一下 README」会被 zsh 当命令跑。这个标记是安全设施，不是装饰。
        kind: claudePanes.has(panePid) ? 'claude' : 'other',
        status,
      })
    }

    const home = homedir()
    const projects = [...byProject.entries()]
      .map(([name, channels]) => ({
        name,
        // 界面上要显示的是"哪个文件夹"，不是 tmux 的 session 名 —— 路径本身就是它的意思。
        // 家目录缩成 ~，否则一排 /home/librae/... 会把读数挤爆。
        path: (channels[0]?.cwd || '').replace(home, '~'),
        channels: channels.sort((a, b) => a.index - b.index),
      }))
      // 主 session 钉在最前 —— 它是最常用的那一个，每次都要转过去很烦
      .sort((a, b) => (a.name === tmuxSession ? -1 : b.name === tmuxSession ? 1 : a.name.localeCompare(b.name)))

    return { projects, tmux: true }
  }

  router.get('/channels', authMiddleware, async (req, res) => {
    const { projects, tmux } = await listChannels()
    const llm = loadLlmProfile(dataDir)
    const asr = await asrAlive()
    res.json({
      projects,
      llm: llm ? { label: llm.label, model: llm.model } : null,
      asr,
      tmux,
    })
  })

  // ── 1.5 流：**跨会话**的时间线 ────────────────────────────────────────
  // 这一条是"它不是 chat app"的全部依据：另一端是这台机器上**所有**在跑的
  // claude —— 包括你白天在终端里开的那些窗口，不只是从手机上发出去的那条。
  // 数据来自各频道的 transcript（跟追踪回复用的是同一份事实来源）。
  router.get('/stream', authMiddleware, async (req, res) => {
    const { projects, tmux } = await listChannels()
    if (!tmux) return res.json({ projects: [], events: [], running: 0, at: Date.now() })

    const used = new Set()
    const events = []
    let running = 0

    for (const p of projects) {
      for (const c of p.channels) {
        if (c.kind !== 'claude') continue
        const key = keyOf(p.name, c.index)
        const file = transcriptFor(key, c.cwd)
        // 同一个 cwd 下可能并行跑着好几个 claude（vault 就有 5 个），
        // 而"最新那个 jsonl"这种按 mtime 的猜测会把同一份记录算给好几个频道。
        // 认过的频道优先（sessions 里有 file），剩下的一个文件只认一次。
        if (!file || used.has(file)) continue
        used.add(file)

        let turns = []
        let lastAt = 0
        let lastText = ''
        try { ({ turns, lastAt, lastText } = readTurnsCached(file, STREAM_TURNS_PER_CHANNEL)) } catch { continue }
        const last = turns[turns.length - 1]
        // 没有 turn_duration 只是"这一轮没写结束标记"，**不等于现在还在跑** ——
        // 被打断的回合、早退的会话都长这样。所以再加一道新鲜度门槛，
        // 而且判据是**文件里最新一条记录的时间**，不是文件的 mtime（见 readTurns 里的说明）。
        // 代价：跑一个十分钟以上的长命令会被误判成停了 —— 那种情况你本来就该去经典界面看。
        const isRunning = !!last && !last.done && Date.now() - lastAt < STREAM_RUNNING_FRESH_MS
        if (isRunning) { running++; c.status = 'working' } else if (c.status === 'ready') c.status = 'idle'

        // 一个回合大到把尾巴占满时，这里一条回合都切不出来。至少把它最后说的那句
        // 摆进流里 —— 那一格是"安静的"，不是"不存在的"。
        if (!turns.length && lastText) {
          events.push({
            ch: key, project: p.name, window: c.index, name: c.name, cwd: c.cwd, path: p.path,
            id: `${key}:${lastAt}:it`, kind: 'it', text: lastText, at: lastAt,
          })
          continue
        }

        for (let i = 0; i < turns.length; i++) {
          const t = turns[i]
          const meta = {
            ch: key, project: p.name, window: c.index,
            name: c.name, cwd: c.cwd, path: p.path,
          }
          if (t.reply) {
            events.push({ ...meta, id: `${key}:${t.repliedAt}:it`, kind: 'it', text: t.reply, at: t.repliedAt })
          }
          if (t.you) {
            events.push({
              ...meta, id: `${key}:${t.at}:you`, kind: 'you', text: t.you, at: t.at,
              // 这一轮还没答完 = 机器现在正在干这件事。partial 是它到目前为止的最后一句
              running: isRunning && i === turns.length - 1,
              partial: isRunning && i === turns.length - 1 ? t.reply : '',
            })
          }
        }
      }
    }

    events.sort((a, b) => b.at - a.at)
    res.json({ projects, events: events.slice(0, STREAM_MAX_EVENTS), running, at: Date.now() })
  })

  // ── 2. 发送：直接落到目标频道的输入框并回车 ───────────────────────────
  router.post('/send', authMiddleware, (req, res) => {
    const { project, window: win, text } = req.body || {}
    if (!project || !NAME_RE.test(String(project))) return res.status(400).json({ error: 'invalid project' })
    if (!Number.isInteger(Number(win)) || Number(win) < 0) return res.status(400).json({ error: 'invalid window' })
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'empty text' })
    if (String(text).length > 20_000) return res.status(400).json({ error: 'text too long' })

    const target = `${project}:${Number(win)}`
    const payload = String(text).trim()

    try {
      execFileSync('tmux', ['has-session', '-t', project], { stdio: 'pipe' })
    } catch {
      return res.status(404).json({ error: 'project not found' })
    }

    // 先看这个窗口的 cwd —— 后面认领 transcript 要用
    let cwd = ''
    try {
      cwd = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_current_path}'],
        { encoding: 'utf8', stdio: 'pipe' }).trim()
    } catch { /* 拿不到就不追踪，发送本身照做 */ }

    // 护栏：目标 pane 里没有 claude 就把这句话交给 shell 执行了 —— 必须拦住。
    // 前端也拦（按 kind 禁用发送），这里是第二道，防的是绕过前端直接打 API。
    if (!req.body?.force) {
      let panePid = 0
      try {
        panePid = Number(execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'],
          { encoding: 'utf8', stdio: 'pipe' }).trim()) || 0
      } catch { /* 拿不到就放行，交给下面的 paste 自己报错 */ }
      if (panePid && !detectClaudePanes().has(panePid)) {
        return res.status(409).json({ error: 'not-a-claude-channel', hint: '该频道没有运行 Claude，直接发送会被 shell 当命令执行。' })
      }
    }

    // 认领用的基线：发送前各 jsonl 的大小
    const before = new Map()
    try {
      for (const f of readdirSync(transcriptDir(cwd))) {
        if (!f.endsWith('.jsonl')) continue
        try { before.set(f, statSync(join(transcriptDir(cwd), f)).size) } catch { /* 忽略 */ }
      }
    } catch { /* 目录不存在 = 这个频道不是 claude，稍后自然超时 */ }

    try {
      // load-buffer 用 stdin 传文本：绕开 shell 引用地狱，也不受参数长度限制
      execFileSync('tmux', ['load-buffer', '-b', TMUX_BUF, '-'], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] })
      // -p 走 bracketed paste：多行文本会原样进入输入框而不是被拆成多次回车提交
      execFileSync('tmux', ['paste-buffer', '-b', TMUX_BUF, '-t', target, '-d', '-p'], { stdio: 'pipe' })
    } catch (e) {
      return res.status(500).json({ error: `paste failed: ${e.message}` })
    }

    // paste 与 Enter 之间留一拍：TUI 要先消化完粘贴内容，否则回车会被当成换行
    setTimeout(() => {
      try { execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'pipe' }) } catch { /* 已记录在 tracker 超时里 */ }
    }, 260)

    startTracking(keyOf(project, Number(win)), { project, win: Number(win), cwd, sentText: payload, before })
    audit?.('walkie-send', req, { target, chars: payload.length })

    res.json({ ok: true, key: keyOf(project, Number(win)) })
  })

  // ── 2.5 附件：收下一个文件，回一个**绝对路径** ────────────────────────
  // 附件不是"从我的文件里挑一个给 AI"（那是 chat app 的语法，前提是你先有文件），
  // 而是"把眼前这张名片/这页 BP/这块白板交出去"。落地之后我们把路径写进那句话里 ——
  // Claude 读一个路径就够了，不需要我们发明什么上传协议。
  //
  // 落在 ~/nexus-inbox/<日期>/ 而不是目标 cwd：往你的仓库里丢文件会弄脏 git status，
  // 而这是**你的**机器，路径写绝对的就是。
  router.post('/upload', authMiddleware, express.raw({ type: () => true, limit: '30mb' }),
    (req, res) => {
      const buf = req.body
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty file' })
      const name = String(req.query.name || 'file')
        .replace(/[^\w.一-龥-]+/g, '_').replace(/^_+|_+$/g, '').slice(-48) || 'file'
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      const dir = join(homedir(), 'nexus-inbox', day)
      try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
      // 秒级时间戳前缀：同一天丢进来两张同名的图不会互相覆盖，翻回去也知道先后
      const file = join(dir, `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${name}`)
      try { writeFileSync(file, buf) } catch (e) {
        return res.status(500).json({ error: `save failed: ${e.message}` })
      }
      audit?.('walkie-upload', req, { bytes: buf.length, name })
      res.json({ ok: true, path: file, name, bytes: buf.length })
    })

  // ── 3. 精炼 ──────────────────────────────────────────────────────────
  router.post('/refine', authMiddleware, async (req, res) => {
    const raw = String((req.body || {}).text || '').trim()
    if (!raw) return res.status(400).json({ error: 'empty text' })
    const llm = loadLlmProfile(dataDir)
    if (!llm) return res.json({ text: raw, refined: false, reason: 'no-llm-profile' })
    try {
      const text = await callLlm(llm, { system: REFINE_SYSTEM, user: raw.slice(0, 12_000), maxTokens: 1200 })
      res.json({ text, refined: text !== raw })
    } catch (e) {
      // 精炼失败绝不能挡住发送 —— 原样退回，前端照常可用
      res.json({ text: raw, refined: false, reason: e.message })
    }
  })

  // ── 4. 摘要（播报用）──────────────────────────────────────────────────
  router.post('/summarize', authMiddleware, async (req, res) => {
    const raw = String((req.body || {}).text || '').trim()
    if (!raw) return res.status(400).json({ error: 'empty text' })
    const llm = loadLlmProfile(dataDir)
    if (!llm) return res.json({ text: raw.slice(0, 120), summarized: false, reason: 'no-llm-profile' })
    try {
      const text = await callLlm(llm, { system: SUMMARY_SYSTEM, user: raw.slice(-16_000), maxTokens: 400, timeoutMs: 20_000 })
      res.json({ text, summarized: true })
    } catch (e) {
      res.json({ text: raw.slice(0, 120), summarized: false, reason: e.message })
    }
  })

  // ── 4.5 语音转写：转发给本地 ASR ────────────────────────────────────────
  // 为什么不用手机自带的 SpeechRecognizer：实测在国产 ROM 上「按下去、有权限、
  // 但一句话都不吐」，而且它出错是静默的（见 docs/WALKIE.md）。改成「App 里录音
  // → 上传到这里 → 本机转写」：不依赖 Google 语音服务、音频不出本机、
  // 且转写实现只有一份（在 ~/work/intake）。
  //
  // 只监听本机 ⇒ 手机只能通过 Nexus 这一道门进来，转写服务本身不对外。
  router.post('/transcribe', authMiddleware, express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      const buf = req.body
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty audio' })
      const name = String(req.query.name || 'clip.webm').replace(/[^\w.-]/g, '_').slice(-40)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 120_000)
      try {
        const r = await fetch(`${ASR_BASE}/transcribe?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: {
            'content-type': req.headers['content-type'] || 'application/octet-stream',
            'x-filename': name,
          },
          body: buf,
          signal: ac.signal,
        })
        const data = await r.json().catch(() => null)
        if (!r.ok || !data) {
          return res.status(502).json({ error: 'asr failed', detail: (data && data.detail) || `HTTP ${r.status}` })
        }
        audit?.('walkie-transcribe', req, { bytes: buf.length, chars: (data.text || '').length, ms: data.elapsedMs })
        res.json(data)
      } catch (e) {
        // intake 没在跑时给一个可识别的错误码，前端据此提示改用输入法
        res.status(503).json({ error: 'asr-unavailable', detail: String(e?.message || e) })
      } finally { clearTimeout(timer) }
    })

  // ── 5. 回复 ──────────────────────────────────────────────────────────
  // 有活跃追踪就报它的状态；没有则回看该频道上一次的回复（peek）。
  router.get('/reply', authMiddleware, (req, res) => {
    const project = String(req.query.project || '')
    const win = Number(req.query.window)
    if (!NAME_RE.test(project) || !Number.isInteger(win)) return res.status(400).json({ error: 'bad target' })
    const key = keyOf(project, win)

    const t = trackers.get(key)
    if (t) return res.json(publicState(t))

    // 没有活跃追踪时**一律**回看该频道上一次的回复，而不是只认 peek=1。
    // 追踪器是内存态：进程重启、或超过 KEEP_DONE_MS 被回收之后就没了，
    // 而前端只会拿到 {state:'idle'} —— 表现就是「AI 在干活，但永远没有结果」，
    // 一直转到它自己 10 分钟超时。真机上就是这么栽的。
    const s = sessions[key]
    if (s?.file) {
      try {
        const { reply } = scanForLastTurn(s.file)
        if (reply) {
          return res.json({ state: 'done', text: reply, done: true, from: 'transcript', sessionId: s.sessionId })
        }
      } catch { /* 文件没了（归档/清理），当作没有 */ }
    }
    return res.json({ state: 'idle', text: '' })
  })

  /**
   * 哪些 pane 里跑着 claude？
   * claude 可能隔着几层（pane → zsh → nexus-run-claude.sh → claude），所以从 pane_pid
   * 做一次进程树 BFS。用一次 ps 拿全量，别对每个 pane 各 spawn 一次。
   */
  function detectClaudePanes() {
    const claude = new Set()
    let out = ''
    try { out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', stdio: 'pipe' }) } catch { return claude }
    const parentOf = new Map()
    const comm = new Map()
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = Number(m[1])
      parentOf.set(pid, Number(m[2]))
      comm.set(pid, m[3].trim())
    }
    for (const [pid, name] of comm) {
      if (name !== 'claude') continue
      // 连同祖先一起标记：pane_pid 是这条链上的某一环，标记整条链就不用关心隔了几层
      let cur = pid
      for (let hop = 0; cur > 1 && hop < 16; hop++) { claude.add(cur); cur = parentOf.get(cur) || 0 }
    }
    return claude
  }

  /** 追踪到哪一步了。前端直接显示 —— 「不知道它在干嘛」本身就是个 bug。 */
  const stageOf = (t) => {
    if (t.state === 'done') return '已完成'
    if (t.state === 'timeout') return '超时'
    if (!t.file) return '正在认领会话…'
    if (!t.replyParts.length) return '已投递，等它开口…'
    return '正在输出…'
  }

  /**
   * 把 assistant 的一个 content block 提炼成"一行动作"。
   *
   * 数据源是 Claude Code 自己写的 transcript，不是去解析终端画面 —— 里面每个工具调用
   * 都是结构化的（name + input，很多还自带一句人话 description），比从 TUI 上刮文字
   * 可靠得多。用户要的"他每一步的工作，提炼到屏幕上，放在一行显示"就是从这里来的。
   *
   * 带 file_path 的那几种会把路径一起给出去，前端据此把这一行做成可点开的。
   */
  function pushStep(t, b) {
    if (!b || !b.type) return
    if (!t.steps) t.steps = []
    if (!t.stepIds) t.stepIds = new Set()

    // thinking / tool_use 都会随流式输出重复出现，按 id 去重（同一个 id 只记一次）
    const id = b.id || (b.type === 'thinking' ? 'think:' + String(b.thinking || '').slice(0, 40) : '')
    if (id) { if (t.stepIds.has(id)) return; t.stepIds.add(id) }

    let step = null
    if (b.type === 'thinking') {
      // **不再进列表**。"推理中"是个**状态**，不是一件做过的事 —— 把它和
      // "读了 X""改了 Y"并排成一行行，读的人会以为这也是一步进展，而它什么信息都没有。
      // 现在它只出现在底部那行"此刻"，见 t.now。
      if (!t.now || t.now.kind !== 'think') t.now = { kind: 'think', label: '正在推理', since: Date.now() }
      return
    }
    if (b.type === 'text') {
      // 【这一步是这次改动的核心】他说的话才是"他在干嘛"。
      // transcript 里每条工具调用之间都夹着一句人话（"我先看一下现在的实现"），
      // 那是免费的意图说明 —— 以前它被扔进 replyParts、只在最后才拿出来，
      // 于是等待期间屏上只剩下一串工具名，用户的原话是"完全不知道它在干嘛"。
      const say = String(b.text || '').replace(/\s+/g, ' ').trim()
      if (say) step = { kind: 'say', label: say.length > 90 ? say.slice(0, 90) + '…' : say }
    } else if (b.type === 'tool_use') {
      const input = b.input || {}
      const desc = String(input.description || '').trim()
      const file = input.file_path || input.notebook_path || ''
      const name = String(b.name || 'Tool')
      const cut = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x }
      switch (name) {
        case 'Bash':
          step = { kind: 'bash', label: desc || cut(input.command, 64) }
          break
        case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
          step = { kind: name === 'Read' ? 'read' : 'edit', label: shortPath(file), path: file }
          break
        case 'Grep': case 'Glob':
          step = { kind: 'search', label: cut(input.pattern, 40) || '(全部)' }
          break
        case 'Task':
          step = { kind: 'task', label: desc || cut(input.prompt, 48) || '派了个子任务' }
          break
        case 'TodoWrite':
          step = { kind: 'todo', label: '更新任务清单' }
          break
        case 'WebFetch': case 'WebSearch':
          step = { kind: 'web', label: cut(input.query || input.url, 48) }
          break
        default:
          step = { kind: 'tool', label: name }
      }
    }
    if (!step) return
    step.at = Date.now()
    if (b.type === 'tool_use') {
      // 记下 id：工具跑完（tool_result 回来）要把它标成 done，
      // 好让底部那行"此刻"说得出**具体在跑哪一条**，而不是笼统的"正在工作"。
      step.id = b.id
      step.done = false
      // kind 用**这一步自己的**（read/edit/bash…），前端据此说"正在读 / 正在改"，
      // 而不是笼统的"正在调用"。
      t.now = { kind: step.kind, label: step.label, since: Date.now(), id: b.id }
    }
    t.steps.push(step)
    if (t.steps.length > 60) t.steps = t.steps.slice(-60)   // 长任务不至于把响应撑爆
  }

  /**
   * 工具跑完了。把对应那一步标成 done，并把它从"此刻"上撤下来 ——
   * 撤下来之后底部那行会退回"正在推理"，直到下一个工具开始。
   */
  function finishStep(t, block) {
    if (!t.now || t.now.id !== block.tool_use_id) return
    const s = (t.steps || []).find((x) => x.id === block.tool_use_id)
    if (s) s.done = true
    t.now = { kind: 'think', label: '正在推理', since: Date.now() }
  }

  /** 路径只留最后两段：手机上看得见，也知道在哪个目录 */
  function shortPath(p) {
    if (!p) return ''
    const parts = String(p).split('/').filter(Boolean)
    return parts.slice(-2).join('/')
  }

  /**
   * 目标 pane 底部几行。等回复时把它透给前端 —— 「AI 在干活但界面上什么都没有」
   * 是最没法自查的状态，有了这几行，卡在信任提示 / 卡在 shell / 正在跑工具，
   * 一眼就能看出来。
   */
  function paneTail(project, win, lines = 8) {
    try {
      const out = execFileSync('tmux', ['capture-pane', '-p', '-t', `${project}:${win}`],
        { encoding: 'utf8', stdio: 'pipe' })
      return out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-lines)
    } catch { return [] }
  }

  /** 认领会话失败时的排障提示。认领成功就不需要了。 */
  function hintFor(t, pane) {
    if (t.file) return null
    const joined = pane.join('\n')
    if (/trust this folder|Do you trust/i.test(joined)) {
      return '这个频道的目录还没被 Claude 信任，它在等一个确认。到经典界面点一下「Yes, I trust this folder」。'
    }
    if (/bypass permissions/.test(joined) === false && pane.length && !/❯/.test(joined)) {
      return '这个窗口现在不是 Claude 的对话界面 —— 消息可能落在了别的东西上。'
    }
    if (Date.now() - t.startedAt > 20_000) {
      return '这条消息还没进到对话里。看看下面窗口当前的样子，多半能对上原因。'
    }
    return null
  }

  /**
   * 这一轮"他答了什么" = **最后一段话**，不是所有话拼起来。
   *
   * 一轮里会有很多段 text：中间那些是**过程叙述**（"看一下现在的实现"、
   * "找到问题了，是重复旋转"），最后那段才是结论。拼起来会得到两样都坏的东西：
   * 屏上是一堵前后不搭的墙，TTS 会把整场独白念给你听。
   * （实测：本仓一个长回合有 57 段 text。）
   *
   * 过程本身没丢 —— 它随 pushStep 进了动作流，答完之后折在「他做了什么」里。
   */
  function lastWords(t) {
    const parts = (t.replyParts || []).filter((x) => String(x || '').trim())
    if (!parts.length) return ''
    return String(parts[parts.length - 1]).trim()
  }

  const publicState = (t) => {
    // 只在还没答完的时候抓 pane：完成之后前端看的是回复卡，不需要这些
    const pane = t.state === 'running' ? paneTail(t.project, t.win) : []
    return {
      state: t.state,                       // running | done | timeout
      stage: stageOf(t),
      text: t.reply || '',
      // 这一轮是谁要的。前端切走再切回来时要拿它把「你说 · X」那条补回去 ——
      // 没有它，恢复出来的过程就是一堆不知道在回答什么的动作。
      sent: t.sentText || '',
      partial: t.replyParts.join(''),
      done: t.state === 'done',
      error: t.error || null,
      sessionId: t.sessionId || null,
      via: t.via || null,
      elapsedMs: Date.now() - t.startedAt,
      paneTail: pane,
      hint: hintFor(t, pane),
      steps: t.steps || [],
      // 此刻正在发生的那一件事（"正在跑 读取 docs/WALKIE.md" / "正在推理"）。
      // 它是一条**状态**，不属于"做过哪些事"的列表 —— 见 pushStep 里为什么
      // 把"推理中"从 steps 里拿了出来。
      now: t.now || null,
    }
  }

  // ── 追踪器：把「发出去了」变成「答完了」────────────────────────────
  function startTracking(key, { project, win, cwd, sentText, before }) {
    const old = trackers.get(key)
    if (old?.timer) clearInterval(old.timer)

    const t = {
      key, project, win, cwd, sentText,
      before, cwdDir: cwd ? transcriptDir(cwd) : '',
      state: 'running', reply: '', replyParts: [], partial: '',
      file: null, sessionId: null, fileOffset: 0, sawSent: false,
      startedAt: Date.now(), timer: null, error: null, via: null,
    }
    trackers.set(key, t)

    t.timer = setInterval(() => {
      try { tick(t) } catch (e) { t.error = e.message }
      if (t.state !== 'running') {
        clearInterval(t.timer); t.timer = null
        // 完成后留一会儿给前端取，之后释放
        setTimeout(() => { const cur = trackers.get(key); if (cur === t) trackers.delete(key) }, KEEP_DONE_MS)
      }
    }, POLL_MS)
    if (t.timer.unref) t.timer.unref()

    tick(t)
  }

  function tick(t) {
    if (Date.now() - t.startedAt > TURN_TIMEOUT_MS) {
      t.state = 'timeout'
      t.error = t.error || '等待回复超时'
      return
    }

    // 第一件事永远是：认领对应的 transcript 文件
    if (!t.file) { claimFile(t); if (!t.file) return }
    // 文件认了、但里面始终没有"我们刚发的那句" —— 说明这条消息没能进到会话里
    // （卡在信任提示、claude 早退了、或者目标根本不是这个会话）。
    // 明确报出来，别让界面一直转到超时。
    if (!t.sawSent && Date.now() - t.startedAt > 60_000) {
      t.state = 'timeout'
      t.error = '这条消息没有出现在会话记录里 —— 它可能没送达，或者那个 claude 已经不在对话界面上了'
      return
    }

    const { lines, at, offset } = readFrom(t.file, t.fileOffset)
    if (lines.length) t.fileOffset = offset

    for (let i = 0; i < lines.length; i++) {
      const e = lines[i]
      if (e.isSidechain) continue
      if (e.type === 'user' && !t.sawSent) {
        const c = e.message?.content
        if (typeof c === 'string') {
          // 认「我们那句话」**主要看位置，不靠文本对得上**。
          // 为什么：真机上出现过 transcript 里多出一个字符（消息在终端里被谁多敲了一下），
          // 前 24 字比对就失效了。之前那种情况下会一直等下去 —— 正是「AI 在干活但永远
          // 没有结果」那个老毛病。位置判据是：发送前记下的文件末尾之后追加的第一条
          // 人类发言，就是我们刚发的那句。
          const exact = sameText(c, t.sentText)
          const afterSend = at[i] >= (t.baseOffset ?? 0) - 4096
          const human = (e.origin?.kind ?? 'human') === 'human'
          if (exact || (afterSend && human)) {
            t.sawSent = true
            t.via = t.via || (exact ? 'text' : 'position')
            t.sentAt = at[i]
          }
        }
        continue
      }
      if (!t.sawSent) continue
      // 工具跑完的回报（tool_result）也走 human 那条 user 记录 —— 拿它把
      // 对应那一步标成 done，底部"此刻"才知道该不该把它撤下来。
      if (e.type === 'user') {
        const c = e.message?.content
        if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') finishStep(t, b)
        continue
      }
      if (e.type === 'assistant') {
        const blocks = e.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            // 说话既进"回复"（回合结束后的正文），也进"动作流"（等待期间的故事）。
            // 同一句话在两个阶段各有用处，不是重复。
            if (b.type === 'text' && b.text) t.replyParts.push(b.text)
            pushStep(t, b)
          }
        }
      } else if (e.type === 'system' && e.subtype === 'turn_duration') {
        t.reply = lastWords(t)
        t.state = 'done'
      }
    }

    // 兜底：拿不到 turn_duration（老版本 / 被中断）时，靠「发言人已认领 + 有正文 + 文件静默」收敛
    if (t.state === 'running' && t.sawSent && t.replyParts.length) {
      try {
        const quiet = Date.now() - statSync(t.file).mtimeMs
        if (quiet > 6000) {
          t.reply = lastWords(t)
          t.state = 'done'
          t.via = 'quiet-fallback'
        }
      } catch { /* 文件被清理了，交给超时 */ }
    }

    if (t.state === 'done' && t.sessionId) {
      sessions[t.key] = { sessionId: t.sessionId, file: t.file, cwd: t.cwd, updatedAt: new Date().toISOString() }
      saveSessions()
    }
  }

  /**
   * 找出「刚被我们写进一句话」的那个 jsonl。
   *
   * 两轮判据，第一轮靠内容、第二轮靠**位置**：
   *   1. 发送后变大、且尾部有哪条人类发言和我们发的那段文本对得上 —— 最可靠；
   *   2. 对不上也得认：挑长得最多的那个文件，把读取起点**回退到发送前的文件末尾**，
   *      接下来的 tick 就会把「那之后追加的第一条人类发言」当成我们发的那句。
   *
   * 第 2 条是关键。老版本只有第 1 条，匹配一失败就再也找不到，于是永远等下去 ——
   * 真机上的确发生过（消息在终端里被多敲了一个字，文本就对不上了）。
   * 现在只要位置对，认领就一定成立。
   */
  function claimFile(t) {
    t.polls = (t.polls || 0) + 1
    let files
    try { files = readdirSync(t.cwdDir).filter((f) => f.endsWith('.jsonl')) } catch { return }

    const sizeOf = (f) => { try { return statSync(join(t.cwdDir, f)).size } catch { return -1 } }
    const grew = files.filter((f) => { const cur = sizeOf(f); return cur >= 0 && cur > (t.before.get(f) ?? -1) })

    // 第一轮：文本对得上
    for (const f of grew.length ? grew : files) {
      const full = join(t.cwdDir, f)
      let seg
      try { seg = readTailAt(full, TAIL_SCAN_BYTES) } catch { continue }
      let at = seg.start
      for (const line of seg.text.split('\n')) {
        const lineAt = at
        at += Buffer.byteLength(line, 'utf8') + 1     // 无论怎么 continue 都要前进
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e.type !== 'user' || e.isSidechain) continue
        const c = e.message?.content
        // 用**这句话自己的偏移**当基线，别用文件当前大小：那句话后面可能已经跟了
        // 几万字节的回复，从末尾往回 4KB 起步就把它跳过去了（见 readTailAt 的说明）。
        if (typeof c === 'string' && sameText(c, t.sentText)) { claim(t, full, f, lineAt, 'text'); return }
      }
    }

    // 第二轮：位置。等到第 4 拍（约 5 秒）还没对上文本，就不再指望它。
    if (t.polls < 4) return
    let best = null, bestGrow = 0
    for (const f of files) {
      const grow = sizeOf(f) - (t.before.get(f) ?? 0)
      if (grow > bestGrow) { bestGrow = grow; best = f }
    }
    if (best && bestGrow > 120) {
      const full = join(t.cwdDir, best)
      // 起点回退到发送前的末尾 —— tick 从那之后扫，第一条人类发言就是我们的
      claim(t, full, best, sizeOf(best) - bestGrow, 'position-pending')
      t.via = null            // 真正确认由 tick 里设成 position / text
    }
  }

  function claim(t, full, f, sizeAtSend, how) {
    t.file = full
    t.sessionId = f.replace(/\.jsonl$/, '')
    t.baseOffset = Math.max(0, sizeAtSend)
    // 文本命中时 sizeAtSend 就是**那句话自己的字节偏移**，正好落在行首 ——
    // 从这里读，前后都不会串。别的路径只有"发送前的文件末尾"，才需要往回退 4KB
    // 防切在半行上（代价是可能把上一轮的一条人类发言也读进来）。
    t.fileOffset = Math.max(0, how === 'text' ? sizeAtSend : t.baseOffset - 4096)
    t.via = how === 'text' ? 'text' : null
    // 文本对上了 = 我们那句话**已经在文件里**，当场就把 sawSent 立起来。
    // 不依赖后面那次增量读能不能读到它 —— "认领成功"和"确认送达"是同一件事，
    // 分成两步做只会在两步之间的缝里丢掉整轮回复。
    if (how === 'text') { t.sawSent = true; t.sentAt = sizeAtSend }
    // 认领成功就落盘：就算这一轮没答完/被中断，重启后也知道该回看哪个文件
    sessions[t.key] = { sessionId: t.sessionId, file: t.file, cwd: t.cwd, updatedAt: new Date().toISOString() }
    saveSessions()
  }

  // 归一化后比前缀：粘贴进 TUI 的文本可能被折行/加尾随空白，逐字比会漏
  function sameText(a, b) {
    const x = norm(a), y = norm(b)
    const n = Math.min(MATCH_PREFIX, x.length, y.length)
    return n > 0 && x.slice(0, n) === y.slice(0, n)
  }

  /** 从 transcript 里取「最后一个人类回合」的完整回复（peek 用） */
  function scanForLastTurn(file) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let lastUserIdx = -1
    const parsed = lines.map((l) => { try { return JSON.parse(l) } catch { return null } })
    for (let i = 0; i < parsed.length; i++) {
      const e = parsed[i]
      if (!e || e.isSidechain) continue
      if (e.type === 'user' && typeof e.message?.content === 'string') lastUserIdx = i
    }
    if (lastUserIdx < 0) return { reply: '' }
    const parts = []
    for (let i = lastUserIdx + 1; i < parsed.length; i++) {
      const e = parsed[i]
      if (!e || e.isSidechain || e.type !== 'assistant') continue
      const blocks = e.message?.content
      if (Array.isArray(blocks)) for (const b of blocks) if (b.type === 'text' && b.text) parts.push(b.text)
    }
    return { reply: parts.join('\n\n').trim() }
  }

  return router
}

export const _internal = { readFrom, readTail, readTailAt, norm, loadLlmProfile }
