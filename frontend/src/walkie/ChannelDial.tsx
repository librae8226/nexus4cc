// walkie/ChannelDial.tsx — 双旋钮频道选择器（拟物）
//
// 外圈 = project，内圈 = channel。手指在圈上划圈，旋钮跟着手指转，每过一格
// "咔"一声 + 微震，松手吸附到最近一格再"咚"一下。
//
// 【为什么圈上不再写名字】
// 上一版把 project/channel 名字摆在圆周上。中文在圆周上必然挤、必然被截断，
// 而且两个圈的字混在一起，根本分不清哪个是外圈哪个是内圈。现在：
//   - 名字只在**上方**用两行大字显示（PROJECT / CHANNEL）；
//   - 圈上只留刻度 —— 旋钮就该只有刻度，名字在读表的地方看；
//   - 旋钮上那圈齿纹会跟着转动，"它在转"这件事靠齿纹而不是靠文字来表达。
//
// 齿轮纹是关键：静止的刻度看不出动，会动的齿纹一眼就知道转了多少。

import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { WalkieProject } from './api'
import { hapticSnap, hapticTick, primeFeedback, thunk, tick, tickFine } from './feedback'

/** 相邻两项的夹角。项少时留白太空，项多时挤成一团，两头都夹一下。 */
const stepFor = (n: number) => Math.max(26, Math.min(60, 300 / Math.max(n, 1)))
/** 偏离正上方超过这个角度就不画了 —— 在背面，画了只是浪费 */
const VISIBLE_DEG = 108
/** 内外圈的分界（以半个旋钮直径为 1） */
const RING_SPLIT = 0.66
/**
 * 刻度所在半径，单位是**整个旋钮直径**（translateY 走的是绝对长度）。
 * 换算成「占旋钮半径的比例」要 ×2，所以 0.37 → 74%。
 * 这两个值必须落在滚花带内侧：滚花占 88%–100% 半径，上一版刻度放在 91%，
 * 结果整圈刻度淹在纹路里，截图上完全看不出哪一格被选中。
 */
const R_OUTER = 0.370
const R_INNER = 0.205

interface Props {
  projects: WalkieProject[]
  projIdx: number
  chanIdx: number
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

/** 一格分几个细分。4 是个折中：2 个听不出连续感，8 个会糊成一片 */
const SUB = 4

let lastTickAt = 0
/** 走完一整格：重"咔" + 震动。划得快时加最小间隔，别把马达震麻。 */
function detent(strength: number) {
  const now = Date.now()
  if (now - lastTickAt < 38) return
  lastTickAt = now
  tick(strength)
  hapticTick()
}

let lastFineAt = 0
/** 走过一个细分：只有轻响，不震。见 feedback.ts 里为什么细分不震。 */
function subDetent() {
  const now = Date.now()
  if (now - lastFineAt < 18) return
  lastFineAt = now
  tickFine()
}

/**
 * 拿连续值跟上一帧比：跨过细分就轻响，跨过整数格才重响 + 震。
 * 两个判断分开做，所以"轻"和"重"是叠加的层次，不是二选一。
 */
function emitForMove(prev: number, next: number) {
  if (Math.floor(next * SUB) !== Math.floor(prev * SUB)) subDetent()
  if (Math.round(next) !== Math.round(prev)) detent(Math.min(1, 0.5 + Math.abs(next - prev) * 2))
}

export default function ChannelDial({ projects, projIdx, chanIdx, onChange, children }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const dragging = useRef(false)
  // value 是连续的「浮点索引」：拖动时连续变化，松手吸附到整数
  const [outerVal, setOuterVal] = useState(projIdx)
  const [innerVal, setInnerVal] = useState(chanIdx)
  const [active, setActive] = useState<RingName | null>(null)

  // 外部改了索引（切 project 后频道被钳位等）→ 同步进来。比较取整值：拖动中别打断。
  const syncRef = useRef({ projIdx, chanIdx })
  if (syncRef.current.projIdx !== projIdx || syncRef.current.chanIdx !== chanIdx) {
    const fromOutside = Math.round(outerVal) !== projIdx || Math.round(innerVal) !== chanIdx
    syncRef.current = { projIdx, chanIdx }
    if (fromOutside && !dragging.current) {
      setOuterVal(projIdx)
      setInnerVal(chanIdx)
    }
  }

  const channels = useMemo(() => projects[projIdx]?.channels ?? [], [projects, projIdx])
  const outerStep = stepFor(projects.length)
  const innerStep = stepFor(channels.length)

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
    if (ring === 'outer' && projects.length < 2) return
    if (ring === 'inner' && channels.length < 2) return
    drag.current = { ring, lastAngle: angleAt(e.clientX, e.clientY), moved: 0 }
    dragging.current = true
    setActive(ring)
    hapticSnap()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const a = angleAt(e.clientX, e.clientY)
    const delta = normDelta(a - d.lastAngle)
    d.lastAngle = a
    d.moved += Math.abs(delta)
    if (d.ring === 'outer') {
      setOuterVal((v) => {
        const next = clamp(v - delta / outerStep, projects.length - 1)
        emitForMove(v, next)
        const pi = Math.round(next)
        if (pi !== Math.round(v) && pi !== projIdx) {
          const maxCh = (projects[pi]?.channels.length ?? 1) - 1
          setInnerVal((ci) => Math.min(ci, Math.max(0, maxCh)))
        }
        return next
      })
    } else {
      setInnerVal((v) => {
        const next = clamp(v - delta / innerStep, channels.length - 1)
        emitForMove(v, next)
        return next
      })
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
      // 基本没动 = 一次点击：命中哪一格就跳到哪
      const hit = (e.target as HTMLElement).closest('[data-ring]') as HTMLElement | null
      if (hit?.dataset.ring) {
        const idx = Number(hit.dataset.idx)
        hapticSnap()
        if (hit.dataset.ring === 'outer') { setOuterVal(idx); setInnerVal(0); onChange(idx, 0) }
        else { setInnerVal(idx); onChange(projIdx, idx) }
      }
      return
    }

    thunk()                                          // 吸附到位的"咚"
    hapticSnap()
    if (d.ring === 'outer') {
      const pi = Math.round(outerVal)
      const ci = Math.max(0, Math.min(Math.round(innerVal), (projects[pi]?.channels.length ?? 1) - 1))
      setOuterVal(pi); setInnerVal(ci); onChange(pi, ci)
    } else {
      const ci = Math.max(0, Math.min(Math.round(innerVal), channels.length - 1))
      setInnerVal(ci); onChange(projIdx, ci)
    }
  }

