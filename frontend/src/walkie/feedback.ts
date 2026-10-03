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
// 【震动为什么不用 navigator.vibrate】
// 它在 Android WebView 里**是存在的**（`typeof === 'function'`，调用还返回 true），
// 但 Chromium 的 WebView 没有实现 VibrationManager，调用是静默空转 —— 返回 true
// 不代表真的震了。所以原生壳里改走 Capacitor 的 Haptics，那是真的在驱动马达；
// navigator.vibrate 只留给浏览器（桌面 Chrome 会忽略，也无所谓）。
//
// 旋钮的"格"用 selectionChanged：这是系统给滚轮/选择器准备的触感，最轻最跟手；
// 吸附到位用 impact(Medium)，重一点，有"到位了"的收束感。

import { Haptics, ImpactStyle } from '@capacitor/haptics'

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

  // 1) 噪声瞬态：那声"嗒"的锐利部分。带通放宽（Q 从 1.05 降到 0.8）、
  //    中心从 2.3k 下到 1.8k —— 太窄太高会变成"嘶"，宽一点低一点才有"嗒"的实体感。
  const dur = 0.048
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const x = i / len
    data[i] = (Math.random() * 2 - 1) * Math.exp(-x * 42)
  }
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1650 + Math.random() * 550      // 每一声略有不同，免得像电子音
  bp.Q.value = 0.8
  const ng = c.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.5 * s, t + 0.0015)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  noise.connect(bp)
  bp.connect(ng)
  ng.connect(master)
  noise.start(t)
  noise.stop(t + dur)

  // 2) 谐振体：三个不同衰减速度的谐波叠在一起，像金属件被拨了一下。
  //    只留两个会听出"电子滴答"，加个高频短衰减的才有"咔"的边。
  for (const [freq, amp, decay] of [[1250, 0.13, 0.05], [2500, 0.10, 0.036], [4300, 0.05, 0.02]] as const) {
    const osc = c.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq * (0.96 + Math.random() * 0.08)
    const og = c.createGain()
    og.gain.setValueAtTime(amp * s, t)
    og.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    osc.connect(og)
    og.connect(master)
    osc.start(t)
    osc.stop(t + decay + 0.01)
  }
}

/**
 * 细分格的轻"嗒"。
 *
 * 为什么要有它：只在节点出声的话，两格之间是死寂的，划起来像在拨一个接触不良的开关。
 * 真实的编码器（带格的那种）每转一点点都有细微的动静，节点只是**更重**而已。
 *
 * 为什么细分不震：一秒钟能划过十几个细分，每个都震会把马达变成背景噪音、手指发麻，
 * 反而把"到节点了"这个信息淹掉。震动只留给节点，节点才显得重。
 */
export function tickFine(): void {
  const c = audio()
  if (!c || !master || muted) return
  const t = c.currentTime
  const dur = 0.013
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-(i / len) * 30)
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 3200 + Math.random() * 700   // 比节点高一个八度，听起来更"细"
  bp.Q.value = 1.3
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.13, t + 0.001)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  noise.connect(bp); bp.connect(g); g.connect(master)
  noise.start(t); noise.stop(t + dur)
}

/**
 * "发出去了"的一声。必须和旋钮的咔嗒明显不同 —— 发送是圆心轻点触发的，
 * 手势本身没有位移，声音是唯一能确证"这一下真的发出去了"的反馈。
 * 做成一声上扬的气流（带通从 900Hz 扫到 2600Hz），听起来像"送去"。
 */
export function whoosh(): void {
  const c = audio()
  if (!c || !master || muted) return
  const t = c.currentTime
  const dur = 0.16
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const x = i / len
    data[i] = (Math.random() * 2 - 1) * (1 - x) * Math.min(1, x * 8)   // 快速起、缓慢落
  }
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 1.1
  bp.frequency.setValueAtTime(900, t)
  bp.frequency.exponentialRampToValueAtTime(2600, t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  noise.connect(bp); bp.connect(g); g.connect(master)
  noise.start(t); noise.stop(t + dur)
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

function isNative(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return !!w.Capacitor?.isNativePlatform?.()
}

/** 过一格：最轻的触感，跟手用 */
export function hapticTick(): void {
  if (isNative()) { Haptics.selectionChanged().catch(() => {}); return }
  try { navigator.vibrate?.(6) } catch { /* 桌面不支持就算了 */ }
}

/** 吸附到位 / 按下：明显一点的一声 */
export function hapticSnap(): void {
  if (isNative()) { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); return }
  try { navigator.vibrate?.(16) } catch { /* 桌面不支持就算了 */ }
}

/**
 * 音频解锁：浏览器要求 AudioContext 必须在一次真实用户手势里创建/恢复，
 * 否则一直是 suspended，咔嗒声出不来。挂在第一次触摸上，越早越好。
 */
export function attachAudioUnlock(): () => void {
  const unlock = () => { primeFeedback() }
  const opts = { passive: true } as AddEventListenerOptions
  document.addEventListener('touchstart', unlock, opts)
  document.addEventListener('mousedown', unlock, opts)
  document.addEventListener('keydown', unlock, opts)
  return () => {
    document.removeEventListener('touchstart', unlock)
    document.removeEventListener('mousedown', unlock)
    document.removeEventListener('keydown', unlock)
  }
}
