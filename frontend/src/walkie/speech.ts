// walkie/speech.ts — 按住说话的语音转写
//
// 三条路，按可用性依次退让：
//   1. 原生（APK）：Android SpeechRecognizer（@capacitor-community/speech-recognition）
//   2. 浏览器：Web Speech API（Chrome 桌面可用，方便在电脑上验证整条链路）
//   3. 都没有：返回 null，UI 退化成「点一下唤起输入法语音键」
//
// 【为什么要有看门狗】
// 读插件源码（android/.../SpeechRecognition.java）得到的事实，不是猜测：
//   - partialResults=true 时 start() 立即 resolve，之后所有结果都从 partialResults 事件来；
//   - 但这意味着识别出错时 onError 里的 call.reject() 打在一个已 resolve 的 call 上，
//     JS 侧**什么都收不到**；
//   - 而 onError 又不像 onEndOfSpeech 那样发 listeningState 事件。
// 合起来的后果：用户按住不吭声（SPEECH_TIMEOUT）或者说了句识别不出来（NO_MATCH），
// 识别器就悄悄死了 —— 没有事件、没有报错、没有重启，按住说话变成按住没反应。
// 所以这里不依赖插件的事件完整性：只要「按住期间超过 IDLE_RESTART_MS 没有任何事件」，
// 就当作一段结束，commit + 重启。正常分段结束（onEndOfSpeech）也走同一套收尾逻辑，
// 两条路都收敛到 finishSegment()，不会互相打架。
//
// Android 的识别器一次只吃一段话（说完静音就结束），所以「按住 = 一直听」必然是
// 「不断重启、把每段拼起来」。拼接规则见 joinSegments。

import { SpeechRecognition, type PermissionStatus } from '@capacitor-community/speech-recognition'
import { isNative } from '../baseUrl'

const IDLE_RESTART_MS = 2200   // 按住期间多久没动静就当作一段结束、重启识别
const SEGMENT_SETTLE_MS = 320  // 收到 stopped 后等这么久，收尾那一刻的最终结果
const RESTART_DELAY_MS = 220

export type DictationStatus = 'starting' | 'listening' | 'idle'

export interface DictationCallbacks {
  /** 累计后的完整转写文本（每次变化都回调） */
  onText: (text: string) => void
  onStatus?: (status: DictationStatus) => void
  onError?: (message: string) => void
}

export interface Dictation {
  /** 松手：停止识别并返回最终文本 */
  stop: () => Promise<string>
}

/** 只在本机跑得动原生插件；浏览器走 Web Speech API */
export const isNativeShell = isNative

/** 两条路都不通时，UI 要退化成输入法模式 */
export function webSpeechSupported(): boolean {
  const w = window as unknown as Record<string, unknown>
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition)
}

// 中英混说时，两段之间该不该补空格：中文之间不补，ASCII 之间要补
function needsSpace(a: string, b: string): boolean {
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)
}

export function joinSegments(a: string, b: string): string {
  const x = a.trim(), y = b.trim()
  if (!x) return y
  if (!y) return x
  return needsSpace(x, y) ? `${x} ${y}` : x + y
}

/** 检查/申请麦克风权限。返回 false 表示用户拒绝或设备不支持。 */
export async function ensureMicPermission(): Promise<boolean> {
  if (!isNative()) return true // 浏览器由 getDisplayMedia/Web Speech 自己弹权限
  try {
    const cur: PermissionStatus = await SpeechRecognition.checkPermissions()
    if (cur.speechRecognition === 'granted') return true
    const next: PermissionStatus = await SpeechRecognition.requestPermissions()
    return next.speechRecognition === 'granted'
  } catch {
    return false
  }
}

/**
 * 开始一次按住说话。返回的对象负责停止；文本通过 onText 持续回调。
 * 失败时抛异常，由调用方决定怎么提示。
 */
export async function startDictation(
  cb: DictationCallbacks,
  lang = 'zh-CN',
): Promise<Dictation> {
  return isNative() ? startNative(cb, lang) : startWeb(cb, lang)
}

