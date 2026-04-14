import { useState, useRef, useEffect, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
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
  onUpload?: () => void
  onUploadFile?: (file: File) => void
  onOpenFiles?: () => void
  onOpenWorkspace?: () => void
  onFitTerminal?: () => void
  onShowCopySheet?: (text: string) => void
  /** When true: renders as a compact sidebar section (no theme/settings, flex-wrap key grid) */
  embedded?: boolean
  /** Controlled collapsed state (optional). If provided, component acts as controlled. */
  collapsed?: boolean
  /** Callback when collapsed state changes (for controlled mode) */
  onCollapsedChange?: (collapsed: boolean) => void
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

export default function Toolbar({ token, sendToWs, scrollToBottom, termRef: _termRef, themeMode, onToggleTheme, onOpenSettings, onUploadFile, onOpenFiles, onOpenWorkspace, onFitTerminal, onShowCopySheet, embedded, collapsed: controlledCollapsed, onCollapsedChange }: Props) {
  const { t } = useTranslation()
  const [config, setConfig]           = useState<ToolbarConfig>(loadConfig)
  const isControlled = controlledCollapsed !== undefined
  const [collapsedInternal, setCollapsedInternal] = useState(() => {
    const saved = localStorage.getItem(COLLAPSED_KEY)
    if (saved !== null) return saved === 'true'
    // Default: collapsed on PC (has keyboard), expanded on mobile
    return window.innerWidth >= 1024
  })
  const collapsed = isControlled ? controlledCollapsed : collapsedInternal

  function setCollapsed(value: boolean | ((prev: boolean) => boolean)) {
    const next = typeof value === 'function' ? value(collapsed) : value
    if (isControlled) {
      onCollapsedChange?.(next)
    } else {
      setCollapsedInternal(next)
    }
    localStorage.setItem(COLLAPSED_KEY, String(next))
  }

  const [editing, setEditing]         = useState(false)
  const [showPasteBox, setShowPasteBox] = useState(false)
  const pasteBoxRef   = useRef<HTMLTextAreaElement>(null)
  const pasteFileRef  = useRef<HTMLInputElement>(null)
  const fileInputRef  = useRef<HTMLInputElement>(null)
  const [drag, setDrag]               = useState<DragState | null>(null)
  const [savedFlash, setSavedFlash]   = useState(false)
  const [showQuickMenu, setShowQuickMenu] = useState(false)
  const [showUploadMenu, setShowUploadMenu] = useState(false)
  const [menuPos, setMenuPos]         = useState({ bottom: 60, right: 8 })
  const [uploadMenuPos, setUploadMenuPos] = useState({ bottom: 60, right: 44 })
  const menuBtnRef                    = useRef<HTMLButtonElement>(null)
  const uploadBtnRef                  = useRef<HTMLButtonElement>(null)
  const [isPC, setIsPC]               = useState(false)
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
  }, [token])

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

  useEffect(() => {
    if (showPasteBox) setTimeout(() => pasteBoxRef.current?.focus(), 50)
  }, [showPasteBox])

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
      // Try clipboard API silently (HTTPS only); fall back to the paste sheet
      if (navigator.clipboard) {
        let handled = false
        try {
          const items = await navigator.clipboard.read()
          for (const item of items) {
            const imgType = item.types.find(t => t.startsWith('image/'))
            if (imgType && onUploadFile) {
              const blob = await item.getType(imgType)
              onUploadFile(new File([blob], `paste.${imgType.split('/')[1] ?? 'png'}`, { type: imgType }))
              handled = true; break
            }
          }
        } catch {}
        if (!handled) {
          try {
            const text = await navigator.clipboard.readText()
            if (text) { sendToWs(text); handled = true }
          } catch {}
        }
        if (handled) return
      }
      setShowPasteBox(true)
    } else if (key.action === 'fit') {
      onFitTerminal?.()
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
        if (onShowCopySheet) {
          onShowCopySheet(text)
        }
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
      <div className={isPC ? 'flex flex-wrap gap-1.5 px-3 py-1' : 'flex flex-wrap gap-1 px-1.5 py-0.5'}>
        {ids.map(id => {
          const key = KEY_MAP[id]
          if (!key) return null
          return (
            <button
              key={id}
              className={isPC ? keyPCClass : keyClass}
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
        <div className={isPC ? 'flex items-center justify-between px-5 py-4 border-b border-nexus-border shrink-0' : 'flex items-center justify-between px-2.5 py-2 border-b border-nexus-border shrink-0'}>
          <div>
            <span className={isPC ? 'text-nexus-text text-base font-semibold' : 'text-nexus-text text-sm font-semibold'}>{t('toolbar.toolbarEdit')}</span>
            <div className={isPC ? 'text-nexus-muted text-xs mt-1' : 'text-nexus-muted text-[10px] mt-0.5'}>
              {existsUserDefault ? t('toolbar.resetToSaved') : t('toolbar.resetToFactory')}
            </div>
          </div>
          <div className="flex gap-2">
            <button onPointerDown={(e) => { e.preventDefault(); resetConfig() }} className={isPC ? editBtnSmPCClass : editBtnSmClass}>{t('toolbar.reset')}</button>
            <button
              onPointerDown={(e) => { e.preventDefault(); saveAsDefault() }}
              className={savedFlash ? (isPC ? 'text-nexus-success border-nexus-success ' + editBtnSmPCClass : 'text-nexus-success border-nexus-success ' + editBtnSmClass) : (isPC ? editBtnSmPCClass : editBtnSmClass)}
            >
              {savedFlash ? t('common.saved') : t('toolbar.saveAsDefault')}
            </button>
            <button onPointerDown={(e) => { e.preventDefault(); setEditing(false) }} className={isPC ? editBtnPrimaryPCClass : editBtnPrimaryClass}>{t('toolbar.done')}</button>
          </div>
        </div>

        {/* 列表 */}
        <div ref={editScrollRef} className={isPC ? 'overflow-y-auto flex-1 py-2' : 'overflow-y-auto flex-1'}>
          {(['pinned', 'expanded'] as const).map(section => (
            <div key={section} className="mb-1">
              <div className={isPC ? 'text-nexus-text-2 text-xs px-5 py-2.5 pb-1.5 tracking-wide uppercase' : 'text-nexus-text-2 text-[11px] px-2.5 py-1.5 pb-[3px] tracking-wide uppercase'}>
                {section === 'pinned' ? t('toolbar.fixedRow') : t('toolbar.expandSection')}
              </div>
              {getDisplayIds(section).map((id, idx) => {
                const key = KEY_MAP[id]
                if (!key) return null
                const isDragging = drag?.section === section && drag.toIdx === idx && drag.fromIdx !== idx
                const isSource   = drag?.section === section && drag.fromIdx === idx && drag.fromIdx !== drag.toIdx
                return (
                  <div
                    key={id}
                    className={[
                      isPC ? 'flex items-center px-5 h-12 gap-3 border-b border-nexus-border box-border' : 'flex items-center px-2.5 h-12 gap-2 border-b border-nexus-border box-border',
                      isDragging ? 'bg-[color-mix(in_srgb,var(--nexus-accent)_12%,transparent)] border-nexus-accent' : '',
                      isSource ? 'opacity-[0.35]' : ''
                    ].filter(Boolean).join(' ')}
                  >
                    {/* 拖拽手柄 */}
                    <div
                      className="text-nexus-text-2 text-base cursor-grab py-2 px-1 shrink-0 touch-none flex items-center"
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
                    <span className={isPC ? 'text-nexus-text font-mono text-sm min-w-[60px] shrink-0' : 'text-nexus-text font-mono text-[13px] min-w-[48px] shrink-0'}>{key.label}</span>
                    <span className={isPC ? 'text-nexus-text-2 text-xs flex-1 overflow-hidden text-ellipsis whitespace-nowrap' : 'text-nexus-text-2 text-[11px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap'}>{t(key.desc)}</span>
                    <button
                      className={isPC ? 'bg-transparent border-none text-nexus-error cursor-pointer text-xl px-2 py-1 shrink-0 leading-none flex items-center justify-center' : 'bg-transparent border-none text-nexus-error cursor-pointer text-lg px-0.5 shrink-0 leading-none flex items-center justify-center'}
                      onPointerDown={(e) => { e.preventDefault(); removeKey(section, id) }}
                      title={t('toolbar.remove')}
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
            <div className="mb-1">
              <div className={isPC ? 'text-nexus-text-2 text-xs px-5 py-2.5 pb-1.5 tracking-wide uppercase' : 'text-nexus-text-2 text-[11px] px-2.5 py-1.5 pb-[3px] tracking-wide uppercase'}>{t('toolbar.addAvailable')}</div>
              {availableKeys.map(key => (
                <div key={key.id} className={isPC ? 'flex items-center px-5 h-12 gap-3 border-b border-nexus-border box-border' : 'flex items-center px-2.5 h-12 gap-2 border-b border-nexus-border box-border'}>
                  <span className={isPC ? 'text-nexus-text font-mono text-sm min-w-[60px] shrink-0' : 'text-nexus-text font-mono text-[13px] min-w-[48px] shrink-0'}>{key.label}</span>
                  <span className={isPC ? 'text-nexus-text-2 text-xs flex-1 overflow-hidden text-ellipsis whitespace-nowrap' : 'text-nexus-text-2 text-[11px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap'}>{t(key.desc)}</span>
                  <div className="flex gap-1 ml-auto shrink-0">
                    <button className={isPC ? addBtnPCClass : addBtnClass} onPointerDown={(e) => { e.preventDefault(); addKey('pinned', key.id) }}>{t('toolbar.pinToFixed')}</button>
                    <button className={isPC ? addBtnPCClass : addBtnClass} onPointerDown={(e) => { e.preventDefault(); addKey('expanded', key.id) }}>{t('toolbar.pinToExpand')}</button>
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
        <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5">
          <GhostShield />
          <div ref={rootRef} className="bg-nexus-bg border border-nexus-border rounded-xl shrink-0 flex flex-col w-full max-w-[600px] max-h-[70vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
            {editContent}
          </div>
        </div>
      )
    }

    return (
      <div ref={rootRef} className="bg-nexus-bg border-t border-nexus-border shrink-0 flex flex-col max-h-[55vh]">
        <GhostShield />
        {editContent}
      </div>
    )
  }

  // ---- 统一粘贴 / 上传面板 ----
  const pasteBoxEl = showPasteBox && createPortal(
    <>
      <div className="fixed inset-0 z-[700]" onClick={() => setShowPasteBox(false)} />
      <div className="fixed bottom-0 left-0 right-0 z-[701] bg-nexus-bg border-t border-nexus-border rounded-t-xl p-3.5 pb-6 shadow-[0_-4px_24px_rgba(0,0,0,0.35)]"
        onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-nexus-text text-sm font-semibold">{t('toolbar.pasteUpload')}</span>
          <button onPointerDown={(e) => { e.preventDefault(); setShowPasteBox(false) }}
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex">
            <Icon name="x" size={20} />
          </button>
        </div>
        <textarea
          ref={pasteBoxRef}
          rows={3}
          placeholder={t('toolbar.pastePlaceholder')}
          className="w-full box-border bg-nexus-bg-2 border border-nexus-border rounded-lg text-nexus-text text-sm p-2.5 resize-none outline-none font-inherit block"
          onPaste={(e) => {
            const items = e.clipboardData?.items
            if (items) {
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/') && onUploadFile) {
                  e.preventDefault()
                  const file = items[i].getAsFile()
                  if (file) { onUploadFile(file); setShowPasteBox(false) }
                  return
                }
              }
            }
            setTimeout(() => {
              const text = pasteBoxRef.current?.value ?? ''
              if (text) { sendToWs(text); setShowPasteBox(false) }
            }, 0)
          }}
        />
        <button
          className="w-full mt-2 py-2.5 rounded-lg bg-nexus-accent text-white text-sm font-medium cursor-pointer border-none"
          onClick={() => {
            const text = pasteBoxRef.current?.value ?? ''
            if (text) { sendToWs(text); setShowPasteBox(false) }
          }}
        >
          Send
        </button>
        <label className="flex items-center justify-center gap-2 mt-2.5 p-2.5 rounded-lg cursor-pointer bg-nexus-bg-2 border border-nexus-border text-nexus-text-2 text-[13px]">
          <Icon name="paperclip" size={16} />{t('toolbar.selectFile')}
          <input ref={pasteFileRef} type="file" accept="*/*" className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file && onUploadFile) { onUploadFile(file); setShowPasteBox(false) }
              e.target.value = ''
            }}
          />
        </label>
      </div>
    </>,
    document.body
  )

  // 隐藏的文件输入框（移动端和PC端都需要）
  const fileInputsEl = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file && onUploadFile) { onUploadFile(file) }
          e.target.value = ''
        }}
      />
      <input
        ref={pasteFileRef}
        type="file"
        accept="*/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file && onUploadFile) { onUploadFile(file) }
          e.target.value = ''
        }}
      />
    </>
  )

  // ---- 嵌入侧边栏模式（PC端） ----
  if (embedded) {
    const allEmbedded = [...config.pinned, ...(collapsed ? [] : config.expanded)]
    return (
      <div ref={rootRef} className="border-t border-nexus-border shrink-0 bg-nexus-bg">
        {/* Section header */}
        <div className="flex items-center px-2 py-1 gap-0.5">
          <span className="text-[10px] text-nexus-muted flex-1 tracking-wide uppercase">{t('toolbar.shortcuts')}</span>
          <button
            className={iconBtnPCClass}
            onPointerDown={(e) => { e.preventDefault(); setEditing(true) }}
            title={t('toolbar.editShortcuts')}
          ><Icon name="pencil" size={18} /></button>
          <button
            className={iconBtnPCClass}
            onPointerDown={(e) => { e.preventDefault(); setCollapsed(v => { const n = !v; localStorage.setItem(COLLAPSED_KEY, String(n)); return n }) }}
            title={collapsed ? t('toolbar.expand') : t('toolbar.collapse')}
          ><Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={18} /></button>
        </div>
        {/* Key grid */}
        <div className="flex flex-wrap gap-[3px] px-2 pb-2">
          {allEmbedded.map(id => {
            const key = KEY_MAP[id]
            if (!key) return null
            return (
              <button
                key={id}
                className={keyEmbeddedClass}
                onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); handleKey(key) }}
                title={t(key.desc)}
              >{key.label}</button>
            )
          })}
        </div>
        {/* Bottom actions: upload + settings */}
        <div className="flex items-center justify-between px-2 py-1.5 border-t border-nexus-border">
          <div className="flex items-center gap-0.5">
            {onOpenWorkspace && (
              <button
                className={iconBtnPCClass}
                onPointerDown={(e) => { e.preventDefault(); onOpenWorkspace() }}
                title={t('toolbar.workspace')}
              ><Icon name="folder" size={18} /></button>
            )}
            <button
              className={iconBtnPCClass}
              onPointerDown={(e) => { e.preventDefault(); fileInputRef.current?.click() }}
              title={t('toolbar.pasteUpload')}
            ><Icon name="paperclip" size={18} /></button>
          </div>
          <div className="flex items-center gap-0.5">
            {onOpenFiles && (
              <button
                className={iconBtnPCClass}
                onPointerDown={(e) => { e.preventDefault(); onOpenFiles() }}
                title={t('toolbar.fileList')}
              ><Icon name="image" size={18} /></button>
            )}
            {onOpenSettings && (
              <button
                className={iconBtnPCClass}
                onPointerDown={(e) => { e.preventDefault(); onOpenSettings() }}
                title={t('toolbar.settings')}
              ><Icon name="settings" size={18} /></button>
            )}
          </div>
        </div>
        {fileInputsEl}
        {pasteBoxEl}
      </div>
    )
  }

  // ---- 正常工具栏 ----
  if (isPC) {
    return (
      <div ref={rootRef} className="bg-nexus-bg border-t border-nexus-border select-none shrink-0 w-full">
        {fileInputsEl}
        {/* PC: 控制按钮 + 固定键同一行 */}
        <div className="flex items-center px-3 py-1 gap-1.5 h-11 box-border">
          <button className={iconBtnPCClass} onPointerDown={(e) => { e.preventDefault(); setEditing(true) }} title={t('toolbar.editShortcuts')}><Icon name="pencil" size={18} /></button>
          <button className={iconBtnPCClass} onPointerDown={(e) => { e.preventDefault(); onToggleTheme() }} title={t('toolbar.toggleTheme')}>
            <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          {/* 固定键：始终显示，占据中间空间 */}
          <div className="flex gap-1.5 flex-wrap flex-1 ml-2 items-center">
            {config.pinned.map(id => {
              const key = KEY_MAP[id]
              if (!key) return null
              return (
                <button
                  key={id}
                  className={keyPCClass}
                  onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); handleKey(key) }}
                >
                  {key.label}
                </button>
              )
            })}
          </div>
          {/* 右侧按钮组 */}
          {onOpenWorkspace && (
            <button className={iconBtnPCClass} onPointerDown={(e) => { e.preventDefault(); onOpenWorkspace() }} title={t('toolbar.workspace')}>
              <Icon name="folder" size={18} />
            </button>
          )}
          <button
            ref={uploadBtnRef}
            className={`${iconBtnPCClass} relative`}
            onPointerDown={(e) => {
              e.preventDefault()
              if (!showUploadMenu) {
                const rect = uploadBtnRef.current?.getBoundingClientRect()
                if (rect) {
                  setUploadMenuPos({ bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right })
                }
              }
              setShowUploadMenu(v => !v)
            }}
            title={t('toolbar.pasteUpload')}
          >
            <Icon name="paperclip" size={18} />
          </button>
          {showUploadMenu && createPortal(
            <>
              <GhostShield />
              <div className="fixed inset-0 z-[300]" onPointerDown={() => setShowUploadMenu(false)} />
              <div className="fixed bg-nexus-menu-bg border border-nexus-border rounded-lg py-1 min-w-[120px] z-[400] shadow-[0_4px_16px_rgba(0,0,0,0.3)]" style={{ bottom: uploadMenuPos.bottom, right: uploadMenuPos.right }}>
                <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); fileInputRef.current?.click(); setShowUploadMenu(false) }}>
                  <Icon name="image" size={16} />
                  <span>{t('toolbar.photos')}</span>
                </button>
                <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); pasteFileRef.current?.click(); setShowUploadMenu(false) }}>
                  <Icon name="folder" size={16} />
                  <span>{t('toolbar.files')}</span>
                </button>
              </div>
            </>,
            document.body
          )}
          {onOpenSettings && (
            <button className={iconBtnPCClass} onPointerDown={(e) => { e.preventDefault(); onOpenSettings() }} title={t('toolbar.settings')}>
              <Icon name="settings" size={18} />
            </button>
          )}
          <button className={iconBtnPCClass} onPointerDown={(e) => { e.preventDefault(); setCollapsed(v => { const n = !v; localStorage.setItem(COLLAPSED_KEY, String(n)); return n }) }} title={collapsed ? t('toolbar.expand') : t('toolbar.collapse')}>
            <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={18} />
          </button>
        </div>
        {/* 展开区：非折叠时显示第二行 */}
        {!collapsed && (
          <div className="pb-2">
            {chunk(config.expanded, 16).map((row, i) => (
              <div key={i} className="flex flex-wrap gap-1.5 px-3 py-1">
                {row.map(id => {
                  const key = KEY_MAP[id]
                  if (!key) return null
                  return (
                    <button
                      key={id}
                      className={keyPCClass}
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
        {pasteBoxEl}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="bg-nexus-bg border-t border-nexus-border select-none shrink-0">
      {fileInputsEl}
      <div className="flex items-center py-[3px] px-1.5 gap-1">
        <div className="flex-1" />
        {/* 上传按钮 - 显示自定义面板 */}
        {onOpenWorkspace && (
          <button
            className={iconBtnClass}
            onPointerDown={(e) => { e.preventDefault(); onOpenWorkspace() }}
            title={t('toolbar.workspace')}
          >
            <Icon name="folder" size={18} />
          </button>
        )}
        <button
          className={iconBtnClass}
          onPointerDown={(e) => {
            e.preventDefault()
            if (!showUploadMenu) {
              const tbH = rootRef.current?.offsetHeight ?? 56
              setUploadMenuPos({ bottom: tbH + 4, right: 44 })
            }
            setShowUploadMenu(v => !v)
          }}
          title={t('toolbar.pasteUpload')}
        >
          <Icon name="paperclip" size={18} />
        </button>
        {showUploadMenu && createPortal(
          <>
            <GhostShield />
            <div className="fixed inset-0 z-[300]" onPointerDown={() => setShowUploadMenu(false)} />
            <div className="fixed bg-nexus-menu-bg border border-nexus-border rounded-lg py-1 min-w-[120px] z-[400] shadow-[0_-4px_16px_rgba(0,0,0,0.3)]" style={{ bottom: uploadMenuPos.bottom, right: uploadMenuPos.right }}>
              <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); fileInputRef.current?.click(); setShowUploadMenu(false) }}>
                <Icon name="image" size={16} />
                <span>{t('toolbar.photos')}</span>
              </button>
              <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); pasteFileRef.current?.click(); setShowUploadMenu(false) }}>
                <Icon name="folder" size={16} />
                <span>{t('toolbar.files')}</span>
              </button>
            </div>
          </>,
          document.body
        )}
        {/* quick menu */}
        <div className="relative">
          <button
            ref={menuBtnRef}
            className={iconBtnClass}
            onPointerDown={(e) => {
              e.preventDefault()
              if (!showQuickMenu) {
                const tbH = rootRef.current?.offsetHeight ?? 56
                setMenuPos({ bottom: tbH + 4, right: 4 })
              }
              setShowQuickMenu(v => !v)
            }}
            title={t('toolbar.more')}
          ><Icon name="settings" size={18} /></button>
          {showQuickMenu && createPortal(
            <>
              <GhostShield />
              <div className="fixed inset-0 z-[300]" onPointerDown={() => setShowQuickMenu(false)} />
              <div className="fixed bg-nexus-menu-bg border border-nexus-border rounded-lg py-1 min-w-[160px] z-[400] shadow-[0_-4px_16px_rgba(0,0,0,0.3)]" style={{ bottom: menuPos.bottom, right: menuPos.right }}>
                <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); onToggleTheme(); setShowQuickMenu(false) }}>
                  <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={16} />
                  <span>{themeMode === 'dark' ? t('toolbar.switchLight') : t('toolbar.switchDark')}</span>
                </button>
                <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); setEditing(true); setShowQuickMenu(false) }}>
                  <Icon name="pencil" size={16} /><span>{t('toolbar.editShortcuts')}</span>
                </button>
                {onOpenFiles && (
                  <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); onOpenFiles(); setShowQuickMenu(false) }}>
                    <Icon name="image" size={16} />
                    <span>{t('toolbar.fileList')}</span>
                  </button>
                )}
                {onOpenSettings && (
                  <button className={quickMenuItemClass} onPointerDown={(e) => { e.preventDefault(); onOpenSettings(); setShowQuickMenu(false) }}>
                    <Icon name="settings" size={16} />
                    <span>{t('toolbar.settings')}</span>
                  </button>
                )}
              </div>
            </>,
            document.body
          )}
        </div>
        <button className={iconBtnClass} onPointerDown={(e) => { e.preventDefault(); setCollapsed(v => { const n = !v; localStorage.setItem(COLLAPSED_KEY, String(n)); return n }) }}>
          <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={18} />
        </button>
      </div>

      {renderKeys(config.pinned)}

      {!collapsed && (
        <div className="pb-1">
          {chunk(config.expanded, 8).map((row, i) => (
            <div key={i} className="flex flex-wrap gap-1 px-1.5 py-0.5">
              {row.map(id => {
                const key = KEY_MAP[id]
                if (!key) return null
                return (
                  <button
                    key={id}
                    className={keyClass}
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
      {pasteBoxEl}
    </div>
  )
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// Tailwind class constants for reuse
const keyClass = 'bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text cursor-pointer text-xs font-mono min-w-[38px] py-1.5 px-[7px] text-center touch-manipulation flex-shrink-0 transition-all duration-100 active:scale-95 active:bg-nexus-bg active:border-nexus-accent'
const keyPCClass = 'bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text cursor-pointer text-sm font-mono min-w-[48px] py-2 px-2.5 text-center touch-manipulation flex-shrink-0 transition-all duration-100 active:scale-95 active:bg-nexus-bg active:border-nexus-accent'
const keyEmbeddedClass = 'bg-nexus-bg-2 border border-nexus-border rounded text-nexus-text cursor-pointer text-[11px] font-mono min-w-[30px] py-1 px-[5px] text-center touch-manipulation flex-shrink-0 transition-all duration-100 active:scale-95 active:bg-nexus-bg active:border-nexus-accent'
const iconBtnClass = 'bg-transparent border-none text-nexus-text-2 cursor-pointer text-sm py-1 px-2 rounded flex items-center justify-center transition-all duration-100 active:scale-90 active:text-nexus-text active:bg-nexus-bg-2'
const iconBtnPCClass = 'bg-transparent border-none text-nexus-text-2 cursor-pointer text-[13px] py-[3px] px-1.5 rounded flex-shrink-0 flex items-center justify-center transition-all duration-100 active:scale-90 active:text-nexus-text active:bg-nexus-bg-2'
const quickMenuItemClass = 'flex items-center gap-2.5 bg-transparent border-none text-nexus-text cursor-pointer text-sm py-2.5 px-3.5 w-full text-left touch-manipulation transition-all duration-100 active:bg-nexus-bg-2 active:pl-4'
const editBtnSmClass = 'bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-xs py-1 px-2.5 transition-all duration-100 active:scale-95 active:bg-nexus-bg-2'
const editBtnSmPCClass = 'bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-[13px] py-1.5 px-3.5 transition-all duration-100 active:scale-95 active:bg-nexus-bg-2'
const editBtnPrimaryClass = 'bg-nexus-accent border-none rounded text-white cursor-pointer text-xs font-semibold py-1 px-3 transition-all duration-100 active:scale-95 active:bg-blue-600'
const editBtnPrimaryPCClass = 'bg-nexus-accent border-none rounded text-white cursor-pointer text-[13px] font-semibold py-1.5 px-4 transition-all duration-100 active:scale-95 active:bg-blue-600'
const addBtnClass = 'bg-nexus-bg-2 border border-nexus-border rounded text-nexus-accent cursor-pointer text-[11px] py-1 px-2 transition-all duration-100 active:scale-95 active:bg-nexus-bg'
const addBtnPCClass = 'bg-nexus-bg-2 border border-nexus-border rounded text-nexus-accent cursor-pointer text-xs py-1.5 px-3 transition-all duration-100 active:scale-95 active:bg-nexus-bg'
