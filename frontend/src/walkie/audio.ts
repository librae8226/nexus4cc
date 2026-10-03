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
// 【为什么按静音切段、而不是固定时长】
// 本机 ASR（SenseVoice）的耗时几乎全是固定开销：1 秒的片段和 3 秒的片段都是
// ~1.4 秒（实测）。所以"切成小段分别转"几乎不额外花钱，还能让文字边说边冒出来。
// 但切在原词中间会切坏字，所以只在**能量低谷**切 —— 说白了就是个最简 VAD。
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
  stop: () => Promise<void>
}

const DEFAULTS = {
  silenceHoldMs: 420,
  minSegmentS: 2.2,
  maxSegmentS: 9,
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
    if (voiced) curVoiced += input.length

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
    },
  }
}
