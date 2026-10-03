// walkie/Tuner.tsx — 横向调台条（上排 = 工作区，下排 = Agent）
//
// 【为什么不再是同心双圈】旋钮好用的前提是**每个档位有你能看见的位置和名字**。
// 上两版那两个同心圈转起来是十几个无名刻度：你只能盲转、瞄一眼读数、再转 ——
// 那是在"找"，不是在"调"。而且内外圈的半径差只有几十像素，拇指要挑着落点。
// 换成两行横向条之后：每一项都带名字，左右邻居都在视野里，你**知道**往哪边拨。
//
// 【手感一分没丢】细分轻"嗒"、节点重"咔" + 震、停稳"咚" + 更重的震 —— 三档全保留。
// 底子换成浏览器原生的滚动吸附（scroll-snap），所以惯性、橡皮筋、跟手都是系统的，
// 不是模拟的；我们只在滚动过程中判断"跨过了第几格"，按格配音、按格震动。
//
// 【拖动时不惊动父组件】换台要打断语音、清空草稿、去拉上一轮回复 —— 每过一格调一次
// 既没必要也很贵。所以本组件自己跟"转到哪了"，只在**停稳**时提交一次。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WalkieProject } from './api'
import { hapticSnap, hapticTick, primeFeedback, thunk, tick, tickFine } from './feedback'

/** 一格切成几个细分（细分只有轻响、不震） */
const SUB = 3
/** 滚动停稳多久算"到位了" */
const SETTLE_MS = 130
/** 程序化滚动（点击跳转）期间静音，别让一次跳转噼里啪啦响一串 */
const SCROLL_LOCK_MS = 420

const STATUS_TEXT: Record<string, string> = {
  working: '工作中', idle: '空闲', ready: '就绪', offline: '不是 Claude',
}
function statusOf(c?: { kind: string; status?: string }): string {
  if (!c) return 'ready'
  if (c.kind === 'other') return 'offline'
  return c.status || 'ready'
}

interface Chip {
  key: string
  title: string
  /** 选中时才显示的状态字（放每个上面会糊成一片） */
  status?: string
  /** 这一格不是 Claude —— 发过去会被当 shell 命令，标出来 */
  warn?: boolean
}

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

/** 跨过细分就轻响，跨过整格才重响 + 震。两个判断分开做，"轻"和"重"是叠加的层次。 */
function emitForMove(prev: number, next: number) {
  if (Math.floor(next * SUB) !== Math.floor(prev * SUB)) subDetent()
  if (Math.round(next) !== Math.round(prev)) detent(Math.min(1, 0.55 + Math.abs(next - prev) * 2))
}

