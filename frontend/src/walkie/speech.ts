// walkie/speech.ts — 按住说话的录音与转写
//
// 【为什么不再是 Android 的 SpeechRecognizer】
// 上一版走 @capacitor-community/speech-recognition。真机实测：权限给了、按下去也进
// 了"松手结束"状态，但**一个字都不吐**——国产 ROM 上没有可用的 Google 语音服务，
// 而该插件出错是静默的（partialResults 模式下 onError 的 reject 打在已 resolve 的
// call 上，JS 侧什么都收不到）。按住说话于是变成按住没反应。
//
// 现在改成：**App 里录音（MediaRecorder）→ 上传给 Nexus → 本机转写**。
//   - 不依赖任何云端语音服务，国产 ROM 一样能用；
//   - 音频不出本机（转写跑在 ~/work/intake 的 SenseVoice 上）；
//   - 与会议录音共用同一套 ASR，只有一份实现。
// 代价是失去"边说边出字"的实时预览：松手后约 1.5–2 秒出结果。对讲机本来就是
// "说完再看到"，这个取舍可以接受。
//
// 环境要求：secure context。Capacitor 的本地服务在 http://localhost，
// Chrome 视其为可信来源；Android 侧还需要 manifest 里的 RECORD_AUDIO 与
// MODIFY_AUDIO_SETTINGS（Capacitor 的 onPermissionRequest 会把 WebView 的
// 录音请求映射到这两个权限）。

export type DictationStatus = 'starting' | 'recording' | 'transcribing' | 'idle'

export interface DictationCallbacks {
  onStatus?: (status: DictationStatus) => void
  onError?: (message: string) => void
}

export interface Dictation {
  /** 松手：停止录音、上传转写、返回文本 */
  stop: () => Promise<string>
}

/** 录音期间已录了多少秒（UI 显示用） */
export interface RecordingInfo {
  elapsedMs: number
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

function pickMime(): string | undefined {
  const MR = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
  if (!MR?.isTypeSupported) return undefined
  return MIME_CANDIDATES.find((m) => MR.isTypeSupported(m))
}

/** 这个环境能不能录音。不能则 UI 退化成「点 ⌨ 用输入法」。 */
export function dictationSupported(): boolean {
  const w = window as unknown as { MediaRecorder?: unknown; isSecureContext?: boolean }
  return !!w.MediaRecorder
    && !!navigator.mediaDevices?.getUserMedia
    && w.isSecureContext !== false
}

export function isNativeShell(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return !!w.Capacitor?.isNativePlatform?.()
}

/**
 * 开始一次按住说话。返回的对象负责停止。
 * 失败时抛异常，由调用方决定怎么提示。
 */
export async function startDictation(
  token: string,
  cb: DictationCallbacks = {},
): Promise<Dictation> {
  if (!dictationSupported()) throw new Error('NO_MEDIA_API')

  cb.onStatus?.('starting')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('MIC_DENIED')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('MIC_MISSING')
    throw new Error(`MIC_FAILED:${name || String(e)}`)
  }

  const mime = pickMime()
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data) }

  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve()
    // 有些 WebView 在轨道被外部停掉时不发 onstop，兜一个底
    setTimeout(() => resolve(), 4000)
  })

  rec.start(250)
  cb.onStatus?.('recording')

  const releaseTracks = () => {
    for (const t of stream.getTracks()) { try { t.stop() } catch { /* 已经停了 */ } }
  }

  return {
    stop: async () => {
      if (rec.state !== 'inactive') { try { rec.stop() } catch { /* 已停 */ } }
      await stopped
      releaseTracks()

      const blob = new Blob(chunks, { type: mime || 'audio/webm' })
      if (blob.size < 1200) {                  // 一按就松：给个明确结果，别静默
        cb.onStatus?.('idle')
        return ''
      }

      cb.onStatus?.('transcribing')
      try {
        const text = await uploadForTranscription(token, blob, mime)
        cb.onStatus?.('idle')
        return text
      } catch (e) {
        cb.onStatus?.('idle')
        cb.onError?.(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
  }
}

const EXT: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
}

async function uploadForTranscription(token: string, blob: Blob, mime?: string): Promise<string> {
  const base = (mime || 'audio/webm').split(';')[0]
  const name = `clip.${EXT[base] || 'webm'}`
  const res = await fetch(`/api/walkie/transcribe?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'Content-Type': base,
      Authorization: `Bearer ${token}`,
    },
    body: blob,
  })
  const data = await res.json().catch(() => null) as { text?: string; error?: string; detail?: string } | null
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
  if (msg.startsWith('MIC_FAILED')) return `麦克风打不开：${msg.slice(11)}`
  return `转写失败：${msg}`
}
