// walkie/WalkieApp.tsx — 对讲机模式的根组件
//
// 一次交互只做三件事：转旋钮选频道 → 按住说话 → 按发送。
// 语音转写、精炼、投递、追回复各自是独立模块（speech.ts / api.ts / tts.ts），
// 这里只负责把它们串成一条状态机：
//
//   idle ──按住──▶ listening ──松手──▶ review ──发送──▶ waiting ──答完──▶ reply
//                       │                 ▲                              │
//                       └─(没说出东西)────┘◀───────── 再问一句 ───────────┘
//
// 两条刻意的设计：
//   1. 松手后**自动精炼**（用户选的），但精炼只是替换文本框里的内容 —— 你随时能改、
//      能「还原原文」；按发送时发的是框里此刻的文字。精炼失败或超时绝不挡发送。
//   2. 追回复的轮询按**频道**各自独立（Map<频道, timer>），不跟着视野走。
//      切到别的频道看看、甚至在那儿再问一句，原来那轮答完了照样落进 cache，
//      切回去就还在。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChannelDial from './ChannelDial'
import {
  getChannels, getReply, refineText, sendPrompt, summarizeText,
  type ChannelList, type ReplyState,
} from './api'
import {
  dictationSupported, explainDictationError, startDictation,
  type Dictation, type DictationStatus,
} from './speech'
import { speak, stopSpeaking } from './tts'
import './walkie.css'

// listening = 正在录音；transcribing = 松手后本机转写中（约 1.5–2 秒）
type Phase = 'idle' | 'listening' | 'transcribing' | 'review' | 'waiting' | 'reply'

interface CacheEntry { reply: ReplyState; summary: string; sent: string }

const POLL_MS = 1200
const WAIT_LIMIT_MS = 10 * 60_000
const REFINE_WAIT_MS = 3000

const IconMic = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)
const IconKeyboard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
  </svg>
)