  const curProject = projects[projIdx]
  const curChannel = channels[chanIdx]

  /** 刻度。没有文字，所以不需要反向旋转保持水平 —— 整个环一起转即可。 */
  const renderTicks = (
    count: number,
    val: number,
    step: number,
    ring: RingName,
    radiusK: number,
  ) => {
    const list = []
    const sel = Math.round(val)
    for (let i = 0; i < count; i++) {
      const angle = (i - val) * step
      if (Math.abs(angle) > VISIBLE_DEG) continue
      const isSel = i === sel
      const fade = Math.max(0.16, 1 - Math.abs(angle) / VISIBLE_DEG)
      list.push(
        <span
          key={`${ring}-${i}`}
          data-ring={ring}
          data-idx={i}
          className={`walkie-notch walkie-notch-${ring}${isSel ? ' is-sel' : ''}`}
          style={{
            // 刻度是**旋钮上**的刻度，跟着旋钮一起转 —— 所以这里只写 i*step，
            // 偏移由外层容器的 rotate(-val*step) 负责。写成 (i-val)*step 会把
            // 旋转叠加两次，选中的那一格就跑到对面去了（截图里抓到过）。
            transform: `rotate(${i * step}deg) translateY(calc(var(--walkie-dial) * ${-radiusK}))`,
            opacity: isSel ? 1 : fade,
          }}
        />,
      )
    }
    return list
  }

  return (
    <>
      {/* 读数放在旋钮上方：中文在这里能完整显示，也不用绕着圈读 */}
      {/* 读数面板 = 车载电台旋钮上方那块屏：我这一格通的是谁、他忙不忙。
          第一行是**文件夹路径**（"哪个工作区"本来就该用路径说），第二行是人。 */}
      <div className="walkie-readout">
        <div className={`walkie-readout-row${active === 'outer' ? ' is-turn' : ''}`}>
          <i className="walkie-swatch walkie-swatch-outer" aria-hidden="true" />
          <span className="walkie-workspace">{curProject?.path || curProject?.name || '—'}</span>
        </div>
        <div className={`walkie-readout-row walkie-readout-sub${active === 'inner' ? ' is-turn' : ''}`}>
          <i className="walkie-swatch walkie-swatch-inner" aria-hidden="true" />
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
        {/* 固定指针：两个圈共用一根，一眼看出读的是哪一格 */}
        <div className="walkie-index" aria-hidden="true" />

        {/* 外圈 = project */}
        <div className="walkie-knob walkie-knob-outer"
          style={{ transform: `rotate(${-outerVal * outerStep}deg)` }}>
          <div className="walkie-ridges walkie-ridges-outer" />
          {renderTicks(projects.length, outerVal, outerStep, 'outer', R_OUTER)}
        </div>

        {/* 内圈 = channel */}
        <div className="walkie-knob walkie-knob-inner"
          style={{ transform: `rotate(${-innerVal * innerStep}deg)` }}>
          <div className="walkie-ridges walkie-ridges-inner" />
          {renderTicks(channels.length, innerVal, innerStep, 'inner', R_INNER)}
        </div>

        {/* 圆心：由外面传进来（按住说话 / 发送）。以前这里显示"CH 05"，
            那是个没意义的编号 —— 现在圆心是这一屏最重要的操作。 */}
        {children}
      </div>
    </>
  )
}

function clamp(v: number, max: number) {
  return Math.max(0, Math.min(max, v))
}

type Status = 'working' | 'idle' | 'ready' | 'offline'
/** 换过去之前就知道对方在不在干活 —— 这一格同时是一块状态牌 */
export const STATUS_TEXT: Record<Status, string> = {
  working: '工作中',
  idle: '空闲',
  ready: '就绪',
  offline: '不是 Claude 会话',
}
function statusOf(c?: { kind: string; status?: string }): Status {
  if (!c) return 'ready'
  if (c.kind === 'other') return 'offline'
  return (c.status as Status) || 'ready'
}
