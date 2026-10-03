// walkie/WalkieApp.tsx — 极简交互版的根组件
//
// 【版面只有三个带】
//   1. 顶栏   —— 这台机器现在有几件活在跑（+ 静音 / 经典）
//   2. 流     —— **跨会话**的时间线：你说的、它答的、正在跑的。新的在最上面
//   3. 输入框 —— 一个框 + 附件 + 发送；它下面一行小字写着这句话会寄给谁
//
// 【为什么是这个形态】见 docs/WALKIE.md 第十节。一句话：
//   AI chat app 的另一端是**它自己的 agent**；这一屏的另一端是**这台机器** ——
//   你的 shell、你的文件、你已经在跑的那些 claude。所以主屏不该是聊天记录，
//   而是"我的机器在干什么"。判据只有一条：
//   **能不能看见你没通过手机下的那些活。**
//
// 【这一版删掉了什么，以及为什么】
//   · 两排调台条 —— 它在让你回答"哪个目录 / 哪个 shell 窗口"。
//     路由变成"记住上次 + 一个可改的小标签"，人不需要知道 tmux 的存在。
//   · 按住说话 + 本机转写 —— 转写质量拼不过输入法，而且那是另一个进程的按钮，
//     我们本来就按不到。坐着要精确就用输入法；这一屏不自研语音。
//   · "边说边出字" —— 它唯一的理由是"你在看屏幕"，而这一屏存在的理由恰恰是
//     "你可以不盯"。两者矛盾，整条删掉（audio.ts / speech.ts 随之删除）。
//
// 【状态机只剩下两个】
//   待机 ──写字/输入法──▶ 发送 ──▶ 这一轮（在跑 / 答完 / 出错），同时流在后台自己滚。

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { WorkspaceBrowserHandle } from '../WorkspaceBrowser'
import {
  getStream, getReply, refineText, summarizeText, sendPrompt, uploadAttachment,
  type StreamEvent, type ReplyState, type WalkieProject, type WalkieStep, type WalkieNow,
} from './api'
import {
  attachAudioUnlock, hapticSnap, isMuted, land, primeFeedback, roger,
  setMuted as setMutedFeedback, whoosh,
} from './feedback'
import { speak, stopSpeaking } from './tts'
import ReplyText from './replyLinks'
import './walkie.css'

const WorkspaceBrowser = lazy(() => import('../WorkspaceBrowser'))

const POLL_STREAM_MS = 5000
const POLL_STREAM_BUSY_MS = 1500
const POLL_ROUND_MS = 1200
const WAIT_LIMIT_MS = 10 * 60_000
const REFINE_WAIT_MS = 3000
/** 超过这么多字就折叠。手机上这个长度约 20 行，再多就成了一堵墙。 */
const FOLD_AT = 700
/** 一次塞进来这么多字符 = 语音输入法整句提交（打字不会这样），自动精炼 */
const BURST_CHARS = 6
const STORE_KEY = 'nexus_walkie_state'
/** 你"认领"过（从这台手机发过话）的频道 —— 只有它们答完了会出声，别的活不吵你 */
const HEARD_KEY = 'nexus_walkie_heard'
/** 上次你看着这一屏的时刻。回来时用它算"你不在的时候" */
const SEEN_KEY = 'nexus_walkie_seen'
const FILE_INPUT_ID = 'walkie-attach'
/** 离开不到这么久就别提了 —— "你不在的 40 秒里"是废话 */
const ABSENT_MIN_MS = 2 * 60_000
/** 三十多分钟前的旧结论不念 —— 那是在补报历史，不是告诉你"刚办完" */
const SPEAK_MAX_AGE_MS = 30 * 60_000

/**
 * "你最后看到过的那条"的时间戳，模块加载时读一次。
 *
 * 记的**不是"你几点离开的"，而是"你看到过的最新一条的 at"**。这个区别很关键：
 * 记"离开时刻"要写 `Date.now()`，而任何页面卸载 / 切后台都可能是假的
 * （reload 也会触发一次 hidden），一写就把基准推成"现在"，这块提示永远不出现 ——
 * 实测就是这么栽的。记"看过的最新一条"则是个**稳定值**：重复写、乱序写都不改变它。
 */
const SEEN_AT_BOOT = (() => {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0 } catch { return 0 }
})()

/** 折叠时在段落边界下刀 —— 从半句上截断看着像坏了。 */
function fold(text: string): string {
  if (text.length <= FOLD_AT) return text
  const cut = text.slice(0, FOLD_AT)
  const nl = cut.lastIndexOf('\n')
  return (nl > FOLD_AT * 0.55 ? cut.slice(0, nl) : cut) + '…'
}

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 今天的只报时刻；昨天的报日期 —— 一条流里分得清"刚刚"和"昨天"就够了 */
function stamp(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? hhmm(ms) : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hhmm(ms)}`
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
/** 一段时长，用来读："你不在的 2 小时里"。中英混排时长写中文更像人话。 */
function span(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${Math.max(1, m)} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时`
  return `${Math.floor(h / 24)} 天`
}

