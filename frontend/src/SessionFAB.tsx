import { useState, useEffect, useRef, useCallback } from 'react'

const FAB_POS_KEY = 'nexus_fab_pos'
const DRAG_THRESHOLD = 8
const SNAP_MARGIN = 12

interface Pos { x: number; y: number }

interface Props {
  onClick: () => void
  windowCount?: number
  topInset?: number
  bottomInset?: number
}

function snapToEdge(x: number, size: number): number {
  return (x + size / 2) < window.innerWidth / 2 ? SNAP_MARGIN : window.innerWidth - size - SNAP_MARGIN
}

function clampPos(x: number, y: number, size: number, topInset: number, bottomInset: number): Pos {
  return {
    x: Math.max(0, Math.min(x, window.innerWidth - size)),
    y: Math.max(topInset + 8, Math.min(y, window.innerHeight - size - bottomInset - 8)),
  }
}

function defaultPos(size: number, bottomInset: number): Pos {
  return {
    x: window.innerWidth - size - SNAP_MARGIN,
    y: window.innerHeight - size - bottomInset - 24,
  }
}

export default function SessionFAB({ onClick, windowCount, topInset = 0, bottomInset = 0 }: Props) {
  const SIZE = 52

  // Logical position — persisted, keyboard-unaware
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const s = localStorage.getItem(FAB_POS_KEY)
      if (s) {
        const p = JSON.parse(s) as Pos
        return clampPos(p.x, p.y, SIZE, topInset, bottomInset)
      }
    } catch {}
    return defaultPos(SIZE, bottomInset)
  })

  // Keyboard height detected via visualViewport
  const [keyboardHeight, setKeyboardHeight] = useState(0)

  // Transition string — set contextually, cleared after animation
  const [transition, setTransition] = useState('')

  const isDragging = useRef(false)
  const startPointer = useRef<Pos>({ x: 0, y: 0 })
  const startPos = useRef<Pos>({ x: 0, y: 0 })
  const moved = useRef(false)
  const posRef = useRef(pos)
  posRef.current = pos

  // Persist logical position (skip on first mount)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    localStorage.setItem(FAB_POS_KEY, JSON.stringify(pos))
  }, [pos])

  // Track keyboard via visualViewport resize
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    function update() {
      const kbH = Math.max(0, window.innerHeight - vv!.height - vv!.offsetTop)
      setKeyboardHeight(kbH)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  // Animate when keyboard height changes
  const prevKeyboardHeight = useRef(keyboardHeight)
  useEffect(() => {
    if (prevKeyboardHeight.current === keyboardHeight) return
    prevKeyboardHeight.current = keyboardHeight
    setTransition('top 0.22s ease, left 0.22s ease')
    const t = setTimeout(() => setTransition(''), 260)
    return () => clearTimeout(t)
  }, [keyboardHeight])

  // Re-clamp + re-snap when toolbar insets change
  useEffect(() => {
    setPos(p => {
      const clamped = clampPos(p.x, p.y, SIZE, topInset, bottomInset)
      return { x: snapToEdge(clamped.x, SIZE), y: clamped.y }
    })
  }, [topInset, bottomInset])

  // Re-clamp on window resize
  useEffect(() => {
    function onResize() {
      setPos(p => {
        const clamped = clampPos(p.x, p.y, SIZE, topInset, bottomInset)
        return { x: snapToEdge(clamped.x, SIZE), y: clamped.y }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [topInset, bottomInset])

  // Rendered position = logical pos clamped to effective insets (incl. keyboard)
  const effectiveBottomInset = bottomInset + keyboardHeight
  const renderedPos = clampPos(pos.x, pos.y, SIZE, topInset, effectiveBottomInset)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    isDragging.current = true
    moved.current = false
    startPointer.current = { x: e.clientX, y: e.clientY }
    startPos.current = posRef.current
    setTransition('')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return
    const dx = e.clientX - startPointer.current.x
    const dy = e.clientY - startPointer.current.y
    if (!moved.current && Math.hypot(dx, dy) >= DRAG_THRESHOLD) moved.current = true
    if (moved.current) {
      setPos(clampPos(startPos.current.x + dx, startPos.current.y + dy, SIZE, topInset, effectiveBottomInset))
    }
  }, [topInset, effectiveBottomInset])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return
    e.preventDefault()
    isDragging.current = false
    if (!moved.current) {
      onClick()
    } else {
      const dx = e.clientX - startPointer.current.x
      const dy = e.clientY - startPointer.current.y
      const raw = clampPos(startPos.current.x + dx, startPos.current.y + dy, SIZE, topInset, effectiveBottomInset)
      const snapped: Pos = { x: snapToEdge(raw.x, SIZE), y: raw.y }
      setTransition('left 0.28s cubic-bezier(0.34,1.56,0.64,1)')
      setPos(snapped)
      localStorage.setItem(FAB_POS_KEY, JSON.stringify(snapped))
    }
  }, [onClick, topInset, effectiveBottomInset])

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'fixed',
        left: renderedPos.x,
        top: renderedPos.y,
        width: SIZE,
        height: SIZE,
        borderRadius: '50%',
        background: 'var(--nexus-bg2)',
        border: '1px solid var(--nexus-border)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        zIndex: 350,
        userSelect: 'none',
        touchAction: 'none',
        transition,
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--nexus-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="26" height="26">
        {/* 头部 */}
        <rect x="4.5" y="8" width="15" height="11" rx="2.5" />
        {/* 眼睛 */}
        <circle cx="9" cy="13" r="1.5" fill="var(--nexus-accent)" stroke="none" />
        <circle cx="15" cy="13" r="1.5" fill="var(--nexus-accent)" stroke="none" />
        {/* 嘴巴 */}
        <path d="M9.5 17h5" />
        {/* 天线 */}
        <path d="M12 8V5" />
        <circle cx="12" cy="4.5" r="1" fill="var(--nexus-accent)" stroke="none" />
        {/* 侧耳 */}
        <path d="M4.5 12.5H2.5M19.5 12.5H21.5" />
      </svg>
      {!!windowCount && windowCount > 0 && (
        <span style={{
          position: 'absolute',
          top: -4,
          right: -4,
          background: 'var(--nexus-accent)',
          color: '#fff',
          borderRadius: '50%',
          width: 18,
          height: 18,
          fontSize: 11,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}>{windowCount}</span>
      )}
    </div>
  )
}
