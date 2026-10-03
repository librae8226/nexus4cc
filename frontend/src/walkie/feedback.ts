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
    master.gain.value = 0.55          // 手机小喇叭本来就弱，宁可响一点（有静音开关兜底）
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
  if (master) master.gain.value = next ? 0 : 0.55
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

  // 1) 噪声瞬态：那声"嗒"的锐利部分。带通放宽、中心放低 ——
  //    太窄太高会变成"嘶"，宽一点低一点才有"嗒"的实体感。
  const dur = 0.055
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
  ng.gain.exponentialRampToValueAtTime(0.78 * s, t + 0.0015)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  noise.connect(bp)
  bp.connect(ng)
  ng.connect(master)
  noise.start(t)
  noise.stop(t + dur)

  // 1.5) 低频"body"：一个很短的 380Hz。手机小喇叭在 300–600Hz 反而比 1.5kHz 出得来，
  //      这一层负责让节点听起来**有分量**，和细分的"嗒"拉开差距。
  {
    const osc = c.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(430, t)
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.04)
    const bg = c.createGain()
    bg.gain.setValueAtTime(0.28 * s, t)
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.055)
    osc.connect(bg); bg.connect(master)
    osc.start(t); osc.stop(t + 0.06)
  }

  // 2) 谐振体：三个不同衰减速度的谐波叠在一起，像金属件被拨了一下。
  //    只留两个会听出"电子滴答"，加个高频短衰减的才有"咔"的边。
  for (const [freq, amp, decay] of [[1250, 0.22, 0.055], [2500, 0.17, 0.04], [4300, 0.09, 0.022]] as const) {
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
  const dur = 0.018
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-(i / len) * 26)
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  // 原来放在 3.2k：手机小喇叭在这个频段衰减很快，推不出来就"听不见"。
  // 挪到 2.2k 左右，既还比节点高、听得出"细"，又能真的响。
  bp.frequency.value = 2100 + Math.random() * 600
  bp.Q.value = 1.0
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.34, t + 0.001)
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

/**
 * 三档震动，用的是插件在 Android 上的实际参数（读 HapticsImpactType.java 得到的）：
 *   LIGHT  50ms @ 振幅 110
 *   MEDIUM 43ms @ 振幅 180   ← 比 LIGHT 更短更实，"格"用这个
 *   HEAVY  60ms @ 振幅 255   ← 吸附用这个
 *
 * 不用 selectionChanged：它必须先 selectionStart() 才会震（插件源码里
 * `if (this.selectionStarted)`），没调就是彻底空转 —— 早先版本"每过一格震一下"
 * 其实一次都没震过，用户摸到的只有吸附那一下。
 */
export function hapticDown(): void {
  if (isNative()) { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); return }
  try { navigator.vibrate?.(10) } catch { /* 桌面不支持就算了 */ }
}

/** 过一次节点 */
export function hapticTick(): void {
  if (isNative()) { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); return }
  try { navigator.vibrate?.(18) } catch { /* 桌面不支持就算了 */ }
}

/** 吸附到位 */
export function hapticSnap(): void {
  if (isNative()) { Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {}); return }
  try { navigator.vibrate?.(32) } catch { /* 桌面不支持就算了 */ }
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
