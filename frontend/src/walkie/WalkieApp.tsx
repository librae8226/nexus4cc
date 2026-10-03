// walkie/WalkieApp.tsx — 对讲机模式的根组件
//
// 【版面】下半屏是一个**钉死尺寸**的拨码盘（像个实物，不随内容伸缩），上半屏是这一格对面
// 那个人的工作现场。读数面板紧贴旋钮上方 —— 那上面写着"我通的是谁、他忙不忙"。
//
// 【圆心】一个圆，两种手势：
//   按住 = 说话（永远有效）
//   轻点 = 发送（只在框里有草稿时）
// 轻点的判定是「按下不到 300ms 且这一段没录到任何音频」—— 轻点本来就录不到东西，
// 所以这么判不会误伤"想说话但按太短"。
//
// 【状态机】
//   idle ──按住──▶ listening ──松手──▶ review ──发送──▶ waiting ──答完──▶ reply
//                                        ▲                                │
//                         轻点圆心（有草稿）│◀───────── 再问一句 ───────────┘
//
// 【过程可见】等待时不只是转圈：把 transcript 里提炼出的"一行动作"一行行刷出来
// （见 walkie.js 的 pushStep），带文件路径的那行点一下直接开文件浏览器。

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { WorkspaceBrowserHandle } from '../WorkspaceBrowser'
import ChannelDial from './ChannelDial'
import {
  getChannels, getReply, refineText, sendPrompt, summarizeText,
  type ChannelList, type ReplyState, type WalkieStep,
} from './api'
import {
  dictationSupported, explainDictationError, startDictation,
  type Dictation, type DictationStatus,
} from './speech'
import { attachAudioUnlock, isMuted, setMuted as setMutedFeedback, whoosh } from './feedback'
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
const TAP_MS = 300          // 按下短于这个时长才算"轻点"
const LEVEL_BARS = 26

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

