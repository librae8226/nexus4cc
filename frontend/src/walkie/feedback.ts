// walkie/feedback.ts — 声音与震动
//
// 这一版只剩三种声：
//   whoosh() —— 发出去了（手势本身没有位移，声音是唯一能确证"这一下真的发出去了"的反馈）
//   roger()  —— 他答完了（一声"通话结束"，于是"这一轮完了"是听出来的，不用盯屏幕）
//   land()   —— 精炼稿落进输入框（精炼是在你眼皮底下把你说的话换掉，没有这一声就是"悄悄"变的）
//
// 【震动为什么不用 navigator.vibrate】它在 Android WebView 里**是存在的**
// （`typeof === 'function'`，调用还返回 true），但 Chromium 的 WebView 没有实现
// VibrationManager，调用是**静默空转** —— 返回 true 不代表真的震了。所以原生壳里走
// Capacitor 的 Haptics，那才是真的在驱动马达。
// 也不能用 selectionChanged：插件源码里是 `if (this.selectionStarted)`，不先调
// selectionStart() 就完全不震。详见 docs/WALKIE.md。

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

/**
 * Roger beep —— 对讲机的"通话结束"音，两个上扬的短音。
 *
 * 这是整台机器最有辨识度的一声：**松手（我说完了）和答完（他说完了）都用它**，
 * 于是"一轮对话结束了"这件事变成听出来的，不用盯着屏幕等。
 * 用它替代一段静默，也顺手把 TTS 播报的起头垫住。
 */
export function roger(): void {
  const c = audio()
  if (!c || !master || muted) return
  const t = c.currentTime
  for (const [at, freq, dur] of [[0, 980, 0.075], [0.095, 1420, 0.115]] as const) {
    const osc = c.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq
    const g = c.createGain()
    const s = t + at
    g.gain.setValueAtTime(0.0001, s)
    g.gain.exponentialRampToValueAtTime(0.3, s + 0.006)
    g.gain.setValueAtTime(0.3, s + dur - 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, s + dur)
    osc.connect(g); g.connect(master)
    osc.start(s); osc.stop(s + dur + 0.01)
  }
}

/**
 * 精炼稿落进输入框的一声轻"嗒"。
 *
 * 精炼是**在你眼皮底下把你说的话换掉**，没有这一声，那行字是"悄悄"变的；
 * 有了它，你立刻就注意到"哦，它整理过了"。比 tick 更闷、更轻，不抢节点音的戏。
 */
export function land(): void {
  const c = audio()
  if (!c || !master || muted) return
  const t = c.currentTime
  const dur = 0.03
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-(i / len) * 34)
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1050
  bp.Q.value = 1.4
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.26, t + 0.001)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  noise.connect(bp); bp.connect(g); g.connect(master)
  noise.start(t); noise.stop(t + dur)
}

function isNative(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return !!w.Capacitor?.isNativePlatform?.()
}

/** 吸附到位 */
export function hapticSnap(): void {
  if (isNative()) { Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {}); return }
  try { navigator.vibrate?.(32) } catch { /* 桌面不支持就算了 */ }
}

/** 换了一个说话对象（点某条消息 = 回复给那个人）。最轻的一档，够确认就行。 */
export function hapticTap(): void {
  if (isNative()) { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); return }
  try { navigator.vibrate?.(10) } catch { /* 桌面不支持就算了 */ }
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
