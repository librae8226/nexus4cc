import { useState, useRef, useEffect, RefObject } from 'react'
import { createPortal } from 'react-dom'
import GhostShield from './GhostShield'
import useOverlayGuard from './useOverlayGuard'
import { Icon } from './icons'
import type { Terminal } from '@xterm/xterm'
import { KeyDef, ToolbarConfig, ALL_KEYS, FACTORY_CONFIG } from './toolbarDefaults'
import type { ThemeMode } from './Terminal'

interface Props {
  token: string
  sendToWs: (data: string) => void
  scrollToBottom: () => void
  termRef: RefObject<Terminal | null>
  themeMode: ThemeMode
  onToggleTheme: () => void
  onOpenSettings?: () => void
  onOpenSessions?: () => void
  onOpenTasks?: () => void
  onUpload?: () => void
  runningTaskCount?: number
}

const KEY_MAP = Object.fromEntries(ALL_KEYS.map(k => [k.id, k]))

const CONFIG_KEY = 'nexus_toolbar_v2'
const USER_DEFAULT_KEY = 'nexus_toolbar_default'
const COLLAPSED_KEY = 'nexus_toolbar_collapsed'

// PC 端断点
const PC_BREAKPOINT = 768

function loadConfig(): ToolbarConfig {
  try {
    const s = localStorage.getItem(CONFIG_KEY)
    if (s) return JSON.parse(s)
  } catch {}
  try {
    const d = localStorage.getItem(USER_DEFAULT_KEY)
    if (d) return JSON.parse(d)
  } catch {}
  return { pinned: [...FACTORY_CONFIG.pinned], expanded: [...FACTORY_CONFIG.expanded] }
}

function loadDefault(): ToolbarConfig {
  try {
    const d = localStorage.getItem(USER_DEFAULT_KEY)
    if (d) return JSON.parse(d)
  } catch {}
  return { pinned: [...FACTORY_CONFIG.pinned], expanded: [...FACTORY_CONFIG.expanded] }
}

// ---- 拖拽状态 ----
interface DragState {
  section: 'pinned' | 'expanded'
  fromIdx: number
  toIdx: number
  startY: number
  currentY: number
}

const ITEM_HEIGHT = 48 // px，每行编辑项高度

