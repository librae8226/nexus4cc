// walkie/audio.ts — 麦克风采集 + 静音切段 + WAV 编码
//
// 【为什么不用 MediaRecorder】
// MediaRecorder 只能拿去整段音频，中间插不进去 —— 想要"边说边出字"就必须能
// 按段切。这里直接抓 PCM：
//
//   getUserMedia（带 AEC/降噪）→ AudioContext → ScriptProcessorNode → Float32 缓冲
//
// 于是拿到的是裸样本，切段、算音量、编 WAV 全都随自己。顺便还省掉了
// MediaRecorder 那套 MIME 协商（不同 WebView 支持的容器不一样，是个静默的坑）。
//
// 【切段是给"边说边出字"用的，不是最终结果】
// 本机 ASR 常驻之后解一小段只要几十毫秒（实测 3–5 秒的音频 ~0.08s），所以切成
// 小段分别转、边转边冒字，几乎不花钱。切段只在**能量低谷**切 —— 说白了就是个最简 VAD。
//
// 但分段解码有个绕不开的毛病：每段各自看不见句子的另一半，而且长句会在
// maxSegmentS 处被**硬切**（那一刀常常落在词中间）。所以松手时会拿整段音频再转一次
// （见 stop() 返回的 whole），那一遍才是最终发出去的文字；分段只是预览。
//
// 【代价】ScriptProcessorNode 是废弃 API，且跑在主线程。但它到处都有，而
// AudioWorklet 要单独加载一个模块文件，在 WebView 里多一层不确定性。
// 每分钟几十次 4096 样本的回调只做一次 slice，实际开销可以忽略。

/** 采到一段音频。wav 是完整可播的 16-bit PCM WAV。 */
export interface AudioSegment {
  index: number
  wav: Blob
  seconds: number
}

export interface CaptureOptions {
  /** 静音多久算一句话说完 */
  silenceHoldMs?: number
  /** 一段最少多长（太短不切，免得把一口气拆成好几段） */
  minSegmentS?: number
  /** 一段最长多长（长时间不停顿也要切，否则转写延迟一直涨） */
  maxSegmentS?: number
}

export interface Capture {
  /**
   * 停止采集。返回**整段**录音（从第一声到最后一个字，掐掉首尾静音）——
   * 松手后的"第二遍"用它再转一次，那是最终发出去的文字。
   * 没录到有效声音时返回 null。
   */
  stop: () => Promise<{ wav: Blob; seconds: number } | null>
}

const DEFAULTS = {
  silenceHoldMs: 420,
  minSegmentS: 2.2,
  // 硬切上限。松手后还有整段那一遍兜底，所以这里可以放宽一点 ——
  // 切得越少，预览文字越接近最终文字，看起来就不"跳"。
  maxSegmentS: 12,
}

/**
 * 静音判定阈值（RMS）的下限。手机离嘴 20cm 说话大约在 0.05–0.15，安静房间底噪 ~0.003。
 * 因为切段是在"静音已经持续 420ms"之后才做，段尾天然带着一段停顿，
 * 不需要再往回补 —— 段尾落在自然停顿上，不会切在词中间。
 *
 * 实际阈值是自适应的：见 startCapture 里的 floor 追踪。固定阈值在两种情况下都会翻车 ——
 * 底噪高的设备上永远不"静音"（只能靠 maxSegmentS 硬切，文字出得晚），
 * 而更糟的是**纯噪声会被当成一段话送去转写**：SenseVoice 对非语音输入会一本正经地
 * 编出一句听上去很合理的话（模拟器上实测，静音输入转出 6 个字的幻觉）。
 * 所以除了阈值自适应，切段时还要看这一段里"有声"的部分够不够，不够就整段丢掉。
 */
const SILENCE_RMS = 0.012
/** 一段里至少要有这么多秒是"有声"的，才值得送去转写 */
const MIN_VOICED_S = 0.25

export function captureSupported(): boolean {
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown; isSecureContext?: boolean }
  return !!(w.AudioContext || w.webkitAudioContext)
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as unknown as { ScriptProcessorNode?: unknown }).ScriptProcessorNode !== 'undefined'
    && w.isSecureContext !== false
}

/** 把若干 Float32 块编成 16-bit 单声道 WAV */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buf = new ArrayBuffer(44 + total * 2)
  const dv = new DataView(buf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); dv.setUint32(4, 36 + total * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, total * 2, true)
  let o = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]))
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/**
 * 开始采集。每切出一段就回调一次 onSegment（顺序调用，但转写是异步的，
 * 调用方要自己按 index 归位）。
 */
