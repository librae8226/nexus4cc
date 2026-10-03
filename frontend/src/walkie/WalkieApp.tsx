// walkie/WalkieApp.tsx — 极简交互版的根组件
//
// 【版面】顶栏 / 钉住的提示条 / 流 / 输入框。
//   流是**聊天的顺序**：老的在上面，新的在最下面，进来就停在最底下，往上翻是历史。
//   这一版把"新的在最上面"反过来了（见 docs/WALKIE.md 第十二节）——
//   它本来是按"状态牌"设计的，但你用起来是一段对话，对话就该从底下往上读。
//
// 【钉住的两条提示】不跟着流滚：
//   · 你不在的时候 —— 回来第一句要回答"有没有我不知道的事"，滚走了就没意义了
//   · 现在 —— 三件以上在跑时压成一行
//
// 【为什么是这一屏】见 docs/WALKIE.md 第十节。一句话：
//   AI chat app 的另一端是它自己的 agent；这一屏的另一端是**这台机器**。
//   判据只有一条：**能不能看见你没通过手机下的那些活。**

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { WorkspaceBrowserHandle } from '../WorkspaceBrowser'
import {
  getStream, getReply, refineText, summarizeText, sendPrompt, uploadAttachment, createWorkspace, resolvePath,
  answerQuestion, getConfigs, getVersion,
  type StreamEvent, type ReplyState, type WalkieProject, type WalkieStep, type WalkieNow,
  type WalkieConfig, type Ask,
} from './api'
import {
  attachAudioUnlock, hapticSnap, hapticTap, isMuted, land, primeFeedback, roger,
  setMuted as setMutedFeedback, whoosh,
} from './feedback'
import { speak, stopSpeaking } from './tts'
import Markdown, { Preview } from './Markdown'
import './walkie.css'

const WorkspaceBrowser = lazy(() => import('../WorkspaceBrowser'))
const WorkspaceSelector = lazy(() => import('../WorkspaceSelector'))

const POLL_STREAM_MS = 5000
const POLL_STREAM_BUSY_MS = 1500
const POLL_ROUND_MS = 1200
const WAIT_LIMIT_MS = 10 * 60_000
const REFINE_WAIT_MS = 3000
/** 超过这么多字就折叠。手机上这个长度约 20 行，再多就成了一堵墙。 */
const FOLD_AT = 700
/** 超过这么多字就折起来 —— 约三行。这一屏要"扫"，不是"读"。 */
const PREVIEW_AT = 140
/** 一次塞进来这么多字符 = 语音输入法整句提交（打字不会这样），自动精炼 */
const BURST_CHARS = 6

/** 流的页大小。往上翻就一档一档加大（后端 STREAM_EVENT_CAP 是 240）。 */
const PAGE_STEPS = [40, 80, 160, 240]
/** 离底部这么近就算"贴在底部"—— 新消息来了自动跟着走 */
const NEAR_BOTTOM_PX = 60
/** 滚到这么靠上就加载更早的 */
const LOAD_MORE_PX = 80