export default function Toolbar({ token, sendToWs, scrollToBottom, termRef: _termRef, themeMode, onToggleTheme, onOpenSettings, onOpenTasks, onUpload, runningTaskCount }: Props) {
  const [config, setConfig]           = useState<ToolbarConfig>(loadConfig)
  const [collapsed, setCollapsed]     = useState(() => {
    const saved = localStorage.getItem(COLLAPSED_KEY)
    if (saved !== null) return saved === 'true'
    // Default: collapsed on PC (has keyboard), expanded on mobile
    return window.innerWidth >= 1024
  })
  const [editing, setEditing]         = useState(false)
  const [drag, setDrag]               = useState<DragState | null>(null)
  const [savedFlash, setSavedFlash]   = useState(false)
  const [showQuickMenu, setShowQuickMenu] = useState(false)
  const [menuPos, setMenuPos]         = useState({ bottom: 60, right: 8 })
  const menuBtnRef                    = useRef<HTMLButtonElement>(null)
  const [isPC, setIsPC]               = useState(false)
  const [isWidePC, setIsWidePC]       = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024)
  const rootRef = useRef<HTMLDivElement>(null)
  const editScrollRef = useRef<HTMLDivElement>(null)
  const isDraggingMouse = useRef(false)

  // Guard xterm textarea when editing panel is open (prevents keyboard popup)
  useOverlayGuard(_termRef, editing)

  const existsUserDefault = !!localStorage.getItem(USER_DEFAULT_KEY)

  // 检测 PC/移动端
  useEffect(() => {
    const checkWidth = () => {
      setIsPC(window.innerWidth >= PC_BREAKPOINT)
      setIsWidePC(window.innerWidth >= 1024)
    }
    checkWidth()
    window.addEventListener('resize', checkWidth)
    return () => window.removeEventListener('resize', checkWidth)
  }, [])

  // 启动时从服务端拉取配置，覆盖 localStorage 缓存
  useEffect(() => {
    fetch('/api/toolbar-config', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.pinned && data.expanded) {
          setConfig(data)
          localStorage.setItem(CONFIG_KEY, JSON.stringify(data))
        }
      })
      .catch(() => {})
  }, [])

  // 根元素：阻止 touchstart 默认行为，防止键盘弹出。
  // 但滚动区及其子元素（含拖拽手柄）跳过 preventDefault，
  // 让浏览器正常处理滚动，也让 React 合成事件能到达 drag handle。
  // editing 变化时重新注册，因为元素会切换（container ↔ editPanel）。
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const prevent = (e: TouchEvent) => {
      if (editScrollRef.current?.contains(e.target as Node)) return
      e.preventDefault()
    }
    el.addEventListener('touchstart', prevent, { passive: false })
    return () => el.removeEventListener('touchstart', prevent)
  }, [editing])

  // 鼠标拖拽全局监听 — 在 drag 变化时重新注册，确保闭包引用最新的 onDragMove/onDragEnd
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingMouse.current) return
      onDragMove(e.clientY)
    }
    function onMouseUp() {
      if (!isDraggingMouse.current) return
      isDraggingMouse.current = false
      onDragEnd()
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [drag])

  function saveConfig(c: ToolbarConfig) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
    fetch('/api/toolbar-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(c),
    }).catch(() => {})
  }

  function updateConfig(next: ToolbarConfig) { setConfig(next); saveConfig(next) }

  async function handleKey(key: KeyDef) {
    if (key.action === 'scrollToBottom') {
      scrollToBottom()
    } else if (key.action === 'pasteClipboard') {
      try {
        const text = await navigator.clipboard.readText()
        if (text) sendToWs(text)
      } catch {
        // clipboard access denied or unavailable
      }
    } else if (key.action === 'copyTerminal') {
      try {
        const term = _termRef.current
        if (!term) return
        const buffer = (term as any).buffer?.active
        if (!buffer) return
        const lines: string[] = []
        for (let i = buffer.viewportY; i < buffer.length; i++) {
          const line = buffer.getLine(i)
          if (line) lines.push(line.translateToString(true))
        }
        const text = lines.join('\n')
        await navigator.clipboard.writeText(text)
      } catch {
        // ignore
      }
    } else {
      sendToWs(key.seq)
    }
  }

  function removeKey(section: 'pinned' | 'expanded', id: string) {
    updateConfig({ ...config, [section]: config[section].filter(k => k !== id) })
  }

  function addKey(section: 'pinned' | 'expanded', id: string) {
    if (config[section].includes(id)) return
    updateConfig({ ...config, [section]: [...config[section], id] })
  }

  function resetConfig() {
    updateConfig(loadDefault())
  }

  function saveAsDefault() {
    localStorage.setItem(USER_DEFAULT_KEY, JSON.stringify(config))
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  // ---- 拖拽逻辑 ----
  function onDragStart(section: 'pinned' | 'expanded', idx: number, clientY: number) {
    setDrag({ section, fromIdx: idx, toIdx: idx, startY: clientY, currentY: clientY })
  }

  function onDragMove(clientY: number) {
    if (!drag) return
    const delta = clientY - drag.startY
    const shift = Math.round(delta / ITEM_HEIGHT)
    const len = config[drag.section].length
    const toIdx = Math.max(0, Math.min(len - 1, drag.fromIdx + shift))
    setDrag(prev => prev ? { ...prev, currentY: clientY, toIdx } : null)
  }

  function onDragEnd() {
    if (!drag || drag.fromIdx === drag.toIdx) { setDrag(null); return }
    const arr = [...config[drag.section]]
    const [item] = arr.splice(drag.fromIdx, 1)
    arr.splice(drag.toIdx, 0, item)
    updateConfig({ ...config, [drag.section]: arr })
    setDrag(null)
  }

  // 拖拽中预览排列
  function getDisplayIds(section: 'pinned' | 'expanded'): string[] {
    if (!drag || drag.section !== section) return config[section]
    const arr = [...config[section]]
    const [item] = arr.splice(drag.fromIdx, 1)
    arr.splice(drag.toIdx, 0, item)
    return arr
  }

  const usedIds = new Set([...config.pinned, ...config.expanded])
  const availableKeys = ALL_KEYS.filter(k => !usedIds.has(k.id))

  // ---- 渲染按键 ----
  function renderKeys(ids: string[]) {
    return (
      <div style={isPC ? s.rowPC : s.row}>
        {ids.map(id => {
          const key = KEY_MAP[id]
          if (!key) return null
          return (
            <button
              key={id}
              style={isPC ? s.keyPC : s.key}
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); handleKey(key) }}
            >
              {key.label}
            </button>
          )
        })}
      </div>
    )
  }

  // ---- 编辑面板 ----
  if (editing) {
    const editContent = (
      <>
        {/* 头部 */}
        <div style={isPC ? s.editHeaderPC : s.editHeader}>
          <div>
            <span style={isPC ? s.editTitlePC : s.editTitle}>工具栏编辑</span>
            <div style={isPC ? s.editHintPC : s.editHint}>
              {existsUserDefault ? '将恢复到您保存的默认配置' : '将恢复到出厂配置'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onPointerDown={(e) => { e.preventDefault(); resetConfig() }} style={isPC ? s.editBtnSmPC : s.editBtnSm}>重置</button>
            <button
              onPointerDown={(e) => { e.preventDefault(); saveAsDefault() }}
              style={savedFlash ? { ...(isPC ? s.editBtnSmPC : s.editBtnSm), color: 'var(--nexus-success)', borderColor: 'var(--nexus-success)' } : (isPC ? s.editBtnSmPC : s.editBtnSm)}
            >
              {savedFlash ? '已保存' : '存为默认'}
            </button>
            <button onPointerDown={(e) => { e.preventDefault(); setEditing(false) }} style={isPC ? s.editBtnPrimaryPC : s.editBtnPrimary}>完成</button>
          </div>
        </div>

        {/* 列表 */}
        <div ref={editScrollRef} style={isPC ? s.editScrollPC : s.editScroll}>
          {(['pinned', 'expanded'] as const).map(section => (
            <div key={section} style={s.editSection}>
              <div style={isPC ? s.editSectionTitlePC : s.editSectionTitle}>
                {section === 'pinned' ? '固定行（始终显示）' : '展开区'}
              </div>
              {getDisplayIds(section).map((id, idx) => {
                const key = KEY_MAP[id]
                if (!key) return null
                const isDragging = drag?.section === section && drag.toIdx === idx && drag.fromIdx !== idx
                const isSource   = drag?.section === section && drag.fromIdx === idx && drag.fromIdx !== drag.toIdx
                return (
                  <div
                    key={id}
                    style={{
                      ...(isPC ? s.editRowPC : s.editRow),
                      ...(isDragging ? s.editRowTarget : {}),
                      ...(isSource   ? s.editRowSource : {}),
                    }}
                  >
                    {/* 拖拽手柄 */}
                    <div
                      style={s.dragHandle}
                      onTouchStart={(e) => { e.stopPropagation(); onDragStart(section, idx, e.touches[0].clientY) }}
                      onTouchMove={(e) => { e.stopPropagation(); onDragMove(e.touches[0].clientY) }}
                      onTouchEnd={() => onDragEnd()}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        isDraggingMouse.current = true
                        onDragStart(section, idx, e.clientY)
                      }}
                    >
                      <Icon name="grip" size={16} />
                    </div>
                    <span style={isPC ? s.editLabelPC : s.editLabel}>{key.label}</span>
                    <span style={isPC ? s.editDescPC : s.editDesc}>{key.desc}</span>
                    <button
                      style={{ ...(isPC ? s.removeBtnPC : s.removeBtn), display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onPointerDown={(e) => { e.preventDefault(); removeKey(section, id) }}
                      title="移除"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          ))}

          {/* 可添加 */}
          {availableKeys.length > 0 && (
            <div style={s.editSection}>
              <div style={isPC ? s.editSectionTitlePC : s.editSectionTitle}>可添加</div>
              {availableKeys.map(key => (
                <div key={key.id} style={isPC ? s.editRowPC : s.editRow}>
                  <span style={isPC ? s.editLabelPC : s.editLabel}>{key.label}</span>
                  <span style={isPC ? s.editDescPC : s.editDesc}>{key.desc}</span>
                  <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', flexShrink: 0 }}>
                    <button style={isPC ? s.addBtnPC : s.addBtn} onPointerDown={(e) => { e.preventDefault(); addKey('pinned', key.id) }}>固定</button>
                    <button style={isPC ? s.addBtnPC : s.addBtn} onPointerDown={(e) => { e.preventDefault(); addKey('expanded', key.id) }}>展开</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    )

    if (isPC) {
      return (
        <div style={s.desktopOverlay}>
          <GhostShield />
          <div ref={rootRef} style={s.desktopEditPanel}>
            {editContent}
          </div>
        </div>
      )
    }

    return (
      <div ref={rootRef} style={s.editPanel}>
        <GhostShield />
        {editContent}
      </div>
    )
  }

  // ---- 正常工具栏 ----
  if (isPC) {
    return (
      <div ref={rootRef} style={s.containerPC}>
        {/* PC: 控制按钮 + 固定键同一行 */}
        <div style={s.topBarPC}>
          <button style={s.iconBtnPC} onPointerDown={(e) => { e.preventDefault(); setCollapsed(v => { const n = !v; localStorage.setItem(COLLAPSED_KEY, String(n)); return n }) }}>
            <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={18} />
          </button>
          <button style={s.iconBtnPC} onPointerDown={(e) => { e.preventDefault(); setEditing(true) }}><Icon name="pencil" size={18} /></button>
          <button style={s.iconBtnPC} onPointerDown={(e) => { e.preventDefault(); onToggleTheme() }}>
            <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          {/* 固定键：宽屏折叠时隐藏，仅展开时显示 */}
          {(!isWidePC || !collapsed) && (
            <div style={s.pinnedRowPC}>
              {config.pinned.map(id => {
                const key = KEY_MAP[id]
                if (!key) return null
                return (
                  <button
                    key={id}
                    style={s.keyPC}
                    onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); handleKey(key) }}
                  >
                    {key.label}
                  </button>
                )
              })}
            </div>
          )}
          {onOpenSettings && (
            <button style={{ ...s.iconBtnPC, marginLeft: 'auto' }} onPointerDown={(e) => { e.preventDefault(); onOpenSettings() }} title="设置">
              <Icon name="settings" size={18} />
            </button>
          )}
        </div>
        {/* 展开区：非折叠时显示第二行 */}
        {!collapsed && (
          <div style={s.expandedRowsPC}>
            {chunk(config.expanded, 16).map((row, i) => (
              <div key={i} style={s.rowPC}>
                {row.map(id => {
                  const key = KEY_MAP[id]
                  if (!key) return null
                  return (
                    <button
                      key={id}
                      style={s.keyPC}
                      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); handleKey(key) }}
                    >
                      {key.label}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={s.container}>
      <div style={s.topBar}>
        <button style={s.iconBtn} onPointerDown={(e) => { e.preventDefault(); setCollapsed(v => { const n = !v; localStorage.setItem(COLLAPSED_KEY, String(n)); return n }) }}>
          <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={18} />
        </button>
        {/* quick menu */}
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            ref={menuBtnRef}
            style={s.iconBtn}
            onPointerDown={(e) => {
              e.preventDefault()
              if (!showQuickMenu) {
                const tbH = rootRef.current?.offsetHeight ?? 56
                setMenuPos({ bottom: tbH + 4, right: 4 })
              }
              setShowQuickMenu(v => !v)
            }}
            title="更多"
          ><Icon name="settings" size={18} /></button>
          {showQuickMenu && createPortal(
            <>
              <GhostShield />
              <div style={{ position: 'fixed', inset: 0, zIndex: 300 }} onPointerDown={() => setShowQuickMenu(false)} />
              <div style={{ position: 'fixed', bottom: menuPos.bottom, right: menuPos.right, background: 'var(--nexus-menu-bg)', border: '1px solid var(--nexus-border)', borderRadius: 8, padding: '4px 0', minWidth: 160, zIndex: 400, boxShadow: '0 -4px 16px rgba(0,0,0,0.3)' }}>
                <button style={s.quickMenuItem} onPointerDown={(e) => { e.preventDefault(); onToggleTheme(); setShowQuickMenu(false) }}>
                  <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={16} />
                  <span>{themeMode === 'dark' ? '切换亮色' : '切换暗色'}</span>
                </button>
                <button style={s.quickMenuItem} onPointerDown={(e) => { e.preventDefault(); setEditing(true); setShowQuickMenu(false) }}>
                  <Icon name="pencil" size={16} /><span>编辑快捷键</span>
                </button>
                {onOpenTasks && (
                  <button style={s.quickMenuItem} onPointerDown={(e) => { e.preventDefault(); onOpenTasks(); setShowQuickMenu(false) }}>
                    <Icon name="clipboard" size={16} />
                    <span>任务面板</span>
                    {!!runningTaskCount && <span style={{ marginLeft: 'auto', background: 'var(--nexus-success)', color: '#fff', borderRadius: 8, padding: '1px 6px', fontSize: 11 }}>{runningTaskCount}</span>}
                  </button>
                )}
                {onUpload && (
                  <button style={s.quickMenuItem} onPointerDown={(e) => { e.preventDefault(); onUpload(); setShowQuickMenu(false) }}>
                    <Icon name="paperclip" size={16} /><span>上传文件</span>
                  </button>
                )}
              </div>
            </>,
            document.body
          )}
        </div>
      </div>

      {renderKeys(config.pinned)}

      {!collapsed && (
        <div style={s.expandedRows}>
          {chunk(config.expanded, 8).map((row, i) => (
            <div key={i} style={s.row}>
              {row.map(id => {
                const key = KEY_MAP[id]
                if (!key) return null
                return (
                  <button
                    key={id}
                    style={s.key}
                    onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); handleKey(key) }}
                  >
                    {key.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const s: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--nexus-bg)',
    borderTop: '1px solid var(--nexus-border)',
    userSelect: 'none',
    flexShrink: 0,
  },
  containerPC: {
    background: 'var(--nexus-bg)',
    borderTop: '1px solid var(--nexus-border)',
    userSelect: 'none',
    flexShrink: 0,
    width: '100%',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 6px',
    gap: 4,
  },
  quickMenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '10px 14px',
    width: '100%',
    textAlign: 'left' as const,
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
  },
  topBarPC: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 12px',
    gap: 6,
    height: 44,
    boxSizing: 'border-box',
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '4px 8px',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    display: 'flex',
    gap: 4,
    padding: '2px 6px',
    flexWrap: 'wrap',
  },
  rowPC: {
    display: 'flex',
    gap: 6,
    padding: '4px 12px',
    flexWrap: 'wrap',
  },
  expandedRows: { paddingBottom: 4 },
  expandedRowsPC: { paddingBottom: 8 },
  key: {
    background: 'var(--nexus-bg2)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 6,
    color: 'var(--nexus-text)',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'monospace',
    minWidth: 38,
    padding: '6px 7px',
    textAlign: 'center',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    flexShrink: 0,
  },
  keyPC: {
    background: 'var(--nexus-bg2)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 6,
    color: 'var(--nexus-text)',
    cursor: 'pointer',
    fontSize: 14,
    fontFamily: 'monospace',
    minWidth: 48,
    padding: '8px 10px',
    textAlign: 'center',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    flexShrink: 0,
  },
  // ---- 编辑面板 ----
  editPanel: {
    background: 'var(--nexus-bg)',
    borderTop: '1px solid var(--nexus-border)',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '55vh',
  },
  // PC 端编辑面板样式
  desktopOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
  },
  desktopEditPanel: {
    background: 'var(--nexus-bg)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 12,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: 600,
    maxHeight: '70vh',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  },
  editHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  editHeaderPC: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  editTitle: { color: 'var(--nexus-text)', fontSize: 14, fontWeight: 600 },
  editTitlePC: { color: 'var(--nexus-text)', fontSize: 16, fontWeight: 600 },
  editHint: { color: 'var(--nexus-muted)', fontSize: 10, marginTop: 2 },
  editHintPC: { color: 'var(--nexus-muted)', fontSize: 12, marginTop: 4 },
  editScroll: { overflowY: 'auto', flex: 1 },
  editScrollPC: { overflowY: 'auto', flex: 1, padding: '8px 0' },
  editSection: { marginBottom: 4 },
  editSectionTitle: {
    color: 'var(--nexus-text2)',
    fontSize: 11,
    padding: '6px 10px 3px',
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
  editSectionTitlePC: {
    color: 'var(--nexus-text2)',
    fontSize: 12,
    padding: '10px 20px 6px',
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
  editRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 10px',
    height: ITEM_HEIGHT,
    gap: 8,
    borderBottom: '1px solid var(--nexus-border)',
    boxSizing: 'border-box',
  },
  editRowPC: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 20px',
    height: ITEM_HEIGHT,
    gap: 12,
    borderBottom: '1px solid var(--nexus-border)',
    boxSizing: 'border-box',
  },
  editRowTarget: {
    background: 'rgba(59,130,246,0.1)',
    borderColor: 'var(--nexus-accent)',
  },
  editRowSource: {
    opacity: 0.35,
  },
  dragHandle: {
    color: 'var(--nexus-text2)',
    fontSize: 16,
    cursor: 'grab',
    padding: '8px 4px',
    flexShrink: 0,
    touchAction: 'none',
    display: 'flex',
    alignItems: 'center',
  },
  editLabel: {
    color: 'var(--nexus-text)',
    fontFamily: 'monospace',
    fontSize: 13,
    minWidth: 48,
    flexShrink: 0,
  },
  editLabelPC: {
    color: 'var(--nexus-text)',
    fontFamily: 'monospace',
    fontSize: 14,
    minWidth: 60,
    flexShrink: 0,
  },
  editDesc: {
    color: 'var(--nexus-text2)',
    fontSize: 11,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  editDescPC: {
    color: 'var(--nexus-text2)',
    fontSize: 12,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-error)',
    cursor: 'pointer',
    fontSize: 18,
    padding: '0 2px',
    flexShrink: 0,
    lineHeight: 1,
  },
  removeBtnPC: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-error)',
    cursor: 'pointer',
    fontSize: 20,
    padding: '4px 8px',
    flexShrink: 0,
    lineHeight: 1,
  },
  addBtn: {
    background: 'var(--nexus-bg2)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 4,
    color: 'var(--nexus-accent)',
    cursor: 'pointer',
    fontSize: 11,
    padding: '4px 8px',
  },
  addBtnPC: {
    background: 'var(--nexus-bg2)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 4,
    color: 'var(--nexus-accent)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '6px 12px',
  },
  editBtnSm: {
    background: 'transparent',
    border: '1px solid var(--nexus-border)',
    borderRadius: 4,
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '4px 10px',
  },
  editBtnSmPC: {
    background: 'transparent',
    border: '1px solid var(--nexus-border)',
    borderRadius: 4,
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 13,
    padding: '6px 14px',
  },
  editBtnPrimary: {
    background: 'var(--nexus-accent)',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 12px',
  },
  editBtnPrimaryPC: {
    background: 'var(--nexus-accent)',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    padding: '6px 16px',
  },
  // PC 紧凑控制按钮
  iconBtnPC: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 13,
    padding: '3px 6px',
    borderRadius: 4,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinnedRowPC: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    flex: 1,
    marginLeft: 8,
    alignItems: 'center',
  },
}