export async function startCapture(
  onSegment: (seg: AudioSegment) => void,
  onLevel?: (rms: number) => void,
  opts: CaptureOptions = {},
): Promise<Capture> {
  const { silenceHoldMs, minSegmentS, maxSegmentS } = { ...DEFAULTS, ...opts }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })

  const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
  // 尽量直接采到 16k（ASR 要的采样率），拿不到就用设备默认，由服务端重采样
  let ctx: AudioContext
  try { ctx = new Ctor({ sampleRate: 16000 }) } catch { ctx = new Ctor() }
  if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* 由用户手势兜底 */ } }

  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  // ScriptProcessor 必须接到 destination 才会被驱动。中间串一个静音增益，
  // 否则麦克风会直接回放出来（啸叫）。
  const mute = ctx.createGain()
  mute.gain.value = 0
  src.connect(proc)
  proc.connect(mute)
  mute.connect(ctx.destination)

  const rate = ctx.sampleRate
  const minSamples = Math.floor(minSegmentS * rate)
  const maxSamples = Math.floor(maxSegmentS * rate)
  const silenceBlocks = Math.max(1, Math.round((silenceHoldMs / 1000) * rate / 4096))

  let cur: Float32Array[] = []
  let curLen = 0
  let curVoiced = 0          // 这一"有声"的样本数
  let quietRun = 0
  let index = 0
  let stopped = false
  let floor: number | null = null   // 底噪估计（各块 RMS 的运行最小值）

  // 整段留一份底稿，只为了松手后的第二遍解码。分段是给"边说边出字"用的预览，
  // 最终发出去的是整段的结果 —— 一次解码看得见整句话的上下文，也不会在
  // maxSegmentS 那一刻被硬切在词中间。
  const all: Float32Array[] = []
  let allLen = 0
  let firstVoicedAt = -1     // 第一个"有声"样本的绝对下标
  let lastVoicedAt = -1

  const flush = () => {
    const voiced = curVoiced
    if (!curLen) return
    // 长度不够，或者里面几乎没有"有声"部分 —— 噪声/误触，整段丢掉。
    // 第二道门是关键：只按长度过滤的话，安静房间里的一次咳嗽、模拟器的底噪
    // 都会被送去转写，而 SenseVoice 会为它编出一句话来。
    if (curLen < rate * 0.35 || voiced < rate * MIN_VOICED_S) {
      cur = []; curLen = 0; curVoiced = 0; quietRun = 0
      return
    }
    const blob = encodeWav(cur, rate)
    const seconds = curLen / rate
    cur = []; curLen = 0; curVoiced = 0; quietRun = 0
    onSegment({ index: index++, wav: blob, seconds })
  }

  proc.onaudioprocess = (ev) => {
    if (stopped) return
    const input = ev.inputBuffer.getChannelData(0)
    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    const rms = Math.sqrt(sum / input.length)
    onLevel?.(rms)

    // 自适应阈值：底噪高的设备（笔记本风扇、廉价麦）不该因为它永远不"静音"，
    // 就一直攒到上限才切。低于当前阈值的块才用来更新底噪估计。
    const threshold = Math.max(SILENCE_RMS, (floor ?? 0) * 3)
    const voiced = rms >= threshold
    if (!voiced) floor = floor === null ? rms : Math.min(floor, rms)

    cur.push(new Float32Array(input))   // 必须拷一份，inputBuffer 会被复用
    curLen += input.length
    if (voiced) {
      curVoiced += input.length
      if (firstVoicedAt < 0) firstVoicedAt = allLen
      lastVoicedAt = allLen + input.length
    }
    all.push(cur[cur.length - 1])       // 同一份拷贝，不额外占内存
    allLen += input.length

    if (!voiced) {
      quietRun++
      // 静音够久 + 这一段已经攒够长度 → 在这里断句
      if (quietRun >= silenceBlocks && curLen >= minSamples) { flush(); return }
    } else {
      quietRun = 0
    }
    // 一直不停顿也要切，否则转写延迟随录音时长线性涨
    if (curLen >= maxSamples) flush()
  }

  return {
    stop: async () => {
      stopped = true
      proc.onaudioprocess = null as unknown as (ev: AudioProcessingEvent) => void
      try { src.disconnect(); proc.disconnect(); mute.disconnect() } catch { /* 已经断了 */ }
      for (const t of stream.getTracks()) { try { t.stop() } catch { /* 已经停了 */ } }
      flush()
      try { await ctx.close() } catch { /* 已经关了 */ }
      const whole = wholeWav(all, allLen, rate, firstVoicedAt, lastVoicedAt)
      all.length = 0
      return whole
    },
  }
}

/** 首尾各留这一点静音：切在字上会让模型的注意力变差 */
const PAD_S = 0.18

/**
 * 把整段录音拼成一个 WAV，掐掉首尾静音。
 *
 * 为什么值得单独做一遍：分段是**在 9 秒处硬切**的（maxSegmentS），一刀下去
 * 常常落在词中间；而且每段各自解码，看不见句子另一半的上下文。
 * 整段一次解码没这两个问题，而本机 ASR 常驻后解 5 秒音频只要 ~0.1 秒，贵得起。
 */
function wholeWav(
  chunks: Float32Array[], total: number, rate: number, from: number, to: number,
): { wav: Blob; seconds: number } | null {
  if (!chunks.length || total <= 0 || from < 0 || to <= from) return null
  const pad = Math.floor(PAD_S * rate)
  const a = Math.max(0, from - pad)
  const b = Math.min(total, to + pad)
  const out = new Float32Array(b - a)
  let at = 0
  for (const c of chunks) {
    const end = at + c.length
    if (end > a && at < b) {
      const s = Math.max(a, at) - at
      const e = Math.min(b, end) - at
      out.set(c.subarray(s, e), Math.max(0, at - a))
    }
    at = end
    if (at >= b) break
  }
  if (out.length < rate * 0.3) return null
  return { wav: encodeWav([out], rate), seconds: out.length / rate }
}
