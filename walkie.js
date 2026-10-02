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
  try { size = statSync(file).size } catch { return { lines: [], offset } }
  if (size <= offset) return { lines: [], offset }
  const len = size - offset
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, offset) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) return { lines: [], offset }      // 半行，等下次
  const complete = text.slice(0, lastNl)
  const lines = complete.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { lines, offset: offset + Buffer.byteLength(complete, 'utf8') + 1 }
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
  router.get('/channels', authMiddleware, (req, res) => {
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
      byProject.get(proj).push({
        index: Number(idx), name, cwd: cwd || '',
        active: cols[4] === '1',
        // 非 claude 的频道（纯 shell / 其它进程）发过去就是直接执行 —— 前端必须据此拦住，
        // 否则「更新一下 README」会被 zsh 当命令跑。这个标记是安全设施，不是装饰。
        kind: claudePanes.has(panePid) ? 'claude' : 'other',
      })
    }

    const projects = [...byProject.entries()]
      .map(([name, channels]) => ({
        name,
        path: channels[0]?.cwd || '',
        channels: channels.sort((a, b) => a.index - b.index),
      }))
      // 主 session 钉在最前 —— 它是最常用的那一个，每次都要转过去很烦
      .sort((a, b) => (a.name === tmuxSession ? -1 : b.name === tmuxSession ? 1 : a.name.localeCompare(b.name)))

    const llm = loadLlmProfile(dataDir)
    res.json({ projects, llm: llm ? { label: llm.label, model: llm.model } : null, tmux: true })
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

  // ── 5. 回复 ──────────────────────────────────────────────────────────
  // 有活跃追踪就报它的状态；没有则回看该频道上一次的回复（peek）。
  router.get('/reply', authMiddleware, (req, res) => {
    const project = String(req.query.project || '')
    const win = Number(req.query.window)
    if (!NAME_RE.test(project) || !Number.isInteger(win)) return res.status(400).json({ error: 'bad target' })
    const key = keyOf(project, win)

    const t = trackers.get(key)
    if (t) return res.json(publicState(t))

    if (req.query.peek === '1') {
      const s = sessions[key]
      if (s?.file) {
        try {
          const { reply } = scanForLastTurn(s.file)
          return res.json({ state: 'idle', text: reply, done: true, from: 'transcript', sessionId: s.sessionId })
        } catch { /* 文件没了（归档/清理），当作没有 */ }
      }
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

  const publicState = (t) => ({
    state: t.state,                       // running | done | timeout
    text: t.reply || '',
    partial: t.replyParts.join(''),
    done: t.state === 'done',
    error: t.error || null,
    sessionId: t.sessionId || null,
    via: t.via || null,
    elapsedMs: Date.now() - t.startedAt,
  })

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

    const { lines, offset } = readFrom(t.file, t.fileOffset)
    if (lines.length) t.fileOffset = offset

    for (const e of lines) {
      if (e.isSidechain) continue
      if (e.type === 'user' && !t.sawSent) {
        const c = e.message?.content
        if (typeof c === 'string' && sameText(c, t.sentText)) t.sawSent = true
        continue
      }
      if (!t.sawSent) continue
      if (e.type === 'assistant') {
        const blocks = e.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) if (b.type === 'text' && b.text) t.replyParts.push(b.text)
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

  /** 找出「刚被我们写进一句话」的那个 jsonl。判据是内容，不是 mtime。 */
  function claimFile(t) {
    let files
    try { files = readdirSync(t.cwdDir).filter((f) => f.endsWith('.jsonl')) } catch { return }

    // 优先看发送后变大的文件；都没变大就全扫一遍（可能有轮转/新建）
    const grew = files.filter((f) => {
      const prev = t.before.get(f)
      try { return prev === undefined || statSync(join(t.cwdDir, f)).size > prev } catch { return false }
    })
    for (const f of grew.length ? grew : files) {
      const full = join(t.cwdDir, f)
      let tail
      try { tail = readTail(full, TAIL_SCAN_BYTES) } catch { continue }
      for (const line of tail.split('\n')) {
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e.type !== 'user' || e.isSidechain) continue
        const c = e.message?.content
        if (typeof c === 'string' && sameText(c, t.sentText)) {
          t.file = full
          t.sessionId = e.sessionId || f.replace(/\.jsonl$/, '')
          // 认领成功就落盘：就算这一轮没答完/被中断，重启后也知道该回看哪个文件
          sessions[t.key] = { sessionId: t.sessionId, file: t.file, cwd: t.cwd, updatedAt: new Date().toISOString() }
          saveSessions()
          return
        }
      }
    }
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