export default function WalkieApp({ token, onExit }: { token: string; onExit?: () => void }) {
  const [data, setData] = useState<ChannelList | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [projIdx, setProjIdx] = useState(0)
  const [chanIdx, setChanIdx] = useState(0)

  const [phase, setPhase] = useState<Phase>('idle')
  const [recSec, setRecSec] = useState(0)
  const [live, setLive] = useState('')              // 边说边出字的已确定部分
  const [micReady, setMicReady] = useState(false)   // 麦克风是否已打开（首次会弹系统权限框）
  const [bars, setBars] = useState<number[]>(() => new Array(LEVEL_BARS).fill(0))
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [rawText, setRawText] = useState('')
  const [refined, setRefined] = useState(false)
  const [refining, setRefining] = useState(false)
  const [sent, setSent] = useState('')
  const [reply, setReply] = useState<ReplyState | null>(null)
  const [steps, setSteps] = useState<WalkieStep[]>([])
  const [stage, setStage] = useState('')
  const [paneTail, setPaneTail] = useState<string[]>([])
  const [hint, setHint] = useState('')
  const [summary, setSummary] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [err, setErr] = useState('')
  const [speaking, setSpeaking] = useState<Speaking>(null)
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
  const pttDownAt = useRef(0)
  // 按下圆心的瞬间先把框里的字存起来。因为"按下 = 开始录音"会清空输入框，
  // 而这一次按下的真实意图可能只是"轻点发送" —— 不存的话就把要发的东西自己擦了。
  const stashRef = useRef('')
  const refineP = useRef<Promise<unknown> | null>(null)
  const cacheRef = useRef(new Map<string, CacheEntry>())
  const pollsRef = useRef(new Map<string, number>())
  const recStartedRef = useRef(0)
  const recSecRef = useRef(0)
  const barsRef = useRef<number[]>(new Array(LEVEL_BARS).fill(0))
  const lastLevelAt = useRef(0)
  const liveRef = useRef('')
  const deliverRef = useRef<((override?: string) => void) | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const browserRef = useRef<WorkspaceBrowserHandle | null>(null)
  draftRef.current = draft
  chanKeyRef.current = chanKey
  liveRef.current = live

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

  // 首帧：落到该项目的活动窗口（用户上次在用的那个）
  const initedRef = useRef(false)
  useEffect(() => {
    if (initedRef.current || !projects.length) return
    initedRef.current = true
    const act = projects[0].channels.findIndex((c) => c.active)
    setChanIdx(act >= 0 ? act : 0)
  }, [projects])

  useEffect(() => {
    const n = projects[projIdx]?.channels.length ?? 0
    if (n && chanIdx > n - 1) setChanIdx(0)
  }, [projects, projIdx, chanIdx])

  // 动作流：新的一行进来就把内容区滚到底，"在动"这件事才看得见
  useEffect(() => {
    const el = stageRef.current
    if (el && phase === 'waiting') el.scrollTop = el.scrollHeight
  }, [steps, paneTail, phase])

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
    stashRef.current = draftRef.current
    // 首次按下会弹系统的麦克风权限框，getUserMedia 要等用户点完才 resolve。
    // 那几秒界面必须给出反馈，否则就是一个「按了没反应」的死按钮。
    setMicReady(false); setPhase('listening')
    void stopSpeaking(); setSpeaking(null); setErr(''); setNotice('')
    setRecSec(0); setDraft(''); setRawText(''); setRefined(false)
    setSent(''); setReply(null); setSummary(''); setStage(''); setSteps([])
    setLive(''); setBars(new Array(LEVEL_BARS).fill(0)); barsRef.current = new Array(LEVEL_BARS).fill(0)
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
      // 手指在录音器起来的这段时间里就松开了（点一下而非按住）。这一下可能是"轻点发送"，
      // 也可能什么都不是 —— 交给 deliverRef 判断（它有草稿才发）。
      if (!holdRef.current) {
        await d.stop().catch(() => '')
        const stashed = stashRef.current
        stashRef.current = ''
        if (stashed.trim()) { setDraft(stashed); setPhase('review'); deliverRef.current?.(stashed) }
        else setPhase('idle')
        return
      }
      dictRef.current = d
      setPhase('listening')
    } catch (e) {
      holdRef.current = false
      dictRef.current = null
      setPhase('idle')
      setErr(explainDictationError(e instanceof Error ? e.message : String(e)))
    }
  }, [phase, token])

  const endTalk = useCallback(async (quickTap: boolean, stashed: string) => {
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
    if (!final) {
      // 轻点圆心 + 按下前框里有草稿 + 这一下什么也没录到 → 这是"发送"，不是"说了句废话"
      if (quickTap && recSecs < TAP_MS / 1000 && stashed.trim()) {
        setDraft(stashed)
        setPhase('review')
        deliverRef.current?.(stashed)
        return
      }
      setPhase('idle')
      setNotice(failure
        ? explainDictationError(failure)
        : recSecs < 0.6
          ? `按住才录了 ${recSecs.toFixed(1)} 秒 —— 说一句话再松手。`
          : `录了 ${recSecs.toFixed(1)} 秒，但没识别出内容。再说一次，或点 ⌨ 用输入法。`)
      return
    }
    setRawText(final); setDraft(final); setPhase('review')

    setRefining(true)
    const p = refineText(token, final)
      .then((r) => { setDraft((cur) => (cur === final ? r.text : cur)); setRefined(r.refined) })
      .catch(() => { /* 精炼失败就保持原文 */ })
      .finally(() => setRefining(false))
    refineP.current = p
  }, [token])

  const onPttDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    pttDownAt.current = Date.now()
    void startTalk()
  }
  const onPttUp = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    const quick = Date.now() - pttDownAt.current < TAP_MS
    const stashed = stashRef.current
    stashRef.current = ''
    if (dictRef.current) { void endTalk(quick, stashed); return }
    holdRef.current = false            // 录音器还没起来，交给 startTalk 的续行
    // 录音根本没起来（比如没给麦克风权限）—— 轻点依然应该能发送
    if (quick && stashed.trim()) {
      setDraft(stashed); setPhase('review'); deliverRef.current?.(stashed)
    }
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
      const entry = cacheRef.current.get(key)
      if (entry) entry.summary = s.text
      if (chanKeyRef.current !== key) return    // 已经切走了就别突然出声
      setSummary(s.text)
      await play(s.text, 1.12, 'summary')
    } catch { /* 摘要失败就静默，用户还能点「▶ 全文」 */ }
  }, [token, play])

  // ── 发送 + 追回复 ────────────────────────────────────────
  const startPoll = useCallback((key: string, projName: string, win: number, sentText: string) => {
    clearPoll(key)
    const started = Date.now()
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
      }
      if (r.done) {
        clearPoll(key)
        cacheRef.current.set(key, { reply: r, summary: '', sent: sentText })
        if (chanKeyRef.current === key) {
          setReply(r); setPhase('reply'); setPaneTail([]); setHint('')
          if (r.steps) setSteps(r.steps)
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

    whoosh()                                  // 手势没有位移，声音是唯一的确证
    setErr(''); setNotice(''); setSent(text); setReply(null); setSummary(''); setElapsed(0)
    setStage(''); setPaneTail([]); setHint(''); setSteps([])
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
    startPoll(`${project.name}:${channel.index}`, project.name, channel.index, text)
  }, [token, project, channel, refining, startPoll])
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
    setDraft(''); setRawText(''); setRefined(false); setRefining(false); setElapsed(0); setSteps([])

    const key = `${p.name}:${c.index}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      setSent(cached.sent); setReply(cached.reply); setSummary(cached.summary); setPhase('reply')
      return
    }
    setSent(''); setReply(null); setSummary(''); setPhase('idle')

    // 没缓存就向后端要一次「上一轮答了什么」—— 转到哪个频道就能看见那条尾巴，不用重问
    getReply(token, p.name, c.index, true).then((r) => {
      if (chanKeyRef.current !== key || !r.text || cacheRef.current.has(key)) return
      cacheRef.current.set(key, { reply: r, summary: '', sent: '' })
      setReply(r); setSteps(r.steps || []); setPhase('reply')
    }).catch(() => { /* peek 失败无所谓 */ })
  }, [projects, projIdx, chanIdx, token])

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
    setSummary(''); setErr(''); setSteps([])
  }

  const toggleMute = () => { const next = !muted; setMutedFeedback(next); setMutedState(next) }

  // ── 渲染 ────────────────────────────────────────────────
  const busy = phase === 'waiting' || phase === 'transcribing'
  const canSend = !!draft.trim() && !busy
  const noSpeech = !dictationSupported()
  const recording = phase === 'listening' && micReady
  const showSteps = (phase === 'waiting' || phase === 'reply') && steps.length > 0

  const stepList = (rows: WalkieStep[], tail?: boolean) => (
    <ul className="walkie-steps">
      {rows.map((s, i) => (
        <li key={`${s.at}-${i}`} className={`walkie-step k-${s.kind}${tail && i === rows.length - 1 ? ' is-now' : ''}`}>
          <span className="walkie-step-ico">{STEP_ICON[s.kind] || STEP_ICON.tool}</span>
          <span className="walkie-step-text">{s.label}</span>
          {s.path && (
            <button type="button" className="walkie-step-open" onClick={() => openBrowser(s.path)}>打开</button>
          )}
        </li>
      ))}
    </ul>
  )

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
        {phase === 'idle' && !draft && !reply && (
          <div className="walkie-empty">
            {channel
              ? <>转旋钮换个人，按住下面的圆心说话。<br />松手会自动精炼成一条指令。</>
              : '还没有可用的频道。'}
          </div>
        )}

        {phase === 'listening' && (
          <div className="walkie-card">
            <div className="walkie-card-label">
              <span className="walkie-rec"><i />{micReady ? '录音中' : '正在打开麦克风…'}</span>
              <span>{micReady ? `${recSec.toFixed(1)}s` : '首次会弹权限确认'}</span>
            </div>
            {/* 边说边出字：转写是分段送出去的，一段回来就接上一段 */}
            <div className="walkie-draft walkie-live" data-empty={live ? '0' : '1'}>
              {live || '说吧…'}
            </div>
            {/* 波形是真实音量（麦克风采到的 RMS），不是装饰动画 —— 一眼看出到底有没有在收音 */}
            <div className="walkie-levels" aria-hidden="true">
              {bars.map((b, i) => (
                <i key={i} style={{ height: `${14 + b * 86}%`, opacity: 0.35 + b * 0.65 }} />
              ))}
            </div>
          </div>
        )}

        {phase === 'transcribing' && (
          <div className="walkie-card">
            <div className="walkie-wait"><i /><i /><i /><span>转写最后一段…</span></div>
            {live && <div className="walkie-draft walkie-live" style={{ marginTop: 8 }}>{live}</div>}
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
              onChange={(e) => setDraft(e.target.value)}
              placeholder="按住圆心说话，或直接在这里输入"
            />
            <div className="walkie-inline">
              {rawText && draft.trim() !== rawText.trim() && (
                <button type="button" className="walkie-mini" onClick={() => { setDraft(rawText); setRefined(false) }}>
                  还原原文
                </button>
              )}
              <button type="button" className="walkie-mini" onClick={reset}>清空</button>
              <span className="walkie-note">轻点圆心发送</span>
            </div>
          </div>
        )}

        {(phase === 'waiting' || phase === 'reply') && sent && (
          <div className="walkie-card">
            <div className="walkie-card-label">
              <span>你说 · {channel?.name}</span>
              <span>{phase === 'waiting' ? `${elapsed}s` : ''}</span>
            </div>
            <div className="walkie-reply" style={{ color: 'var(--nexus-text-2)', fontSize: 13 }}>{sent}</div>
          </div>
        )}

        {phase === 'waiting' && (
          <div className="walkie-card">
            <div className="walkie-wait">
              <i /><i /><i />
              <span>{stage || '已投递…'}（{elapsed}s）</span>
            </div>
            {/* 他在干什么：一行一步，从 transcript 的结构化工具调用里提炼出来的 */}
            {showSteps
              ? stepList(steps.slice(-14), true)
              /* 动作流还没接上（还没认领会话）时退回显示窗口现状，总比一片空白强 */
              : paneTail.length > 0 && <pre className="walkie-pane"><code>{paneTail.join('\n')}</code></pre>}
            {hint && <div className="walkie-hint-bad">{hint}</div>}
          </div>
        )}

        {/* 看回复时按 ⌨ 起新一轮：回复不撤走，留在输入框上面当上下文 */}
        {(phase === 'reply' || phase === 'review') && reply && (
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
                  ? <ReplyText text={reply.text} onOpen={openBrowser} />
                  : '（这一轮没有说话，可能只动了文件）'}
            </div>
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
                  {speaking === 'full' ? '⏹ 停止' : '▶ 全文'}
                </button>
              )}
              <button type="button" className="walkie-mini" onClick={() => openBrowser()}>看文件</button>
              <button type="button" className="walkie-mini" onClick={reset}>再问一句</button>
              {onExit && <button type="button" className="walkie-mini" onClick={openInTerminal}>完整过程</button>}
            </div>
            {summary && reply.text && summary.trim() !== reply.text.trim() && (
              <details className="walkie-full" open={reply.text.length <= 700}>
                <summary>完整回复</summary>
                <div className="walkie-reply" style={{ marginTop: 8 }}>
                  <ReplyText text={reply.text} onOpen={openBrowser} />
                </div>
              </details>
            )}
          </div>
        )}

        {showSteps && phase === 'reply' && (
          <div className="walkie-card">
            <div className="walkie-card-label"><span>他做了什么</span><span>{steps.length} 步</span></div>
            {stepList(steps.slice(-20))}
          </div>
        )}
      </div>

      {(err || loadErr) && <div className="walkie-error">{err || loadErr}</div>}
      {notice && !err && <div className="walkie-notice">{notice}</div>}

      {/* 下半屏：钉死尺寸的旋钮。它是手用的，不是眼睛看的 —— 所以内容多了也不缩。 */}
      <div className="walkie-dial-wrap">
        {projects.length > 0 ? (
          // 圆心作为 children 传给旋钮，落在 .walkie-dial 里面 ——
          // 那里是 position:relative，绝对定位才真的居中在旋钮上。
          // 写成兄弟节点的话它会相对更外层的祖先定位，跑偏。
          <ChannelDial projects={projects} projIdx={projIdx} chanIdx={chanIdx} onChange={onChannelChange}>
            <button
              type="button"
              className={`walkie-hub-btn${recording ? ' is-live' : ''}${canSend ? ' is-send' : ''}`}
              onPointerDown={onPttDown}
              onPointerUp={onPttUp}
              onPointerCancel={onPttUp}
              onContextMenu={(e) => e.preventDefault()}
              disabled={busy}
            >
              {canSend
                ? <><IconSend /><span>发送</span><em>按住可重说</em></>
                : <><IconMic /><span>{recording ? '松手结束' : '按住说话'}</span>{noSpeech && <em>点 ⌨ 用输入法</em>}</>}
            </button>
          </ChannelDial>
        ) : (
          <div className="walkie-dial" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="walkie-note">{loadErr ? '连不上服务器' : '载入频道…'}</span>
          </div>
        )}
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
