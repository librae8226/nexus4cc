// walkie/ChannelDial.tsx — 双旋钮频道选择器（拟物）
//
// **外圈 = Agent（channel），内圈 = 工作区（project）。** 外圈更大更好抓，而"换个人"
// 是更常用的动作。名字只在**上方**的读数面板显示 —— 中文绕在圆周上必然被截断，
// 而且两个圈的字混在一起根本分不清；圈上只留刻度。
//
// 【循环】两个圈都能一直转下去，转到底自动回到头。做法是把连续值当成**无界**的
// （可以到 7.3、-2.1），只在取索引时取模；刻度角度用"绕回来的差"算，所以过界那一刻
// 是平滑的，不会跳。
//
// 【拨动时读数实时跟跳】读数从**本组件自己的连续值**算，不等父组件。
// 父组件只在松手时被通知一次 —— 否则每过一格都要打断语音、清空草稿、去拉上一轮回复。
//
// 【手感】一格分 4 个细分：细分只有轻"嗒"、不震；节点是重"咔" + 震；松手吸附"咚" + 更重的震。

import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { WalkieProject } from './api'
import { hapticDown, hapticSnap, hapticTick, primeFeedback, thunk, tick, tickFine } from './feedback'

/** 相邻两项的夹角。循环之后 360/n 才是"铺满一圈"的自然间距。 */
const stepFor = (n: number) => (n <= 1 ? 60 : Math.max(26, 360 / n))
/** 偏离正上方超过这个角度就不画了 —— 在背面，画了只是浪费 */
const VISIBLE_DEG = 104
/** 内外圈的分界（以半个旋钮直径为 1）：外圈刻度在 0.75，内圈在 0.41 */
const RING_SPLIT = 0.60
/**
 * 刻度所在半径，单位是**整个旋钮直径**（translateY 走的是绝对长度）。
 * 换算成"占旋钮半径的比例"要 ×2，所以 0.375 → 75%。
 */
const R_OUTER = 0.375
const R_INNER = 0.205

interface Props {
  projects: WalkieProject[]
  projIdx: number
  chanIdx: number
  /** 只在松手（或点击）时通知一次。拨动过程中的读数由本组件自己跟。 */
  onChange: (projIdx: number, chanIdx: number) => void
  /** 圆心。放在 .walkie-dial 里，这样绝对定位天然居中，不用去算读数面板多高。 */
  children?: React.ReactNode
}

type RingName = 'outer' | 'inner'

interface DragState {
  ring: RingName
  lastAngle: number
  moved: number
}

const normDelta = (d: number) => {
  let x = d
  while (x > 180) x -= 360
  while (x < -180) x += 360
  return x
}
/** 取模到 [0, n) —— 循环的索引换算都走这里 */
const mod = (v: number, n: number) => (n <= 0 ? 0 : ((v % n) + n) % n)
/** 把"第 i 项距离当前值多远"折到半圈以内，这样过界那一刻是接上的，不会跳 */
const wrapDelta = (d: number, n: number) => {
  if (n <= 1) return 0
  const h = n / 2
  return (((d + h) % n) + n) % n - h
}

const SUB = 4

let lastTickAt = 0
/** 走完一整格：重"咔" + 震。划得快时加最小间隔，别把马达震麻。 */
function detent(strength: number) {
  const now = Date.now()
  if (now - lastTickAt < 34) return
  lastTickAt = now
  tick(strength)
  hapticTick()
}

let lastFineAt = 0
/** 走过一个细分：只有轻响，不震。见 feedback.ts 里为什么细分不震。 */
function subDetent() {
  const now = Date.now()
  if (now - lastFineAt < 16) return
  lastFineAt = now
  tickFine()
}

/** 跨过细分就轻响，跨过整数格才重响 + 震。两个判断分开做，"轻"和"重"是叠加的层次。 */
function emitForMove(prev: number, next: number) {
  if (Math.floor(next * SUB) !== Math.floor(prev * SUB)) subDetent()
  if (Math.round(next) !== Math.round(prev)) detent(Math.min(1, 0.55 + Math.abs(next - prev) * 2))
}