// ── 原生（Android）───────────────────────────────────────────────────────
async function startNative(cb: DictationCallbacks, lang: string): Promise<Dictation> {
  const available = await SpeechRecognition.available().catch(() => ({ available: false }))
  if (!available.available) {
    throw new Error('设备没有可用的语音识别服务')
  }

  let committed = ''      // 已结束分段的累计
  let segText = ''        // 当前分段（会随 partial 反复改写）
  let held = true
  let finished = false    // stop() 之后为 true，禁止再重启
  let restarting = false
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let lastEventAt = Date.now()

  const emit = () => cb.onText(joinSegments(committed, segText))

  const handles: Array<{ remove: () => Promise<void> }> = []

  const commitSegment = () => {
    committed = joinSegments(committed, segText)
    segText = ''
    emit()
  }

  const restart = () => {
    if (!held || finished || restarting) return
    restarting = true
    setTimeout(async () => {
      restarting = false
      if (!held || finished) return
      try {
        await SpeechRecognition.start({
          language: lang,
          maxResults: 3,
          partialResults: true,   // 必须为 true：本插件只有这条路能持续吐字
          popup: false,           // popup=true 时 Android 端不支持 partialResults
        })
        lastEventAt = Date.now()
        cb.onStatus?.('listening')
      } catch {
        // start 被拒（RECOGNIZER_BUSY 等）不该中断按住 —— 隔一拍再试
        if (held && !finished) setTimeout(restart, 400)
      }
    }, RESTART_DELAY_MS)
  }

  /** 一段结束：等一小会儿收下尾音，再 commit 并重启 */
  const finishSegment = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (finished) { commitSegment(); return }
      commitSegment()
      restart()
    }, SEGMENT_SETTLE_MS)
  }

  handles.push(await SpeechRecognition.addListener('partialResults', (data) => {
    lastEventAt = Date.now()
    const m = data?.matches?.[0]
    if (typeof m === 'string' && m) { segText = m; emit() }
  }))

  handles.push(await SpeechRecognition.addListener('listeningState', (data) => {
    lastEventAt = Date.now()
    if (data?.status === 'stopped' && !finished) finishSegment()
  }))

  // 看门狗：插件出错时是静默的（见文件头），只能靠「太久没动静」兜底
  const watchdog = setInterval(() => {
    if (finished || !held) return
    if (Date.now() - lastEventAt > IDLE_RESTART_MS) {
      lastEventAt = Date.now()
      commitSegment()
      restart()
    }
  }, 900)

  const cleanup = async () => {
    finished = true
    clearInterval(watchdog)
    if (settleTimer) clearTimeout(settleTimer)
    for (const h of handles) { try { await h.remove() } catch { /* 卸载失败无所谓 */ } }
  }

  cb.onStatus?.('listening')
  await SpeechRecognition.start({
    language: lang, maxResults: 3, partialResults: true, popup: false,
  })

  return {
    stop: async () => {
      held = false
      finished = true
      clearInterval(watchdog)
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
      try { await SpeechRecognition.stop() } catch { /* 已经停了 */ }
      commitSegment()
      await cleanup()
      cb.onStatus?.('idle')
      return joinSegments(committed, segText)
    },
  }
}

// ── 浏览器（Web Speech API）──────────────────────────────────────────────
interface WebSR {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
  onend: (() => void) | null
}

async function startWeb(cb: DictationCallbacks, lang: string): Promise<Dictation> {
  const w = window as unknown as { SpeechRecognition?: new () => WebSR; webkitSpeechRecognition?: new () => WebSR }
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!Ctor) throw new Error('NO_SPEECH_API')

  let committed = ''
  let segText = ''
  let held = true
  let rec: WebSR | null = null

  const emit = () => cb.onText(joinSegments(committed, segText))

  const build = () => {
    const r = new Ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    r.onresult = (ev: unknown) => {
      const e = ev as { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        const t = res[0]?.transcript ?? ''
        if (res.isFinal) committed = joinSegments(committed, t)
        else interim += t
      }
      segText = interim
      emit()
    }
    r.onerror = (ev: unknown) => {
      const err = (ev as { error?: string })?.error
      if (err && err !== 'no-speech' && err !== 'aborted') cb.onError?.(String(err))
    }
    r.onend = () => {
      // Chrome 在静音后会自己结束；还按着就接着听
      if (!held) return
      committed = joinSegments(committed, segText)
      segText = ''
      emit()
      setTimeout(() => { if (held) { try { rec = build(); rec.start() } catch { /* 忽略 */ } } }, RESTART_DELAY_MS)
    }
    return r
  }

  rec = build()
  rec.start()
  cb.onStatus?.('listening')

  return {
    stop: async () => {
      held = false
      try { rec?.stop() } catch { /* 已停 */ }
      committed = joinSegments(committed, segText)
      segText = ''
      cb.onStatus?.('idle')
      return committed
    },
  }
}
