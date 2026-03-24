import { useEffect, useRef, useCallback, useState, lazy, Suspense } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import Toolbar from './Toolbar'
import SessionFAB from './SessionFAB'
import GhostShield from './GhostShield'
import { Icon } from './icons'
import { getWindowStatus, STATUS_DOT_COLOR, STATUS_DOT_TITLE } from './windowStatus'

const SessionManager = lazy(() => import('./SessionManager'))
const WorkspaceSelector = lazy(() => import('./WorkspaceSelector'))
const TaskPanel = lazy(() => import('./TaskPanel'))

interface TmuxWindow {
  index: number
  name: string
  active: boolean
}

interface Props {
  token: string
}

const FONT_SIZE_KEY = 'nexus_font_size'
const THEME_KEY = 'nexus_theme'
const WINDOW_KEY = 'nexus_window'
const TAP_THRESHOLD = 8

export type ThemeMode = 'dark' | 'light'

const DARK_THEME: ITheme = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#94a3b8',
  cursorAccent: '#0f172a',
  selectionBackground: '#3b82f660',
  selectionForeground: '#f1f5f9',
  black: '#1a1a2e',
  brightBlack: '#4a5568',
  red: '#fc8181',
  brightRed: '#feb2b2',
  green: '#68d391',
  brightGreen: '#9ae6b4',
  yellow: '#f6e05e',
  brightYellow: '#faf089',
  blue: '#63b3ed',
  brightBlue: '#90cdf4',
  magenta: '#b794f4',
  brightMagenta: '#d6bcfa',
  cyan: '#76e4f7',
  brightCyan: '#b2f5ea',
  white: '#e2e8f0',
  brightWhite: '#f7fafc',
}

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1e293b',
  cursor: '#475569',
  cursorAccent: '#f8fafc',
  selectionBackground: '#bfdbfe',
  selectionForeground: '#1e293b',
  black: '#000000',
  brightBlack: '#666666',
  red: '#cd3131',
  brightRed: '#f14c4c',
  green: '#00bc00',
  brightGreen: '#23d18b',
  yellow: '#949800',
  brightYellow: '#f5f543',
  blue: '#0451a5',
  brightBlue: '#3b8eea',
  magenta: '#bc05bc',
  brightMagenta: '#d670d6',
  cyan: '#0598bc',
  brightCyan: '#29b8db',
  white: '#cccccc',
  brightWhite: '#e5e5e5',
}

export const THEMES: Record<ThemeMode, ITheme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
}

export function getInitialTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// 主题色板 — 统一 Tailwind slate 色阶
function applyNexusCssVars(mode: ThemeMode) {
  const isDark = mode === 'dark'
  const root = document.documentElement
  root.style.setProperty('--nexus-bg',         isDark ? '#0f172a' : '#ffffff')   // slate-900 / white
  root.style.setProperty('--nexus-bg2',        isDark ? '#1e293b' : '#f1f5f9')   // slate-800 / slate-100
  root.style.setProperty('--nexus-menu-bg',    isDark ? '#1e293b' : '#ffffff')    // 面板/弹层背景
  root.style.setProperty('--nexus-border',     isDark ? '#334155' : '#e2e8f0')   // slate-700 / slate-200
  root.style.setProperty('--nexus-text',       isDark ? '#f1f5f9' : '#0f172a')   // slate-100 / slate-900
  root.style.setProperty('--nexus-text2',      isDark ? '#94a3b8' : '#64748b')   // slate-400 / slate-500
  root.style.setProperty('--nexus-muted',      isDark ? '#475569' : '#94a3b8')   // slate-600 / slate-400
  root.style.setProperty('--nexus-tab-active', isDark ? '#1e293b' : '#f1f5f9')   // 选中标签高亮
  root.style.setProperty('--nexus-accent',     '#3b82f6')                         // blue-500
  root.style.setProperty('--nexus-success',    '#22c55e')                         // green-500
  root.style.setProperty('--nexus-warning',    '#f59e0b')                         // amber-500
  root.style.setProperty('--nexus-error',      '#ef4444')                         // red-500
}
applyNexusCssVars(getInitialTheme())