const STATUS_TEXT: Record<string, string> = {
  working: '工作中', idle: '空闲', ready: '就绪', offline: '不是 Claude 会话',
}
function statusOf(c?: { kind: string; status?: string }): string {
  if (!c) return 'ready'
  if (c.kind === 'other') return 'offline'
  return c.status || 'ready'
}

export default function ChannelDial({ projects, projIdx, chanIdx, onChange, children }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const dragging = useRef(false)
  // 连续、**无界**的索引：拖动时连续变化，松手吸附到整数。取模之后才是真实下标。
  const [wsVal, setWsVal] = useState(projIdx)     // 内圈 = 工作区
  const [chVal, setChVal] = useState(chanIdx)     // 外圈 = Agent
  const [active, setActive] = useState<RingName | null>(null)

  const nWs = projects.length
  const wsIdx = mod(Math.round(wsVal), nWs)
  const liveChans = useMemo(() => projects[wsIdx]?.channels ?? [], [projects, wsIdx])
  const nCh = liveChans.length
  const chIdx = mod(Math.round(chVal), nCh)
  const curProject = projects[wsIdx]
  const curChannel = liveChans[chIdx]

  const wsStep = stepFor(nWs)
  const chStep = stepFor(nCh)

  // 外面改了索引（换项目后频道被钳位、重新载入等）→ 同步进来。拖动中别打断。
  const syncRef = useRef({ projIdx, chanIdx })
  if (syncRef.current.projIdx !== projIdx || syncRef.current.chanIdx !== chanIdx) {
    syncRef.current = { projIdx, chanIdx }
    if (!dragging.current) {
      if (mod(Math.round(wsVal), nWs) !== projIdx) setWsVal(projIdx)
      if (mod(Math.round(chVal), Math.max(1, nCh)) !== chanIdx) setChVal(chanIdx)
    }
  }

  const angleAt = useCallback((clientX: number, clientY: number) => {
    const el = boxRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    return (Math.atan2(dx, -dy) * 180) / Math.PI   // 0° 在正上方，顺时针为正
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    const el = boxRef.current
    if (!el) return
    // 圆心那颗按钮长在旋钮里面，指针事件会冒泡到这里。旋钮一旦 setPointerCapture，
    // 后续的 pointerup 就全被它截走，圆心的按下/松手再也收不到 ——
    // 表现就是按住说话停不下来。所以圆心上的事件旋钮一律不碰。
    if ((e.target as HTMLElement).closest('.walkie-hub-btn')) return
    primeFeedback()                                 // 借这次手势解锁音频
    const r = el.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    const ring: RingName = Math.hypot(dx, dy) / (r.width / 2) > RING_SPLIT ? 'outer' : 'inner'
    if (ring === 'outer' && nCh < 2) return
    if (ring === 'inner' && nWs < 2) return
    drag.current = { ring, lastAngle: angleAt(e.clientX, e.clientY), moved: 0 }
    dragging.current = true
    setActive(ring)
    hapticDown()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const a = angleAt(e.clientX, e.clientY)
    const delta = normDelta(a - d.lastAngle)
    d.lastAngle = a
    d.moved += Math.abs(delta)

    // 刻度跟着手指走：顺时针拖 → 索引减小（原先前方的格子被转到了顶上）
    if (d.ring === 'outer') {
      setChVal((v) => { const next = v - delta / chStep; emitForMove(v, next); return next })
    } else {
      setWsVal((v) => { const next = v - delta / wsStep; emitForMove(v, next); return next })
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    dragging.current = false
    setActive(null)
    if (!d) return
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)

    if (d.moved < 8) {
      // 基本没动 = 一次点击：按到哪个刻度就跳到哪儿
      const hit = (e.target as HTMLElement).closest('[data-ring]') as HTMLElement | null
      if (hit?.dataset.ring) {
        const idx = Number(hit.dataset.idx)
        hapticSnap()
        if (hit.dataset.ring === 'outer') { setChVal(idx); onChange(wsIdx, mod(idx, nCh)) }
        else { setWsVal(idx); onChange(mod(idx, nWs), 0) }
      }
      return
    }

    thunk()
    hapticSnap()
    // 吸附到整数格，再一次性通知外面 —— 拨动过程中外面完全不受打扰
    const wi = mod(Math.round(wsVal), nWs)
    const chansOfWi = projects[wi]?.channels ?? []
    const ci = mod(Math.round(chVal), Math.max(1, chansOfWi.length))
    setWsVal(wi); setChVal(ci)
    onChange(wi, ci)
  }

  /** 刻度：没有文字，整个环一起转，所以不需要反向旋转保持水平 */
  const renderTicks = (count: number, val: number, step: number, ring: RingName, radiusK: number, sel: number) => {
    const list = []
    for (let i = 0; i < count; i++) {
      const d = wrapDelta(i - val, count)
      const angle = d * step
      if (Math.abs(angle) > VISIBLE_DEG) continue
      const isSel = i === sel
      const fade = Math.max(0.16, 1 - Math.abs(angle) / VISIBLE_DEG)
      list.push(
        <span
          key={`${ring}-${i}`}
          data-ring={ring}
          data-idx={i}
          className={`walkie-notch walkie-notch-${ring}${isSel ? ' is-sel' : ''}`}
          style={{ transform: `rotate(${angle}deg) translateY(calc(var(--walkie-dial) * ${-radiusK}))`, opacity: isSel ? 1 : fade }}
        />,
      )
    }
    return list
  }

  const wsStatus = statusOf(curChannel)
  void wsStatus

  return (
    <>
      {/* 读数面板 —— 车载电台旋钮上方那块屏。拨动时**实时**跟着跳，
          不用等松手才知道转到了哪一格。 */}
      <div className="walkie-readout">
        <div className={`walkie-readout-row${active === 'inner' ? ' is-turn' : ''}`}>
          <i className="walkie-swatch walkie-swatch-ws" aria-hidden="true" />
          <span className="walkie-workspace">{curProject?.path || curProject?.name || '—'}</span>
        </div>
        <div className={`walkie-readout-row walkie-readout-sub${active === 'outer' ? ' is-turn' : ''}`}>
          <i className="walkie-swatch walkie-swatch-agent" aria-hidden="true" />
          <span className="walkie-agent">{curChannel?.name ?? '—'}</span>
          <span className={`walkie-status is-${statusOf(curChannel)}`}>
            <i />{STATUS_TEXT[statusOf(curChannel)]}
          </span>
        </div>
      </div>

      <div
        className={`walkie-dial${active ? ` is-turning is-turning-${active}` : ''}`}
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* 固定指针：不偏任何一圈的颜色 —— 它同时指着内外两圈的正上方那一格 */}
        <div className="walkie-index" aria-hidden="true" />

        {/* 外圈 = Agent（channel） */}
        <div className="walkie-knob walkie-knob-outer" style={{ transform: `rotate(${-chVal * chStep}deg)` }}>
          <div className="walkie-ridges walkie-ridges-outer" />
          {renderTicks(nCh, chVal, chStep, 'outer', R_OUTER, chIdx)}
        </div>

        {/* 内圈 = 工作区（project） */}
        <div className="walkie-knob walkie-knob-inner" style={{ transform: `rotate(${-wsVal * wsStep}deg)` }}>
          <div className="walkie-ridges walkie-ridges-inner" />
          {renderTicks(nWs, wsVal, wsStep, 'inner', R_INNER, wsIdx)}
        </div>

        {/* 圆心：由外面传进来（按住说话 / 轻点发送） */}
        {children}
      </div>
    </>
  )
}
