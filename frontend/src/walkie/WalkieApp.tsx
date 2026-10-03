// walkie/WalkieApp.tsx — 对讲机模式的根组件
//
// 【新版面：三个带】从上到下
//   1. 状态条   —— 应用级操作（静音 / 文件 / 输入法 / 经典）
//   2. 屏       —— 这一轮的通话记录：你的话、他的动作流、他的回复
//   3. 台面     —— 调台条（两行，工作区 / Agent）+ 讲话键
//
// 【为什么把旋钮拆了】见 Tuner.tsx 的抬头。一句话：同心双圈是十几个无名刻度，
// 你只能盲转找名字；而这一屏真正的主角（按住说话）被挤在中间一个 90px 的圆里，
// 还要和两个圈抢指针。现在讲话键占满整个拇指区，选频道退成两行**可读**的条子。
//
// 【手势不再有歧义】老版本圆心是一个圆两种手势（按住说话 / 轻点发送），要靠
// 「按下不到 300ms 且没录到音频」去猜意图，还得在按下瞬间把草稿偷偷存起来，
// 因为"开始录音"会清空输入框 —— 一个圆扛两件事，代价是这些补丁。
// 现在**有草稿的时候按键区直接变成两个键**：按住重说 / 点发送。没有猜测。
//
// 【状态机】
//   idle ──按住──▶ listening ──松手──▶ transcribing ──▶ review ──发送──▶ waiting ──答完──▶ reply
//                                                        ▲                                │
//                                         按住重说 / 清空 │◀───────── 再问一句 ───────────┘

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { WorkspaceBrowserHandle } from '../WorkspaceBrowser'
import Tuner from './Tuner'
import {
  getChannels, getReply, refineText, sendPrompt, summarizeText,
  type ChannelList, type ReplyState, type WalkieStep, type WalkieNow,
} from './api'
import {
  dictationSupported, explainDictationError, startDictation,
  type Dictation, type DictationStatus,
} from './speech'
import {
  attachAudioUnlock, hapticDown, hapticSnap, hapticTick, isMuted,
  land, roger, setMuted as setMutedFeedback, squelch, whoosh,
} from './feedback'
import { speak, stopSpeaking } from './tts'
import ReplyText from './replyLinks'
import './walkie.css'

const WorkspaceBrowser = lazy(() => import('../WorkspaceBrowser'))

// listening = 正在录音（边说边出字）；transcribing = 松手后等最后一段落地（约 1.5 秒）
type Phase = 'idle' | 'listening' | 'transcribing' | 'review' | 'waiting' | 'reply'
type Speaking = 'summary' | 'full' | null

interface CacheEntry { reply: ReplyState; summary: string; sent: string }

const POLL_MS = 1200
const WAIT_LIMIT_MS = 10 * 60_000
const REFINE_WAIT_MS = 3000
const LEVEL_BARS = 30
/** 超过这么多字就折叠。手机上这个长度约 20 行，再多就成了一堵墙。 */
const FOLD_AT = 700

/** 折叠时在段落边界下刀 —— 从"它不是需求文档，是—…"这种半句上截断，看着像坏了。 */
function fold(text: string): string {
  if (text.length <= FOLD_AT) return text
  const cut = text.slice(0, FOLD_AT)
  const nl = cut.lastIndexOf('\n')
  return (nl > FOLD_AT * 0.55 ? cut.slice(0, nl) : cut) + '…'
}

// 草稿落盘。手机锁屏、切走再回来、甚至 WebView 被系统回收，打了一半的字都不该丢。
// 按频道各存一份：切走再切回来，那一格自己的半成品还在。
const STORE_KEY = 'nexus_walkie_state'
interface DraftState { draft: string; raw: string; refined: boolean }
interface Persisted { last?: string; drafts: Record<string, DraftState> }

const IconMic = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)
const IconSend = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12h15M13 6l6 6-6 6" />
  </svg>
)
const IconKeyboard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
  </svg>
)
const IconSound = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    {off ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
  </svg>
)
const IconFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

/** 动作流每一行的图标。不用 emoji：不同 ROM 的字形差异太大，排在一起会歪。 */
const STEP_ICON: Record<string, string> = {
  bash: '❯', read: '◫', edit: '✎', search: '⌕', task: '⧉', todo: '☑', web: '⌘', think: '◌', tool: '⚙',
}

const EMPTY_BARS = () => new Array(LEVEL_BARS).fill(0)