const IconSound = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    {off ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
  </svg>
)
const IconClip = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 11.5 12.3 19a4.6 4.6 0 0 1-6.5-6.5l7.4-7.4a3 3 0 0 1 4.3 4.3l-7.4 7.4a1.5 1.5 0 0 1-2.1-2.1l6.7-6.7" />
  </svg>
)
const IconSend = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)
const IconChevron = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
)

/** 动作流每一行的图标。不用 emoji：不同 ROM 的字形差异太大，排在一起会歪。 */
const STEP_ICON: Record<string, string> = {
  bash: '❯', read: '◫', edit: '✎', search: '⌕', task: '⧉', todo: '☑', web: '⌘', think: '◌', tool: '⚙',
}
const NOW_VERB: Record<string, string> = {
  bash: '正在运行', read: '正在读', edit: '正在改', search: '正在搜',
  task: '正在派子任务', web: '正在查', todo: '正在更新清单', tool: '正在调用', think: '正在推理',
}

/** 本地这一轮：刚发出去、还在跑、或者已经答完的那一件事 */
interface Round {
  key: string
  project: string
  window: number
  sent: string
  startedAt: number
  state: 'waiting' | 'done' | 'timeout'
  reply: ReplyState | null
  steps: WalkieStep[]
  now: WalkieNow | null
  summary: string
  err: string
  via: string | null
}