const STORE_KEY = 'nexus_walkie_state'
/** 新会话默认用哪个模型 profile（设置面板里选的） */
const PROFILE_KEY = 'nexus_walkie_profile'
/** 你"认领"过的频道 —— 只有它们答完了会出声，别的活不吵你 */
const HEARD_KEY = 'nexus_walkie_heard'
/** 你看到过的最新一条的 at。回来时用它算"你不在的时候" */
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
/** 今天的只报时刻；昨天的报日期 */
function stamp(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? hhmm(ms) : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hhmm(ms)}`
}
/** 一段时长，用来读："你不在的 2 小时里" */
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
const IconExpand = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4H4v5M15 20h5v-5M20 9V4h-5M4 15v5h5" />
  </svg>
)
const IconFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
)
/** 齿轮。**不能画成"圆 + 放射状短线"** —— 那个形状在手机上读作"亮度/太阳"，
    点开发现是设置就成了一次小意外。齿要有齿的样子。 */
const IconGear = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
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
  /** 这一轮挂着的问题（它停下来等你选）—— 选项就画在卡片上 */
  ask: Ask | null
  summary: string
  err: string
}

export default function WalkieApp({ token }: { token: string }) {
  const [projects, setProjects] = useState<WalkieProject[]>([])
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [runningCount, setRunningCount] = useState(0)
  const [loadErr, setLoadErr] = useState('')
  const [tmuxOk, setTmuxOk] = useState(true)
  const [limit, setLimit] = useState(PAGE_STEPS[0])

  const [target, setTarget] = useState('')          // "project:window"
  const [picker, setPicker] = useState(false)
  const [pickWs, setPickWs] = useState('')          // 选人面板左栏当前高亮的工作区
  const [adding, setAdding] = useState(false)       // 目录选择器（新增工作区）
  const [justCreated, setJustCreated] = useState('')

  const [draft, setDraft] = useState('')
  const [rawText, setRawText] = useState('')
  const [refined, setRefined] = useState(false)
  const [refining, setRefining] = useState(false)
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState(false)     // 全屏编辑

  const [round, setRound] = useState<Round | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())
  /** 刚点中的那条消息 —— 闪一下，让你看清"现在跟谁说话" */
  const [flash, setFlash] = useState('')
  const flashTimer = useRef<number | null>(null)

  const [err, setErr] = useState('')
  const [speaking, setSpeaking] = useState<string | null>(null)
  const [muted, setMutedState] = useState(() => isMuted())
  const [browser, setBrowser] = useState<{ root: string; file?: string } | null>(null)
  const [since] = useState(SEEN_AT_BOOT)
  const [absentRead, setAbsentRead] = useState(false)
  const [digest, setDigest] = useState('')
  /** 家目录绝对路径（后端给）—— 展开 `~/x` 要用 */
  const homeRef = useRef('')
  /** 宽屏（折叠屏）：文件浏览器要像经典版那样左右并排，而不是全屏盖住 */
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 700)
  /** 宽屏下左侧文件树要不要展开 */
  const [tree, setTree] = useState(true)
  /** 新增 channel 的表单（选人面板右栏） */
  const [addingChan, setAddingChan] = useState(false)
  const [newChan, setNewChan] = useState('')

  /** 设置面板。现在只有一件事（新会话用哪个模型），但它是个**容器** ——
      以后的功能性设置都往这里放，不再往主屏上加按钮。 */
  const [settings, setSettings] = useState(false)
  const [profiles, setProfiles] = useState<WalkieConfig[] | null>(null)
  const [dflt, setDflt] = useState(() => {
    try { return localStorage.getItem(PROFILE_KEY) || '' } catch { return '' }
  })
  const [about, setAbout] = useState<{ current: string; clean: boolean } | null>(null)

  // 滚动：贴在底部就跟着走，翻上去看历史时不打扰
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [missed, setMissed] = useState(0)
  const lastLenRef = useRef(0)

  const roundRef = useRef<Round | null>(null)
  const draftRef = useRef('')
  const targetRef = useRef('')
  const limitRef = useRef(limit)
  const pastedRef = useRef(false)
  const pollRef = useRef<number | null>(null)
  const browserRef = useRef<WorkspaceBrowserHandle | null>(null)
  const heardRef = useRef<Set<string>>(new Set())
  const spokenRef = useRef<Map<string, string>>(new Map())
  const seededRef = useRef(false)
  const digestAskedRef = useRef(false)
  const digestSpokenRef = useRef(false)
  roundRef.current = round
  draftRef.current = draft
  targetRef.current = target
  limitRef.current = limit

  // ── 目标 ────────────────────────────────────────────────
  const findChannel = useCallback((key: string) => {
    for (const p of projects) {
      const c = p.channels.find((x) => `${p.name}:${x.index}` === key)
      if (c) return { project: p, channel: c }
    }
    return null
  }, [projects])
  const cur = findChannel(target)
  const blocked = !!cur && cur.channel.kind !== 'claude'

  // ── 流 ──────────────────────────────────────────────────
  const pollStream = useCallback(async () => {
    try {
      const s = await getStream(token, limitRef.current)
      setProjects(s.projects)
      setEvents(s.events)
      setRunningCount(s.running)
      setTmuxOk(true)
      setLoadErr('')
      if (s.home) homeRef.current = s.home
      // 新建成的工作区一出现就选中它
      if (justCreated) {
        const hit = s.projects.flatMap((p) => p.channels.map((c) => ({ p, c }))).find((x) => x.c.name === justCreated)
        if (hit) { setTarget(`${hit.p.name}:${hit.c.index}`); setJustCreated('') }
      }
      // 没选过就落到主 session 的活动窗口；上次那个没了就顺延
      if (!targetRef.current || !s.projects.some((p) => p.channels.some((c) => `${p.name}:${c.index}` === targetRef.current))) {
        const p = s.projects[0]
        const c = p?.channels.find((x) => x.kind === 'claude' && x.active) ?? p?.channels.find((x) => x.kind === 'claude') ?? p?.channels[0]
        if (p && c) setTarget(`${p.name}:${c.index}`)
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
      setTmuxOk(false)
    }
  }, [token, justCreated])

  const busy = round?.state === 'waiting'
  useEffect(() => {
    let alive = true
    // 切到后台就停 —— 装在手机上就是常驻唤醒源 + 电台占用。回来立刻补一次。
    const tick = () => { if (alive && !document.hidden) void pollStream() }
    tick()
    const t = window.setInterval(tick, busy ? POLL_STREAM_BUSY_MS : POLL_STREAM_MS)
    const onVis = () => { if (alive && !document.hidden) void pollStream() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [pollStream, busy])

  useEffect(() => { void attachAudioUnlock() }, [])
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 700)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); void stopSpeaking() }, [])

  // 落盘：目标 + 草稿。锁屏 / 退出 / WebView 被回收之后回来，字还在。
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ last: target, draft, raw: rawText, refined })) } catch { /* 隐私模式 */ }
    }, 250)
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
    try {
      const raw = localStorage.getItem(HEARD_KEY)
      if (raw) heardRef.current = new Set(JSON.parse(raw) as string[])
    } catch { /* 坏的当作没有 */ }
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

  const openBrowser = useCallback((cwd: string, file?: string) => {
    const root = (cwd || '').replace(/\/+$/, '')
    if (!root) { setErr('这一格还没有工作目录'); return }
    if (!file) { setBrowser({ root }); return }
    // AI 写的路径经常是 `~/work/nexus/x.md`。不展开 `~` 就会拼成 `<cwd>/~/…`，
    // 文件浏览器当然打不开 —— 这就是"点了没反应"的那个 bug。
    const f = file.startsWith('~/') && homeRef.current ? `${homeRef.current}/${file.slice(2)}` : file
    const abs = f.startsWith('/') ? f : `${root}/${f.replace(/^\.\//, '')}`
    const dir = abs.slice(0, abs.lastIndexOf('/')) || root
    setBrowser({ root: dir, file: abs })
  }, [])

  /** 点消息里的文件路径。先让服务端把路径解析成真的存在的那一个，再开浏览器 ——
      直接按 cwd 拼会拼出 `<cwd>/debian-l-colorful/postgres.md` 这种双份路径然后 ENOENT。 */
  const openFile = useCallback(async (cwd: string, p: string) => {
    try {
      const r = await resolvePath(token, cwd || '', p)
      if (r.missing) setErr(`这条消息里的路径没找到：${p}`)
      openBrowser(cwd, r.path)
    } catch {
      openBrowser(cwd, p)      // 解析接口不通也得能点开（退回老行为）
    }
  }, [token, openBrowser])

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

  /** 输入框里进来的字。**输入法的语音键走的就是这里。** */
  const onDraftInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    const burst = next.length - draft.length
    const pasted = pastedRef.current
    pastedRef.current = false
    setDraft(next)
    // 粘贴也是"一次进来一大串"，但它和语音是两回事：粘进来的本来就该原样发出去。
    if (burst >= BURST_CHARS && next.trim() && !pasted) { setRawText(next.trim()); refineNow(next.trim()) }
  }

  // ── 附件 ────────────────────────────────────────────────
  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (!picked.length) return
    setUploading(true); setErr('')
    try {
      for (const f of picked) {
        const up = await uploadAttachment(token, f)
        setFiles((c) => [...c, up])
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally { setUploading(false) }
  }

  // ── 发送 + 追这一轮 ──────────────────────────────────────
  const startPoll = useCallback((r0: Round) => {
    if (pollRef.current) clearInterval(pollRef.current)
    const tick = async () => {
      // 后台不追。这一轮跑完时反正会进流，回来那一下的流刷新就把它带回来了。
      if (document.hidden) return
      let r: ReplyState
      try { r = await getReply(token, r0.project, r0.window) } catch { return }
      const now = roundRef.current
      if (!now || now.key !== r0.key) return
      setElapsed(Math.round((Date.now() - r0.startedAt) / 1000))
      if (r.done) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setRound({ ...now, state: 'done', reply: r, steps: r.steps || now.steps, now: null })
        roger()
        void autoSpeak(r.text, r0.key)
        return
      }
      if (r.state === 'timeout') {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setRound({ ...now, state: 'timeout', err: r.error || '没等到结果' })
        return
      }
      setRound({ ...now, steps: r.steps || now.steps, now: r.now ?? null, ask: r.ask ?? null })
      // 它在等你回答 —— 这个"等"不该被十分钟的上限掐掉（那等于替你放弃）
      if (!r.ask && Date.now() - r0.startedAt > WAIT_LIMIT_MS) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setRound({ ...now, state: 'timeout', err: '等了 10 分钟还没答完。切到经典界面看看它卡在哪了。' })
      }
    }
    pollRef.current = window.setInterval(tick, POLL_ROUND_MS)
    void tick()
  }, [token])

  const play = useCallback(async (text: string, rate: number, which: string) => {
    if (!text || !which) return
    await stopSpeaking()
    setSpeaking(which)
    try { await speak(text, { rate }) } finally { setSpeaking((c) => (c === which ? null : c)) }
  }, [])

  const autoSpeak = useCallback(async (text: string, key: string) => {
    if (!text) return
    try {
      const s = await summarizeText(token, text)
      // 摘要降级时后端给的是"截前 120 字"，那**不是摘要** —— 是同一段话的残句。
      const real = s.summarized ? s.text : ''
      setRound((c) => (c && c.key === key ? { ...c, summary: real } : c))
      const say = real || (text.length <= 400 ? text : '')
      if (say) await play(say, real ? 1.12 : 1.06, real ? 'summary' : 'full')
    } catch { /* 摘要失败就静默，你还能点「读一遍」 */ }
  }, [token, play])

  // ── 回话走声音 ──────────────────────────────────────────
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
    } catch { /* 念不出来就算了 */ }
  }, [token, play])

  useEffect(() => {
    if (!events.length) return
    const newest = new Map<string, StreamEvent>()
    for (const e of events) {
      if (e.kind !== 'it') continue
      const prev = newest.get(e.ch)
      if (!prev || e.at > prev.at) newest.set(e.ch, e)
    }
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
      if (Date.now() - e.at > SPEAK_MAX_AGE_MS) continue
      void speakEvent(e)
    }
  }, [events, speakEvent])

  const deliver = useCallback(async (override?: string) => {
    if (!cur) { setErr('还没选好寄给谁'); return }
    if (cur.channel.kind !== 'claude') {
      setErr(`「${cur.channel.name}」里跑的不是 Claude —— 这句话发过去会被当命令执行，所以拦住了。`)
      return
    }
    if (refining) await new Promise((r) => setTimeout(r, REFINE_WAIT_MS))
    const body = (override ?? draftRef.current).trim()
    if (!body) return
    const withFiles = files.length ? `${body}\n\n${files.map((f) => `[附件] ${f.path}`).join('\n')}` : body

    whoosh(); hapticSnap(); setErr('')
    rememberHeard(targetRef.current)
    setAbsentRead(true)
    setEditing(false)
    const r0: Round = {
      key: targetRef.current, project: cur.project.name, window: cur.channel.index,
      sent: body, startedAt: Date.now(), state: 'waiting',
      reply: null, steps: [], now: null, ask: null, summary: '', err: '',
    }
    setRound(r0); setElapsed(0)
    setDraft(''); setRawText(''); setRefined(false); setFiles([])
    try {
      await sendPrompt(token, cur.project.name, cur.channel.index, withFiles)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      setRound({ ...r0, state: 'timeout', err: msg })
      return
    }
    startPoll(r0)
  }, [token, cur, refining, files, startPoll, rememberHeard])

  const toggleMute = () => { const next = !muted; setMutedFeedback(next); setMutedState(next) }

  /**
   * 回答它问的题。**不生成任何文案** —— 送回的就是选项本身的字，那是它自己写的，
   * 我们改写一个字都可能让它对不上。答完立刻补一次流，让那张卡尽快变回"它说"。
   */
  const answer = useCallback(async (project: string, win: number, picks: number[][]) => {
    try {
      await answerQuestion(token, project, win, picks)
      hapticTap()
      window.setTimeout(() => { void pollStream() }, 700)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [token, pollStream])

  // ── 派生 ────────────────────────────────────────────────

  /** 屏上真正要画的东西 = 流 + 本地这一轮（去重：这一轮涉及的频道，发送时刻之后的服务端事件丢掉） */
  const shown = useMemo(() => {
    const cut = round ? round.startedAt - 3000 : 0
    return events.filter((e) => !(round && e.ch === round.key && e.at >= cut))
  }, [events, round])
  // **升序**：老 → 新，新的在底下。本地那一轮是最新的，永远排在最后。
  const items = useMemo(() => [...shown].sort((a, b) => a.at - b.at), [shown])
  const runningItems = items.filter((e) => e.running)

  /**
   * 你现在对着的那个人，正停下来等你选。
   *
   * 这时候**输入框必须停用**：终端里那道题还开着的时候，打进输入框的字会被它吞掉，
   * 而回车会替你按在**当前高亮的那一项**上 —— 实测就是这个行为。也就是说，
   * 不拦的话你会得到一个"我没选它，它却收到了"的答案，这比不让发糟得多。
   */
  const asking = items.find((e) => e.ch === target && e.ask)?.ask ?? null
  const canSend = !!draft.trim() && !busy && !blocked && !asking
  const showAbsent = !absentRead && since > 0 && Date.now() - since > ABSENT_MIN_MS && items.some((e) => e.kind === 'it' && e.at > since)
  const absentCount = since ? items.filter((e) => e.kind === 'it' && e.at > since).length : 0

  /** 一条"现在"：把正在跑的那几件压成一行（两件以上才值得占这一行）。
      停在那儿等你选的**不算"在跑的事"** —— 把它的原文摘进这一行只会让人以为它在干活。 */
  const nowLine = useMemo(() => {
    const busyItems = runningItems.filter((e) => !e.ask)
    if (busyItems.length < 2) return ''
    return busyItems.map((e) => `${e.path} ${e.text.replace(/\s+/g, ' ').slice(0, 24)}`).join(' · ')
  }, [runningItems])

  const speakOverview = useCallback(() => {
    if (speaking === 'overview') { void stopSpeaking(); setSpeaking(null); return }
    const line = runningItems.length
      ? `${runningItems.length} 件在跑。` + runningItems.map((e) => `${e.path}：${e.text.replace(/\s+/g, ' ').slice(0, 40)}`).join('；')
      : '机器上没有人在干活。'
    void play(line, 1.06, 'overview')
  }, [runningItems, speaking, play])

  // 「你不在的时候」那一句：只问一次 LLM，回来的那句要念出来
  useEffect(() => {
    if (!showAbsent || digestAskedRef.current) return
    digestAskedRef.current = true
    const raw = items.filter((e) => e.kind === 'it' && e.at > since).slice(-8)
      .map((e) => `· ${e.path}：${e.text.slice(0, 400)}`).join('\n')
    summarizeText(token, raw)
      .then((s) => { if (s.summarized && s.text) setDigest(s.text) })
      .catch(() => { /* 没有摘要就只报条数，绝不编一句 */ })
  }, [showAbsent, items, since, token])

  useEffect(() => {
    if (!digest || digestSpokenRef.current) return
    digestSpokenRef.current = true
    void play(digest, 1.08, 'absent')
  }, [digest, play])

  // 把水位线推到"你看到过的最新一条"。**只在页面可见时推**。
  useEffect(() => {
    if (!events.length || document.hidden) return
    const maxAt = events.reduce((m, e) => Math.max(m, e.at), 0)
    if (maxAt <= 0) return
    try {
      if (maxAt > (Number(localStorage.getItem(SEEN_KEY)) || 0)) localStorage.setItem(SEEN_KEY, String(maxAt))
    } catch { /* 隐私模式 */ }
  }, [events])

  // ── 滚动：新的在底下，贴在底部就跟着走 ────────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const grew = items.length + (round ? 1 : 0) - lastLenRef.current
    lastLenRef.current = items.length + (round ? 1 : 0)
    if (grew <= 0) return
    if (atBottom) scrollToBottom()
    else setMissed((c) => c + grew)
  }, [items.length, round, atBottom, scrollToBottom])

  // 输入框跟着内容长高（到上限就内部滚）。textarea 不会自己长 ——
  // 不写这段的话，恢复回来的长草稿只露出上面两行，看着像被截断了。
  // 全屏编辑时不干预：那里它本来就该撑满。
  useEffect(() => {
    if (editing) return
    const ta = document.getElementById('walkie-draft') as HTMLTextAreaElement | null
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`
  }, [draft, editing])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    setAtBottom(nearBottom)
    if (nearBottom) setMissed(0)
    // 翻到顶了就多要点历史
    if (el.scrollTop < LOAD_MORE_PX) {
      setLimit((l) => {
        const i = PAGE_STEPS.indexOf(l)
        return i >= 0 && i < PAGE_STEPS.length - 1 ? PAGE_STEPS[i + 1] : l
      })
    }
  }, [])

  // ── 换聊天对象 ──────────────────────────────────────────
  const pick = (key: string) => { setTarget(key); setPicker(false) }

  /** 开选人面板。**每次都从"你现在对着的那个人"重新起头**，不沿用上一次的高亮 ——
      那个工作区可能已经在经典界面里被关掉了，留着的旧高亮会指向一个不存在的地方。 */
  const openPicker = useCallback(() => {
    setPickWs(findChannel(targetRef.current)?.project.name || '')
    setPicker(true)
  }, [findChannel])

  // 面板开着的时候，那个工作区被别处删了 —— 当场退到第一个，不留一个空右栏
  useEffect(() => {
    if (picker && pickWs && !projects.some((p) => p.name === pickWs)) setPickWs(projects[0]?.name || '')
  }, [picker, pickWs, projects])

  const pickProfile = useCallback((id: string) => {
    setDflt(id)
    try { localStorage.setItem(PROFILE_KEY, id) } catch { /* 隐私模式 */ }
  }, [])

  // 设置面板要用的东西**打开时才拿** —— 不开设置就不花这个钱
  useEffect(() => {
    if (!settings) return
    if (!profiles) void getConfigs(token).then(setProfiles).catch(() => setProfiles([]))
    void getVersion(token).then(setAbout).catch(() => { /* 拿不到就不显示，不编一个版本号 */ })
  }, [settings, profiles, token])

  /**
   * 点一条消息 = "我要回复给这个人"。
   *
   * 聊天软件里这是最自然的一下：你看着谁说的话，就是在跟谁说话。所以点它
   * 就把底下的收件人切过去（条子上的地址会跟着变，加上一下轻震和一闪）。
   * **展开全文是另一件事，有自己的按钮** —— 一个手势干两件事，就得开始猜了。
   */
  const replyTo = useCallback((key: string, id: string) => {
    setTarget(key)
    hapticTap()
    setFlash(id)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(''), 900)
  }, [])

  /** 在一个**已有工作区**里再开一个 channel（tmux 窗口），名字由你起 */
  const createChan = useCallback(async () => {
    const p = projects.find((x) => x.name === pickWs)
    const cwd = p?.channels[0]?.cwd
    const name = newChan.trim()
    if (!p || !cwd || !name) return
    try {
      // profile 来自设置里的"新会话默认模型" —— 建 channel 这一步不再问你要模型
      await createWorkspace(token, cwd, 'claude', dflt || undefined, { session: p.name, name })
      setAddingChan(false); setNewChan(''); setPicker(false); setJustCreated(name)
      setTimeout(() => { void pollStream() }, 1200)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [token, projects, pickWs, newChan, pollStream, dflt])

  const onCreated = useCallback(async (path: string, shellType: 'claude' | 'bash', profile?: string) => {
    setAdding(false)
    try {
      // 那个对话框里自己选过就用它的；没选就落到设置里的默认模型
      const r = await createWorkspace(token, path, shellType, profile || dflt || undefined)
      setJustCreated(r.name)
      setPicker(false)
      setTimeout(() => { void pollStream() }, 1200)   // 给它一点时间起来
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [token, pollStream, dflt])

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

  const composer = (full: boolean) => (
    <>
      {/* 为什么发不出去，必须在**看得见的地方**说 —— 全屏编辑时它盖住整屏，
          所以这条说明也得跟着进来，不然你看到的就是一个按不动的发送键。 */}
      {asking && <div className="walkie-blocked is-ask">它在等你选一个 —— 就在上面那条消息里。选完就能接着说话。</div>}
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
          placeholder={full ? '说点什么…' : '说点什么…'}
        />
        <input id={FILE_INPUT_ID} type="file" multiple hidden onChange={onPickFiles} />
        {/* 常驻的文件入口。它常驻是因为"这台机器上的文件"不是某一轮的产物 ——
            任何时刻你都想去看一眼，而它必须**永远在同一个地方**（同一个位置 = 不用找）。
            点开的是**你正对着的那个人**的目录：你已经选好了地方，文件就是那个地方的。 */}
        <button type="button" className="walkie-roundbtn" title="文件"
          onClick={() => openBrowser(cur?.channel.cwd || '')}>
          <IconFolder />
        </button>
        <button type="button" className="walkie-roundbtn" disabled={uploading}
          onClick={() => document.getElementById(FILE_INPUT_ID)?.click()} title="附件">
          {uploading ? '…' : <IconClip />}
        </button>
        {full ? null : (
          <>
            <button type="button" className="walkie-roundbtn" title="全屏编辑"
              onClick={() => { setEditing(true); setTimeout(() => document.getElementById('walkie-draft')?.focus(), 60) }}>
              <IconExpand />
            </button>
            <button type="button" className="walkie-sendbtn" disabled={!canSend}
              onClick={() => void deliver()} title="发送">
              <IconSend />
            </button>
          </>
        )}
      </div>
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
    </>
  )

  return (
    <div className="walkie-root">
      <div className="walkie-top">
        <button type="button" className="walkie-top-title" onClick={speakOverview}>
          <span className="walkie-dot" style={{ background: tmuxOk ? 'var(--nexus-success)' : 'var(--nexus-error)' }} />
          我的机器{runningCount > 0 ? ` · ${runningCount} 个在跑` : ''}
          {/* 只留"正在念"这个状态。以前这里还挂一个 🔊 提示"点标题会念出来" ——
              右上方就是喇叭键，同一件事说两遍。 */}
          {speaking === 'overview' ? ' ⏹' : ''}
        </button>
        <div className="walkie-top-actions">
          <button type="button" className="walkie-icon-btn" onClick={toggleMute} title={muted ? '开启声音' : '静音'}>
            <IconSound off={muted} />
          </button>
          <button type="button" className="walkie-icon-btn" onClick={() => setSettings(true)} title="设置">
            <IconGear />
          </button>
        </div>
      </div>

      {/* 钉住的两条：滚流的时候它们不动 —— 前者回答"有没有我不知道的事"，
          后者回答"机器现在在干什么"，两件都不该被滚走。 */}
      {showAbsent && (
        <div className="walkie-absent">
          <b>你不在的 {span(Date.now() - since)}里 · {absentCount} 件办完了</b>
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
      {nowLine && (
        <button type="button" className="walkie-nowline" onClick={speakOverview}>
          <span className="walkie-now-dot" />
          <span>{runningItems.length} 件在跑 · {nowLine}</span>
        </button>
      )}

      <div className="walkie-stage" ref={scrollRef} onScroll={onScroll}>
        <div className="walkie-stage-inner">
          {items.map((e) => {
            const mine = e.kind === 'you'
            const open = openIds.has(e.id)
            // 长到需要折的才折 —— 三行以内没有"扫不动"的问题，直接正常渲染。
            const long = e.text.length > PREVIEW_AT || e.text.includes('\n\n')
            const toggle = () => {
              if (!long) return
              setOpenIds((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n })
            }
            return (
              <div key={e.id}
                className={`walkie-msg ${mine ? 'mine' : 'theirs'}${e.ch === target ? ' is-target' : ''}${flash === e.id ? ' is-flash' : ''}`}>
                {/* 署名一行里有两个**各自说自己意思**的靶子（都约 32px 高）：
                      · 名字 = 这是谁 → 点它就把收件人切成这个人（回复给他）
                      · 路径 = 他在哪   → 点它就打开他的工作区（那个目录的文件）
                    正文是第三个命中区，管展开。三个手势各按"它写的是什么"分给谁，
                    没有一个是靠记的。 */}
                <div className="walkie-who">
                  <button type="button" className="walkie-who-who" onClick={() => replyTo(e.ch, e.id)}
                    title={mine ? `再跟 ${e.name} 说一句` : `回复 ${e.name}`}>
                    {!mine && <span className="walkie-who-dot" />}
                    <b>{mine ? '你' : e.name}</b>
                  </button>
                  <button type="button" className="walkie-who-where" onClick={() => openBrowser(e.cwd)}
                    title={`打开 ${e.cwd} 的文件`}>
                    {mine ? `${e.path} · ${e.name}` : e.path}
                  </button>
                  <span className="walkie-who-time">{stamp(e.at)}</span>
                  {e.running && <span className="walkie-who-live">在跑</span>}
                </div>
                <div className="walkie-body" onClick={toggle}>
                  {open || !long
                    ? <Markdown text={e.text} onOpen={(p) => void openFile(e.cwd, p)} />
                    : <Preview text={e.text} onOpen={(p) => void openFile(e.cwd, p)} />}
                  {speaking === e.id && <span className="walkie-at walkie-speaking">🔊 正在念</span>}
                </div>
                {e.ask && (
                  <AskCard key={e.ask.id} ask={e.ask}
                    onPick={(picks) => void answer(e.project, e.window, picks)} />
                )}
              </div>
            )
          })}

          {round && (
            <div className={`walkie-round${round.state === 'waiting' ? ' is-live' : ''}`}>
              <div className="walkie-card-label">
                <span className="walkie-round-head">
                  {round.state === 'waiting'
                    ? <span className="walkie-rec"><i />正在跑</span>
                    : round.state === 'done' ? '它说' : '没跑成'}
                  <em className="walkie-at">{displayPath(round.project, projects)} · {stamp(round.startedAt)}</em>
                </span>
                {round.state === 'waiting' && <span className="walkie-at">{elapsed}s</span>}
              </div>

              <Markdown text={round.sent} className="walkie-said"
                onOpen={(p) => void openFile(findChannel(round.key)?.channel.cwd || '', p)} />

              {round.state === 'waiting' && (round.steps.length ? story(round.steps.slice(-18))
                : <p className="walkie-waiting-line">已经投递，等它开口…</p>)}
              {round.state === 'waiting' && (
                <div className="walkie-now">
                  <span className="walkie-now-dot" />
                  <span className="walkie-now-text">
                    {round.now ? `${NOW_VERB[round.now.kind] || '正在处理'}${round.now.kind === 'think' ? '…' : ` ${round.now.label}`}` : '正在连接…'}
                  </span>
                </div>
              )}

              {/* 它在这一轮里停下来问你 —— 选项就长在卡片上，不用切到别处去答 */}
              {round.state === 'waiting' && round.ask && (
                <AskCard key={round.ask.id} ask={round.ask}
                  onPick={(picks) => void answer(round.project, round.window, picks)} />
              )}

              {round.state === 'done' && round.reply?.text && (
                <Markdown text={fold(round.reply.text)}
                  onOpen={(f) => void openFile(findChannel(round.key)?.channel.cwd || '', f)} />
              )}
              {round.state === 'done' && !round.reply?.text && <p className="walkie-dim">（这一轮没有说话，可能只动了文件）</p>}
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
                  {round.reply?.text && round.reply.text.length > FOLD_AT && (
                    <button type="button" className="walkie-mini"
                      onClick={() => openBrowser(findChannel(round.key)?.channel.cwd || '')}>看长文去文件</button>
                  )}
                </div>
              )}
              {(round.err || round.state === 'timeout') && <p className="walkie-hint-bad">{round.err}</p>}
            </div>
          )}

          {/* 冷启动的空态是**第一印象**，不能是一句"没有数据"。
              这里要说清的一件事：这条流接的是整台机器 —— 包括你没通过手机下的那些活。 */}
          {!items.length && !round && !loadErr && (
            <div className="walkie-quiet">
              这台机器上还没有人说过话。
              <em>你白天在终端里开的那些窗口，说到的话也会出现在这里 —— 不用从手机上派活也看得见。</em>
            </div>
          )}
        </div>
      </div>

      {/* 新消息在你看历史的时候来了 —— 别把你拽下去，给一个回去的口子 */}
      {missed > 0 && (
        <button type="button" className="walkie-missed" onClick={() => { setMissed(0); scrollToBottom(true) }}>
          ↓ {missed} 条新消息
        </button>
      )}

      {loadErr ? (
        <div className="walkie-error">
          <b>连不上这台机器</b>
          <span>{loadErr}</span>
          <button type="button" className="walkie-mini" onClick={() => void pollStream()}>重试</button>
        </div>
      ) : err ? (
        <div className="walkie-error"><span>{err}</span></div>
      ) : null}
      {blocked && <div className="walkie-blocked">这一格不是 Claude —— 发过去会被当命令执行。点下面的地址换一个。</div>}

      <div className="walkie-compose">
        {composer(false)}
        <button type="button" className={`walkie-target${blocked ? ' is-warn' : ''}`}
          onClick={openPicker}>
          {blocked && '⚠ '}
          <span className="walkie-target-path">{targetLabel}</span>
          <IconChevron />
        </button>
      </div>

      {/* 全屏编辑：手机上一条小框改长文很难受。微信的做法是对的 ——
          默认一小条，旁边一个键摊开成全屏，改完收回来。文本是同一份状态，不存在同步问题。 */}
      {editing && (
        <div className="walkie-full-edit">
          <div className="walkie-compose walkie-compose-full">{composer(true)}</div>
          {/* 三个键都在底边：收起在左、发送在右 —— 竖屏单手也够得着。
              中间那行"寄给谁"是可以直接改的，不用先收起来。 */}
          <div className="walkie-full-bar">
            <button type="button" className="walkie-mini" onClick={() => setEditing(false)}>收起</button>
            <button type="button" className="walkie-full-who" onClick={openPicker}>
              寄给 {targetLabel}
              <IconChevron />
            </button>
            <button type="button" className="walkie-sendbtn" disabled={!canSend}
              onClick={() => void deliver()} title="发送">
              <IconSend />
            </button>
          </div>
        </div>
      )}

      {/* 选人：左边工作区、右边频道。一屏看清"这台机器上有哪些地方、每个地方有谁" */}
      {picker && (
        <div className="walkie-sheet" onClick={() => setPicker(false)}>
          <div className="walkie-sheet-body" onClick={(e) => e.stopPropagation()}>
            <div className="walkie-sheet-title">寄给谁</div>
            <div className="walkie-panes">
              <div className="walkie-pane-ws">
                {projects.map((p) => (
                  <button key={p.name} type="button"
                    className={`walkie-ws${p.name === pickWs ? ' is-on' : ''}`}
                    onClick={() => setPickWs(p.name)}>
                    <span className="walkie-ws-path">{p.path || p.name}</span>
                    <span className="walkie-ws-n">{p.channels.filter((c) => c.kind === 'claude').length}</span>
                  </button>
                ))}
              </div>
              <div className="walkie-pane-ch">
                {(projects.find((p) => p.name === pickWs)?.channels ?? []).map((c) => {
                  const key = `${pickWs}:${c.index}`
                  return (
                    <button key={key} type="button"
                      className={`walkie-ch${key === target ? ' is-on' : ''}`}
                      onClick={() => pick(key)}>
                      <span className="walkie-ch-name">{c.name}</span>
                      <span className="walkie-ch-st">
                        {c.kind !== 'claude' ? '不是 Claude' : c.status === 'working' ? '在跑' : '空闲'}
                      </span>
                    </button>
                  )
                })}
                {addingChan ? (
                  <div className="walkie-newchan">
                    <input autoFocus value={newChan} onChange={(e) => setNewChan(e.target.value)}
                      placeholder="叫它什么" onKeyDown={(e) => { if (e.key === 'Enter') void createChan() }} />
                    <button type="button" className="walkie-mini" disabled={!newChan.trim()} onClick={() => void createChan()}>建立</button>
                  </div>
                ) : (
                  <button type="button" className="walkie-addch" onClick={() => setAddingChan(true)}>＋ 新增 channel</button>
                )}
              </div>
            </div>
            <button type="button" className="walkie-addws" onClick={() => { setAdding(true); setPicker(false) }}>
              ＋ 新增工作区
            </button>
          </div>
        </div>
      )}

      {/* 设置。它是一个**容器** —— 现在只有一件（新建会话用哪个模型），
          以后的功能性设置都往这里放，主屏上不再长按钮。 */}
      {settings && (
        <div className="walkie-sheet" onClick={() => setSettings(false)}>
          <div className="walkie-sheet-body" onClick={(e) => e.stopPropagation()}>
            <div className="walkie-sheet-head">
              <span className="walkie-sheet-title">设置</span>
              <button type="button" className="walkie-mini" onClick={() => setSettings(false)}>完成</button>
            </div>

            <div className="walkie-set-h">新建会话用哪个模型</div>
            <div className="walkie-opts">
              <button type="button" className={`walkie-opt${dflt ? '' : ' is-on'}`}
                onClick={() => pickProfile('')}>
                <span className="walkie-opt-name">随服务端默认</span>
                <span className="walkie-opt-id">不指定 profile</span>
              </button>
              {(profiles || []).map((p) => (
                <button key={p.id} type="button" className={`walkie-opt${p.id === dflt ? ' is-on' : ''}`}
                  onClick={() => pickProfile(p.id)}>
                  <span className="walkie-opt-name">{p.label}</span>
                  <span className="walkie-opt-id">{p.id}</span>
                </button>
              ))}
            </div>
            <div className="walkie-set-note">
              {profiles === null ? '读取中…'
                : profiles.length ? '新建工作区 / channel 时用它；那个对话框里自己选过就以你选的为准。'
                  : '这台机器上还没有配置过 profile。'}
            </div>

            <div className="walkie-set-h">关于</div>
            <div className="walkie-set-note">
              Nexus {about?.current || '—'}
              {about && !about.clean ? '（有未提交的改动）' : ''}
            </div>
          </div>
        </div>
      )}

      {adding && (
        <Suspense fallback={null}>
          <WorkspaceSelector token={token} onClose={() => setAdding(false)} onConfirm={onCreated} />
        </Suspense>
      )}

      {/* 文件浏览器：宽屏（折叠屏）像经典版那样**左右并排** —— 左边文件树快速跳，
          右边看内容；树可以收掉，收起后内容占满。窄屏还是全屏一张。
          复用的是经典界面那套 embedded / overlay / hideSidebar，不是另写一个。 */}
      {browser && (
        <Suspense fallback={null}>
          {wide ? (
            <div className="walkie-browse-wide">
              <WorkspaceBrowser embedded={tree} overlay={!tree} hideSidebar={!tree}
                token={token} title="工作目录" initialPath={browser.root}
                onClose={() => setBrowser(null)} ref={browserRef} />
              <button type="button" className="walkie-tree-toggle" onClick={() => setTree((v) => !v)}
                title={tree ? '收起文件树' : '展开文件树'}>{tree ? '◀' : '▶'}</button>
            </div>
          ) : (
            <WorkspaceBrowser token={token} title="工作目录" initialPath={browser.root}
              onClose={() => setBrowser(null)} ref={browserRef} />
          )}
        </Suspense>
      )}
    </div>
  )
}

/**
 * 它在问你 —— 选项就在消息里，点一下就是回答。
 *
 * 为什么它必须长在这一屏上：在终端里这道题是**方向键 + 回车**，手机上根本没有那两个键。
 * 不把它接出来，你看到的就是一句"你要 A 还是 B？"然后无处可答 —— 只能打字描述一个
 * 位置（"第一个"），而那正是我们想让这一屏消灭的那类输入。
 *
 * 选项文字**原样送回去**（label 是它自己写的），界面不改写、不翻译、不缩略。
 */
function AskCard({ ask, onPick }: { ask: Ask; onPick: (picks: number[][]) => void }) {
  const [sel, setSel] = useState<number[][]>(() => ask.questions.map(() => []))
  const [sent, setSent] = useState(false)
  const many = ask.questions.length > 1
  const multi = many || ask.questions.some((q) => q.multiSelect)

  const tap = (qi: number, oi: number) => {
    if (sent) return
    const q = ask.questions[qi]
    if (!multi) {
      // 一道题、单选 = 点一下就是答复。没有"确认"这一步 —— 选择就是你按的那一下。
      const next = ask.questions.map((_, i) => (i === qi ? [oi] : []))
      setSel(next); setSent(true); onPick(next)
      return
    }
    setSel((cur) => cur.map((c, i) => {
      if (i !== qi) return c
      return q.multiSelect
        ? (c.includes(oi) ? c.filter((x) => x !== oi) : [...c, oi])
        : [oi]
    }))
  }

  return (
    <div className="walkie-ask">
      {ask.questions.map((q, qi) => (
        <div className="walkie-ask-q" key={qi}>
          {many && <p className="walkie-ask-title">{q.header || `第 ${qi + 1} 个问题`}</p>}
          {q.question && <p className="walkie-ask-text">{q.question}</p>}
          {q.options.map((o, oi) => (
            <button key={oi} type="button"
              className={`walkie-choice${sel[qi]?.includes(oi) ? ' is-on' : ''}`}
              onClick={() => tap(qi, oi)}>
              <span className="walkie-choice-label">{o.label}</span>
              {o.description && <span className="walkie-choice-desc">{o.description}</span>}
            </button>
          ))}
          {q.multiSelect && <span className="walkie-ask-hint">可选多个</span>}
        </div>
      ))}
      {multi && (
        <button type="button" className="walkie-ask-go" disabled={sent || !sel.some((c) => c.length)}
          onClick={() => { setSent(true); onPick(sel) }}>
          {sent ? '已送出' : '就这样'}
        </button>
      )}
      {!multi && sent && <span className="walkie-ask-hint">已送出，等它接着办…</span>}
    </div>
  )
}

/** 这一轮发生在哪个目录 —— 卡片头上要写的不是 tmux 的名字，是那个文件夹 */
function displayPath(projectName: string, projects: WalkieProject[]): string {
  return projects.find((x) => x.name === projectName)?.path || projectName
}