export default function WalkieApp({ token, onExit }: { token: string; onExit?: () => void }) {
  const [data, setData] = useState<ChannelList | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [projIdx, setProjIdx] = useState(0)
  const [chanIdx, setChanIdx] = useState(0)

  const [phase, setPhase] = useState<Phase>('idle')
  const [recSec, setRecSec] = useState(0)
  const [live, setLive] = useState('')              // 边说边出字的已确定部分
  const [micReady, setMicReady] = useState(false)   // 麦克风是否已打开（首次会弹系统权限框）
  const [bars, setBars] = useState<number[]>(EMPTY_BARS)
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [rawText, setRawText] = useState('')
  const [refined, setRefined] = useState(false)
  const [refining, setRefining] = useState(false)
  const [sent, setSent] = useState('')
  const [reply, setReply] = useState<ReplyState | null>(null)
  const [steps, setSteps] = useState<WalkieStep[]>([])
  /** 此刻正在做的那件事（状态，不是「做过的事」） */
  const [now, setNow] = useState<WalkieNow | null>(null)
  const [stage, setStage] = useState('')
  const [paneTail, setPaneTail] = useState<string[]>([])
  const [hint, setHint] = useState('')
  const [summary, setSummary] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [err, setErr] = useState('')
  const [speaking, setSpeaking] = useState<Speaking>(null)
  /** 长回复先折起来。摘要没落地时（比如切过来回看上一轮）也是这个待遇 ——
      不折的话，一条长回复会把整块屏占满，"这是谁说的话"都看不见了。 */
  const [expanded, setExpanded] = useState(false)
  /** 你刚才说的那句默认折三行 —— 它是上一句，不是这一屏的主角。点一下摊开。 */
  const [mineOpen, setMineOpen] = useState(false)
  const [muted, setMutedState] = useState(() => isMuted())
  const [browser, setBrowser] = useState<{ root: string; file?: string } | null>(null)

  const projects = useMemo(() => data?.projects ?? [], [data])
  const project = projects[projIdx]
  const channel = project?.channels[chanIdx]
  const chanKey = project && channel ? `${project.name}:${channel.index}` : ''

  // 回调里要读最新值，用 ref 兜住闭包
  const draftRef = useRef('')
  const chanKeyRef = useRef('')
  const dictRef = useRef<Dictation | null>(null)
  const holdRef = useRef(false)
  const refineP = useRef<Promise<unknown> | null>(null)
  const cacheRef = useRef(new Map<string, CacheEntry>())
  const pollsRef = useRef(new Map<string, number>())
  const recStartedRef = useRef(0)
  const recSecRef = useRef(0)
  const barsRef = useRef<number[]>(EMPTY_BARS())
  const lastLevelAt = useRef(0)
  const liveRef = useRef('')
  const deliverRef = useRef<((override?: string) => void) | null>(null)
  // peekInto 要能在"恢复一轮还在干活的过程"时把轮询接回来，但 startPoll 定义在它后面
  // （依赖 autoSpeak）。用 ref 兜一层，别为了这个把整个组件的定义顺序翻过来。
  const startPollRef = useRef<((key: string, proj: string, win: number, sent: string, offsetMs?: number) => void) | null>(null)
  const storeRef = useRef<Persisted>({ drafts: {} })
  const draftStateRef = useRef<DraftState>({ draft: '', raw: '', refined: false })
  const stageRef = useRef<HTMLDivElement | null>(null)
  const browserRef = useRef<WorkspaceBrowserHandle | null>(null)
  draftRef.current = draft
  chanKeyRef.current = chanKey
  liveRef.current = live
  draftStateRef.current = { draft, raw: rawText, refined }

  const persist = useCallback(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(storeRef.current)) } catch { /* 隐私模式 */ }
  }, [])

  /** 把当前草稿归到某个频道名下（空的就删掉，别在盘上留一堆空壳） */
  const stashDraft = useCallback((key: string) => {
    if (!key) return
    const cur = draftStateRef.current
    if (cur.draft.trim()) storeRef.current.drafts[key] = cur
    else delete storeRef.current.drafts[key]
  }, [])

  const clearPoll = useCallback((key: string) => {
    const t = pollsRef.current.get(key)
    if (t !== undefined) { clearInterval(t); pollsRef.current.delete(key) }
  }, [])

  // ── 频道清单 ─────────────────────────────────────────────
  const reload = useCallback(async (keep: boolean) => {
    try {
      const d = await getChannels(token)
      setData(d)
      setLoadErr('')
      if (!keep || !d.projects.length) { setProjIdx(0); setChanIdx(0) }
      else setProjIdx((pi) => Math.min(pi, d.projects.length - 1))
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [token])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Persisted
        storeRef.current = { last: parsed.last, drafts: parsed.drafts || {} }
      }
    } catch { /* 坏的就当作没有 */ }
  }, [])

  useEffect(() => { void reload(false) }, [reload])
  useEffect(() => attachAudioUnlock(), [])
  useEffect(() => () => {
    for (const t of pollsRef.current.values()) clearInterval(t)
    pollsRef.current.clear()
    void stopSpeaking()
  }, [])

  // 录音计时：只在麦克风真的打开之后才走 —— 权限弹窗那几秒不算录音时间
  useEffect(() => {
    if (phase !== 'listening' || !micReady) return
    recStartedRef.current = Date.now()
    recSecRef.current = 0
    setRecSec(0)
    const t = window.setInterval(() => {
      recSecRef.current = (Date.now() - recStartedRef.current) / 1000
      setRecSec(recSecRef.current)
    }, 200)
    return () => clearInterval(t)
  }, [phase, micReady])

  /** 转到哪一格，就把那一格**上一次答了什么**取回来铺在屏上 ——
      不用重问，也不用面对一块空白。开场那一次也走这条路。 */
  const peekInto = useCallback((projName: string, win: number, key: string) => {
    const cached = cacheRef.current.get(key)
    if (cached) {
      setSent(cached.sent); setReply(cached.reply); setSummary(cached.summary); setPhase('reply')
      return
    }
    getReply(token, projName, win, true).then((r) => {
      if (chanKeyRef.current !== key || cacheRef.current.has(key)) return
      // 【还在干活那一轮】不能拿 text 当门槛 —— running 时 text 本来就是空的
      // （它还在说），只有 steps 和 paneTail。老代码在这里 `if (!r.text) return`，
      // 于是切走再切回来，一整屏的动作流全没了，只剩台面上一个"工作中"（真机反馈）。
      // 恢复的是**过程**：把这句话、动作流、阶段文案、已经走了多少秒都摆回去，
      // 并把轮询接回来 —— 否则界面会停在"等待中"再也不动。
      if (r.state === 'running') {
        const said = r.sent || ''
        setSent(said); setReply(null); setSummary(''); setErr('')
        setSteps(r.steps || []); setNow(r.now ?? null); setPaneTail(r.paneTail || []); setHint(r.hint || '')
        setStage(r.stage || ''); setPhase('waiting')
        startPollRef.current?.(key, projName, win, said, r.elapsedMs || 0)
        return
      }
      // 答完了（哪怕这一轮一个字没说、只动了文件）：恢复成回复态。
      // 空正文也认 —— 卡片自己会说「（这一轮没有说话，可能只动了文件）」。
      cacheRef.current.set(key, { reply: r, summary: '', sent: r.sent || '' })
      setSent(r.sent || ''); setReply(r); setSteps(r.steps || []); setPhase('reply'); setExpanded(false)
    }).catch(() => { /* peek 失败无所谓 */ })
  }, [token])

  // 首帧：先试"上次停在哪一格"，没有就落到该项目的活动窗口（用户上次在用的那个）
  const initedRef = useRef(false)
  useEffect(() => {
    if (initedRef.current || !projects.length) return
    initedRef.current = true
    const last = storeRef.current.last
    if (last) {
      for (let pi = 0; pi < projects.length; pi++) {
        const ci = projects[pi].channels.findIndex((c) => `${projects[pi].name}:${c.index}` === last)
        if (ci >= 0) {
          setProjIdx(pi); setChanIdx(ci)
          const saved = storeRef.current.drafts[last]
          if (saved?.draft) {
            setDraft(saved.draft); setRawText(saved.raw); setRefined(saved.refined); setPhase('review')
          } else {
            peekInto(projects[pi].name, projects[pi].channels[ci].index, last)
          }
          return
        }
      }
    }
    const act = projects[0].channels.findIndex((c) => c.active)
    const ci = act >= 0 ? act : 0
    setChanIdx(ci)
    if (projects[0].channels[ci]) {
      peekInto(projects[0].name, projects[0].channels[ci].index, `${projects[0].name}:${projects[0].channels[ci].index}`)
    }
  }, [projects, peekInto])

  useEffect(() => {
    const n = projects[projIdx]?.channels.length ?? 0
    if (n && chanIdx > n - 1) setChanIdx(0)
  }, [projects, projIdx, chanIdx])

  // 草稿一变就落盘（防抖 400ms）。锁屏或 WebView 被回收之后回来，字还在。
  useEffect(() => {
    const t = setTimeout(() => {
      if (!chanKey) return
      stashDraft(chanKey)
      storeRef.current.last = chanKey
      persist()
    }, 400)
    return () => clearTimeout(t)
  }, [draft, rawText, refined, chanKey, stashDraft, persist])

  // 屏滚到底：内容**从讲话键往上长**，所以新东西永远在下面 ——
  // 不跟过去的话，你看到的是上一段，而"他答完了"这件事就藏在屏幕下面。
  // 按"内容身份"判断，而不是每次渲染都滚 —— 否则你想往上翻着看，会被一直拽回去。
  const scrolledSig = useRef('')
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    if (phase !== 'waiting' && phase !== 'reply') return
    const sig = `${phase}|${sent}|${reply?.text?.length ?? 0}|${steps.length}|${paneTail.length}`
    if (sig === scrolledSig.current) return
    scrolledSig.current = sig
    el.scrollTop = el.scrollHeight
  }, [phase, sent, reply, steps, paneTail])

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

  // ── 语音 ────────────────────────────────────────────────
  const startTalk = useCallback(async () => {
    if (dictRef.current || phase === 'waiting') return
    holdRef.current = true
    squelch()                       // 按下就有回音：这一下是真的按下去了
    hapticDown()
    // 首次按下会弹系统的麦克风权限框，getUserMedia 要等用户点完才 resolve。
    // 那几秒界面必须给出反馈，否则就是一个「按了没反应」的死按钮。
    setMicReady(false); setPhase('listening')
    void stopSpeaking(); setSpeaking(null); setErr(''); setNotice('')
    setRecSec(0); setDraft(''); setRawText(''); setRefined(false)
    // 注意：**不清 reply**。他上一轮说的话留在屏上（暗一档、折三行）——
    // 你在回他，不是在对空气说话；发出去的那一刻它才让位给这一轮。
    setSent(''); setSummary(''); setStage(''); setSteps([]); setNow(null); setExpanded(false); setMineOpen(false)
    setLive(''); setBars(EMPTY_BARS()); barsRef.current = EMPTY_BARS()
    try {
      const d = await startDictation(token, {
        onStatus: (s: DictationStatus) => {
          if (s === 'recording') { setMicReady(true); if (holdRef.current) setPhase('listening') }
        },
        onLive: (t) => setLive(t),
        onLevel: (v) => {
          // 每 85ms 一次回调，直接 setState 会把主线程打满；压到 ~9fps 足够画波形
          const now = performance.now()
          if (now - lastLevelAt.current < 110) return
          lastLevelAt.current = now
          barsRef.current = [...barsRef.current.slice(1), Math.min(1, v * 9)]
          setBars(barsRef.current)
        },
        onError: (m) => setErr(explainDictationError(m)),
      })
      // 手指在录音器起来的这段时间里就松开了（按了一下而不是按住）——
      // 交给 endTalk 收尾：没录到内容就明确说"按太短"，不猜。
      if (!holdRef.current) { await d.stop().catch(() => ''); setPhase('idle'); return }
      dictRef.current = d
      setPhase('listening')
    } catch (e) {
      holdRef.current = false
      dictRef.current = null
      setPhase('idle')
      setErr(explainDictationError(e instanceof Error ? e.message : String(e)))
    }
  }, [phase, token])

  /**
   * 松手后自动精炼。**输入法那条路也走同一个函数** —— 见 onDraftInput。
   */
  const refineNow = useCallback((raw: string) => {
    setRefining(true)
    const p = refineText(token, raw)
      .then((r) => {
        if (r.text && r.text !== raw) land()   // 稿子被换掉了 —— 得让你注意到
        setDraft((cur) => (cur === raw ? r.text : cur)); setRefined(r.refined)
      })
      .catch(() => { /* 精炼失败就保持原文 */ })
      .finally(() => setRefining(false))
    refineP.current = p
  }, [token])

  const endTalk = useCallback(async () => {
    const d = dictRef.current
    if (!d) return
    dictRef.current = null
    const recSecs = recSecRef.current
    setPhase('transcribing')
    let text = ''
    let failure = ''
    try { text = await d.stop() } catch (e) { failure = e instanceof Error ? e.message : String(e) }
    // 收尾那一段没回来时，用已经逐段转出来的文字兜底 —— 总比一个字都不给强
    const final = (text || liveRef.current || '').trim()
    hapticTick()                    // 松手：我说完了
    if (!final) {
      setPhase('idle')
      setNotice(failure
        ? explainDictationError(failure)
        : recSecs < 0.6
          ? `按住才录了 ${recSecs.toFixed(1)} 秒 —— 说一句话再松手。`
          : `录了 ${recSecs.toFixed(1)} 秒，但没识别出内容。再说一次，或点 ⌨ 用输入法。`)
      return
    }
    roger()                         // 电台的"通话结束"音。听得见的"这一轮我说完了"
    setRawText(final); setDraft(final); setPhase('review')
    refineNow(final)
  }, [token, refineNow])

  /**
   * 输入框里进来的字。**输入法语音键走的就是这里。**
   *
   * 为什么值得单独处理：微信输入法/搜狗那类"按住说话"的识别质量比本机模型好，
   * 而我们**没办法**从 App 里去按别人键盘上的麦克风（输入法是另一个进程，
   * 它的按钮不对我们开放）。所以正解不是再做一个更差的语音输入，而是
   * **让用输入法说出来的话也拿到这一屏的全部好处**：一样自动精炼、一样落到同一条流程里。
   *
   * 判据是"一次性塞进来一长串"：语音输入是一次提交整句，打字是一下一个字符。
   * 打字绝不会一次 +6 个字符，所以这条几乎不会误伤。万一误伤也能点「还原原文」。
   */
  const onDraftInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    const burst = next.length - draft.length
    setDraft(next)
    if (burst >= 6 && next.trim()) {
      const t = next.trim()
      setRawText(t)
      refineNow(t)
    }
  }

  const onPttDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    void startTalk()
  }
  const onPttUp = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    if (dictRef.current) { void endTalk(); return }
    holdRef.current = false          // 录音器还没起来，交给 startTalk 的续行
  }

  /** 兜底：调起输入法（含它的语音键），走同一条文本框 */
  const focusDraft = () => {
    setNotice('')
    setPhase((p) => (p === 'listening' || p === 'transcribing' ? p : 'review'))
    setTimeout(() => document.getElementById('walkie-draft')?.focus(), 60)
  }

  // ── 播报 ────────────────────────────────────────────────
  // 记"在播哪一个"，而不是一个笼统的布尔 —— 否则播摘要时"全文"按钮也会变成"停止"，
  // 想从摘要切到全文得先停一次（老版本就是这么联动的）。
  const play = useCallback(async (text: string, rate: number, which: Speaking) => {
    if (!text || !which) return
    await stopSpeaking()               // 想切就直接切过去，不用先停
    setSpeaking(which)
    try { await speak(text, { rate }) } finally { setSpeaking((cur) => (cur === which ? null : cur)) }
  }, [])
  const hush = () => { void stopSpeaking(); setSpeaking(null) }

  const autoSpeak = useCallback(async (text: string, key: string) => {
    if (!text) return
    try {
      const s = await summarizeText(token, text)
      // 摘要降级时后端给的是"截前 120 字"，那**不是摘要** —— 它是同一段话的残句
      // （截在句子中间，屏上还会把回复显示两遍，真机上就是这么看到的）。
      // 所以只认真正的摘要：没有就没有，回复自己就是那段话。
      const real = s.summarized ? s.text : ''
      const entry = cacheRef.current.get(key)
      if (entry) entry.summary = real
      if (chanKeyRef.current !== key) return    // 已经切走了就别突然出声
      setSummary(real)
      // 没有摘要时要不要自动读？回复本来就短（它现在只是他最后那段话）就直接读；
      // 太长就不出声了 —— 自动念一长段是最烦人的那种"贴心"。
      const say = real || (text.length <= 400 ? text : '')
      if (!say) return
      await play(say, real ? 1.12 : 1.06, real ? 'summary' : 'full')
    } catch { /* 摘要失败就静默，用户还能点「▶ 全文」 */ }
  }, [token, play])

  // ── 发送 + 追回复 ────────────────────────────────────────
  const startPoll = useCallback((key: string, projName: string, win: number, sentText: string, offsetMs = 0) => {
    clearPoll(key)
    // offsetMs：接管一轮**已经跑了很久**的追踪时（切走再切回来），秒表要接着走，
    // 不能从 0 重新数 —— 那样你会看见"45s"跳回"0s"，像是它重头开始了。
    const started = Date.now() - offsetMs
    const tick = async () => {
      let r: ReplyState
      try {
        r = await getReply(token, projName, win)
      } catch { return }                       // 网络抖一下就下轮再试
      if (chanKeyRef.current === key) {
        setElapsed(Math.round((Date.now() - started) / 1000))
        if (r.stage) setStage(r.stage)
        setPaneTail(r.paneTail || [])
        setHint(r.hint || '')
        if (r.steps) setSteps(r.steps)
        setNow(r.now ?? null)
      }
      if (r.done) {
        clearPoll(key)
        cacheRef.current.set(key, { reply: r, summary: '', sent: sentText })
        if (chanKeyRef.current === key) {
          setReply(r); setPhase('reply'); setPaneTail([]); setHint(''); setNow(null); setExpanded(false)
          if (r.steps) setSteps(r.steps)
          roger()                                // 他答完了 —— 也是这一声
          void autoSpeak(r.text, key)
        }
        return
      }
      // 后端判定这一轮没戏了（消息没进会话 / 超时）—— 立刻收尾并说明原因，
      // 别让界面一直转到自己的 10 分钟上限
      if (r.state === 'timeout') {
        clearPoll(key)
        if (chanKeyRef.current === key) {
          setErr(r.error || '没等到结果')
          setPhase('review')
        }
        return
      }
      if (Date.now() - started > WAIT_LIMIT_MS) {
        clearPoll(key)
        if (chanKeyRef.current === key) {
          setErr('等了 10 分钟还没答完。切到经典界面看看它卡在哪了。')
          setPhase('review')
        }
      }
    }
    pollsRef.current.set(key, window.setInterval(tick, POLL_MS))
    void tick()
  }, [token, clearPoll, autoSpeak])
  startPollRef.current = startPoll

  const deliver = useCallback(async (override?: string) => {
    if (!project || !channel) return
    if (channel.kind !== 'claude') {
      setErr(`「${channel.name}」里跑的不是 Claude。这句话发过去会被当命令执行，所以拦住了。`)
      return
    }
    // 精炼还没落地就等一下（最多 3 秒）；宁可发原文，也不让你干等
    if (refining) await Promise.race([refineP.current, new Promise((r) => setTimeout(r, REFINE_WAIT_MS))])
    const text = (override ?? draftRef.current).trim()
    if (!text) return

    whoosh()                                  // 送出去了
    hapticSnap()
    setErr(''); setNotice(''); setSent(text); setReply(null); setSummary(''); setElapsed(0); setExpanded(false)
    setStage(''); setPaneTail([]); setHint(''); setSteps([]); setNow(null)
    setPhase('waiting')

    try {
      await sendPrompt(token, project.name, channel.index, text)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPhase('review')
      return
    }
    // 已发出的就清出文本框：否则「发送」会一直亮着，一点就重复发同一句
    setDraft(''); setRawText(''); setRefined(false)
    draftStateRef.current = { draft: '', raw: '', refined: false }
    delete storeRef.current.drafts[`${project.name}:${channel.index}`]
    persist()
    startPoll(`${project.name}:${channel.index}`, project.name, channel.index, text)
  }, [token, project, channel, refining, startPoll, persist])
  deliverRef.current = (override?: string) => { void deliver(override) }

  // ── 换频道 ──────────────────────────────────────────────
  const onChannelChange = useCallback((pi: number, ci: number) => {
    const p = projects[pi]
    const c = p?.channels[ci]
    if (!p || !c || (pi === projIdx && ci === chanIdx)) return

    void stopSpeaking(); setSpeaking(null)
    dictRef.current?.stop().catch(() => {})
    dictRef.current = null

    setProjIdx(pi); setChanIdx(ci)
    setErr(''); setNotice(''); setStage(''); setPaneTail([]); setHint(''); setLive('')
    setDraft(''); setRawText(''); setRefined(false); setRefining(false); setElapsed(0); setSteps([]); setNow(null)
    setExpanded(false)

    const key = `${p.name}:${c.index}`
    // 切走之前先把自己这半句收好，再取新那一格自己的草稿 —— 打了一半的字不该因为
    // 转了下条子就没了（这是真机上被明确抱怨过的一条）
    stashDraft(chanKey)
    storeRef.current.last = key
    persist()
    const saved = storeRef.current.drafts[key]
    if (saved?.draft) {
      setDraft(saved.draft); setRawText(saved.raw); setRefined(saved.refined); setPhase('review')
      setSent(''); setReply(null); setSummary(''); setSteps([]); setNow(null)
      return
    }

    const cached = cacheRef.current.get(key)
    if (cached) {
      setSent(cached.sent); setReply(cached.reply); setSummary(cached.summary); setPhase('reply')
      return
    }
    setSent(''); setReply(null); setSummary(''); setPhase('idle')
    peekInto(p.name, c.index, key)
  }, [projects, projIdx, chanIdx, stashDraft, persist, peekInto])

  /** 去经典终端看这一轮的完整过程。把当前 project/channel 写进它读的那两个键，
      切过去就是这一格，不用再自己找。 */
  const openInTerminal = () => {
    try {
      if (project) localStorage.setItem('nexus_session', project.name)
      if (channel) localStorage.setItem('nexus_window', String(channel.index))
    } catch { /* 隐私模式 */ }
    onExit?.()
  }

  /**
   * 开文件浏览器。
   * 不带参数：根目录 = 当前这一格的 cwd（换一格，看到的目录跟着换）。
   * 带文件：相对路径对着 cwd 解析；**根目录设成那个文件所在的目录** ——
   * 你要的是"navigate 到那个文件所在的目录"，而不是打开 cwd 再自己往下翻。
   */
  const openBrowser = (file?: string) => {
    const cwd = (channel?.cwd || '').replace(/\/+$/, '')
    if (!cwd) { setErr('这一格还没有工作目录'); return }
    if (!file) { setBrowser({ root: cwd }); return }
    const abs = file.startsWith('/') ? file : `${cwd}/${file.replace(/^\.\//, '')}`
    const dir = abs.slice(0, abs.lastIndexOf('/')) || cwd
    setBrowser({ root: dir, file: abs })
  }

  const reset = () => {
    void stopSpeaking(); setSpeaking(null)
    setPhase('idle'); setDraft(''); setRawText(''); setSent(''); setReply(null)
    setSummary(''); setErr(''); setSteps([]); setNow(null); setExpanded(false)
  }

  const toggleMute = () => { const next = !muted; setMutedFeedback(next); setMutedState(next) }

  /** 从当前格往后找下一个能用的池子。找不到就什么也不做（全都不行时点了也没去处）。 */
  const jumpToClaude = () => {
    const cs = project?.channels ?? []
    for (let s = 1; s <= cs.length; s++) {
      const i = (chanIdx + s) % cs.length
      if (cs[i]?.kind === 'claude') { onChannelChange(projIdx, i); return }
    }
  }

  // ── 渲染 ────────────────────────────────────────────────
  const busy = phase === 'waiting' || phase === 'transcribing'
  const canSend = !!draft.trim() && !busy
  /** 这一格发不出去（pane 里不是 claude）。**由讲话键自己说出来**，
      不再另挂一行黄字 —— 那行字和禁用的键隔着 40px 各说各的，是最糟的一种分工。 */
  const blocked = !!channel && channel.kind !== 'claude'
  const noSpeech = !dictationSupported()
  const recording = phase === 'listening' && micReady
  const showSteps = (phase === 'waiting' || phase === 'reply') && steps.length > 0
  const folded = !summary && !!reply?.text && reply.text.length > FOLD_AT && !expanded

  /** 此刻在做的事，说成人话："正在读 docs/WALKIE.md"，而不是一个光秃秃的文件名 */
  const NOW_VERB: Record<string, string> = {
    bash: '正在运行', read: '正在读', edit: '正在改', search: '正在搜',
    task: '正在派子任务', web: '正在查', todo: '正在更新清单', tool: '正在调用', think: '正在推理',
  }

  /**
   * 把动作流折成"章"。**这句话说什么是标题，工具是它下面的证据。**
   *
   * 为什么要这么折：老版本是一行行工具名（Read / Grep / Edit / 推理中…），
   * 那是**实现细节**，不是"他在干嘛" —— 用户的原话是"显示一个动作调用动作，
   * 然后显示推理中，完全不知道它在干嘛"。而他其实已经把意图用大白话写下来了
   * （transcript 里每条工具调用之间都夹着一句），我们原来把它扔进"回复"里、
   * 只在最后才拿出来。
   *
   * 反了。**等待的时候你想知道的是"他在干嘛"，那句话就是答案。**
   */
  const story = (rows: WalkieStep[]) => {
    const chapters: { say?: WalkieStep; tools: WalkieStep[] }[] = []
    for (const s of rows) {
      if (s.kind === 'say') chapters.push({ say: s, tools: [] })
      else {
        if (!chapters.length) chapters.push({ tools: [] })
        chapters[chapters.length - 1].tools.push(s)
      }
    }
    // 纯"推理中"不留章 —— 它现在只在底部那条"此刻"里出现
    const shown = chapters.filter((c) => c.say || c.tools.length)
    return (
      <ol className="walkie-story">
        {shown.map((c, i) => (
          <li key={i} className="walkie-chapter">
            {c.say && <p className="walkie-say">{c.say.label}</p>}
            {c.tools.length > 0 && (
              <ul className="walkie-doings">
                {c.tools.map((s, j) => (
                  <li key={j} className={`walkie-step k-${s.kind}${s.done === false ? ' is-running' : ''}`}>
                    <span className="walkie-step-ico">{STEP_ICON[s.kind] || STEP_ICON.tool}</span>
                    <span className="walkie-step-text">{s.label}</span>
                    {s.path && (
                      <button type="button" className="walkie-step-open" onClick={() => openBrowser(s.path)}>打开</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    )
  }

  /** 讲话键。它是这一屏的主角，所以整块都是命中区 —— 拇指不用瞄。 */
  const talkButton = (() => {
    if (phase === 'transcribing' || phase === 'waiting') {
      return (
        <div className={`walkie-ptt is-busy${phase === 'waiting' ? ' is-work' : ''}`}>
          <span className="walkie-wait"><i /><i /><i /></span>
          <span className="walkie-ptt-label">
            {phase === 'transcribing' ? '转写最后一段…' : `${stage || '已投递'} · ${elapsed}s`}
          </span>
        </div>
      )
    }
    return (
      <button
        type="button"
        className={`walkie-ptt${recording ? ' is-live' : ''}`}
        onPointerDown={onPttDown}
        onPointerUp={onPttUp}
        onPointerCancel={onPttUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {recording ? (
          <>
            {/* 波形长在按键上 —— 你说话的样子就在你拇指下面，而不是屏幕中段某个卡片里 */}
            <span className="walkie-ptt-wave" aria-hidden="true">
              {bars.map((b, i) => (
                <i key={i} style={{ height: `${8 + b * 92}%`, opacity: 0.4 + b * 0.6 }} />
              ))}
            </span>
            <span className="walkie-ptt-label">{`松手结束 · ${recSec.toFixed(1)}s`}</span>
          </>
        ) : (
          <>
            <IconMic />
            <span className="walkie-ptt-label">
              {phase === 'listening' ? '正在打开麦克风…' : '按住说话'}
            </span>
            {!noSpeech && <em>松手自动精炼成一条指令</em>}
            {noSpeech && <em>这个环境录不了音，用上面的 ⌨</em>}
          </>
        )}
      </button>
    )
  })()

  return (
    <div className="walkie-root">
      <div className="walkie-top">
        <div className="walkie-top-title">
          <span className="walkie-dot" style={{ background: data?.tmux === false ? 'var(--nexus-error)' : 'var(--nexus-success)' }} />
          对讲机
        </div>
        <div className="walkie-top-actions">
          {data && !data.asr && (
            <span className="walkie-note walkie-note-warn" title="按住说话要用本机转写，它没在跑">
              转写未启动
            </span>
          )}
          <button type="button" className="walkie-icon-btn" onClick={toggleMute} title={muted ? '开启旋钮音' : '静音'}>
            <IconSound off={muted} />
          </button>
          <button type="button" className="walkie-icon-btn" onClick={() => void reload(true)} title="刷新频道">↻</button>
          <button type="button" className="walkie-icon-btn" onClick={() => openBrowser()} title="看这一格的文件"><IconFolder /></button>
          <button type="button" className="walkie-icon-btn" onClick={focusDraft} title="用输入法输入"><IconKeyboard /></button>
          {onExit && <button type="button" className="walkie-chip" onClick={openInTerminal}>经典</button>}
        </div>
      </div>

      <div className="walkie-stage" ref={stageRef}>
        <div className="walkie-stage-inner">
        {/* 待机就是待机：这块屏上什么都没有，是因为还没有人的话落在这。
            上一版在这里写了两行"按住下面那条说话 / 松手自动精炼成一条指令"——
            和 40px 之下那个键上印的字一模一样。**键会说话，就别再替它说一遍。** */}
        {!channel && projects.length > 0 && (
          <div className="walkie-standby"><p>还没有可用的频道。</p></div>
        )}

        {/* 他上一轮说的，留在上面当上下文。暗一档、折三行 —— 这一刻的主角是
            拇指底下那件事，但它不该是一片空白：**你是在回他，不是在对空气说话。** */}
        {/* 只在"新一轮"里当上下文。按 ⌨ 从回复里起一个后续（sent 还在）时不算 ——
            那种情况下面那块就是这条回复本身，再引一遍就成了同一句话说两次。 */}
        {(phase === 'listening' || phase === 'transcribing' || (phase === 'review' && !sent)) && reply?.text && (
          <div className="walkie-mine walkie-mine-them">
            <div className="walkie-card-label"><span>他上一轮 · {channel?.name}</span></div>
            <p className="is-clamp">
              <ReplyText text={reply.text.length > 180 ? `${reply.text.slice(0, 180)}…` : reply.text} onOpen={openBrowser} />
            </p>
          </div>
        )}

        {phase === 'listening' && (
          <div className="walkie-card walkie-card-tx">
            <div className="walkie-card-label">
              <span className="walkie-rec"><i />{micReady ? '发送中' : '正在打开麦克风…'}</span>
              <span>{micReady ? `${recSec.toFixed(1)}s` : '首次会弹权限确认'}</span>
            </div>
            {/* 边说边出字：转写是分段送出去的，一段回来就接上一段 */}
            <div className="walkie-draft walkie-live" data-empty={live ? '0' : '1'}>
              {live || '说吧…'}
            </div>
          </div>
        )}

        {phase === 'review' && (
          <div className="walkie-card">
            <div className="walkie-card-label">
              <span>{refining ? '精炼中…' : refined ? '已精炼' : '原文'}</span>
              <span>{draft.length} 字</span>
            </div>
            <textarea
              id="walkie-draft"
              className="walkie-draft"
              value={draft}
              onChange={onDraftInput}
              placeholder="按住说话，或点 ⌨ 用输入法的语音键"
            />
            <div className="walkie-inline">
              {rawText && draft.trim() !== rawText.trim() && (
                <button type="button" className="walkie-mini" onClick={() => { setDraft(rawText); setRefined(false) }}>
                  还原原文
                </button>
              )}
              <button type="button" className="walkie-mini" onClick={reset}>清空</button>
            </div>
          </div>
        )}

        {/* 你刚说的那句：**不占一张卡**。它是上一句，不是这一屏的主角 ——
            左边一道竖线就够认出"这是我说的话"，卡片会把它抬到和他回复同级。 */}
        {(phase === 'waiting' || phase === 'reply') && sent && (
          <div className="walkie-mine" onClick={() => setMineOpen((v) => !v)}>
            {/* 秒表只在讲话键上走：那儿是拇指区、永远看得见。
                这里再来一个就是同一个数字在同一屏出现两次。 */}
            <div className="walkie-card-label">
              <span>你说 · {channel?.name}</span>
            </div>
            <p className={mineOpen ? '' : 'is-clamp'}>{sent}</p>
          </div>
        )}

        {phase === 'waiting' && (
          <div className="walkie-card">
            {/* 他在干什么：**他说的那句话**当标题，工具退成它下面的证据。
                见 story() 里为什么要把这两样反过来摆。 */}
            {showSteps
              ? story(steps.slice(-18))
              /* 动作流还没接上（还没认领会话）时退回显示窗口现状，总比一片空白强 */
              : paneTail.length > 0
                ? <pre className="walkie-pane"><code>{paneTail.join('\n')}</code></pre>
                : null}
            {/* 此刻：一行，永远在最底下。它是一条**状态**，所以不跟上面那些
                "做过的事"排在一起 —— 混进去就变成"每想一次记一笔"的噪音。 */}
            <div className="walkie-now">
              <span className="walkie-now-dot" />
              <span className="walkie-now-text">
                {now ? `${NOW_VERB[now.kind] || '正在处理'}${now.kind === 'think' ? '…' : ` ${now.label}`}` : '正在连接…'}
              </span>
            </div>
            {hint && <div className="walkie-hint-bad">{hint}</div>}
          </div>
        )}

        {/* 看回复时按 ⌨ 起新一轮：回复不撤走，留在输入框上面当上下文。
            但刚录完一轮（sent 已被清空）时这里不该出现它 —— 那说明屏上那条是**上一轮**的，
            它的位置在上面那块"他上一轮"里。 */}
        {(phase === 'reply' || (phase === 'review' && !!sent)) && reply && (
          <div className="walkie-card">
            <div className="walkie-card-label">
              <span>他的回复</span>
              {reply.via === 'grew-fallback' && <span>（靠文件增长猜的，可能不是这一条）</span>}
            </div>
            {/* 页面上只给摘要 —— 手机上塞不下完整结果，详情本来就该去文件里看。
                但回复短的时候直接整段摊开：里面的文件引用要能当场点。 */}
            <div className="walkie-reply">
              {summary
                ? <ReplyText text={summary} onOpen={openBrowser} />
                : reply.text
                  ? <ReplyText text={folded ? fold(reply.text) : reply.text} onOpen={openBrowser} />
                  : '（这一轮没有说话，可能只动了文件）'}
            </div>
            {folded && (
              <div className="walkie-inline">
                <button type="button" className="walkie-mini" onClick={() => setExpanded(true)}>
                  展开全文（{reply.text.length} 字）
                </button>
              </div>
            )}
            <div className="walkie-inline">
              {summary && (
                <button type="button" className="walkie-mini"
                  onClick={() => (speaking === 'summary' ? hush() : void play(summary, 1.12, 'summary'))}>
                  {speaking === 'summary' ? '⏹ 停止' : '▶ 摘要'}
                </button>
              )}
              {reply.text && (
                <button type="button" className="walkie-mini"
                  onClick={() => (speaking === 'full' ? hush() : void play(reply.text, 1.06, 'full'))}>
                  {/* 没有摘要时，屏上这段**就是**全文 —— 再写"全文"是个说不通的标签 */}
                  {speaking === 'full' ? '⏹ 停止' : summary ? '▶ 全文' : '▶ 读一遍'}
                </button>
              )}
              <button type="button" className="walkie-mini" onClick={() => openBrowser()}>看文件</button>
              {/* 「再问一句」删了：它做的事（清屏回到 idle）按住讲话键本来就会做，
                  而且讲话键就在拇指底下。同一个动作给两个入口，只会让人犹豫。 */}
              {onExit && <button type="button" className="walkie-mini" onClick={openInTerminal}>完整过程</button>}
            </div>
            {summary && reply.text && summary.trim() !== reply.text.trim() && (
              <details className="walkie-full" open={reply.text.length <= FOLD_AT}>
                <summary>完整回复</summary>
                <div className="walkie-reply" style={{ marginTop: 8 }}>
                  <ReplyText text={reply.text} onOpen={openBrowser} />
                </div>
              </details>
            )}
          </div>
        )}

        {/* 答完之后，过程退成一行 —— 想复盘再摊开。它和"他的回复"平起平坐时，
            这一屏就有两张一样重的卡，读的人得先决定该看哪张。 */}
        {showSteps && phase === 'reply' && (
          <details className="walkie-steps-fold">
            <summary>他做了什么（{steps.filter((s) => s.kind !== 'say').length} 步）</summary>
            <div className="walkie-steps-body">{story(steps.slice(-24))}</div>
          </details>
        )}
        </div>
      </div>

      {(err || loadErr) && <div className="walkie-error">{err || loadErr}</div>}
      {notice && !err && <div className="walkie-notice">{notice}</div>}

      {/* 台面：调台条（两行）+ 讲话键。它是**手**用的，所以钉在拇指区、尺寸不随内容变。 */}
      <div className="walkie-deck">
        {projects.length > 0 ? (
          <Tuner projects={projects} projIdx={projIdx} chanIdx={chanIdx} onChange={onChannelChange} />
        ) : (
          <div className="tuner"><div className="tuner-empty">
            <span className="walkie-note">{loadErr ? '连不上服务器' : '载入频道…'}</span>
          </div></div>
        )}

        <div className="walkie-ptt-zone">
          {blocked ? (
            /* 这一格发不出去。**由键自己说**，而且顺手给出下一步（跳到一个能用的）——
               上一版是"上面一行黄字警告 + 下面一个照常可以按的讲话键"，
               你会对着一个明知道会被拦住的东西按下去，白说一遍再被拒。 */
            <button type="button" className="walkie-ptt is-blocked" onClick={jumpToClaude}>
              <span className="walkie-ptt-label">这一格不是 Claude</span>
              <em>发过去会被当命令执行 · 点这里换一个</em>
            </button>
          ) : canSend ? (
            /* 有草稿 = 两个明确的键。老版本用一个圆的两种手势（按住说话 / 轻点发送）
               来表达这两件事，得靠"按了多久、录到声音没有"去猜意图 —— 现在没有猜测。 */
            <div className="walkie-actions">
              <button
                type="button"
                className="walkie-again"
                onPointerDown={onPttDown}
                onPointerUp={onPttUp}
                onPointerCancel={onPttUp}
                onContextMenu={(e) => e.preventDefault()}
              >
                <IconMic /><span>按住重说</span>
              </button>
              <button type="button" className="walkie-send" onClick={() => deliverRef.current?.()}>
                <IconSend /><span>发送</span>
              </button>
            </div>
          ) : talkButton}
        </div>
      </div>

      {browser && (
        <Suspense fallback={null}>
          <WorkspaceBrowser
            token={token}
            title="工作目录"
            initialPath={browser.root}
            currentSession={project?.name}
            onClose={() => setBrowser(null)}
            ref={browserRef}
          />
        </Suspense>
      )}
    </div>
  )
}
