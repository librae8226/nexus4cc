// walkie/speech.ts — 按住说话的转写
//
// 【为什么不是 Android 的 SpeechRecognizer】
// 真机实测：权限给了、按下去也进了"松手结束"状态，但一个字都不吐 —— 国产 ROM 上
// 没有可用的 Google 语音服务，而那个插件出错是静默的（partialResults 模式下
// onError 的 reject 打在一个已 resolve 的 call 上，JS 侧什么都收不到）。
// 按住说话于是变成按住没反应，且没有任何提示。
//
// 【现在的做法】App 里抓 PCM → 按静音切段 → 逐段送到 Nexus → 本机 intake 的
// SenseVoice 转写。音频不出本机，也不依赖任何云端服务。
//
// 【为什么能"边说边出字"】
// 本机 ASR 常驻后解一小段只要几十毫秒（实测 3–5 秒音频 ~0.08s），所以切成小段
// 分别转、边转边冒字，几乎不花钱。切段由 audio.ts 的静音检测负责，只在能量低谷切。
//
// 【但分段只是预览】每段各自看不见句子的另一半，长句还会在 maxSegmentS 处被硬切。
// 所以松手时会**拿整段音频再转一次**，那一遍才是最终发出去的文字；
// 它失败就退回分段拼出来的，绝不因为这一遍而丢字。

import { captureSupported, startCapture, type AudioSegment, type Capture } from './audio'

export type DictationStatus = 'starting' | 'recording' | 'transcribing' | 'idle'

export interface DictationCallbacks {
  onStatus?: (status: DictationStatus) => void
  /** 边说边出字：已确定部分的拼接，会随录音增长 */
  onLive?: (text: string) => void
  /** 0..1 的音量，画波形用 */
  onLevel?: (level: number) => void
  onError?: (message: string) => void
}

export interface Dictation {
  /** 松手：停止采集、等最后一段转写完、返回全文 */
  stop: () => Promise<string>
}

/** 这个环境能不能按住说话。不能则 UI 退化成「点 ⌨ 用输入法」。 */
export function dictationSupported(): boolean {
  return captureSupported()
}

export function isNativeShell(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return !!w.Capacitor?.isNativePlatform?.()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startDictation(
  token: string,
  cb: DictationCallbacks = {},
): Promise<Dictation> {
  if (!dictationSupported()) throw new Error('NO_MEDIA_API')

  cb.onStatus?.('starting')

  /** 按 index 归位：转写是并发的，回来的顺序不保证 */
  const parts: (string | null)[] = []
  let inflight = 0
  let firstError: string | null = null
  let idleWaiters: Array<() => void> = []

  /** 只拼到第一个还没回来的段落 —— 后面的先不显示，免得文字跳来跳去 */
  const settledText = () => {
    const out: string[] = []
    for (const p of parts) { if (p === null) break; out.push(p) }
    return out.join('')
  }

  const handle = (seg: AudioSegment) => {
    parts[seg.index] = null
    inflight++
    transcribeSegment(token, seg)
      .then((t) => { parts[seg.index] = t })
      .catch((e) => {
        parts[seg.index] = ''
        if (!firstError) firstError = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
        inflight--
        cb.onLive?.(settledText())
        if (inflight === 0) { const w = idleWaiters; idleWaiters = []; w.forEach((f) => f()) }
      })
  }

  let capture: Capture
  try {
    capture = await startCapture(handle, cb.onLevel, {})
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('MIC_DENIED')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('MIC_MISSING')
    throw new Error(`MIC_FAILED:${name || String(e)}`)
  }

  cb.onStatus?.('recording')

  return {
    stop: async () => {
      cb.onStatus?.('transcribing')
      const whole = await capture.stop()
      // 等在飞的转写落地。给个上限，别让网络问题把"松手"卡死。
      const deadline = Date.now() + 40_000
      while (inflight > 0 && Date.now() < deadline) {
        await Promise.race([
          new Promise<void>((r) => idleWaiters.push(r)),
          sleep(300),
        ])
      }
      const live = parts.filter((p) => p !== null).join('').trim()

      // 【第二遍，也是最终说了算的那一遍】把整段音频重新解码一次。
      // 分段那几遍只是"边说边出字"的预览：它们各自看不见句子的另一半，
      // 而且长句会在 maxSegmentS（9s）处被硬切在词中间。
      let finalText = ''
      if (whole) {
        try {
          finalText = (await transcribeSegment(token, { index: -1, wav: whole.wav, seconds: whole.seconds })).trim()
        } catch { /* 整段这遍失败就用分段拼出来的，绝不因此丢掉文字 */ }
      }
      cb.onStatus?.('idle')
      const text = finalText || live
      // 一段都没转出来、而且确实报过错 —— 把那个错抛上去，别静默返回空串
      if (!text && firstError) throw new Error(firstError)
      return text
    },
  }
}

async function transcribeSegment(token: string, seg: AudioSegment): Promise<string> {
  const res = await fetch(`/api/walkie/transcribe?name=seg${seg.index}.wav`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${token}` },
    body: seg.wav,
  })
  const data = (await res.json().catch(() => null)) as { text?: string; error?: string; detail?: string } | null
  if (!res.ok) {
    if (res.status === 503) throw new Error('ASR_DOWN')
    throw new Error(`TRANSCRIBE_FAILED:${data?.detail || data?.error || res.status}`)
  }
  return (data?.text || '').trim()
}

/** 把内部错误码翻成人话 */
export function explainDictationError(msg: string): string {
  if (msg === 'NO_MEDIA_API') return '这个环境不支持录音（需要 HTTPS 或 localhost）。点 ⌨ 用输入法语音键。'
  if (msg === 'MIC_DENIED') return '没有麦克风权限。到系统设置里给 Nexus 打开「麦克风」，或点 ⌨ 用输入法语音键。'
  if (msg === 'MIC_MISSING') return '找不到麦克风设备。'
  if (msg === 'ASR_DOWN') return '本机转写服务没在跑（PM2 的 intake）。点 ⌨ 先用输入法语音键顶着。'
  if (msg === 'NO_TEXT') return '没识别出内容。再说一次，或点 ⌨ 用输入法。'
  if (msg.startsWith('MIC_FAILED')) return `麦克风打不开：${msg.slice(11)}`
  return `转写失败：${msg}`
}
