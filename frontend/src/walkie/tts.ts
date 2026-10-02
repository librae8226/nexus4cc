// walkie/tts.ts — 把 AI 的回复读出来
//
// 两条路：原生用 Capacitor 的 TTS 插件（走系统语音引擎，中文音色由系统决定，
// 一般比 WebView 内置的好）；浏览器用 speechSynthesis。
// 原生的 speak() 失败时退到 speechSynthesis —— 系统没装 TTS 引擎时不至于直接失声。

import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { isNative } from '../baseUrl'

export interface SpeakOptions {
  /** 语速，1 为常速。口播摘要稍慢一点更清楚 */
  rate?: number
}

let speaking = false

export const isSpeaking = () => speaking

/** 正在播报时先掐断，避免两条语音叠在一起 */
export async function stopSpeaking(): Promise<void> {
  speaking = false
  try {
    if (isNative()) await TextToSpeech.stop()
  } catch { /* 没在播 */ }
  try { window.speechSynthesis?.cancel() } catch { /* 浏览器没这个 API */ }
}

export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const body = text.trim()
  if (!body) return
  await stopSpeaking()

  const rate = opts.rate ?? 1.0

  if (isNative()) {
    try {
      speaking = true
      await TextToSpeech.speak({
        text: body,
        lang: 'zh-CN',
        rate,
        pitch: 1.0,
        volume: 1.0,
        category: 'playback',
      })
      speaking = false
      return
    } catch {
      speaking = false
      // 落到下面的 speechSynthesis
    }
  }

  const synth = window.speechSynthesis
  if (!synth) return
  await new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(body)
    u.lang = 'zh-CN'
    u.rate = rate
    // 挑一个中文音色，没有就用默认的
    const zh = synth.getVoices().find((v) => /^zh/i.test(v.lang))
    if (zh) u.voice = zh
    u.onend = () => { speaking = false; resolve() }
    u.onerror = () => { speaking = false; resolve() }
    speaking = true
    synth.speak(u)
    // 兜底：某些 WebView 的 onend 不触发，别让 promise 永远挂着
    setTimeout(() => { speaking = false; resolve() }, Math.max(4000, body.length * 220))
  })
}
