// walkie/ChannelDial.tsx — 双旋钮频道选择器
//
// 外圈 = project，内圈 = channel。手指在圈上划圈，圈上的标签跟着手指走
// （物理旋钮的心智模型：刻度随旋钮转），松手吸附到最近一格，每过一格震一下；
// 直接点某个标签 = 跳到那个频道，省得转。
//
// 实现上用 HTML + CSS transform，不用 SVG：标签要始终正着（中文倒着没法读），
// 而 `rotate(θ) translateY(-R) rotate(-θ)` 这组变换正好把标签摆到圆周上且保持水平，
// 还能让 CSS transition 给吸附做平滑收尾。SVG 里旋转 group 会让字跟着倒。
//
// 半径必须写成 calc(var(--walkie-dial) * k) 的绝对量：translateY 的百分比是相对
// **元素自身**高度算的，拿它当半径会把标签堆在圆心附近。

import { useCallback, useMemo, useRef, useState } from 'react'
import type { WalkieChannel, WalkieProject } from './api'
import { shortProject } from './api'

/** 相邻两项的夹角。项少时留白太空，项多时挤成一团，两头都夹一下。 */
const stepFor = (n: number) => Math.max(30, Math.min(62, 320 / Math.max(n, 1)))
/** 偏离正上方超过这个角度就不画了 —— 在背面，画了只是浪费 */
const VISIBLE_DEG = 104
/** 内外圈的分界（以半个旋钮直径为 1）：外圈标签在 0.75，内圈在 0.58，取中间 */
const RING_SPLIT = 0.665

interface Props {
  projects: WalkieProject[]
  projIdx: number
  chanIdx: number
  onChange: (projIdx: number, chanIdx: number) => void
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

let tickAt = 0
/** 每过一格震一下。划得快时别把马达震麻，加个最小间隔。 */
function tick() {
  const now = Date.now()
  if (now - tickAt < 55) return
  tickAt = now
  try { navigator.vibrate?.(8) } catch { /* 桌面或不支持就算了 */ }
}

export default function ChannelDial({ projects, projIdx, chanIdx, onChange }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const dragging = useRef(false)
  // value 是连续的「浮点索引」：拖动时连续变化，松手吸附到整数；整数部分就是选中项。
  const [outerVal, setOuterVal] = useState(projIdx)
  const [innerVal, setInnerVal] = useState(chanIdx)
  const [active, setActive] = useState<RingName | null>(null)
  const [, forceRender] = useState(0)

  // 外部改了索引（切 project 后频道被钳位等）→ 同步进来。
  // 比较的是取整值：拖动中外部别来打断。
  const syncRef = useRef({ projIdx, chanIdx })
  if (syncRef.current.projIdx !== projIdx || syncRef.current.chanIdx !== chanIdx) {
    const fromOutside = Math.round(outerVal) !== projIdx || Math.round(innerVal) !== chanIdx
    syncRef.current = { projIdx, chanIdx }
    if (fromOutside && !dragging.current) {
      setOuterVal(projIdx)
      setInnerVal(chanIdx)
    }
  }

  const channels: WalkieChannel[] = useMemo(
    () => projects[projIdx]?.channels ?? [],
    [projects, projIdx],
  )
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
    const r = el.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    const ring: RingName = Math.hypot(dx, dy) / (r.width / 2) > RING_SPLIT ? 'outer' : 'inner'
    if (ring === 'outer' && projects.length < 2) return
    if (ring === 'inner' && channels.length < 2) return
    drag.current = { ring, lastAngle: angleAt(e.clientX, e.clientY), moved: 0 }
    dragging.current = true
    setActive(ring)
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
      setOuterVal((v) => {
        const next = clamp(v - delta / outerStep, projects.length - 1)
        if (Math.round(next) !== Math.round(v)) tick()
        const pi = Math.round(next)
        if (pi !== projIdx) {
          const maxCh = (projects[pi]?.channels.length ?? 1) - 1
          setInnerVal((ci) => Math.min(ci, Math.max(0, maxCh)))
        }
        return next
      })
    } else {
      setInnerVal((v) => {
        const next = clamp(v - delta / innerStep, channels.length - 1)
        if (Math.round(next) !== Math.round(v)) tick()
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
      // 基本没动 = 一次点击：命中哪个标签就跳到哪
      const hit = (e.target as HTMLElement).closest('[data-ring]') as HTMLElement | null
      if (hit?.dataset.ring) {
        const idx = Number(hit.dataset.idx)
        if (hit.dataset.ring === 'outer') { setOuterVal(idx); setInnerVal(0); onChange(idx, 0) }
        else { setInnerVal(idx); onChange(projIdx, idx) }
      }
      return
    }

    // 吸附到整数格（下一次 render 的 transition 负责动画）
    if (d.ring === 'outer') {
      const pi = Math.round(outerVal)
      const ci = Math.max(0, Math.min(Math.round(innerVal), (projects[pi]?.channels.length ?? 1) - 1))
      setOuterVal(pi); setInnerVal(ci); onChange(pi, ci)
    } else {
      const ci = Math.max(0, Math.min(Math.round(innerVal), channels.length - 1))
      setInnerVal(ci); onChange(projIdx, ci)
    }
    forceRender((n) => n + 1)
  }

  const curProject = projects[projIdx]
  const curChannel = channels[chanIdx]

  const renderTicks = (
    items: { label: string; key: string; cls: string }[],
    val: number,
    step: number,
    ring: RingName,
    radiusK: number,
    selected: number,
  ) =>
    items.map((it, i) => {
      const angle = (i - val) * step
      if (Math.abs(angle) > VISIBLE_DEG) return null
      const isActive = i === selected
      const opacity = isActive ? 1 : Math.max(0.14, 1 - Math.abs(angle) / VISIBLE_DEG)
      return (
        <button
          key={it.key}
          type="button"
          data-ring={ring}
          data-idx={i}
          className={`walkie-tick walkie-tick-${ring}${isActive ? ' is-active' : ''}${it.cls}`}
          style={{
            transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(calc(var(--walkie-dial) * ${-radiusK})) rotate(${-angle}deg)`,
            opacity,
            transition: active ? 'opacity .2s' : 'transform .26s cubic-bezier(.2,.9,.25,1), opacity .2s',
          }}
          onClick={(ev) => ev.preventDefault()}
        >
          {it.label}
        </button>
      )
    })

  return (
    <div className="walkie-dial" ref={boxRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="walkie-ring walkie-ring-outer" />
      <div className="walkie-ring walkie-ring-inner" />

      {renderTicks(
        projects.map((p) => ({ label: shortProject(p.name), key: p.name, cls: '' })),
        // 外圈标签放在刻度环**内侧**（0.375 vs 环在 0.44）：否则正上方那个标签
        // 会被顶部的指针三角压住半边
        outerVal, outerStep, 'outer', 0.375, projIdx,
      )}
      {renderTicks(
        channels.map((c) => ({ label: c.name, key: `${c.index}-${c.name}`, cls: c.kind === 'other' ? ' is-shell' : '' })),
        innerVal, innerStep, 'inner', 0.29, chanIdx,
      )}

      {/* 中心：当前频道读数 */}
      <div className="walkie-hub">
        <div className="walkie-hub-ch">CH {String((curChannel?.index ?? 0) + 1).padStart(2, '0')}</div>
        <div className="walkie-hub-name">{curChannel?.name ?? '—'}</div>
        <div className="walkie-hub-project">{shortProject(curProject?.name ?? '')}</div>
      </div>
    </div>
  )
}

function clamp(v: number, max: number) {
  return Math.max(0, Math.min(max, v))
}
