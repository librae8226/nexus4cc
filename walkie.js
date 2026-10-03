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
import { readFileSync, writeFileSync, statSync, readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 常量 ────────────────────────────────────────────────────────────────
const POLL_MS = 1200                 // 追踪轮询间隔
const TURN_TIMEOUT_MS = 15 * 60_000  // 单轮最长追踪时间（长任务不至于把我们吊死）
const KEEP_DONE_MS = 10 * 60_000     // 完成后结果保留多久（供前端回看）
const TAIL_SCAN_BYTES = 256 * 1024   // 认领文件时只扫尾部这么多字节
const MATCH_PREFIX = 24              // 文本比对取前 N 个字符（去掉空白后）
const TMUX_BUF = 'nexus-walkie'      // 专用 paste buffer，避免和用户自己的 buffer 撞

// 本地语音转写服务（~/work/intake，PM2 `intake`）。只连本机，不对外。
const ASR_BASE = process.env.WALKIE_ASR_URL || 'http://127.0.0.1:59011'

// 频道名/session 名允许的字符。tmux 目标串是我们拼的，白名单比转义可靠。
const NAME_RE = /^[A-Za-z0-9._@-]+$/

const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim()

/** 读文件尾部若干字节（jsonl 认领用；不整读 3MB 的文件） */
function readTail(file, maxBytes) {
  const size = statSync(file).size
  const start = Math.max(0, size - maxBytes)
  const len = size - start
  if (len <= 0) return ''
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  // 起点可能落在某行中间，丢掉第一个不完整的片段
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
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

  router.get('/channels', authMiddleware, async (req, res) => {
    let raw = ''
    try {
      raw = execFileSync('tmux', ['list-windows', '-a', '-F',
        '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_path}\t#{window_active}\t#{pane_pid}'],
        { encoding: 'utf8', stdio: 'pipe' })
    } catch {
      return res.json({ projects: [], llm: null, tmux: false })
    }

    const claudePanes = detectClaudePanes()
    const byProject = new Map()
    for (const line of raw.split('\n').filter(Boolean)) {
      const cols = line.split('\t')
      const [proj, idx, name, cwd] = cols
      if (!proj) continue
      const panePid = Number(cols[5]) || 0
      if (!byProject.has(proj)) byProject.set(proj, [])
      // 这一格现在忙不忙。旋钮同时是一块状态牌 —— 换过去之前就知道对方在不在干活。
      // 判据是"我们记得的那个 transcript 文件最近 20 秒动过没有"：不额外抓 pane，
      // 代价只有一次 stat。没聊过的频道就没有这个信息，如实报 ready。
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

    const llm = loadLlmProfile(dataDir)
    const asr = await asrAlive()
    res.json({
      projects,
      llm: llm ? { label: llm.label, model: llm.model } : null,
      asr,
      tmux: true,
    })
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
      // 内容会很长且没意义，只表达"在推理"
      step = { kind: 'think', label: '推理中…' }
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
    t.steps.push(step)
    if (t.steps.length > 60) t.steps = t.steps.slice(-60)   // 长任务不至于把响应撑爆
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

  const publicState = (t) => {
    // 只在还没答完的时候抓 pane：完成之后前端看的是回复卡，不需要这些
    const pane = t.state === 'running' ? paneTail(t.project, t.win) : []
    return {
      state: t.state,                       // running | done | timeout
      stage: stageOf(t),
      text: t.reply || '',
      partial: t.replyParts.join(''),
      done: t.state === 'done',
      error: t.error || null,
      sessionId: t.sessionId || null,
      via: t.via || null,
      elapsedMs: Date.now() - t.startedAt,
      paneTail: pane,
      hint: hintFor(t, pane),
      steps: t.steps || [],
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
      if (e.type === 'assistant') {
        const blocks = e.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === 'text' && b.text) t.replyParts.push(b.text)
            else pushStep(t, b)
          }
        }
      } else if (e.type === 'system' && e.subtype === 'turn_duration') {
        t.reply = t.replyParts.join('\n\n').trim()
        t.state = 'done'
      }
    }

    // 兜底：拿不到 turn_duration（老版本 / 被中断）时，靠「发言人已认领 + 有正文 + 文件静默」收敛
    if (t.state === 'running' && t.sawSent && t.replyParts.length) {
      try {
        const quiet = Date.now() - statSync(t.file).mtimeMs
        if (quiet > 6000) {
          t.reply = t.replyParts.join('\n\n').trim()
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
      let tail
      try { tail = readTail(full, TAIL_SCAN_BYTES) } catch { continue }
      for (const line of tail.split('\n')) {
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e.type !== 'user' || e.isSidechain) continue
        const c = e.message?.content
        if (typeof c === 'string' && sameText(c, t.sentText)) { claim(t, full, f, sizeOf(f), 'text'); return }
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
    t.fileOffset = Math.max(0, t.baseOffset - 4096)   // 留一点重叠，别切在半行上
    t.via = how === 'text' ? 'text' : null
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

export const _internal = { readFrom, readTail, norm, loadLlmProfile }