export default function WalkieApp({ token, onExit }: { token: string; onExit?: () => void }) {
  const [data, setData] = useState<ChannelList | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [projIdx, setProjIdx] = useState(0)
  const [chanIdx, setChanIdx] = useState(0)

  const [phase, setPhase] = useState<Phase>('idle')
  const [recSec, setRecSec] = useState(0)
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [rawText, setRawText] = useState('')
  const [refined, setRefined] = useState(false)
  const [refining, setRefining] = useState(false)
  const [sent, setSent] = useState('')
  const [reply, setReply] = useState<ReplyState | null>(null)
  const [stage, setStage] = useState('')
  const [summary, setSummary] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [err, setErr] = useState('')
  const [speakingNow, setSpeakingNow] = useState(false)

  const projects = useMemo(() => data?.projects ?? [], [data])
  const project = projects[projIdx]
  const channel = project?.channels[chanIdx]
  const chanKey = project && channel ? `${project.name}:${channel.index}` : ''

  // 回调里要读最新值，用 ref 兜住闭包
  const draftRef = useRef('')
  const chanKeyRef = useRef('')
  const dictRef = useRef<Dictation | null>(null)
  const holdRef = useRef(false)     // 手指是否还按在 PTT 上（识别器起来之前松手要能兜住）
  const refineP = useRef<Promise<unknown> | null>(null)
  const cacheRef = useRef(new Map<string, CacheEntry>())
  const pollsRef = useRef(new Map<string, number>())
  const recStartedRef = useRef(0)     // 本次录音起点
  const recSecRef = useRef(0)         // 已录秒数（松手时用来判断"是不是按太短了"）
  draftRef.current = draft
  chanKeyRef.current = chanKey

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
  useEffect(() => () => {
    for (const t of pollsRef.current.values()) clearInterval(t)
    pollsRef.current.clear()
    void stopSpeaking()
  }, [])

  // 录音计时：只说"正在听"没法判断麦克风到底有没有在工作，
  // 让它一秒一秒地走，至少能确认"确实在录"。
  useEffect(() => {
    if (phase !== 'listening') return
    recStartedRef.current = Date.now()
    recSecRef.current = 0
    setRecSec(0)
    const t = window.setInterval(() => {
      recSecRef.current = (Date.now() - recStartedRef.current) / 1000
      setRecSec(recSecRef.current)
    }, 200)
    return () => clearInterval(t)
  }, [phase])

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

  // ── 语音 ────────────────────────────────────────────────
  const startTalk = useCallback(async () => {
    if (dictRef.current || phase === 'waiting') return
    holdRef.current = true
    void stopSpeaking(); setSpeakingNow(false); setErr(''); setNotice('')
    setRecSec(0); setDraft(''); setRawText(''); setRefined(false)
    setSent(''); setReply(null); setSummary(''); setStage('')
    try {
      const d = await startDictation(token, {
        onStatus: (s: DictationStatus) => {
          // 手指已松开、但录音器才刚起来 —— 别把状态往回拨
          if (s === 'recording' && holdRef.current) setPhase('listening')
        },
        onError: (m) => setErr(explainDictationError(m)),
      })
      // 手指在录音器起来的这段时间里就松开了（点一下而非按住）：
      // 直接掐掉，否则麦克风会一直开着，而且没有任何东西能停它
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

  const endTalk = useCallback(async () => {
    holdRef.current = false
    const d = dictRef.current
    if (!d) return
    dictRef.current = null
    const recSecs = recSecRef.current
    setPhase('transcribing')
    let text = ''
    try { text = await d.stop() } catch { /* 转写失败已由 onError 说明 */ }
    const final = (text || '').trim()
    if (!final) {
      setPhase('idle')
      setNotice(recSecs < 0.6
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
    void startTalk()
  }
  const onPttUp = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    void endTalk()
  }

  /** 兜底：调起输入法（含它的语音键），走同一条文本框 */
  const focusDraft = () => {
    setPhase((p) => (p === 'idle' ? 'review' : p))
    // 文本框要等这一轮 render 出来才存在，rAF 有时仍早一拍，给个短延时
    setTimeout(() => document.getElementById('walkie-draft')?.focus(), 60)
  }

  // ── 播报 ────────────────────────────────────────────────
  const autoSpeak = useCallback(async (text: string, key: string) => {
    if (!text) return
    try {
      const s = await summarizeText(token, text)
      const entry = cacheRef.current.get(key)
      if (entry) entry.summary = s.text
      if (chanKeyRef.current !== key) return    // 已经切走了就别突然出声
      setSummary(s.text)
      setSpeakingNow(true)
      await speak(s.text, { rate: 1.12 })
    } catch { /* 摘要失败就静默，用户还能点「▶ 全文」 */ }
    finally { setSpeakingNow(false) }
  }, [token])

  const play = async (text: string, rate: number) => {
    if (!text) return
    setSpeakingNow(true)
    try { await speak(text, { rate }) } finally { setSpeakingNow(false) }
  }
  const hush = () => { void stopSpeaking(); setSpeakingNow(false) }

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
      }
      if (r.done) {
        clearPoll(key)
        cacheRef.current.set(key, { reply: r, summary: '', sent: sentText })
        if (chanKeyRef.current === key) {
          setReply(r); setPhase('reply')
          void autoSpeak(r.text, key)
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

  const deliver = useCallback(async () => {
    if (!project || !channel) return
    if (channel.kind !== 'claude') {
      setErr(`「${channel.name}」里跑的不是 Claude（是个 shell）。这句话发过去会被当命令执行，所以拦住了。`)
      return
    }
    // 精炼还没落地就等一下（最多 3 秒）；宁可发原文，也不让你干等
    if (refining) await Promise.race([refineP.current, new Promise((r) => setTimeout(r, REFINE_WAIT_MS))])
    const text = draftRef.current.trim()
    if (!text) return

    setErr(''); setSent(text); setReply(null); setSummary(''); setElapsed(0); setPhase('waiting')

    try {
      await sendPrompt(token, project.name, channel.index, text)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPhase('review')
      return
    }
    // 已发出的就清出文本框：否则「发送」会一直亮着，一点就重复发同一句。
    // 发出去的内容由下面的「已发出」卡片负责显示。
    setDraft(''); setRawText(''); setRefined(false)
    startPoll(`${project.name}:${channel.index}`, project.name, channel.index, text)
  }, [token, project, channel, refining, startPoll])

  // ── 换频道 ──────────────────────────────────────────────
  const onChannelChange = useCallback((pi: number, ci: number) => {
    const p = projects[pi]
    const c = p?.channels[ci]
    if (!p || !c || (pi === projIdx && ci === chanIdx)) return

    void stopSpeaking(); setSpeakingNow(false)
    dictRef.current?.stop().catch(() => {})
    dictRef.current = null

    setProjIdx(pi); setChanIdx(ci)
    setErr(''); setNotice(''); setStage(''); setDraft(''); setRawText(''); setRefined(false); setRefining(false); setElapsed(0)

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
      setReply(r); setPhase('reply')
    }).catch(() => { /* peek 失败无所谓 */ })
  }, [projects, projIdx, chanIdx, token])

  const reset = () => {
    void stopSpeaking(); setSpeakingNow(false)
    setPhase('idle'); setDraft(''); setRawText(''); setSent(''); setReply(null); setSummary(''); setErr('')
  }

  // ── 渲染 ────────────────────────────────────────────────
  const hasContent = phase !== 'idle' || !!draft
  const busy = phase === 'waiting' || phase === 'transcribing'
  const canSend = !!draft.trim() && !busy
  const noSpeech = !dictationSupported()

  return (
    <div className={`walkie-root${hasContent ? ' has-content' : ''}`}>
      <div className="walkie-top">
        <div className="walkie-top-title">
          <span className="walkie-dot" style={{ background: data?.tmux === false ? 'var(--nexus-error)' : 'var(--nexus-success)' }} />
          对讲机
        </div>
        <div className="walkie-top-actions">
          {data?.llm && <span className="walkie-note">{data.llm.label}</span>}
          <button type="button" className="walkie-chip" onClick={() => void reload(true)}>刷新</button>
          {onExit && <button type="button" className="walkie-chip" onClick={onExit}>经典</button>}
        </div>
      </div>

      <div className="walkie-dial-wrap">
        <div className="walkie-dial-col">
          {projects.length > 0 ? (
            <ChannelDial projects={projects} projIdx={projIdx} chanIdx={chanIdx} onChange={onChannelChange} />
          ) : (
            <div className="walkie-dial" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="walkie-note">{loadErr ? '连不上服务器' : '载入频道…'}</span>
            </div>
          )}
          {/* 闲置时把说明贴在旋钮正下方 —— 作为一组居中，比把它甩到屏幕底部好看得多 */}
          {phase === 'idle' && !draft && (
            <div className="walkie-hint">
              {channel ? <>按住下面说话，松手会自动精炼成一条指令</> : '还没有可用的频道'}
            </div>
          )}
        </div>
      </div>

      <div className="walkie-stage">
        {phase === 'listening' && (
          <div className="walkie-card">
            <div className="walkie-card-label">
              <span className="walkie-rec"><i />录音中</span>
              <span>{recSec.toFixed(1)}s · 松手结束</span>
            </div>
            {/* 上一版这里显示"边说边出字"，但那条路在国产 ROM 上是死的。
                现在改成本机转写，代价是没有实时预览 —— 所以用一条随时间起伏的
                波形告诉你"确实在录"，而不是让你对着静止的文字猜。 */}
            <div className="walkie-levels" aria-hidden="true">
              {Array.from({ length: 28 }, (_, i) => (
                <i key={i} style={{ animationDelay: `${(i % 7) * 90}ms` }} />
              ))}
            </div>
          </div>
        )}

        {phase === 'transcribing' && (
          <div className="walkie-card">
            <div className="walkie-wait"><i /><i /><i /><span>本机转写中…</span></div>
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
              placeholder="按住说话，或直接在这里输入"
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

        {(phase === 'waiting' || phase === 'reply') && sent && (
          <div className="walkie-card">
            <div className="walkie-card-label">
              <span>已发出 · {project?.name}/{channel?.name}</span>
              <span>{phase === 'waiting' ? `${elapsed}s` : ''}</span>
            </div>
            <div className="walkie-reply" style={{ color: 'var(--nexus-text-2)', fontSize: 13 }}>{sent}</div>
          </div>
        )}

        {phase === 'waiting' && (
          <div className="walkie-card">
            <div className="walkie-wait">
              <i /><i /><i />
              <span>{stage || 'Claude 在干活…'}（{elapsed}s）</span>
            </div>
          </div>
        )}

        {phase === 'reply' && reply && (
          <div className="walkie-card">
            <div className="walkie-card-label"><span>AI 回复</span></div>
            <div className="walkie-reply">{reply.text || '（这一轮没有说话，可能只动了文件）'}</div>
            <div className="walkie-inline">
              {summary && (
                <button type="button" className="walkie-mini" onClick={() => (speakingNow ? hush() : void play(summary, 1.12))}>
                  {speakingNow ? '⏹ 停止' : '▶ 摘要'}
                </button>
              )}
              {reply.text && (
                <button type="button" className="walkie-mini" onClick={() => (speakingNow ? hush() : void play(reply.text, 1.06))}>
                  {speakingNow ? '⏹ 停止' : '▶ 全文'}
                </button>
              )}
              <button type="button" className="walkie-mini" onClick={reset}>再问一句</button>
            </div>
            {summary && <div className="walkie-note" style={{ marginTop: 8 }}>摘要：{summary}</div>}
          </div>
        )}
      </div>

      {(err || loadErr) && <div className="walkie-error">{err || loadErr}</div>}
      {notice && !err && <div className="walkie-notice">{notice}</div>}

      <div className="walkie-controls">
        <div className={`walkie-ptt-row${canSend ? ' has-text' : ''}`}>
          {/* 输入法兜底入口。只在"手上没话要说"的两个状态出现：
              说话中说这个没意义；已在看回复或等回复时，用「再问一句」起新的一轮，
              而不是把回复从眼前顶掉。 */}
          {!canSend && (phase === 'idle' || phase === 'review') && (
            <button type="button" className="walkie-key" onClick={focusDraft} title="用输入法输入">
              <IconKeyboard />
            </button>
          )}
          <button
            type="button"
            className={`walkie-ptt${phase === 'listening' ? ' is-live' : ''}`}
            onPointerDown={onPttDown}
            onPointerUp={onPttUp}
            onPointerCancel={onPttUp}
            onContextMenu={(e) => e.preventDefault()}
            disabled={busy}
          >
            <IconMic />
            <span>{phase === 'listening' ? '松手结束' : phase === 'transcribing' ? '识别中…' : '按住说话'}</span>
          </button>
          {canSend && (
            <button type="button" className="walkie-send" onClick={() => void deliver()}>
              {refining ? '精炼后发送 →' : '发送 →'}
            </button>
          )}
        </div>
        {noSpeech && (
          <div className="walkie-note" style={{ textAlign: 'center' }}>
            这个环境没有语音识别，点 ⌨ 用输入法语音键输入
          </div>
        )}
      </div>
    </div>
  )
}
