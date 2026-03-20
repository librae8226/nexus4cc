import { useState, useRef, useEffect } from 'react'
import { getWindowStatus, STATUS_DOT_COLOR, STATUS_DOT_TITLE } from './windowStatus'

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
  onOpenSettings: () => void
  onOpenTasks?: () => void
  onUpload?: () => void
  onRename?: (index: number, name: string) => void
  token?: string
  sessions?: string[]
  activeSession?: string
  onSwitchSession?: (session: string) => void
  windowOutputs?: Record<number, { output: string; clients: number; idleMs: number; connected: boolean }>
  runningTaskCount?: number
}

export default function TabBar({ windows, activeIndex, onSwitch, onClose, onAdd, onOpenSettings, onOpenTasks, onUpload, onRename, token, sessions, activeSession, onSwitchSession, windowOutputs: windowOutputsProp, runningTaskCount }: Props) {
  const [menuIndex, setMenuIndex] = useState<number | null>(null)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [renameIndex, setRenameIndex] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [localWindowOutputs, setLocalWindowOutputs] = useState<Record<number, { output: string; clients: number; idleMs: number; connected: boolean }>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeTabRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Use provided windowOutputs if available, otherwise poll internally
  const windowOutputs = windowOutputsProp ?? localWindowOutputs

  // 轮询获取窗口输出预览（仅在未从上层传入时）
  useEffect(() => {
    if (windowOutputsProp !== undefined || !token) return
    const fetchOutputs = async () => {
      const outputs: Record<number, any> = {}
      for (const win of windows) {
        try {
          const r = await fetch(`/api/sessions/${win.index}/output`, { headers: { Authorization: `Bearer ${token}` } })
          if (r.ok) outputs[win.index] = await r.json()
        } catch {}
      }
      setLocalWindowOutputs(outputs)
    }
    fetchOutputs()
    const interval = setInterval(fetchOutputs, 5000)
    return () => clearInterval(interval)
  }, [windows.map(w => w.index).join(','), token, windowOutputsProp])

  // 自动滚动到激活的 tab
  useEffect(() => {
    if (activeTabRef.current && scrollRef.current) {
      const scrollContainer = scrollRef.current
      const activeTab = activeTabRef.current
      const containerRect = scrollContainer.getBoundingClientRect()
      const tabRect = activeTab.getBoundingClientRect()

      const scrollLeft = tabRect.left - containerRect.left + scrollContainer.scrollLeft - containerRect.width / 2 + tabRect.width / 2
      scrollContainer.scrollTo({ left: scrollLeft, behavior: 'smooth' })
    }
  }, [activeIndex])

  function handleContextMenu(e: React.MouseEvent | React.TouchEvent, index: number) {
    e.preventDefault()
    e.stopPropagation()

    let clientX: number, clientY: number
    if ('touches' in e) {
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = (e as React.MouseEvent).clientX
      clientY = (e as React.MouseEvent).clientY
    }

    setMenuPos({ x: clientX, y: clientY })
    setMenuIndex(index)
  }

  function handleClose(index: number) {
    onClose(index)
    setMenuIndex(null)
  }

  function startRename(index: number, currentName: string) {
    setRenameIndex(index)
    setRenameValue(currentName)
    setMenuIndex(null)
    setTimeout(() => renameInputRef.current?.focus(), 50)
  }

  function submitRename() {
    if (renameIndex !== null && renameValue.trim() && onRename) {
      onRename(renameIndex, renameValue.trim())
    }
    setRenameIndex(null)
    setRenameValue('')
  }

  function handleSwitch(index: number) {
    if (menuIndex === null) {
      onSwitch(index)
    }
  }

  return (
    <>
      <div style={s.container}>
        <div ref={scrollRef} style={s.tabs}>
          {windows.map(item => (
            <div
              key={item.index}
              ref={item.index === activeIndex ? activeTabRef : null}
              style={{
                ...s.tab,
                ...(item.index === activeIndex ? s.tabActive : {}),
                position: 'relative',
              }}
              onClick={() => handleSwitch(item.index)}
              onContextMenu={(e) => handleContextMenu(e, item.index)}
              onMouseEnter={() => setHoverIndex(item.index)}
              onMouseLeave={() => setHoverIndex(null)}
              onTouchStart={(e) => {
                // 长按触发关闭菜单
                const timer = setTimeout(() => handleContextMenu(e, item.index), 600)
                const clear = () => {
                  clearTimeout(timer)
                  document.removeEventListener('touchend', clear)
                  document.removeEventListener('touchmove', clear)
                }
                document.addEventListener('touchend', clear)
                document.addEventListener('touchmove', clear)
              }}
            >
              {renameIndex === item.index ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename()
                    if (e.key === 'Escape') { setRenameIndex(null); setRenameValue('') }
                  }}
                  onBlur={submitRename}
                  style={s.renameInput}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span style={{
                  ...s.tabName,
                  ...(item.index === activeIndex ? s.tabNameActive : {}),
                }}>{item.name}</span>
              )}
              {item.index === activeIndex && <span style={s.activeIndicator} />}
              {(() => {
                const status = getWindowStatus(windowOutputs[item.index])
                return <span style={{ ...s.runningDot, background: STATUS_DOT_COLOR[status] }} title={STATUS_DOT_TITLE[status]} />
              })()}
            </div>
          ))}
        </div>
        <div style={s.actions}>
          {sessions && sessions.length > 1 && (
            <button
              style={{ ...s.iconBtn, fontSize: 11, padding: '0 6px', maxWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              onPointerDown={(e) => { e.preventDefault(); setShowSessionPicker(v => !v) }}
              title={`当前 session: ${activeSession}`}
            >{activeSession}</button>
          )}
          <button style={s.iconBtn} onPointerDown={(e) => { e.preventDefault(); onAdd() }} title="新建会话">+</button>
          {onUpload && <button style={s.iconBtn} onPointerDown={(e) => { e.preventDefault(); onUpload() }} title="上传文件">📎</button>}
          {onOpenTasks && (
            <button style={{ ...s.iconBtn, position: 'relative' }} onPointerDown={(e) => { e.preventDefault(); onOpenTasks() }} title="任务面板">
              📋
              {!!runningTaskCount && (
                <span style={{ position: 'absolute', top: 2, right: 2, background: '#22c55e', borderRadius: '50%', width: 8, height: 8, display: 'block' }} />
              )}
            </button>
          )}
          <button style={s.iconBtn} onPointerDown={(e) => { e.preventDefault(); onOpenSettings() }} title="设置">⚙</button>
        </div>
      </div>

      {/* Session 切换浮层（仅多 session 时出现） */}
      {showSessionPicker && sessions && sessions.length > 1 && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 200 }} onClick={() => setShowSessionPicker(false)} />
          <div style={{
            position: 'fixed',
            top: 44,
            right: 0,
            background: 'var(--nexus-menu-bg)',
            border: '1px solid var(--nexus-border)',
            borderRadius: '0 0 0 8px',
            zIndex: 201,
            minWidth: 160,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          }}>
            {sessions.map(sess => (
              <div
                key={sess}
                style={{
                  padding: '12px 16px',
                  cursor: 'pointer',
                  background: sess === activeSession ? 'var(--nexus-tab-active)' : 'transparent',
                  color: sess === activeSession ? 'var(--nexus-text)' : 'var(--nexus-text2)',
                  fontSize: 14,
                  fontFamily: 'Menlo, Monaco, monospace',
                  borderBottom: '1px solid var(--nexus-border)',
                }}
                onClick={() => {
                  onSwitchSession?.(sess)
                  setShowSessionPicker(false)
                }}
              >{sess === activeSession ? '✓ ' : '  '}{sess}</div>
            ))}
          </div>
        </>
      )}

      {/* 输出预览 Tooltip */}
      {hoverIndex !== null && windowOutputs[hoverIndex]?.output && (
        <div style={{
          position: 'fixed',
          top: 44, // TabBar 高度
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--nexus-menu-bg)',
          border: '1px solid var(--nexus-border)',
          borderRadius: 8,
          padding: '8px 12px',
          maxWidth: 600,
          maxHeight: 200,
          overflow: 'auto',
          zIndex: 300,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        }}>
          <div style={{ color: 'var(--nexus-text2)', fontSize: 11, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span>最后输出 ({windows.find(w => w.index === hoverIndex)?.name})</span>
            {windowOutputs[hoverIndex].clients > 0 && (
              <span style={{ color: '#22c55e' }}>● 在线</span>
            )}
          </div>
          <pre style={{
            color: 'var(--nexus-text)',
            fontSize: 12,
            fontFamily: 'Menlo, Monaco, monospace',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.4,
          }}>
            {windowOutputs[hoverIndex].output.slice(-500)}
          </pre>
        </div>
      )}

      {/* 右键/长按菜单 */}
      {menuIndex !== null && (
        <>
          <div style={s.menuOverlay} onPointerDown={() => setMenuIndex(null)} />
          <div style={{
            ...s.contextMenu,
            left: Math.min(menuPos.x, window.innerWidth - 180),
            top: Math.min(menuPos.y + 10, window.innerHeight - 120),
          }}>
            <div style={s.menuTitle}>{windows.find(w => w.index === menuIndex)?.name}</div>
            <button
              style={s.menuItem}
              onPointerDown={() => menuIndex !== null && startRename(menuIndex, windows.find(w => w.index === menuIndex)?.name || '')}
            >
              <span style={s.menuIcon}>✎</span> 重命名
            </button>
            <button
              style={s.menuItemClose}
              onPointerDown={() => menuIndex !== null && handleClose(menuIndex)}
            >
              <span style={s.menuIcon}>✕</span> 关闭会话
            </button>
          </div>
        </>
      )}

    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--nexus-bg)',
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
    height: 44,
  },
  tabs: {
    display: 'flex',
    flex: 1,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
    padding: '0 4px',
    gap: 4,
    WebkitOverflowScrolling: 'touch',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 14px',
    height: 36,
    minWidth: 60,
    maxWidth: 140,
    borderRadius: 8,
    background: 'transparent',
    cursor: 'pointer',
    position: 'relative',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.15s',
    flexShrink: 0,
  },
  tabActive: {
    background: 'var(--nexus-tab-active)',
  },
  tabName: {
    color: 'var(--nexus-text2)',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 100,
  },
  tabNameActive: {
    color: 'var(--nexus-text)',
    fontWeight: 500,
  },
  activeIndicator: {
    position: 'absolute',
    bottom: 4,
    left: '20%',
    right: '20%',
    height: 2,
    background: '#3b82f6',
    borderRadius: 1,
  },
  runningDot: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#22c55e',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '0 8px',
    borderLeft: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-muted)',
    cursor: 'pointer',
    fontSize: 18,
    padding: '6px 10px',
    borderRadius: 6,
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.15s, color 0.15s',
  },
  menuOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 150,
  },
  contextMenu: {
    position: 'fixed',
    background: 'var(--nexus-menu-bg)',
    borderRadius: 8,
    padding: '8px 0',
    minWidth: 140,
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
    border: '1px solid var(--nexus-border)',
    zIndex: 200,
  },
  menuTitle: {
    color: 'var(--nexus-muted)',
    fontSize: 11,
    padding: '4px 16px 8px',
    borderBottom: '1px solid var(--nexus-border)',
    marginBottom: 4,
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'transparent',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 14,
    padding: '8px 16px',
    width: '100%',
    textAlign: 'left',
    transition: 'background 0.15s',
  },
  menuIcon: {
    fontSize: 12,
  },
  menuItemClose: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'transparent',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 14,
    padding: '8px 16px',
    width: '100%',
    textAlign: 'left',
    transition: 'background 0.15s',
  },
  renameInput: {
    background: 'var(--nexus-bg)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 4,
    color: 'var(--nexus-text)',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
    padding: '2px 6px',
    width: 80,
    outline: 'none',
  },
}
