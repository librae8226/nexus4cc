// walkie/feedback.ts — 旋钮的"手感"：咔嗒声 + 震动
//
// 为什么用 WebAudio 合成而不是塞一个 mp3：旋钮每过一格都要响，而且响的强度
// 跟着转速走。合成出来的每一声都能轻微变化（音高/响度扰动），比循环同一个
// 采样更像真东西；也不用多一个资源文件走网络。
//
// 一声"咔"拆两层：
//   1) 噪声瞬态（~3ms，2.4kHz 带通）—— 就是那声"嗒"的锐利部分
//   2) 两个快速衰减的谐振（1.75k / 3.3k）—— 给它一点实体感，不然只有"嘶"没有"咔"
//
// 震动走 navigator.vibrate。Android 上需要 manifest 里的 VIBRATE 权限，
// 否则调用是静默空转（上一版就是这样，所以"震一下"从来没生效过）。

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = w.AudioContext || w.webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.32          // 够清楚但不吵
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** 必须在一次用户手势里调用：浏览器不允许在没有交互的情况下出声 */
export function primeFeedback(): void {
  audio()
}

export function setMuted(next: boolean): void {
  muted = next
  if (master) master.gain.value = next ? 0 : 0.32
}

export function isMuted(): boolean {
  return muted
}

/**
 * 一声"咔"。strength 0..1，转得快时可以给大一点。
 */
export function tick(strength = 1): void {
  const c = audio()
  if (!c || !master || muted) return
  const t = c.currentTime
  const s = Math.max(0.15, Math.min(1, strength))

  // 1) 噪声瞬态
  const dur = 0.042
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const x = i / len
    data[i] = (Math.random() * 2 - 1) * Math.exp(-x * 46)
  }
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 2300 + Math.random() * 500      // 每一声略有不同
  bp.Q.value = 1.05
  const ng = c.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.55 * s, t + 0.0015)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  noise.connect(bp)
  bp.connect(ng)
  ng.connect(master)
  noise.start(t)
  noise.stop(t + dur)

  // 2) 谐振体
  for (const [freq, amp] of [[1750, 0.16], [3300, 0.085]] as const) {
    const osc = c.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq * (0.97 + Math.random() * 0.06)
    const og = c.createGain()
    og.gain.setValueAtTime(amp * s, t)
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.034)
    osc.connect(og)
    og.connect(master)
    osc.start(t)
    osc.stop(t + 0.04)
  }
}

/** 吸附到位的低沉一点的一声 */
export function thunk(): void {
  const c = audio()
  if (!c || !master || muted) return
  const t = c.currentTime
  const osc = c.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(220, t)
  osc.frequency.exponentialRampToValueAtTime(120, t + 0.07)
  const g = c.createGain()
  g.gain.setValueAtTime(0.22, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
  osc.connect(g)
  g.connect(master)
  osc.start(t)
  osc.stop(t + 0.1)
}

/** 微弱震动。毫秒级，别把马达震麻。 */
export function haptic(ms = 7): void {
  try { navigator.vibrate?.(ms) } catch { /* 桌面或不支持就算了 */ }
}
