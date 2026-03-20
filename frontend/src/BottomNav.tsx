import { useState, useRef, useCallback, useEffect } from 'react'

interface TmuxWindow {
  index: number
  name: string
  active: boolean
}

interface Props {
  windows: TmuxWindow[]
  activeIndex: number
  onSwitch: (index: number) => void
  onClose: (index: number) => void
  onAdd: () => void
  onRename?: (index: number, name: string) => void
}

const SWIPE_THRESHOLD = 40

export default function BottomNav({ windows, activeIndex, onSwitch, onClose, onAdd, onRename }: Props) {
  const [showSheet, setShowSheet] = useState(false)
  const [touchStartX, setTouchStartX] = useState(0)
  const [touchStartY, setTouchStartY] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [menuWin, setMenuWin] = useState<TmuxWindow | null>(null)
  const [renameWin, setRenameWin] = useState<TmuxWindow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const sheetRef = useRef<HTMLDivElement>(null)

  // 找到当前 active window 在 windows 数组中的位置
  const activePosition = windows.findIndex(w => w.index === activeIndex)
  const totalWindows = windows.length

  // 处理底部区域的触摸手势
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    setTouchStartX(touch.clientX)
    setTouchStartY(touch.clientY)
    setIsSwiping(false)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartX === 0) return
    const touch = e.touches[0]
    const deltaX = touch.clientX - touchStartX
    const deltaY = touch.clientY - touchStartY

    // 水平滑动超过阈值，判定为切换窗口手势
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 20) {
      setIsSwiping(true)
    }
  }, [touchStartX])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isSwiping || touchStartX === 0) {
      setTouchStartX(0)
      return
    }

    const touch = e.changedTouches[0]
    const deltaX = touch.clientX - touchStartX

    if (Math.abs(deltaX) > SWIPE_THRESHOLD) {
      if (deltaX > 0) {
        // 右滑 -> 上一个窗口
        const prevPos = activePosition > 0 ? activePosition - 1 : totalWindows - 1
        if (windows[prevPos]) onSwitch(windows[prevPos].index)
      } else {
        // 左滑 -> 下一个窗口
        const nextPos = activePosition < totalWindows - 1 ? activePosition + 1 : 0
        if (windows[nextPos]) onSwitch(windows[nextPos].index)
      }
    }

    setTouchStartX(0)
    setIsSwiping(false)
  }, [isSwiping, touchStartX, activePosition, totalWindows, windows, onSwitch])

  // 点击指示点切换
  const handleDotClick = (position: number) => {
    const win = windows[position]
    if (win) onSwitch(win.index)
  }

  // 长按显示操作菜单
  const longPressTimer = useRef<number | null>(null)

  const handleDotTouchStart = (win: TmuxWindow) => {
    longPressTimer.current = window.setTimeout(() => {
      setMenuWin(win)
    }, 500)
  }

  const handleDotTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
    }
  }, [])

  function startRename(win: TmuxWindow) {
    setMenuWin(null)
    setRenameWin(win)
    setRenameValue(win.name)
  }

  function submitRename() {
    if (renameWin && renameValue.trim() && onRename) {
      onRename(renameWin.index, renameValue.trim())
    }
    setRenameWin(null)
    setRenameValue('')
  }

  return (
    <>
      {/* 底部窗口导航条 */}
      <div
        style={s.navBar}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 窗口指示器 */}
        <div style={s.indicators}>
          {windows.map((win, pos) => (
            <button
              key={win.index}
              style={{
                ...s.dot,
                ...(win.index === activeIndex ? s.dotActive : {}),
              }}
              onClick={() => handleDotClick(pos)}
              onTouchStart={() => handleDotTouchStart(win)}
              onTouchEnd={handleDotTouchEnd}
              onMouseDown={() => handleDotTouchStart(win)}
              onMouseUp={handleDotTouchEnd}
              onMouseLeave={handleDotTouchEnd}
              title={win.name}
            />
          ))}
          {/* 新建按钮（小圆点样式） */}
          <button style={s.addDot} onClick={onAdd} title="新建会话">+</button>
        </div>

        {/* 当前窗口名称 */}
        <div style={s.currentWinName}>
          {windows.find(w => w.index === activeIndex)?.name || '未连接'}
        </div>

        {/* 展开按钮 - 显示完整窗口列表 */}
        <button style={s.expandBtn} onClick={() => setShowSheet(true)}>
          {totalWindows}
        </button>
      </div>

      {/* 窗口列表底部浮层 */}
      {showSheet && (
        <>
          <div style={s.sheetOverlay} onClick={() => setShowSheet(false)} />
          <div ref={sheetRef} style={s.sheet}>
            <div style={s.sheetHeader}>
              <span style={s.sheetTitle}>窗口列表</span>
              <button style={s.sheetClose} onClick={() => setShowSheet(false)}>×</button>
            </div>
            <div style={s.sheetContent}>
              {windows.map((win, pos) => (
                <div
                  key={win.index}
                  style={{
                    ...s.sheetItem,
                    ...(win.index === activeIndex ? s.sheetItemActive : {}),
                  }}
                  onClick={() => {
                    onSwitch(win.index)
                    setShowSheet(false)
                  }}
                >
                  <span style={s.sheetItemNumber}>{pos + 1}</span>
                  <span style={s.sheetItemName}>{win.name}</span>
                  {win.active && <span style={s.runningBadge}>运行中</span>}
                  {win.index === activeIndex && <span style={s.activeBadge}>当前</span>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* 长按菜单 */}
      {menuWin && (
        <>
          <div style={s.menuOverlay} onClick={() => setMenuWin(null)} />
          <div style={s.contextMenu}>
            <div style={s.menuTitle}>{menuWin.name}</div>
            {onRename && (
              <button
                style={s.menuItem}
                onClick={() => startRename(menuWin)}
              >
                <span style={s.menuIcon}>✎</span> 重命名
              </button>
            )}
            <button
              style={s.menuItemClose}
              onClick={() => {
                onClose(menuWin.index)
                setMenuWin(null)
              }}
            >
              <span style={s.menuIcon}>✕</span> 关闭会话
            </button>
            <button style={s.menuItemCancel} onClick={() => setMenuWin(null)}>
              取消
            </button>
          </div>
        </>
      )}

      {/* 重命名对话框 */}
      {renameWin && (
        <>
          <div style={s.menuOverlay} onClick={() => setRenameWin(null)} />
          <div style={s.renameDialog}>
            <div style={s.menuTitle}>重命名会话</div>
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename()
                if (e.key === 'Escape') setRenameWin(null)
              }}
              style={s.renameInput}
              autoFocus
            />
            <div style={s.renameActions}>
              <button style={s.menuItemCancel} onClick={() => setRenameWin(null)}>取消</button>
              <button style={s.renameConfirm} onClick={submitRename}>确定</button>
            </div>
          </div>
        </>
      )}

    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  navBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--nexus-bg)',
    borderTop: '1px solid var(--nexus-border)',
    padding: '8px 16px',
    height: 52,
    gap: 12,
  },
  indicators: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--nexus-muted)',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    transition: 'all 0.2s',
  },
  dotActive: {
    background: '#3b82f6',
    transform: 'scale(1.3)',
  },
  addDot: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'transparent',
    border: '1px dashed var(--nexus-muted)',
    color: 'var(--nexus-muted)',
    cursor: 'pointer',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    marginLeft: 4,
  },
  currentWinName: {
    flex: 1,
    color: 'var(--nexus-text)',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
    textAlign: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  expandBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'var(--nexus-bg2)',
    border: 'none',
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    flexShrink: 0,
  },
  // 底部浮层样式
  sheetOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 200,
  },
  sheet: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    background: 'var(--nexus-sheet-bg)',
    borderRadius: '16px 16px 0 0',
    zIndex: 201,
    maxHeight: '60vh',
    display: 'flex',
    flexDirection: 'column',
  },
  sheetHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid var(--nexus-border)',
  },
  sheetTitle: {
    color: 'var(--nexus-text)',
    fontSize: 16,
    fontWeight: 600,
  },
  sheetClose: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text2)',
    fontSize: 24,
    cursor: 'pointer',
    padding: 0,
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetContent: {
    overflowY: 'auto',
    padding: '8px 0',
  },
  sheetItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 20px',
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  sheetItemActive: {
    background: 'var(--nexus-tab-active)',
  },
  sheetItemNumber: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: 'var(--nexus-border)',
    color: 'var(--nexus-text2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 600,
  },
  sheetItemName: {
    flex: 1,
    color: 'var(--nexus-text)',
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  activeBadge: {
    background: '#3b82f6',
    color: '#fff',
    fontSize: 10,
    padding: '2px 8px',
    borderRadius: 4,
  },
  runningBadge: {
    background: '#22c55e',
    color: '#fff',
    fontSize: 10,
    padding: '2px 8px',
    borderRadius: 4,
  },
  // 菜单样式
  menuOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 250,
  },
  contextMenu: {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'var(--nexus-menu-bg)',
    borderRadius: 12,
    padding: '16px 0',
    minWidth: 200,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    border: '1px solid var(--nexus-border)',
    zIndex: 251,
  },
  menuTitle: {
    color: '#64748b',
    fontSize: 11,
    padding: '0 16px 12px',
    borderBottom: '1px solid var(--nexus-border)',
    marginBottom: 8,
    textAlign: 'center',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'transparent',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 15,
    padding: '12px 20px',
    width: '100%',
    textAlign: 'left',
  },
  menuIcon: {
    fontSize: 14,
  },
  menuItemCancel: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '12px 20px',
    width: '100%',
    textAlign: 'center',
    borderTop: '1px solid var(--nexus-border)',
    marginTop: 8,
  },
  menuItemClose: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'transparent',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 15,
    padding: '12px 20px',
    width: '100%',
    textAlign: 'left',
  },
  renameDialog: {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'var(--nexus-menu-bg)',
    borderRadius: 12,
    padding: '16px 0',
    minWidth: 260,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    border: '1px solid var(--nexus-border)',
    zIndex: 251,
  },
  renameInput: {
    background: 'var(--nexus-bg)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 6,
    color: 'var(--nexus-text)',
    fontSize: 14,
    padding: '8px 12px',
    width: 'calc(100% - 40px)',
    margin: '0 20px 12px',
    outline: 'none',
  },
  renameActions: {
    display: 'flex',
    gap: 8,
    padding: '0 20px',
  },
  renameConfirm: {
    flex: 1,
    background: '#3b82f6',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    padding: '10px 16px',
  },
}