export default function WalkieApp({ token, onExit }: { token: string; onExit?: () => void }) {
  const [projects, setProjects] = useState<WalkieProject[]>([])
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [runningCount, setRunningCount] = useState(0)
  const [loadErr, setLoadErr] = useState('')
  const [tmuxOk, setTmuxOk] = useState(true)

  const [target, setTarget] = useState('')          // "project:window"
  const [picker, setPicker] = useState(false)

  const [draft, setDraft] = useState('')
  const [rawText, setRawText] = useState('')
  const [refined, setRefined] = useState(false)
  const [refining, setRefining] = useState(false)
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [uploading, setUploading] = useState(false)

  const [round, setRound] = useState<Round | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())

  const [err, setErr] = useState('')
  const [speaking, setSpeaking] = useState<string | null>(null)
  const [muted, setMutedState] = useState(() => isMuted())
  const [browser, setBrowser] = useState<{ root: string; file?: string } | null>(null)
  /** 上次你看着这一屏的时刻（见 SEEN_AT_BOOT 里为什么在模块层读）；>0 才显示"你不在的时候" */
  const [since] = useState(SEEN_AT_BOOT)
  const [absentRead, setAbsentRead] = useState(false)

  const streamRef = useRef<HTMLDivElement | null>(null)
  const roundRef = useRef<Round | null>(null)
  const draftRef = useRef('')
  const targetRef = useRef('')
  /** onPaste 先于 onInput 触发：用它把"粘贴"和"语音提交"这两件同形的事分开 */
  const pastedRef = useRef(false)
  const pollRef = useRef<number | null>(null)
  const browserRef = useRef<WorkspaceBrowserHandle | null>(null)
  /** 你认领过的频道 */
  const heardRef = useRef<Set<string>>(new Set())
  /** 频道 -> 最近念过的那条结论的 id。用来判断"新出了一条" */
  const spokenRef = useRef<Map<string, string>>(new Map())
  const seededRef = useRef(false)
  roundRef.current = round
  draftRef.current = draft
  targetRef.current = target

  // ── 目标：记住上次，不让你每次重新选 ─────────────────────
  const findChannel = useCallback((key: string) => {
    for (const p of projects) {
      const c = p.channels.find((x) => `${p.name}:${x.index}` === key)
      if (c) return { project: p, channel: c }
    }
    return null
  }, [projects])
  const cur = findChannel(target)
  const blocked = !!cur && cur.channel.kind !== 'claude'

  // ── 流：主屏的内容 ──────────────────────────────────────
  const pollStream = useCallback(async () => {
    try {
      const s = await getStream(token)
      setProjects(s.projects)
      setEvents(s.events)
      setRunningCount(s.running)
      setTmuxOk(true)
      setLoadErr('')
      // 首帧：没选过就落到主 session 的活动窗口；上次那个没了就顺延
      if (!targetRef.current || !s.projects.some((p) => p.channels.some((c) => `${p.name}:${c.index}` === targetRef.current))) {
        const p = s.projects[0]
        const c = p?.channels.find((x) => x.kind === 'claude' && x.active) ?? p?.channels.find((x) => x.kind === 'claude') ?? p?.channels[0]
        if (p && c) setTarget(`${p.name}:${c.index}`)
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
      setTmuxOk(false)
    }
  }, [token])

  const busy = round?.state === 'waiting'
  useEffect(() => {
    let alive = true
    // **切到后台就停**。原来是不管有没有人在看，每 5 秒问一次服务端 —— 装在手机上
    // 就是一个常驻的唤醒源 + 电台占用，一天下来是实打实的电。回来时立刻补一次，
    // 所以"塞回兜里再掏出来"看到的一定是新的。
    const tick = () => { if (alive && !document.hidden) void pollStream() }
    tick()
    const t = window.setInterval(tick, busy ? POLL_STREAM_BUSY_MS : POLL_STREAM_MS)
    const onVis = () => { if (alive && !document.hidden) void pollStream() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [pollStream, busy])

  useEffect(() => { void attachAudioUnlock() }, [])
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); void stopSpeaking() }, [])

  // 落盘：目标 + 草稿。锁屏或 WebView 被回收之后回来，都还在。
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ last: target, draft, raw: rawText, refined })) } catch { /* 隐私模式 */ }
    }, 400)
    return () => clearTimeout(t)
  }, [target, draft, rawText, refined])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as { last?: string; draft?: string; raw?: string; refined?: boolean }
      if (s.last) setTarget(s.last)
      if (s.draft) { setDraft(s.draft); setRawText(s.raw || ''); setRefined(!!s.refined) }
    } catch { /* 坏的就当作没有 */ }
  }, [])

  // 文件浏览器挂载后，把要打开的文件交给它
  useEffect(() => {
    if (!browser?.file) return
    const want = browser.file
    let tries = 0
    const tick = () => {
      const h = browserRef.current
      if (h?.openPath) { h.openPath(want); return }
      if (++tries < 30) requestAnimationFrame(tick)
    }
    tick()
  }, [browser])

  const openBrowser = (cwd: string, file?: string) => {
    const root = (cwd || '').replace(/\/+$/, '')
    if (!root) { setErr('这一格还没有工作目录'); return }
    if (!file) { setBrowser({ root }); return }
    const abs = file.startsWith('/') ? file : `${root}/${file.replace(/^\.\//, '')}`
    const dir = abs.slice(0, abs.lastIndexOf('/')) || root
    setBrowser({ root: dir, file: abs })
  }

  // ── 精炼 ────────────────────────────────────────────────
  const refineNow = useCallback((raw: string) => {
    setRefining(true)
    refineText(token, raw)
      .then((r) => {
        if (r.text && r.text !== raw) land()      // 稿子被换掉了 —— 得让你注意到
        setDraft((c) => (c === raw ? r.text : c))
        setRefined(r.refined)
      })
      .catch(() => { /* 精炼失败就保持原文 */ })
      .finally(() => setRefining(false))
  }, [token])

  /**
   * 输入框里进来的字。**输入法的语音键走的就是这里。**
   *
   * 判据是"一次性塞进来一长串"：语音输入是一次提交整句，打字是一下一个字符。
   * 打字绝不会一次 +6 个字符，所以这条几乎不会误伤。万一误伤也有「还原」。
   */
  const onDraftInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    const burst = next.length - draft.length
    const pasted = pastedRef.current
    pastedRef.current = false
    setDraft(next)
    // 粘贴也是"一次进来一大串"，但它和语音是两回事：**粘进来的东西本来就该原样发出去**
    // （一段日志、一份需求、一个路径）。所以粘贴这一下不精炼 —— 靠 paste 事件区分，
    // 输入法的语音提交不会触发它。
    if (burst >= BURST_CHARS && next.trim() && !pasted) { setRawText(next.trim()); refineNow(next.trim()) }
  }

  // ── 附件 ────────────────────────────────────────────────
  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''                        // 同一个文件能再选一次
    if (!picked.length) return
    setUploading(true); setErr('')
    try {
      for (const f of picked) {
        const up = await uploadAttachment(token, f)
        setFiles((cur) => [...cur, up])
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally { setUploading(false) }
  }

  // ── 发送 + 追这一轮 ──────────────────────────────────────
  const startPoll = useCallback((r0: Round) => {
    if (pollRef.current) clearInterval(pollRef.current)
    const tick = async () => {
      // 后台不追。这一轮跑完时反正会进流，回来那一下的流刷新就把它带回来了 ——
      // 而 1.2 秒一次的轮询留在后台，是这一屏最贵的一笔电。
      if (document.hidden) return
      let r: ReplyState
      try { r = await getReply(token, r0.project, r0.window) } catch { return }
      const cur = roundRef.current
      if (!cur || cur.key !== r0.key) return
      setElapsed(Math.round((Date.now() - r0.startedAt) / 1000))
      if (r.done) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setRound({ ...cur, state: 'done', reply: r, steps: r.steps || cur.steps, now: null, via: r.via || null })
        roger()                                 // 他答完了 —— 一声"通话结束"
        void autoSpeak(r.text, r0.key)
        return
      }
      if (r.state === 'timeout') {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setRound({ ...cur, state: 'timeout', err: r.error || '没等到结果' })
        return
      }
      setRound({ ...cur, steps: r.steps || cur.steps, now: r.now ?? null })
      if (Date.now() - r0.startedAt > WAIT_LIMIT_MS) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setRound({ ...cur, state: 'timeout', err: '等了 10 分钟还没答完。切到经典界面看看它卡在哪了。' })
      }
    }
    pollRef.current = window.setInterval(tick, POLL_ROUND_MS)
    void tick()
  }, [token])

  /**
   * 屏上真正要画的东西 = 流 + 本地这一轮。
   * 去重规则：本地这一轮涉及的频道，它在发送时刻之后的那些服务端事件全部丢掉 ——
   * 否则同一句话会在"正在跑"卡片和下面的流里各出现一次。
   */
  const shown = useMemo(() => {
    const cut = round ? round.startedAt - 3000 : 0
    return events.filter((e) => !(round && e.ch === round.key && e.at >= cut))
  }, [events, round])
  const runningItems = shown.filter((e) => e.running)
  // 只画最近这些 —— 这一屏是"现在怎么样"，不是档案。往下翻是经典界面的事。
  const restItems = shown.filter((e) => !e.running).slice(0, 14)

  /** 你不在的时候，这台机器上有什么落了地 */
  const absent = useMemo(
    () => (since ? events.filter((e) => e.kind === 'it' && e.at > since) : []),
    [events, since],
  )
  const showAbsent = !absentRead && since > 0 && Date.now() - since > ABSENT_MIN_MS && absent.length > 0

  /**
   * 一条"现在"：把正在跑的那几件压成一行。
   *
   * 这是评审里"流没有摘要层"的一半。另一半（你不在的时候）要 LLM 写，
   * 这一半**不需要** —— 机器现在在干什么本来就是确定的，让人自己从三张卡里
   * 拼出来才是多余的。三件以上才值得占这一行。
   */
  const nowLine = useMemo(() => {
    if (runningItems.length < 2) return ''
    return runningItems
      .map((e) => `${e.path} ${e.text.replace(/\s+/g, ' ').slice(0, 24)}`)
      .join(' · ')
  }, [runningItems])

  const play = useCallback(async (text: string, rate: number, which: string) => {
    if (!text) return
    await stopSpeaking()
    setSpeaking(which)
    try { await speak(text, { rate }) } finally { setSpeaking((c) => (c === which ? null : c)) }
  }, [])

  const autoSpeak = useCallback(async (text: string, key: string) => {
    if (!text) return
    try {
      const s = await summarizeText(token, text)
      // 摘要降级时后端给的是"截前 120 字"，那**不是摘要** —— 是同一段话的残句。
      // 只认真正的摘要：没有就没有，回复自己就是那段话。
      const real = s.summarized ? s.text : ''
      setRound((c) => (c && c.key === key ? { ...c, summary: real } : c))
      // 太长就不自动念 —— 自动念一长段是最烦人的那种"贴心"
      const say = real || (text.length <= 400 ? text : '')
      if (say) await play(say, real ? 1.12 : 1.06, real ? 'summary' : 'full')
    } catch { /* 摘要失败就静默，你还能点「读一遍」 */ }
  }, [token, play])

  // ── 回话走声音 ──────────────────────────────────────────
  // 这一屏存在的理由就是**你可以不盯着它**。所以结论必须能听见，
  // 否则"把手机塞回兜里还能用"就是一句空话。
  //
  // 出声的范围要拿捏：只念**你认领过的频道**（你从这台手机跟他说过话的那些）。
  // 机器上别的活不出声 —— 那不是"没做完的功能"，那是"别吵我"。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HEARD_KEY)
      if (raw) heardRef.current = new Set(JSON.parse(raw) as string[])
    } catch { /* 坏的当作没有 */ }
  }, [])

  const rememberHeard = useCallback((key: string) => {
    if (!key || heardRef.current.has(key)) return
    heardRef.current.add(key)
    try { localStorage.setItem(HEARD_KEY, JSON.stringify([...heardRef.current])) } catch { /* 隐私模式 */ }
  }, [])

  const speakEvent = useCallback(async (e: StreamEvent) => {
    try {
      const s = await summarizeText(token, e.text)
      const real = s.summarized ? s.text : ''
      const say = real || (e.text.length <= 400 ? e.text : '')
      if (say) await play(say, real ? 1.12 : 1.06, e.id)
    } catch { /* 念不出来就算了，你还能点「读一遍」 */ }
  }, [token, play])

  useEffect(() => {
    if (!events.length) return
    const newest = new Map<string, StreamEvent>()
    for (const e of events) {
      if (e.kind !== 'it') continue
      const cur = newest.get(e.ch)
      if (!cur || e.at > cur.at) newest.set(e.ch, e)
    }
    // 首帧只记不念 —— 一打开就把历史念一遍是最烦的那种"贴心"
    if (!seededRef.current) {
      for (const [ch, e] of newest) spokenRef.current.set(ch, e.id)
      seededRef.current = true
      return
    }
    for (const [ch, e] of newest) {
      const prev = spokenRef.current.get(ch)
      spokenRef.current.set(ch, e.id)
      if (!prev || prev === e.id) continue            // 第一次见 / 没有新的
      if (!heardRef.current.has(ch)) continue         // 不是你认领的频道，别吵你
      if (roundRef.current?.key === ch) continue      // 你自己那一轮由 autoSpeak 念
      if (Date.now() - e.at > SPEAK_MAX_AGE_MS) continue   // 太旧的是补报历史，不是"刚办完"
      void speakEvent(e)
    }
  }, [events, speakEvent])

  /**
   * 「你不在的时候」那一句。只问一次 LLM —— 它是这一屏唯一一处"要动脑子"的摘要，
   * 而且回来的那句要**念出来**（你不在这段时间发生的事，本来就该用耳朵收）。
   */
  const [digest, setDigest] = useState('')
  const digestAskedRef = useRef(false)
  const digestSpokenRef = useRef(false)
  useEffect(() => {
    if (!showAbsent || digestAskedRef.current) return
    digestAskedRef.current = true
    const raw = absent.slice(0, 8).map((e) => `· ${e.path}：${e.text.slice(0, 400)}`).join('\n')
    summarizeText(token, raw)
      .then((s) => { if (s.summarized && s.text) setDigest(s.text) })
      .catch(() => { /* 没有摘要就只报条数，绝不编一句 */ })
  }, [showAbsent, absent, token])

  useEffect(() => {
    if (!digest || digestSpokenRef.current) return
    digestSpokenRef.current = true
    void play(digest, 1.08, 'absent')
  }, [digest, play])

  /** 顶栏那个「N 个在跑」点一下 = 让它用一句话告诉你机器现在在干什么 */
  const speakOverview = useCallback(() => {
    if (speaking === 'overview') { void stopSpeaking(); setSpeaking(null); return }
    const line = runningItems.length
      ? `${runningItems.length} 件在跑。` + runningItems
        .map((e) => `${e.path}：${e.text.replace(/\s+/g, ' ').slice(0, 40)}`)
        .join('；')
      : '机器上没有人在干活。'
    void play(line, 1.06, 'overview')
  }, [runningItems, speaking, play])

  // 把水位线推到"你看到过的最新一条"。**只在页面可见时推** —— 切到后台的 WebView
  // 还在跑 JS，那时候收到的东西你没看见，不该算数。
  useEffect(() => {
    if (!events.length || document.hidden) return
    const maxAt = events.reduce((m, e) => Math.max(m, e.at), 0)
    if (maxAt <= 0) return
    try {
      if (maxAt > (Number(localStorage.getItem(SEEN_KEY)) || 0)) {
        localStorage.setItem(SEEN_KEY, String(maxAt))
      }
    } catch { /* 隐私模式 */ }
  }, [events])

  const deliver = useCallback(async (override?: string) => {
    if (!cur) { setErr('还没选好寄给谁'); return }
    if (cur.channel.kind !== 'claude') {
      setErr(`「${cur.channel.name}」里跑的不是 Claude —— 这句话发过去会被当命令执行，所以拦住了。`)
      return
    }
    // 精炼还没落地就等一下（最多 3 秒）；宁可发原文，也不让你干等
    if (refining) await new Promise((r) => setTimeout(r, REFINE_WAIT_MS))
    const body = (override ?? draftRef.current).trim()
    if (!body) return

    // 附件：把绝对路径写进那句话里。Claude 读一个路径就够了，不需要发明上传协议。
    const withFiles = files.length
      ? `${body}\n\n${files.map((f) => `[附件] ${f.path}`).join('\n')}`
      : body

    whoosh()
    hapticSnap()
    setErr('')
    rememberHeard(targetRef.current)   // 认领这个频道：它以后答完了会出声
    setAbsentRead(true)
    const r0: Round = {
      key: targetRef.current, project: cur.project.name, window: cur.channel.index,
      sent: body, startedAt: Date.now(), state: 'waiting',
      reply: null, steps: [], now: null, summary: '', err: '', via: null,
    }
    setRound(r0); setElapsed(0)
    setDraft(''); setRawText(''); setRefined(false); setFiles([])

    try {
      await sendPrompt(token, cur.project.name, cur.channel.index, withFiles)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setRound({ ...r0, state: 'timeout', err: e instanceof Error ? e.message : String(e) })
      return
    }
    startPoll(r0)
  }, [token, cur, refining, files, startPoll, rememberHeard])

  const toggleMute = () => { const next = !muted; setMutedFeedback(next); setMutedState(next) }

  // ── 渲染 ────────────────────────────────────────────────
  const canSend = !!draft.trim() && !busy && !blocked

  const story = (rows: WalkieStep[]) => {
    const chapters: { say?: WalkieStep; tools: WalkieStep[] }[] = []
    for (const s of rows) {
      if (s.kind === 'say') chapters.push({ say: s, tools: [] })
      else {
        if (!chapters.length) chapters.push({ tools: [] })
        chapters[chapters.length - 1].tools.push(s)
      }
    }
    return (
      <ol className="walkie-story">
        {chapters.filter((c) => c.say || c.tools.length).map((c, i) => (
          <li key={i} className="walkie-chapter">
            {c.say && <p className="walkie-say">{c.say.label}</p>}
            {c.tools.length > 0 && (
              <ul className="walkie-doings">
                {c.tools.map((s, j) => (
                  <li key={j} className={`walkie-step k-${s.kind}${s.done === false ? ' is-running' : ''}`}>
                    <span className="walkie-step-ico">{STEP_ICON[s.kind] || STEP_ICON.tool}</span>
                    <span className="walkie-step-text">{s.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    )
  }

  const targetLabel = cur
    ? `${cur.project.path || cur.project.name}${cur.project.channels.length > 1 ? ` · ${cur.channel.name}` : ''}`
    : '选一个地方'

  return (
    <div className="walkie-root">
      <div className="walkie-top">
        {/* 点一下 = 让它用一句话说机器现在在干什么。这是"兜里能用"的第二半：
            流是给眼睛的，这一句是给耳朵的。 */}
        <button type="button" className="walkie-top-title" onClick={speakOverview}>
          <span className="walkie-dot" style={{ background: tmuxOk ? 'var(--nexus-success)' : 'var(--nexus-error)' }} />
          我的机器{runningCount > 0 ? ` · ${runningCount} 个在跑` : ''}
          {speaking === 'overview' ? ' ⏹' : runningCount > 0 ? ' 🔊' : ''}
        </button>
        <div className="walkie-top-actions">
          <button type="button" className="walkie-icon-btn" onClick={toggleMute} title={muted ? '开启声音' : '静音'}>
            <IconSound off={muted} />
          </button>
          {onExit && <button type="button" className="walkie-chip" onClick={onExit}>经典</button>}
        </div>
      </div>

      {/* 流：这台机器上**所有**在跑的 claude，不只是从手机上发出去的那些。
          「正在跑」钉在最上面 —— 那是这一屏最要紧的一件事。 */}
      <div className="walkie-stage" ref={streamRef}>
        <div className="walkie-stage-inner">
          {/* 你不在的时候。这一屏是状态牌，第一句就该回答"有没有我不知道的事"——
              而且要回答"是什么事"，不是只报个数（只报个数等于让你自己去翻下面那堆）。 */}
          {showAbsent && (
            <div className="walkie-absent">
              <b>你不在的 {span(Date.now() - since)}里 · {absent.length} 件办完了</b>
              {digest && <p className="walkie-absent-say">{digest}</p>}
              <div className="walkie-absent-acts">
                {digest && (
                  <button type="button" className="walkie-mini"
                    onClick={() => (speaking === 'absent' ? (void stopSpeaking(), setSpeaking(null)) : void play(digest, 1.08, 'absent'))}>
                    {speaking === 'absent' ? '⏹ 停止' : '🔊 再听一遍'}
                  </button>
                )}
                <button type="button" className="walkie-mini" onClick={() => setAbsentRead(true)}>知道了</button>
              </div>
            </div>
          )}

          {/* 现在：把在跑的那几件压成一行。三件以上才占地方，两件以下那两张卡自己就说清了。 */}
          {nowLine && (
            <button type="button" className="walkie-nowline" onClick={speakOverview}>
              <span className="walkie-now-dot" />
              <span>{runningItems.length} 件在跑 · {nowLine}</span>
            </button>
          )}

          {round && (
            <div className={`walkie-round${round.state === 'waiting' ? ' is-live' : ''}`}>
              <div className="walkie-card-label">
                <span className="walkie-round-head">
                  {round.state === 'waiting'
                    ? <><span className="walkie-rec"><i />正在跑</span></>
                    : round.state === 'done' ? '它说' : '没跑成'}
                  <em className="walkie-at">{displayPath(round.project, projects)} · {stamp(round.startedAt)}</em>
                </span>
                {round.state === 'waiting' && <span className="walkie-at">{elapsed}s</span>}
              </div>

              <p className="walkie-said">{round.sent}</p>

              {round.state === 'waiting' && (
                round.steps.length ? story(round.steps.slice(-18)) : (
                  <p className="walkie-waiting-line">已经投递，等它开口…</p>
                )
              )}

              {round.state === 'waiting' && (
                <div className="walkie-now">
                  <span className="walkie-now-dot" />
                  <span className="walkie-now-text">
                    {round.now
                      ? `${NOW_VERB[round.now.kind] || '正在处理'}${round.now.kind === 'think' ? '…' : ` ${round.now.label}`}`
                      : '正在连接…'}
                  </span>
                </div>
              )}

              {round.state === 'done' && round.reply?.text && (
                <div className="walkie-reply">
                  <ReplyText
                    text={fold(round.reply.text)}
                    onOpen={(f) => {
                      const cwd = findChannel(round.key)?.channel.cwd || ''
                      openBrowser(cwd, f)
                    }}
                  />
                </div>
              )}
              {round.state === 'done' && !round.reply?.text && (
                <p className="walkie-dim">（这一轮没有说话，可能只动了文件）</p>
              )}
              {round.state === 'done' && (
                <div className="walkie-inline">
                  {round.summary && (
                    <button type="button" className="walkie-mini"
                      onClick={() => (speaking === 'summary' ? (void stopSpeaking(), setSpeaking(null)) : void play(round.summary, 1.12, 'summary'))}>
                      {speaking === 'summary' ? '⏹ 停止' : '▶ 摘要'}
                    </button>
                  )}
                  {round.reply?.text && (
                    <button type="button" className="walkie-mini"
                      onClick={() => (speaking === 'full' ? (void stopSpeaking(), setSpeaking(null)) : void play(round.reply?.text || '', 1.06, 'full'))}>
                      {speaking === 'full' ? '⏹ 停止' : round.summary ? '▶ 全文' : '▶ 读一遍'}
                    </button>
                  )}
                  <button type="button" className="walkie-mini"
                    onClick={() => openBrowser(findChannel(round.key)?.channel.cwd || '')}>看文件</button>
                </div>
              )}
              {(round.err || round.state === 'timeout') && <p className="walkie-hint-bad">{round.err}</p>}
            </div>
          )}

          {runningItems.map((e) => (
            <div key={e.id} className="walkie-run">
              <div className="walkie-card-label">
                <span className="walkie-rec"><i />正在跑</span>
                <span className="walkie-at">{ago(e.at)} · {e.path}</span>
              </div>
              <p className="walkie-said">{e.text}</p>
              {e.partial && <p className="walkie-partial">{fold(e.partial).slice(0, 220)}</p>}
            </div>
          ))}

          {(() => {
            // 连着几条都是同一个目录时，只写一次 —— 每条都印一遍 ~/work/nexus
            // 是一屏里最占地方又最没信息的那点墨水。
            let prevPath = ''
            return restItems.map((e) => {
              const showPath = e.path !== prevPath
              prevPath = e.path
              const where = showPath ? `${stamp(e.at)} · ${e.path}` : stamp(e.at)
              return e.kind === 'you' ? (
                <div key={e.id} className="walkie-you">
                  <p>{e.text.length > 300 ? `${e.text.slice(0, 300)}…` : e.text}</p>
                  <span className="walkie-at">{where}</span>
                </div>
              ) : (
                <div key={e.id} className="walkie-it" onClick={() => setOpenIds((s) => {
                  const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n
                })}>
                  <p className={openIds.has(e.id) ? '' : 'is-clamp'}>{openIds.has(e.id) ? e.text : fold(e.text).slice(0, 600)}</p>
                  <span className="walkie-at">{speaking === e.id && <span className="walkie-speaking">🔊 </span>}{where}</span>
                  {openIds.has(e.id) && (
                    <div className="walkie-inline" onClick={(ev) => ev.stopPropagation()}>
                      <button type="button" className="walkie-mini"
                        onClick={() => (speaking === e.id ? (void stopSpeaking(), setSpeaking(null)) : void play(e.text, 1.06, e.id))}>
                        {speaking === e.id ? '⏹ 停止' : '▶ 读一遍'}
                      </button>
                      <button type="button" className="walkie-mini" onClick={() => openBrowser(e.cwd)}>看文件</button>
                    </div>
                  )}
                </div>
              )
            })
          })()}

          {!events.length && !round && !loadErr && (
            <div className="walkie-quiet">这台机器上还没有人说过话。</div>
          )}
        </div>
      </div>

      {/* 出错时给的是**下一步**，不是一个红条。连不上机器和"这句话没发出去"是两件事，
          界面上不该长得一样。 */}
      {loadErr ? (
        <div className="walkie-error">
          <b>连不上这台机器</b>
          <span>{loadErr}</span>
          <button type="button" className="walkie-mini" onClick={() => void pollStream()}>重试</button>
        </div>
      ) : err ? (
        <div className="walkie-error"><span>{err}</span></div>
      ) : null}
      {blocked && (
        <div className="walkie-blocked">
          这一格不是 Claude —— 发过去会被当命令执行。点下面的地址换一个。
        </div>
      )}

      {/* 输入框：一个框、一个附件、一个发送。转写交给输入法 —— 它比本机模型好，
          而且按住说话那个按钮本来就是别人键盘上的，我们按不到。 */}
      <div className="walkie-compose">
        {files.length > 0 && (
          <div className="walkie-files">
            {files.map((f) => (
              <button key={f.path} type="button" className="walkie-file"
                onClick={() => setFiles((c) => c.filter((x) => x.path !== f.path))} title="点一下移除">
                📎 {f.name}
              </button>
            ))}
          </div>
        )}
        <div className="walkie-box">
          <textarea
            id="walkie-draft"
            className="walkie-input"
            value={draft}
            rows={1}
            onChange={onDraftInput}
            onPaste={() => { pastedRef.current = true }}
            onFocus={() => { primeFeedback(); setErr('') }}
            placeholder="说点什么…"
          />
          <input id={FILE_INPUT_ID} type="file" multiple hidden onChange={onPickFiles} />
          <button type="button" className="walkie-roundbtn" disabled={uploading}
            onClick={() => document.getElementById(FILE_INPUT_ID)?.click()} title="附件">
            {uploading ? '…' : <IconClip />}
          </button>
          <button type="button" className="walkie-sendbtn" disabled={!canSend}
            onClick={() => void deliver()} title="发送">
            <IconSend />
          </button>
        </div>
        <button type="button" className={`walkie-target${blocked ? ' is-warn' : ''}`} onClick={() => setPicker(true)}>
          {blocked && '⚠ '}
          <span className="walkie-target-path">{targetLabel}</span>
          <IconChevron />
        </button>
        {(refined || refining) && (
          <div className="walkie-refine">
            {refining ? '精炼中…' : (
              <>
                已精炼
                <button type="button" className="walkie-mini" onClick={() => { setDraft(rawText); setRefined(false) }}>还原</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* 换一个收件人。这里才出现 tmux 的窗口名 —— 平时它不该在你眼前。 */}
      {picker && (
        <div className="walkie-sheet" onClick={() => setPicker(false)}>
          <div className="walkie-sheet-body" onClick={(e) => e.stopPropagation()}>
            <div className="walkie-sheet-title">寄给谁</div>
            <div className="walkie-sheet-list">
              {/* 按**目录**分组：目录才是人认的地方，窗口名只是"这个目录里的哪一个人"。
                  同目录下有几个 claude 时，名字才有意义 —— 它是替代品，不是标签。 */}
              {projects.map((p) => (
                <div key={p.name} className="walkie-group">
                  <div className="walkie-group-head">{p.path || p.name}</div>
                  {p.channels.map((c) => {
                    const key = `${p.name}:${c.index}`
                    return (
                      <button key={key} type="button"
                        className={`walkie-option${key === target ? ' is-on' : ''}`}
                        onClick={() => { setTarget(key); setPicker(false) }}>
                        <span className="walkie-option-name">{c.name}</span>
                        <span className="walkie-option-where">
                          {c.kind !== 'claude' ? '不是 Claude' : c.status === 'working' ? '在跑' : '空闲'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {browser && (
        <Suspense fallback={null}>
          <WorkspaceBrowser
            token={token}
            title="工作目录"
            initialPath={browser.root}
            onClose={() => setBrowser(null)}
            ref={browserRef}
          />
        </Suspense>
      )}
    </div>
  )
}

/** 这一轮发生在哪个目录 —— 卡片头上要写的不是 tmux 的名字，是那个文件夹 */
function displayPath(projectName: string, projects: WalkieProject[]): string {
  const p = projects.find((x) => x.name === projectName)
  return p?.path || projectName
}