// Agent 状态推断（F-15）
// 复制模式覆盖层组件
function Sidebar({
  windows,
  activeIndex,
  sessions,
  activeSession,
  onSwitchSession,
  onSwitch,
  onClose,
  onAdd,
  onOpenSettings,
  onOpenTasks,
  onRename,
  onFocusTerm,
  themeMode,
  onToggleTheme,
  windowOutputs,
  runningTaskCount,
}: {
  windows: TmuxWindow[]
  activeIndex: number
  sessions: string[]
  activeSession: string
  onSwitchSession: (session: string) => void
  onSwitch: (index: number) => void
  windowOutputs: Record<number, { output: string; clients: number; idleMs: number; connected: boolean }>
  onClose: (index: number) => void
  onAdd: () => void
  onOpenSettings: () => void
  onOpenTasks: () => void
  onRename?: (index: number, name: string) => void
  onFocusTerm?: () => void
  themeMode: 'dark' | 'light'
  onToggleTheme: () => void
  runningTaskCount?: number
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [renameIndex, setRenameIndex] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  function startRename(index: number, currentName: string) {
    setRenameIndex(index)
    setRenameValue(currentName)
    setTimeout(() => renameInputRef.current?.focus(), 50)
  }

  function submitRename() {
    if (renameIndex !== null && renameValue.trim() && onRename) {
      onRename(renameIndex, renameValue.trim())
    }
    setRenameIndex(null)
    setRenameValue('')
  }

  return (
    <div style={{
      flex: 1,
      background: 'var(--nexus-bg)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
    }}>
      {/* Session Selector */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--nexus-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: 'var(--nexus-muted)', fontSize: 11, flex: 1 }}>Session</span>
          <button
            style={{ background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', borderRadius: 4 }}
            onClick={onToggleTheme}
            title={themeMode === 'dark' ? '切换浅色' : '切换深色'}
          ><Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={14} /></button>
        </div>
        <select
          value={activeSession}
          onChange={(e) => { onSwitchSession(e.target.value); setTimeout(() => onFocusTerm?.(), 50) }}
          style={{
            width: '100%',
            background: 'var(--nexus-bg2)',
            border: '1px solid var(--nexus-border)',
            borderRadius: 6,
            color: 'var(--nexus-text)',
            fontSize: 13,
            padding: '6px 8px',
            cursor: 'pointer',
          }}
        >
          {sessions.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {windows.map(win => (
          <div
            key={win.index}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 12px',
              cursor: 'pointer',
              background: win.index === activeIndex ? 'var(--nexus-tab-active)' :
                          hoveredIndex === win.index ? 'var(--nexus-bg2)' : 'transparent',
              borderLeft: win.index === activeIndex ? '3px solid var(--nexus-accent)' : '3px solid transparent',
              transition: 'background 0.15s',
              gap: 8,
            }}
            onMouseEnter={() => setHoveredIndex(win.index)}
            onMouseLeave={() => setHoveredIndex(null)}
            onClick={() => { onSwitch(win.index); setTimeout(() => onFocusTerm?.(), 50) }}
          >
            <span style={{
              flex: 1,
              color: win.index === activeIndex ? 'var(--nexus-text)' : 'var(--nexus-text2)',
              fontSize: 13,
              fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: win.index === activeIndex ? 500 : 400,
            }}>
              {renameIndex === win.index ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename()
                    if (e.key === 'Escape') { setRenameIndex(null); setRenameValue('') }
                  }}
                  onBlur={submitRename}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: 'var(--nexus-bg)',
                    border: '1px solid var(--nexus-border)',
                    borderRadius: 4,
                    color: 'var(--nexus-text)',
                    fontSize: 13,
                    fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
                    padding: '2px 6px',
                    flex: 1,
                    outline: 'none',
                  }}
                />
              ) : (
                <>
                  <span style={{ color: 'var(--nexus-muted)', marginRight: 6 }}>{win.index}:</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{win.name}</span>
                </>
              )}
            </span>
            {renameIndex !== win.index && (() => {
              const status = getWindowStatus(windowOutputs[win.index])
              const color = STATUS_DOT_COLOR[status]
              const title = STATUS_DOT_TITLE[status]
              return <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, marginRight: 4 }} title={title} />
            })()}
            {hoveredIndex === win.index && renameIndex !== win.index && (
              <>
                <button
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--nexus-text2)',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: '0 4px',
                    flexShrink: 0,
                    opacity: 0.7,
                    lineHeight: 1,
                  }}
                  onClick={(e) => { e.stopPropagation(); startRename(win.index, win.name) }}
                  title="重命名"
                >✎</button>
                <button
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--nexus-error)',
                    cursor: 'pointer',
                    padding: '2px',
                    flexShrink: 0,
                    opacity: 0.7,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onClick={(e) => { e.stopPropagation(); onClose(win.index) }}
                  title="关闭"
                ><Icon name="x" size={14} /></button>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{
        borderTop: '1px solid var(--nexus-border)',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        <button
          style={{
            background: 'var(--nexus-accent)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            padding: '8px 12px',
            width: '100%',
            textAlign: 'left',
          }}
          onClick={onAdd}
        >+ 新建会话</button>
        <button
          style={{
            background: 'transparent',
            border: '1px solid var(--nexus-border)',
            borderRadius: 6,
            color: 'var(--nexus-text2)',
            cursor: 'pointer',
            fontSize: 13,
            padding: '7px 12px',
            width: '100%',
            textAlign: 'left',
          }}
          onClick={onOpenTasks}
        ><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="clipboard" size={16} />任务面板{runningTaskCount ? <span style={{ marginLeft: 'auto', background: 'var(--nexus-success)', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 5px' }}>{runningTaskCount}</span> : null}</span></button>
        <button
          style={{
            background: 'transparent',
            border: '1px solid var(--nexus-border)',
            borderRadius: 6,
            color: 'var(--nexus-text2)',
            cursor: 'pointer',
            fontSize: 13,
            padding: '7px 12px',
            width: '100%',
            textAlign: 'left',
          }}
          onClick={onOpenSettings}
        ><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="settings" size={16} />配置管理</span></button>
      </div>
    </div>
  )
}

export default function Terminal({ token }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const userScrolledRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [windows, setWindows] = useState<TmuxWindow[]>([])
  const [activeWindowIndex, setActiveWindowIndex] = useState(() => parseInt(localStorage.getItem(WINDOW_KEY) || '0', 10))
  const [showSettings, setShowSettings] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [showSessionDrawer, setShowSessionDrawer] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme)

  const [isWidePC, setIsWidePC] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  const [isConnecting, setIsConnecting] = useState(false)
  const hasConnectedRef = useRef(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showScrollback, setShowScrollback] = useState(false)
  const [scrollbackContent, setScrollbackContent] = useState('')
  const [scrollbackLoading, setScrollbackLoading] = useState(false)
  const showScrollbackRef = useRef(false)
  const swipeUpAccumRef = useRef(0)
  const scrollbackOverlayRef = useRef<HTMLDivElement>(null)
  const triggerScrollbackRef = useRef<() => void>(() => {})
  const pausePollingRef = useRef(false)
  const activeWindowIndexRef = useRef(0)
  const windowsInitializedRef = useRef(false)
  const windowsLoadedRef = useRef(false)
  const [windowsLoaded, setWindowsLoaded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadFileRef = useRef<(file: File) => Promise<void>>(null!)
  const [windowOutputs, setWindowOutputs] = useState<Record<number, { output: string; clients: number; idleMs: number; connected: boolean }>>({})
  const [runningTaskCount, setRunningTaskCount] = useState(0)
  const scrollPositionsRef = useRef<Record<number, number>>({})
  const windowsRef = useRef<TmuxWindow[]>([])
  windowsRef.current = windows
  const attachWindowFnRef = useRef<(index: number) => void>(() => {})
  const [showGuide, setShowGuide] = useState(() => localStorage.getItem('nexus_guide_seen') !== 'true')
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const toolbarWrapRef = useRef<HTMLDivElement>(null)
  const toolbarHeightRef = useRef(0)
  const keyboardVisibleRef = useRef(false)
  // Viewport height is handled by CSS 100dvh, not JS
  const [drawerMenuIndex, setDrawerMenuIndex] = useState<number | null>(null)
  const [drawerRenameIndex, setDrawerRenameIndex] = useState<number | null>(null)
  const [drawerRenameValue, setDrawerRenameValue] = useState('')

  // F-18: 多 tmux session 支持
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([])
  const [activeTmuxSession, setActiveTmuxSession] = useState<string>(() => localStorage.getItem('nexus_session') || 'main')
  const [wsSessionKey, setWsSessionKey] = useState<string>(() => localStorage.getItem('nexus_session') || 'main')
  const activeTmuxSessionRef = useRef(activeTmuxSession)
  activeTmuxSessionRef.current = activeTmuxSession

  // 加载服务端默认 session
  useEffect(() => {
    fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (d.tmuxSession && !localStorage.getItem('nexus_session')) {
          setActiveTmuxSession(d.tmuxSession)
        }
      })
      .catch(() => {})
  }, [token])

  // 获取所有 tmux sessions
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const r = await fetch('/api/tmux-sessions', { headers: { Authorization: `Bearer ${token}` } })
        if (r.ok) {
          const sessions = await r.json()
          setTmuxSessions(sessions.map((s: any) => s.name))
        }
      } catch {}
    }
    fetchSessions()
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [token])

  useEffect(() => {
    const check = () => setIsWidePC(window.innerWidth >= 768)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // 请求通知权限（首次使用时，静默请求）
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  // 跟随系统深色/浅色模式切换（用户未手动设置时）
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const handler = (e: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_KEY)) return // user has manual override
      setThemeMode(e.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // CSS vars 统一调用模块级函数，保证一致性
  const applyCssVars = useCallback((mode: ThemeMode) => {
    applyNexusCssVars(mode)
  }, [])

  const applyTheme = useCallback((mode: ThemeMode) => {
    applyCssVars(mode)
    localStorage.setItem(THEME_KEY, mode)
    const term = termRef.current
    if (term) term.options.theme = THEMES[mode]
  }, [applyCssVars])

  const toggleTheme = useCallback(() => {
    const newMode = themeMode === 'dark' ? 'light' : 'dark'
    setThemeMode(newMode)
    applyTheme(newMode)
  }, [themeMode, applyTheme])

  const sendToWs = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  useEffect(() => {
    applyTheme(themeMode)
  }, [themeMode, applyTheme])

  // 动态页面标题：反映当前窗口和 Agent 状态
  useEffect(() => {
    const win = windows.find(w => w.index === activeWindowIndex)
    const taskBadge = runningTaskCount > 0 ? `(${runningTaskCount}) ` : ''
    if (!win) { document.title = `${taskBadge}Nexus`; return }
    const status = getWindowStatus(windowOutputs[activeWindowIndex])
    const statusSymbol = status === 'running' ? '⚡' : status === 'waiting' ? '⏳' : status === 'shell' ? '💤' : ''
    document.title = `${taskBadge}${statusSymbol ? statusSymbol + ' ' : ''}${win.name} — Nexus`
    return () => { document.title = 'Nexus' }
  }, [windows, activeWindowIndex, windowOutputs, runningTaskCount])

  // 定期刷新窗口列表（每 2 秒），保持与 tmux 同步
  useEffect(() => {
    fetchWindows() // 初始立即加载
    const interval = setInterval(() => {
      if (!pausePollingRef.current) fetchWindows()
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  // 轮询各窗口输出（F-15 状态卡片）
  useEffect(() => {
    async function fetchOutputs() {
      const outputs: Record<number, any> = {}
      for (const win of windows) {
        try {
          const r = await fetch(`/api/sessions/${win.index}/output?session=${encodeURIComponent(activeTmuxSession)}`, { headers: { Authorization: `Bearer ${token}` } })
          if (r.ok) outputs[win.index] = await r.json()
        } catch {}
      }
      setWindowOutputs(outputs)
    }
    const interval = setInterval(fetchOutputs, 3000)
    return () => clearInterval(interval)
  }, [windows.length, token, activeTmuxSession])

  // 轮询运行中任务数量（用于徽标显示）
  useEffect(() => {
    async function fetchTaskCount() {
      try {
        const r = await fetch('/api/tasks', { headers: { Authorization: `Bearer ${token}` } })
        if (r.ok) {
          const tasks = await r.json()
          setRunningTaskCount(tasks.filter((t: { status: string }) => t.status === 'running').length)
        }
      } catch {}
    }
    fetchTaskCount()
    const interval = setInterval(fetchTaskCount, 5000)
    return () => clearInterval(interval)
  }, [token])

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom()
    userScrolledRef.current = false
    setIsScrolledUp(false)
  }, [])

  const fitTerminal = useCallback(() => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    const container = containerRef.current
    if (!term || !fitAddon || !container) return

    // 延迟执行，等待任何 CSS transition 完成
    setTimeout(() => {
      // 强制重新计算布局
      void container.offsetHeight

      // 执行 fit
      fitAddon.fit()

      // 发送新的尺寸到后端
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }

      // 滚动到底部
      if (!userScrolledRef.current) {
        term.scrollToBottom()
      }
    }, 150)
  }, [])

  // 简化的 resize 处理：只在必要时执行，避免过度工程化
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let rafId: number | null = null
    let debounceTimer: number | null = null
    let lastWidth = 0
    let lastHeight = 0

    function doResize() {
      const term = termRef.current
      const fitAddon = fitAddonRef.current
      const containerEl = containerRef.current
      if (!term || !fitAddon || !containerEl) return

      // 获取容器实际渲染尺寸
      const rect = containerEl.getBoundingClientRect()

      // 如果变化太小，忽略（避免微抖动）
      const wDelta = Math.abs(rect.width - lastWidth)
      const hDelta = Math.abs(rect.height - lastHeight)
      if (wDelta < 2 && hDelta < 2) return

      lastWidth = rect.width
      lastHeight = rect.height

      // 清除任何待执行的 raf 和 timer
      if (rafId) cancelAnimationFrame(rafId)
      if (debounceTimer) window.clearTimeout(debounceTimer)

      // Debounce: 延迟执行，确保布局稳定（特别是工具栏动画结束后）
      debounceTimer = window.setTimeout(() => {
        rafId = requestAnimationFrame(() => {
          fitAddon.fit()
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
          if (!userScrolledRef.current) term.scrollToBottom()
          rafId = null
        })
      }, 150) // 150ms debounce 覆盖 CSS transition
    }

    // 使用 ResizeObserver 监听容器变化（唯一来源）
    const ro = new ResizeObserver(doResize)
    ro.observe(container)

    // 只在 orientation change 时额外处理
    function onOrientationChange() {
      // 重置缓存，强制重新计算
      lastWidth = 0
      lastHeight = 0
      setTimeout(doResize, 300)
    }
    window.addEventListener('orientationchange', onOrientationChange)

    // 初始执行（延迟确保布局稳定）
    setTimeout(doResize, 100)

    return () => {
      ro.disconnect()
      window.removeEventListener('orientationchange', onOrientationChange)
      if (rafId) cancelAnimationFrame(rafId)
      if (debounceTimer) window.clearTimeout(debounceTimer)
    }
  }, [])

  async function fetchWindows() {
    try {
      const session = activeTmuxSessionRef.current
      const r = await fetch(`/api/sessions?session=${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      const wins = d.windows ?? []
      setWindows(wins)
      if (!windowsLoadedRef.current) {
        windowsLoadedRef.current = true
        setWindowsLoaded(true)
      }
      // 首次加载：同步到 tmux 当前活跃窗口
      // 后续轮询：只有当前窗口消失时才 fallback，避免反复重连 WebSocket
      const currentStillExists = wins.some((w: TmuxWindow) => w.index === activeWindowIndexRef.current)
      if (!windowsInitializedRef.current) {
        windowsInitializedRef.current = true
        // 首次加载：优先使用 localStorage 记忆的窗口，否则用 tmux 活跃窗口
        if (!currentStillExists) {
          const active = wins.find((w: TmuxWindow) => w.active)
          if (active) {
            setActiveWindowIndex(active.index)
            localStorage.setItem(WINDOW_KEY, String(active.index))
          }
        }
        // 如果 currentStillExists，保持 persisted window 不变
      } else if (!currentStillExists) {
        // 轮询时当前窗口消失：fallback 到 tmux 活跃窗口
        const active = wins.find((w: TmuxWindow) => w.active)
        if (active) {
          setActiveWindowIndex(active.index)
          localStorage.setItem(WINDOW_KEY, String(active.index))
        }
      }
    } catch {
      // ignore
    }
  }

  attachWindowFnRef.current = (index: number) => { attachToWindow(index) }

  async function attachToWindow(index: number) {
    // 保存当前窗口的滚动位置
    if (termRef.current && activeWindowIndex !== index) {
      const buffer = (termRef.current as any).buffer
      if (buffer?.active) {
        scrollPositionsRef.current[activeWindowIndex] = buffer.active.viewportY
      }
    }

    try {
      const session = activeTmuxSessionRef.current
      const r = await fetch(`/api/sessions/${index}/attach?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (r.ok) {
        setActiveWindowIndex(index)
        localStorage.setItem(WINDOW_KEY, String(index))
        // 暂停轮询 3 秒，避免 optimistic 状态被覆盖
        pausePollingRef.current = true
        setTimeout(() => { pausePollingRef.current = false }, 3000)
        // 恢复目标窗口的滚动位置（延迟等待 WebSocket 连接和数据渲染）
        setTimeout(() => {
          const savedY = scrollPositionsRef.current[index]
          if (savedY !== undefined && termRef.current) {
            termRef.current.scrollLines(savedY - (termRef.current as any).buffer.active.viewportY)
          }
        }, 500)
      }
    } catch {
      // ignore
    }
  }

  async function closeWindow(index: number) {
    try {
      const session = activeTmuxSessionRef.current
      const r = await fetch(`/api/sessions/${index}?session=${encodeURIComponent(session)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (r.ok) {
        await fetchWindows()
      }
    } catch {
      // ignore
    }
  }

  async function renameWindow(index: number, name: string) {
    try {
      const session = activeTmuxSessionRef.current
      const r = await fetch(`/api/sessions/${index}/rename?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (r.ok) {
        await fetchWindows()
      }
    } catch {
      // ignore
    }
  }

  async function createSession(relPath: string, shellType: 'claude' | 'bash' = 'claude', profile?: string) {
    try {
      const session = activeTmuxSessionRef.current
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel_path: relPath, shell_type: shellType, profile, session }),
      })
      if (r.ok) {
        const { name: newWindowName } = await r.json()
        // 等待一小段时间让 tmux 创建窗口，然后刷新列表
        await new Promise(resolve => setTimeout(resolve, 300))
        // 获取更新后的窗口列表并切换到新窗口
        const sessionNow = activeTmuxSessionRef.current
        const listRes = await fetch(`/api/sessions?session=${encodeURIComponent(sessionNow)}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (listRes.ok) {
          const d = await listRes.json()
          const wins: TmuxWindow[] = d.windows ?? []
          setWindows(wins)
          // 找到新窗口并切换
          const newWin = wins.find(w => w.name === newWindowName)
          if (newWin) {
            attachToWindow(newWin.index)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function openNewSessionDialog() {
    setShowNewSession(true)
  }

  function handleCreateSession(path: string, shellType: 'claude' | 'bash', profile?: string) {
    setShowNewSession(false)
    createSession(path, shellType, profile)
  }

  function handleSwitchSession(newSession: string) {
    localStorage.setItem('nexus_session', newSession)
    // 同步更新 ref，确保 fetchWindows 能立即读到新 session
    activeTmuxSessionRef.current = newSession
    setActiveTmuxSession(newSession)
    // 强制 WebSocket 重新连接（即使 activeWindowIndex 没变）
    setWsSessionKey(newSession)
    // 重置窗口状态
    setWindows([])
    setActiveWindowIndex(0)
    localStorage.removeItem(WINDOW_KEY)
    windowsInitializedRef.current = false
    windowsLoadedRef.current = false
    setWindowsLoaded(false)
    // 重新获取窗口列表
    setTimeout(() => fetchWindows(), 100)
  }

  function handleFileUpload() {
    fileInputRef.current?.click()
  }

  async function uploadFile(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    const activeWindow = windows.find(w => w.index === activeWindowIndex)
    if (activeWindow) {
      formData.append('session_name', activeWindow.name)
    }
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      // 在终端中输入文件路径
      const path = data.path
      if (path) {
        // 输入文件路径到终端（带引号处理空格）
        const needsQuotes = path.includes(' ')
        const displayPath = needsQuotes ? `"${path}"` : path
        sendToWs(displayPath)
      }
    } catch (e: any) {
      console.error('Upload failed:', e)
    }
  }

  // Keep refs current on every render
  uploadFileRef.current = uploadFile
  activeWindowIndexRef.current = activeWindowIndex

  // 全局剪贴板粘贴：图片直接上传（F-14）
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement
      // 不拦截文本输入框里的粘贴
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault()
          const file = items[i].getAsFile()
          if (file) uploadFileRef.current(file)
          return
        }
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // Effect A: create xterm instance + DOM attachment + touch/resize events (once per token)
  useEffect(() => {
    const fontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
    const initialTheme = getInitialTheme()

    const term = new XTerm({
      theme: THEMES[initialTheme],
      fontSize,
      fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
      scrollback: 10000,
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    termRef.current = term
    fitAddonRef.current = fitAddon

    const container = containerRef.current!
    term.open(container)
    // Defer initial fit so fonts and flex layout are fully settled
    requestAnimationFrame(() => fitAddon.fit())

    // On mobile: suppress keyboard from xterm's internal textarea until user explicitly enables it
    const xtermTextarea = term.textarea
    if (xtermTextarea && window.innerWidth < 1024) {
      xtermTextarea.inputMode = 'none'
      xtermTextarea.addEventListener('touchstart', (e: TouchEvent) => {
        if (!keyboardVisibleRef.current) e.preventDefault()
      }, { passive: false })
    }

    // Enable text selection - use auto for PC, but handle touch events for mobile scrolling
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement
    if (viewport) {
      viewport.style.pointerEvents = 'auto'
      viewport.style.userSelect = 'text'
    }

    // Enable text selection in the terminal screen element
    const screen = container.querySelector('.xterm-screen') as HTMLElement
    if (screen) screen.style.userSelect = 'text'

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && ['w', 't', 'n', 'l', 'r'].includes(e.key.toLowerCase())) {
        e.preventDefault()
        return true
      }
      return true
    })

    // 键盘输入 → 发送到当前 WebSocket
    term.onData((data) => wsRef.current?.send(data))

    // 滚动位置追踪 → 浮动回底部按钮
    term.onScroll(() => {
      const buffer = (term as any).buffer?.active
      if (buffer) {
        const scrolledUp = buffer.viewportY < buffer.baseY
        userScrolledRef.current = scrolledUp
        setIsScrolledUp(scrolledUp)
      }
    })

    let touchStartX = 0
    let touchStartY = 0
    let touchLastY = 0
    let isPinching = false
    let pinchStartDist = 0
    let pinchStartFontSize = fontSize
    let swipeAxis: 'vertical' | 'horizontal' | null = null

    function getTouchDist(e: TouchEvent): number {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        isPinching = true
        pinchStartDist = getTouchDist(e)
        pinchStartFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
      } else {
        isPinching = false
        touchStartX = e.touches[0].clientX
        touchStartY = e.touches[0].clientY
        touchLastY = e.touches[0].clientY
        swipeUpAccumRef.current = 0
        swipeAxis = null
      }
    }

    function onTouchMove(e: TouchEvent) {
      e.preventDefault()
      if (isPinching && e.touches.length === 2) {
        const dist = getTouchDist(e)
        const scale = dist / pinchStartDist
        const newSize = Math.round(Math.max(8, Math.min(32, pinchStartFontSize * scale)))
        if (newSize !== term.options.fontSize) {
          term.options.fontSize = newSize
          localStorage.setItem(FONT_SIZE_KEY, String(newSize))
          fitAddon.fit()
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
        }
      } else if (!isPinching) {
        // Determine primary swipe axis on first significant movement
        if (!swipeAxis) {
          const dx = Math.abs(e.touches[0].clientX - touchStartX)
          const dy = Math.abs(e.touches[0].clientY - touchStartY)
          if (dx > 8 || dy > 8) swipeAxis = dx > dy ? 'horizontal' : 'vertical'
        }
        if (swipeAxis === 'horizontal') return
        if (swipeAxis === 'vertical' && !showScrollbackRef.current) {
          const y = e.touches[0].clientY
          const deltaY = touchLastY - y  // positive = finger UP = want older content
          touchLastY = y
          if (deltaY < 0) {  // finger DOWN = swipe down = view history
            swipeUpAccumRef.current += -deltaY
            if (swipeUpAccumRef.current > 40) {
              triggerScrollbackRef.current()
            }
          } else {
            swipeUpAccumRef.current = 0
          }
        }
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (isPinching) {
        isPinching = false
        return
      }
      const endX = e.changedTouches[0].clientX
      const endY = e.changedTouches[0].clientY
      // Ignore if touch ended outside the terminal container (e.g. drifted to FAB/toolbar)
      const rect = container.getBoundingClientRect()
      if (endX < rect.left || endX > rect.right || endY < rect.top || endY > rect.bottom) return
      const dx = endX - touchStartX
      const dy = endY - touchStartY
      // Horizontal swipe (>60px, primarily horizontal) → switch window
      if (swipeAxis === 'horizontal' && Math.abs(dx) > 60) {
        const wins = [...windowsRef.current].sort((a, b) => a.index - b.index)
        const pos = wins.findIndex(w => w.index === activeWindowIndexRef.current)
        if (dx < 0 && pos < wins.length - 1) {
          attachWindowFnRef.current(wins[pos + 1].index)
        } else if (dx > 0 && pos > 0) {
          attachWindowFnRef.current(wins[pos - 1].index)
        }
        return
      }
      if (Math.abs(dy) < TAP_THRESHOLD && Math.abs(dx) < TAP_THRESHOLD) {
        // Tap toggles keyboard: tap to show, tap again to hide
        const xtermTa = termRef.current?.textarea
        if (keyboardVisibleRef.current) {
          keyboardVisibleRef.current = false
          if (inputRef.current) { inputRef.current.inputMode = 'none'; inputRef.current.blur() }
          if (xtermTa) { xtermTa.inputMode = 'none'; xtermTa.blur() }
        } else {
          keyboardVisibleRef.current = true
          // Focus xterm's own textarea — term.onData handles all input natively
          // (letters, numbers, IME/CJK) without the quirks of our hidden input.
          if (xtermTa) { xtermTa.inputMode = 'text'; xtermTa.focus() }
          if (inputRef.current) inputRef.current.inputMode = 'text'
        }
      }
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: true })

    // Layer 4: Prevent any touch on the hidden input itself from showing keyboard
    function onInputTouchStart(e: TouchEvent) {
      if (!keyboardVisibleRef.current) e.preventDefault()
    }
    const inp = inputRef.current
    if (inp) {
      inp.addEventListener('touchstart', onInputTouchStart, { passive: false })
    }

    function sendResize() {
      fitAddonRef.current?.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      if (!userScrolledRef.current) term.scrollToBottom()
    }

    function onOrientationChange() {
      setTimeout(sendResize, 300)
    }
    window.addEventListener('orientationchange', onOrientationChange)

    // Re-fit when tab/PWA returns to foreground
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') sendResize()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', sendResize)

    return () => {
      window.removeEventListener('orientationchange', onOrientationChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', sendResize)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      if (inp) inp.removeEventListener('touchstart', onInputTouchStart)
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [token])

  // Effect B: WebSocket connection (reconnects on window switch, xterm persists)
  useEffect(() => {
    setIsScrolledUp(false)
    // If this window had a saved scroll position, don't auto-scroll on incoming messages
    // until the restore timeout in attachToWindow fires and onScroll updates the ref.
    const hasSavedScroll = (scrollPositionsRef.current[activeWindowIndex] ?? 0) > 0
    userScrolledRef.current = hasSavedScroll
    hasConnectedRef.current = false

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'

    // 延迟显示 loading，避免快速连接时的闪烁
    const loadingTimer = setTimeout(() => {
      if (!hasConnectedRef.current) setIsConnecting(true)
    }, 300)

    // 标记是否为主动关闭（useEffect cleanup），避免触发重连
    let intentionalClose = false

    // 重连逻辑：不刷新页面，直接创建新 WebSocket
    let reconnectAttempts = 0
    const maxReconnectAttempts = 8
    const reconnectDelay = () => Math.min(1000 * Math.pow(2, reconnectAttempts), 15000)

    function writeTerm(data: string) {
      termRef.current?.write(data)
    }

    function createWs(isReconnect = false) {
      const s = activeTmuxSessionRef.current
      const wi = activeWindowIndexRef.current
      const newWs = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}&window=${wi}&session=${encodeURIComponent(s)}`)
      wsRef.current = newWs

      newWs.onopen = () => {
        if (isReconnect) {
          writeTerm('\r\n\x1b[32m[Nexus: 已重新连接]\x1b[0m\r\n')
        } else {
          clearTimeout(loadingTimer)
          // Clear terminal buffer for the new window
          termRef.current?.clear()
        }
        reconnectAttempts = 0
        hasConnectedRef.current = true
        setIsConnecting(false)
        fitAddonRef.current?.fit()
        const term = termRef.current
        if (term) newWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        // Follow-up fit in case layout wasn't fully settled at onopen time
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit()
          if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }))
          }
        })
      }

      newWs.onmessage = (e) => {
        writeTerm(e.data)
        if (!userScrolledRef.current) termRef.current?.scrollToBottom()
      }

      newWs.onclose = (e) => {
        if (intentionalClose) return
        if (e.code === 4001) {
          writeTerm('\r\n\x1b[31m[Nexus: 认证失败，请刷新重新登录]\x1b[0m\r\n')
          return
        }
        if (reconnectAttempts >= maxReconnectAttempts) {
          writeTerm('\r\n\x1b[31m[Nexus: 重连失败，请刷新页面]\x1b[0m\r\n')
          return
        }
        reconnectAttempts++
        const delay = reconnectDelay()
        writeTerm(`\r\n\x1b[33m[Nexus: 连接断开，${delay / 1000}s 后重连 (${reconnectAttempts}/${maxReconnectAttempts})...]\x1b[0m\r\n`)
        setTimeout(() => createWs(true), delay)
      }

      newWs.onerror = () => writeTerm('\r\n\x1b[31m[Nexus: WebSocket 错误]\x1b[0m\r\n')
    }

    createWs()

    return () => {
      intentionalClose = true
      clearTimeout(loadingTimer)
      wsRef.current?.close()
    }
  }, [token, activeWindowIndex, wsSessionKey])

  const isComposingRef = useRef(false)

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (isComposingRef.current) return // handled by compositionEnd
    // Fallback for Android (keydown fires key='Unidentified', onChange is reliable there)
    const val = e.target.value
    if (val) { sendToWs(val); e.target.value = '' }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposingRef.current) return
    if (e.key === 'Enter') { e.preventDefault(); sendToWs('\r') }
    else if (e.key === 'Backspace') { e.preventDefault(); sendToWs('\x7f') }
    else if (e.key === 'Tab') { e.preventDefault(); sendToWs('\t') }
    else if (e.key === 'Escape') { e.preventDefault(); sendToWs('\x1b') }
    else if (e.key === 'Delete') { e.preventDefault(); sendToWs('\x1b[3~') }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sendToWs('\x1b[A') }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sendToWs('\x1b[B') }
    else if (e.key === 'ArrowRight') { e.preventDefault(); sendToWs('\x1b[C') }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); sendToWs('\x1b[D') }
    else if (e.key === 'Home') { e.preventDefault(); sendToWs('\x1b[H') }
    else if (e.key === 'End') { e.preventDefault(); sendToWs('\x1b[F') }
    else if (e.key === 'PageUp') { e.preventDefault(); sendToWs('\x1b[5~') }
    else if (e.key === 'PageDown') { e.preventDefault(); sendToWs('\x1b[6~') }
    else if (e.ctrlKey && e.key.length === 1) {
      e.preventDefault()
      sendToWs(String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96))
    }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Intercept printable chars (letters, digits, punctuation) directly from keydown.
      // preventDefault stops the browser from updating input.value, so onChange won't
      // double-fire. This is reliable on iOS/desktop where e.key is always correct.
      e.preventDefault()
      sendToWs(e.key)
    }
  }

  function handleCompositionEnd(e: React.CompositionEvent<HTMLInputElement>) {
    isComposingRef.current = false
    const text = e.data
    if (text) sendToWs(text)
    ;(e.currentTarget as HTMLInputElement).value = ''
  }

  // Track keyboard visibility for input handling (not for layout height)
  useEffect(() => {
    if (isWidePC) return
    const vv = window.visualViewport
    if (!vv) return
    const handleResize = () => {
      keyboardVisibleRef.current = vv.height < window.innerHeight * 0.8
    }
    handleResize()
    vv.addEventListener('resize', handleResize)
    return () => vv.removeEventListener('resize', handleResize)
  }, [isWidePC])

  // Layer 2: Global focusin guard — blur any input that triggers keyboard when it should be hidden
  // This covers both our custom hidden input AND xterm's internal textarea
  useEffect(() => {
    if (isWidePC) return
    function handleFocusin(e: FocusEvent) {
      if (keyboardVisibleRef.current) return
      const target = e.target as HTMLElement
      const xtermTa = termRef.current?.textarea
      if (target === inputRef.current || (xtermTa && target === xtermTa)) {
        target.blur()
      }
    }
    document.addEventListener('focusin', handleFocusin)
    return () => document.removeEventListener('focusin', handleFocusin)
  }, [isWidePC])

  // Track toolbar height for FAB constraint (using ref to avoid re-render loop)
  useEffect(() => {
    const el = toolbarWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      toolbarHeightRef.current = el.offsetHeight
    })
    ro.observe(el)
    toolbarHeightRef.current = el.offsetHeight
    return () => ro.disconnect()
  }, [])

  // Overlay guard: when any overlay opens, set xterm textarea to readOnly
  // to prevent virtual keyboard from appearing when keyboard dismisses
  const anyOverlayOpen = showSessionDrawer || showTasks || showSettings || showNewSession || showScrollback
  useEffect(() => {
    if (isWidePC) return
    const ta = termRef.current?.textarea
    if (!ta) return
    if (anyOverlayOpen) {
      ta.readOnly = true
    } else {
      // Delay restoring to avoid race with keyboard dismiss animation
      setTimeout(() => {
        const ta2 = termRef.current?.textarea
        if (ta2) ta2.readOnly = false
      }, 100)
    }
  }, [anyOverlayOpen, isWidePC])

  function closeScrollback() {
    showScrollbackRef.current = false
    setShowScrollback(false)
    setScrollbackContent('')
  }

  function handleOverlayScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30
    if (atBottom) {
      closeScrollback()
    }
  }

  async function fetchScrollback() {
    if (showScrollbackRef.current) return // already showing
    showScrollbackRef.current = true
    swipeUpAccumRef.current = 0
    setScrollbackLoading(true)
    setShowScrollback(true)
    try {
      const r = await fetch(
        `/api/sessions/${activeWindowIndex}/scrollback?session=${encodeURIComponent(wsSessionKey)}&lines=3000`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await r.json()
      setScrollbackContent(data.content || '')
    } catch {
      setScrollbackContent('(加载历史失败)')
    } finally {
      setScrollbackLoading(false)
    }
  }

  useEffect(() => {
    if (scrollbackContent && scrollbackOverlayRef.current) {
      // 初始滚动到距离底部 50px，避免立即触发 atBottom 检测
      const el = scrollbackOverlayRef.current
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 50)
    }
  }, [scrollbackContent])

  triggerScrollbackRef.current = fetchScrollback

  const toolbarProps = {
    token,
    sendToWs,
    scrollToBottom,
    onFitTerminal: fitTerminal,
    termRef,
    themeMode,
    onToggleTheme: toggleTheme,
    onOpenSettings: () => setShowSettings(true),
    onOpenTasks: () => setShowTasks(true),
    onUpload: handleFileUpload,
    onUploadFile: uploadFile,
    runningTaskCount,
  }

  return (
    <div style={styles.wrapper}>
      <input
        ref={inputRef}
        style={styles.hiddenInput}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={handleCompositionEnd}
        aria-hidden="true"
      />
      <input
        ref={fileInputRef}
        type="file"
        style={styles.hiddenInput}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) uploadFile(file)
          e.target.value = '' // reset
        }}
        aria-hidden="true"
      />

      {isWidePC ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
          {/* Sidebar column: session/window list + embedded shortcut keys */}
          <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--nexus-border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Sidebar
              windows={windows}
              activeIndex={activeWindowIndex}
              sessions={tmuxSessions}
              activeSession={activeTmuxSession}
              onSwitchSession={handleSwitchSession}
              onSwitch={attachToWindow}
              onClose={closeWindow}
              onAdd={openNewSessionDialog}
              onOpenSettings={() => setShowSettings(true)}
              onOpenTasks={() => setShowTasks(true)}
              onRename={renameWindow}
              onFocusTerm={() => termRef.current?.textarea?.focus()}
              themeMode={themeMode}
              onToggleTheme={toggleTheme}
              windowOutputs={windowOutputs}
              runningTaskCount={runningTaskCount}
            />
            <Toolbar {...toolbarProps} embedded />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
            <div ref={containerRef} style={styles.terminal} onClick={() => termRef.current?.textarea?.focus()} />
            {isConnecting && (
              <div style={styles.loadingOverlay}>
                <div style={styles.spinner} />
                <span style={styles.loadingText}>Connecting...</span>
              </div>
            )}
            {isScrolledUp && (
              <button style={styles.scrollBtn} onClick={scrollToBottom} title="滚到底部"><Icon name="arrowDown" size={16} /></button>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            <div ref={containerRef} style={styles.terminal} />
            {isConnecting && (
              <div style={styles.loadingOverlay}>
                <div style={styles.spinner} />
                <span style={styles.loadingText}>Connecting...</span>
              </div>
            )}
            {isScrolledUp && (
              <button style={styles.scrollBtn} onClick={scrollToBottom} title="滚到底部"><Icon name="arrowDown" size={16} /></button>
            )}
          </div>
          <SessionFAB onClick={() => setShowSessionDrawer(true)} windowCount={windows.length} bottomInset={toolbarHeightRef.current} />
          <div ref={toolbarWrapRef}><Toolbar {...toolbarProps} /></div>
        </div>
      )}

      {/* 移动端会话抽屉 */}
      {showSessionDrawer && !isWidePC && (
        <>
          <GhostShield />
          <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.5)' }} onPointerDown={() => { setShowSessionDrawer(false); setDrawerMenuIndex(null); setDrawerRenameIndex(null) }} />
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 401, background: 'var(--nexus-menu-bg)', borderRadius: '12px 12px 0 0', border: '1px solid var(--nexus-border)', borderBottom: 'none', maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 24px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--nexus-border)', flexShrink: 0 }}>
              <span style={{ color: 'var(--nexus-text)', fontWeight: 600, fontSize: 15 }}>会话管理</span>
              <button style={{ background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onPointerDown={(e) => { e.preventDefault(); setShowSessionDrawer(false); setDrawerMenuIndex(null); setDrawerRenameIndex(null); (document.activeElement as HTMLElement)?.blur() }}><Icon name="x" size={20} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
              {windows.map(win => {
                const status = getWindowStatus(windowOutputs[win.index])
                const isActive = win.index === activeWindowIndex
                const isMenuOpen = drawerMenuIndex === win.index
                const isRenaming = drawerRenameIndex === win.index
                return (
                  <div key={win.index} style={{ borderBottom: '1px solid var(--nexus-border)' }}>
                    {/* Main row */}
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: isActive ? 'var(--nexus-tab-active)' : 'transparent' }}
                    >
                      <span
                        style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_DOT_COLOR[status], flexShrink: 0, display: 'inline-block' }}
                        title={STATUS_DOT_TITLE[status]}
                      />
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={drawerRenameValue}
                          onChange={e => setDrawerRenameValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { renameWindow(win.index, drawerRenameValue.trim() || win.name); setDrawerRenameIndex(null) }
                            if (e.key === 'Escape') setDrawerRenameIndex(null)
                          }}
                          onBlur={() => setDrawerRenameIndex(null)}
                          style={{ flex: 1, background: 'var(--nexus-bg)', border: '1px solid var(--nexus-accent)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, fontFamily: 'Menlo, Monaco, monospace', padding: '4px 8px', outline: 'none' }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          style={{ flex: 1, color: 'var(--nexus-text)', fontSize: 14, fontFamily: 'Menlo, Monaco, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                          onPointerUp={(e) => { e.stopPropagation(); attachToWindow(win.index); setShowSessionDrawer(false); setDrawerMenuIndex(null) }}
                        >{win.name}</span>
                      )}
                      {isActive && !isRenaming && <span style={{ color: 'var(--nexus-accent)', fontSize: 13, fontWeight: 600, flexShrink: 0, display: 'flex', alignItems: 'center' }}><Icon name="check" size={14} /></span>}
                      <button
                        style={{ background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', padding: '4px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onPointerDown={e => { e.stopPropagation(); setDrawerMenuIndex(isMenuOpen ? null : win.index); setDrawerRenameIndex(null) }}
                      ><Icon name="more" size={18} /></button>
                    </div>
                    {/* Action row */}
                    {isMenuOpen && !isRenaming && (
                      <div style={{ display: 'flex', gap: 8, padding: '6px 16px 10px', background: 'var(--nexus-bg)' }}>
                        <button
                          style={{ flex: 1, background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 13, padding: '7px 0', cursor: 'pointer' }}
                          onPointerDown={e => { e.stopPropagation(); setDrawerRenameValue(win.name); setDrawerRenameIndex(win.index); setDrawerMenuIndex(null) }}
                        ><span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><Icon name="pencil" size={14} />改名</span></button>
                        <button
                          style={{ flex: 1, background: 'transparent', border: '1px solid var(--nexus-error)', borderRadius: 6, color: 'var(--nexus-error)', fontSize: 13, padding: '7px 0', cursor: 'pointer' }}
                          onPointerDown={e => { e.stopPropagation(); closeWindow(win.index); setDrawerMenuIndex(null); if (windows.length <= 1) setShowSessionDrawer(false) }}
                        ><span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><Icon name="x" size={14} />关闭</span></button>
                      </div>
                    )}
                  </div>
                )
              })}
              {/* tmux session 切换（多 session 时显示） */}
              {tmuxSessions.length > 1 && (
                <div style={{ padding: '10px 16px 4px', color: 'var(--nexus-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Tmux Sessions</div>
              )}
              {tmuxSessions.length > 1 && tmuxSessions.map(sess => (
                <div
                  key={sess}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer', background: sess === activeTmuxSession ? 'var(--nexus-tab-active)' : 'transparent' }}
                  onClick={() => { handleSwitchSession(sess); setShowSessionDrawer(false) }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: sess === activeTmuxSession ? 'var(--nexus-accent)' : 'var(--nexus-text2)', fontSize: 13 }}>{sess === activeTmuxSession ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}{sess}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--nexus-border)', flexShrink: 0 }}>
              <button
                style={{ width: '100%', background: 'var(--nexus-accent)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 0', cursor: 'pointer', touchAction: 'manipulation' }}
                onClick={() => { setShowSessionDrawer(false); openNewSessionDialog() }}
              >
                + 新建会话
              </button>
            </div>
          </div>
        </>
      )}

      {showTasks && (
        <Suspense fallback={null}>
          <TaskPanel
            token={token}
            windows={windows}
            activeWindowName={windows.find(w => w.index === activeWindowIndex)?.name || ''}
            tmuxSession={activeTmuxSession}
            onClose={() => setShowTasks(false)}
          />
        </Suspense>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <SessionManager
            token={token}
            onClose={() => setShowSettings(false)}
          />
        </Suspense>
      )}
      {showNewSession && (
        <Suspense fallback={null}>
          <WorkspaceSelector
            token={token}
            onClose={() => setShowNewSession(false)}
            onConfirm={handleCreateSession}
          />
        </Suspense>
      )}

      {/* 首次使用引导 */}
      {showGuide && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          zIndex: 500,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}>
          <div style={{
            background: 'var(--nexus-menu-bg)',
            borderRadius: 12,
            padding: '24px',
            maxWidth: 400,
            border: '1px solid var(--nexus-border)',
          }}>
            <h3 style={{ color: 'var(--nexus-text)', marginTop: 0 }}>欢迎使用 Nexus</h3>
            <ul style={{ color: 'var(--nexus-text2)', lineHeight: 1.9, fontSize: 13, paddingLeft: 20, margin: '8px 0' }}>
              <li>黑色区域是终端，点击聚焦后可键盘输入</li>
              <li>底部工具栏提供 Esc/Tab/^C 等快捷键</li>
              <li style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="clipboard" size={14} />任务面板：后台发送 claude -p 任务</li>
              <li style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="paperclip" size={14} />上传图片/文件到当前 session 目录</li>
              <li>长按标签可重命名或关闭会话</li>
            </ul>
            <p style={{ color: 'var(--nexus-muted)', fontSize: 11, marginTop: 8 }}>
              Telegram Bot: /api/telegram/setup 一键配置
            </p>
            <button
              onClick={() => {
                setShowGuide(false)
                localStorage.setItem('nexus_guide_seen', 'true')
              }}
              style={{
                background: 'var(--nexus-accent)',
                border: 'none',
                borderRadius: 6,
                color: '#fff',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
                padding: '10px 20px',
                marginTop: 12,
                width: '100%',
              }}
            >
              开始使用
            </button>
          </div>
        </div>
      )}

      {/* 空状态提示：只在数据加载完成后才显示 */}
      {windows.length === 0 && windowsLoaded && !isConnecting && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          color: 'var(--nexus-muted)',
        }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🖥️</div>
          <div style={{ fontSize: 16, marginBottom: 8 }}>没有活动会话</div>
          <div style={{ fontSize: 13 }}>点击「+ 新建会话」开始</div>
        </div>
      )}
      {showScrollback && (() => {
        const termTheme = termRef.current?.options.theme ?? {}
        const termBg = (termTheme as any).background ?? '#1a1a2e'
        const termFg = (termTheme as any).foreground ?? '#e2e8f0'
        const termFontSize = termRef.current?.options.fontSize ?? 14
        const termFontFamily = termRef.current?.options.fontFamily ?? 'Menlo, Monaco, monospace'
        const termMuted = (termTheme as any).brightBlack ?? '#4a5568'
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: termBg, display: 'flex', flexDirection: 'column' }}>
            <GhostShield />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${termMuted}44`, flexShrink: 0 }}>
              <span style={{ color: termFg, fontWeight: 600, fontSize: 14 }}>历史记录</span>
              <span style={{ color: termMuted, fontSize: 12, flex: 1, textAlign: 'center' }}>滚到底部返回终端</span>
              <button
                style={{ background: 'transparent', border: 'none', color: termMuted, cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={closeScrollback}
              ><Icon name="x" size={20} /></button>
            </div>
            <div
              ref={scrollbackOverlayRef}
              onScroll={handleOverlayScroll}
              style={{ flex: 1, overflowY: 'auto', padding: '8px 0', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            >
              {scrollbackLoading ? (
                <div style={{ color: termMuted, textAlign: 'center', padding: 32, fontFamily: termFontFamily, fontSize: termFontSize }}>加载中...</div>
              ) : (
                <pre style={{ margin: 0, padding: 0, fontFamily: termFontFamily, fontSize: termFontSize, color: termFg, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.2 }}>
                  {scrollbackContent}
                </pre>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100dvh',
    position: 'relative',
  },
  terminal: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  hiddenInput: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    fontSize: 16,
    pointerEvents: 'none',
    zIndex: -1,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'var(--nexus-bg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    zIndex: 10,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid var(--nexus-border)',
    borderTopColor: 'var(--nexus-accent)',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  loadingText: {
    color: 'var(--nexus-text2)',
    fontSize: 14,
  },
  scrollBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'var(--nexus-accent)',
    border: 'none',
    color: '#fff',
    fontSize: 18,
    cursor: 'pointer',
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
  },
}