function Row({
  chips, index, tone, onSettle, label,
}: {
  chips: Chip[]
  index: number
  tone: 'ws' | 'agent'
  onSettle: (i: number) => void
  label: string
}) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const chipEls = useRef<(HTMLElement | null)[]>([])
  const [live, setLive] = useState(index)
  const committed = useRef(index)
  const lastPos = useRef(index)
  const lock = useRef(false)
  const settleTimer = useRef<number | null>(null)
  const key = chips.map((c) => c.key).join('|')

  /** 当前连续位置：以"哪一项的中心最贴近容器中心"算，项宽不等也成立 */
  const position = useCallback(() => {
    const el = scroller.current
    if (!el) return 0
    const centers: number[] = []
    for (const c of chipEls.current) {
      if (c) centers.push(c.offsetLeft + c.offsetWidth / 2)
    }
    if (!centers.length) return 0
    const last = centers.length - 1
    const target = el.scrollLeft + el.clientWidth / 2
    if (target <= centers[0]) return 0
    if (target >= centers[last]) return last
    let i = 0
    while (i < last - 1 && centers[i + 1] < target) i++
    const a = centers[i]
    const b = centers[i + 1]
    return i + (b > a ? (target - a) / (b - a) : 0)
  }, [])

  const onScroll = useCallback(() => {
    const p = position()
    if (!lock.current) {
      emitForMove(lastPos.current, p)
      lastPos.current = p
      const near = Math.round(p)
      if (near !== live) setLive(near)
    }
    if (settleTimer.current !== null) clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      // 滚动停了，不管是手指还是程序发起的，锁都该放掉 —— 早先这里直接 return，
      // 结果是"点击跳转后 400ms 内再拖一次"会被整段吞掉（选中的格子悄悄变了但不提交）
      const wasLocked = lock.current
      lock.current = false
      if (wasLocked) return           // 程序化滚动不用提交：committed 早就设成目标值了
      const i = Math.round(position())
      if (i === committed.current) return
      committed.current = i
      thunk()
      hapticSnap()
      onSettle(i)
    }, SETTLE_MS)
  }, [position, live, onSettle])

  /** 外面改了选中项（换工作区后频道被钳位、重新载入）→ 把条子挪过去。
      拖动中和点击跳转的过程中不插手，免得和动画打架 —— 但**整批项换了**
      （换工作区后 Agent 那排是另一批）是例外：那时候不挪就等于停在错的位置上。 */
  const lastKey = useRef(key)
  useEffect(() => {
    const el = scroller.current
    const chip = chipEls.current[index]
    const swapped = lastKey.current !== key
    lastKey.current = key
    if (!el || !chip) return
    if (lock.current && !swapped) return
    const want = chip.offsetLeft + chip.offsetWidth / 2 - el.clientWidth / 2
    if (!swapped && Math.abs(el.scrollLeft - want) < 3) return
    lock.current = true
    committed.current = index
    lastPos.current = index
    setLive(index)
    el.scrollTo({ left: want, behavior: 'auto' })
    const t = window.setTimeout(() => { lock.current = false }, SCROLL_LOCK_MS)
    return () => clearTimeout(t)
  }, [index, key])

  /** 点某一格 = 跳到那一格。手感照给：一声落定 + 一次重震。 */
  const pick = (i: number) => {
    const el = scroller.current
    const chip = chipEls.current[i]
    if (!el || !chip) return
    if (i === committed.current) return
    lock.current = true
    committed.current = i
    lastPos.current = i
    setLive(i)
    el.scrollTo({ left: chip.offsetLeft + chip.offsetWidth / 2 - el.clientWidth / 2, behavior: 'smooth' })
    window.setTimeout(() => { lock.current = false }, SCROLL_LOCK_MS)
    thunk()
    hapticSnap()
    onSettle(i)
  }

  return (
    <div className={`tuner-row tuner-row-${tone}`} role="group" aria-label={label}>
      <div
        className="tuner-scroll"
        ref={scroller}
        onScroll={onScroll}
        /* 手指一搭上来，就说明是人在驱动了 —— 把程序化滚动的静音锁撤掉，
           免得"点了跳转、接着又拖"的那一下完全没有声音反馈 */
        onPointerDown={() => { lock.current = false; primeFeedback() }}
      >
        <i className="tuner-pad" aria-hidden="true" />
        {chips.map((c, i) => (
          <button
            key={c.key}
            type="button"
            ref={(el) => { chipEls.current[i] = el }}
            className={`tuner-chip is-${tone}${i === live ? ' is-on' : ''}${c.warn ? ' is-warn' : ''}`}
            aria-pressed={i === live}
            onClick={() => pick(i)}
          >
            {c.warn && <span className="tuner-warn" aria-hidden="true">⚠</span>}
            {/* 忙的那几个，没被选中时也得看得出来 —— 一点灯就够，不用字 */}
            {c.status && <i className={`tuner-led is-${c.status}`} aria-hidden="true" />}
            <span className="tuner-title">{c.title}</span>
            {c.status && <span className={`tuner-status is-${c.status}`}><i />{STATUS_TEXT[c.status]}</span>}
          </button>
        ))}
        <i className="tuner-pad" aria-hidden="true" />
      </div>
    </div>
  )
}

interface Props {
  projects: WalkieProject[]
  projIdx: number
  chanIdx: number
  /** 只在停稳（或点击）时通知一次 */
  onChange: (projIdx: number, chanIdx: number) => void
}

export default function Tuner({ projects, projIdx, chanIdx, onChange }: Props) {
  const wsChips: Chip[] = projects.map((p) => ({ key: p.name, title: p.path || p.name }))

  const cur = projects[projIdx]
  const agentChips: Chip[] = (cur?.channels ?? []).map((c) => ({
    key: `${cur?.name}:${c.index}`,
    title: c.name,
    status: statusOf(c),
    warn: c.kind !== 'claude',
  }))

  return (
    <div className="tuner">
      <Row
        chips={wsChips}
        index={projIdx}
        tone="ws"
        label="工作区"
        onSettle={(i) => onChange(i, 0)}
      />
      <Row
        chips={agentChips}
        index={chanIdx}
        tone="agent"
        label="Agent"
        onSettle={(i) => onChange(projIdx, i)}
      />
    </div>
  )
}
