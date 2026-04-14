import { useEffect, useRef, useCallback, useState, lazy, Suspense } from 'react'
import type { SessionManagerV2Handle } from './SessionManagerV2'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import Toolbar from './Toolbar'
import SessionFAB from './SessionFAB'
import GhostShield from './GhostShield'
import { Icon } from './icons'
import { getWindowStatus, STATUS_DOT_COLOR, STATUS_DOT_TITLE } from './windowStatus'

// ANSI 256-color palette (0-15 standard, 16-231 6x6x6 cube, 232-255 grayscale)
const ANSI256: string[] = (() => {
  const c = [
    '#000000','#cc0000','#4e9a06','#c4a000','#3465a4','#75507b','#06989a','#d3d7cf',
    '#555753','#ef2929','#8ae234','#fce94f','#729fcf','#ad7fa8','#34e2e2','#eeeeec',
  ]
  const h = (v: number) => v.toString(16).padStart(2, '0')
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    const rv = r ? r * 40 + 55 : 0, gv = g ? g * 40 + 55 : 0, bv = b ? b * 40 + 55 : 0
    c.push(`#${h(rv)}${h(gv)}${h(bv)}`)
  }
  for (let i = 0; i < 24; i++) { const v = h(8 + i * 10); c.push(`#${v}${v}${v}`) }
  return c
})()

function ansiToHtml(raw: string): string {
  const style = { fg: '', bg: '', bold: false, italic: false, dim: false }
  const out: string[] = []
  let buf = ''

  const flush = () => {
    if (!buf) return
    const esc = buf.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const css: string[] = []
    if (style.fg) css.push(`color:${style.fg}`)
    if (style.bg) css.push(`background-color:${style.bg}`)
    if (style.bold) css.push('font-weight:700')
    if (style.italic) css.push('font-style:italic')
    if (style.dim) css.push('opacity:0.6')
    out.push(css.length ? `<span style="${css.join(';')}">${esc}</span>` : esc)
    buf = ''
  }

  const applyParams = (params: string) => {
    const codes = params.split(';').map(s => parseInt(s, 10) || 0)
    let j = 0
    while (j < codes.length) {
      const c = codes[j]
      if (c === 0) { style.fg = ''; style.bg = ''; style.bold = false; style.italic = false; style.dim = false }
      else if (c === 1) style.bold = true
      else if (c === 2) style.dim = true
      else if (c === 3) style.italic = true
      else if (c === 22) { style.bold = false; style.dim = false }
      else if (c === 23) style.italic = false
      else if (c >= 30 && c <= 37) style.fg = ANSI256[c - 30]
      else if (c === 39) style.fg = ''
      else if (c >= 40 && c <= 47) style.bg = ANSI256[c - 40]
      else if (c === 49) style.bg = ''
      else if (c >= 90 && c <= 97) style.fg = ANSI256[c - 90 + 8]
      else if (c >= 100 && c <= 107) style.bg = ANSI256[c - 100 + 8]
      else if (c === 38 && codes[j + 1] === 5 && j + 2 < codes.length) { style.fg = ANSI256[codes[j + 2]] ?? ''; j += 2 }
      else if (c === 38 && codes[j + 1] === 2 && j + 4 < codes.length) { style.fg = `rgb(${codes[j+2]},${codes[j+3]},${codes[j+4]})`; j += 4 }
      else if (c === 48 && codes[j + 1] === 5 && j + 2 < codes.length) { style.bg = ANSI256[codes[j + 2]] ?? ''; j += 2 }
      else if (c === 48 && codes[j + 1] === 2 && j + 4 < codes.length) { style.bg = `rgb(${codes[j+2]},${codes[j+3]},${codes[j+4]})`; j += 4 }
      j++
    }
  }

  let i = 0
  const s = raw.replace(/\r/g, '')
  while (i < s.length) {
    if (s[i] !== '\x1b') { buf += s[i++]; continue }
    // find CSI terminator
    if (s[i + 1] === '[') {
      let end = i + 2
      while (end < s.length && !/[A-Za-z]/.test(s[end])) end++
      const term = s[end]
      const params = s.slice(i + 2, end)
      i = end + 1
      if (term === 'm') { flush(); applyParams(params) }
      // other CSI sequences: skip silently
    } else {
      // non-CSI escape: skip to next letter
      i += 2
      while (i < s.length && !/[A-Za-z]/.test(s[i])) i++
      i++
    }
  }
  flush()
  return out.join('')
}

const SessionManager = lazy(() => import('./SessionManager'))
const SessionManagerV2 = lazy(() => import('./SessionManagerV2'))
const WorkspaceSelector = lazy(() => import('./WorkspaceSelector'))
const NewWindowDialog = lazy(() => import('./NewWindowDialog'))
const FilePanel = lazy(() => import('./FilePanel'))
const WorkspaceBrowser = lazy(() => import('./WorkspaceBrowser'))
const GeneralSettings = lazy(() => import('./GeneralSettings'))

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
const MAX_UPLOAD_NOTIFICATIONS = 5

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
export default function Terminal({ token }: Props) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const userScrolledRef = useRef(false)
  const lastContainerSizeRef = useRef({ w: 0, h: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const [windows, setWindows] = useState<TmuxWindow[]>([])
  const [activeWindowIndex, setActiveWindowIndex] = useState(() => parseInt(localStorage.getItem(WINDOW_KEY) || '0', 10))
  const [showSettings, setShowSettings] = useState(false)
  const [showGeneralSettings, setShowGeneralSettings] = useState(false)
  const [showSessionManagerV2, setShowSessionManagerV2] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [showNewWindow, setShowNewWindow] = useState(false)
  const [showSessionDrawer, setShowSessionDrawer] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme)

  const [isWidePC, setIsWidePC] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  const [isConnecting, setIsConnecting] = useState(false)
  const hasConnectedRef = useRef(false)
  const [showFiles, setShowFiles] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [copySheetText, setCopySheetText] = useState<string | null>(null)
  const [showScrollback, setShowScrollback] = useState(false)
  const [scrollbackContent, setScrollbackContent] = useState('')
  const [scrollbackLoading, setScrollbackLoading] = useState(false)
  const showScrollbackRef = useRef(false)
  const swipeUpAccumRef = useRef(0)
  const scrollbackOverlayRef = useRef<HTMLDivElement>(null)
  const triggerScrollbackRef = useRef<() => void>(() => {})
  const scrollbackPrefetchRef = useRef<Promise<{ content: string }> | null>(null)
  const scrollbackCacheRef = useRef<string | null>(null)
  const pausePollingRef = useRef(false)
  const activeWindowIndexRef = useRef(0)
  const windowsInitializedRef = useRef(false)
  const windowsLoadedRef = useRef(false)
  const [windowsLoaded, setWindowsLoaded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pasteFileRef = useRef<HTMLInputElement>(null)
  const uploadFileRef = useRef<(file: File) => Promise<void>>(null!)
  const [windowOutputs, setWindowOutputs] = useState<Record<number, { output: string; clients: number; idleMs: number; connected: boolean }>>({})
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
  // Toolbar 展开状态（移动端点击空白区域时收起）
  // 初始值与 Toolbar 内部逻辑保持一致，确保首次加载时 ref 能正确反映展开状态
  const [toolbarCollapsed, setToolbarCollapsed] = useState<boolean | undefined>(() => {
    const saved = localStorage.getItem('nexus_toolbar_collapsed')
    if (saved !== null) return saved === 'true'
    return window.innerWidth >= 1024 // PC 默认收起，移动端默认展开
  })
  const toolbarCollapsedRef = useRef<boolean | undefined>(undefined)
  useEffect(() => { toolbarCollapsedRef.current = toolbarCollapsed }, [toolbarCollapsed])
  const [uploadNotifications, setUploadNotifications] = useState<Array<{ id: string; filename: string; path: string }>>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // F-18: 多 tmux session 支持
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([])
  const [activeTmuxSession, setActiveTmuxSession] = useState<string>(() => localStorage.getItem('nexus_session') || '~')
  const [wsSessionKey, setWsSessionKey] = useState<string>(() => localStorage.getItem('nexus_session') || '~')
  const activeTmuxSessionRef = useRef(activeTmuxSession)
  activeTmuxSessionRef.current = activeTmuxSession
  const sessionManagerRef = useRef<SessionManagerV2Handle>(null)

  // Projects list (for getting project path when creating new channel)
  interface ProjectInfo {
    name: string
    path: string
    active: boolean
    channelCount: number
  }
  const [projects, setProjects] = useState<ProjectInfo[]>([])


  // 加载服务端默认 session
  useEffect(() => {
    fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (d.tmuxSession && !localStorage.getItem('nexus_session')) {
          setActiveTmuxSession(d.tmuxSession)
          setWsSessionKey(d.tmuxSession)
        }
      })
      .catch(() => {})
  }, [token])

  // 获取所有 tmux sessions 和 projects
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
    const fetchProjects = async () => {
      try {
        const r = await fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
        if (r.ok) {
          setProjects(await r.json())
        }
      } catch {}
    }
    fetchSessions()
    fetchProjects()
    const interval = setInterval(() => {
      fetchSessions()
      fetchProjects()
    }, 10000)
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

  const addUploadNotification = useCallback((filename: string, path: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setUploadNotifications(prev => {
      const next = [{ id, filename, path }, ...prev]
      return next.slice(0, MAX_UPLOAD_NOTIFICATIONS)
    })
  }, [])

  const removeUploadNotification = useCallback((id: string) => {
    setUploadNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
  }, [])

  const handleCopyNotification = useCallback(async (id: string, path: string) => {
    await copyToClipboard(path)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }, [copyToClipboard])

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
    const taskBadge = ''
    if (!win) { document.title = `${taskBadge}Nexus`; return }
    const status = getWindowStatus(windowOutputs[activeWindowIndex])
    const statusSymbol = status === 'running' ? '⚡' : status === 'waiting' ? '⏳' : status === 'shell' ? '💤' : ''
    document.title = `${taskBadge}${statusSymbol ? statusSymbol + ' ' : ''}${win.name} — Nexus`
    return () => { document.title = 'Nexus' }
  }, [windows, activeWindowIndex, windowOutputs])

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

    // 更新尺寸基线，让 ResizeObserver 的 delta 检查保持同步
    const rect = container.getBoundingClientRect()
    lastContainerSizeRef.current = { w: rect.width, h: rect.height }

    // 走和 ResizeObserver 完全相同的路径：debounce + rAF
    setTimeout(() => {
      requestAnimationFrame(() => {
        const wasAtBottom = !userScrolledRef.current
        fitAddon.fit()
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
        if (wasAtBottom) { userScrolledRef.current = false; term.scrollToBottom() }
      })
    }, 150)
  }, [])

  // 简化的 resize 处理：只在必要时执行，避免过度工程化
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let rafId: number | null = null
    let debounceTimer: number | null = null

    function doResize() {
      const term = termRef.current
      const fitAddon = fitAddonRef.current
      const containerEl = containerRef.current
      if (!term || !fitAddon || !containerEl) return

      // 获取容器实际渲染尺寸
      const rect = containerEl.getBoundingClientRect()

      // 如果变化太小，忽略（避免微抖动）
      const wDelta = Math.abs(rect.width - lastContainerSizeRef.current.w)
      const hDelta = Math.abs(rect.height - lastContainerSizeRef.current.h)
      if (wDelta < 2 && hDelta < 2) return

      lastContainerSizeRef.current = { w: rect.width, h: rect.height }

      // 清除任何待执行的 raf 和 timer
      if (rafId) cancelAnimationFrame(rafId)
      if (debounceTimer) window.clearTimeout(debounceTimer)

      // Debounce: 延迟执行，确保布局稳定（特别是工具栏动画结束后）
      debounceTimer = window.setTimeout(() => {
        rafId = requestAnimationFrame(() => {
          const wasAtBottom = !userScrolledRef.current
          fitAddon.fit()
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
          if (wasAtBottom) { userScrolledRef.current = false; term.scrollToBottom() }
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
      lastContainerSizeRef.current = { w: 0, h: 0 }
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
      // F-20: 使用 /api/projects 创建新的 project（tmux session）
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: relPath, shell_type: shellType, profile }),
      })
      if (r.ok) {
        const { name: newProjectName } = await r.json()
        // 切换到新创建的 project
        handleSwitchSession(newProjectName, 0)
      }
    } catch {
      // ignore
    }
  }

  // F-19: 创建新窗口（继承当前项目目录）
  async function createWindow(shellType: 'claude' | 'bash' = 'claude', profile?: string) {
    try {
      const session = activeTmuxSessionRef.current
      // 获取当前 project 的路径
      const currentProject = projects.find(p => p.name === session)
      const projectPath = currentProject?.path
      // 修复：使用正确的 API 端点 /api/projects/:name/channels
      const r = await fetch(`/api/projects/${encodeURIComponent(session)}/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell_type: shellType, profile, path: projectPath }),
      })
      if (r.ok) {
        const { name: newWindowName } = await r.json()
        await new Promise(resolve => setTimeout(resolve, 300))
        const sessionNow = activeTmuxSessionRef.current
        const listRes = await fetch(`/api/sessions?session=${encodeURIComponent(sessionNow)}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (listRes.ok) {
          const d = await listRes.json()
          const wins: TmuxWindow[] = d.windows ?? []
          setWindows(wins)
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

  // F-19: 处理新窗口创建（打开配置对话框）
  function handleCreateWindow() {
    setShowNewWindow(true)
  }

  function handleNewWindowConfirm(shellType: 'claude' | 'bash', profile?: string) {
    setShowNewWindow(false)
    createWindow(shellType, profile)
    setTimeout(() => sessionManagerRef.current?.refresh(), 500)
  }

  function handleSwitchSession(newSession: string, lastChannel?: number) {
    localStorage.setItem('nexus_session', newSession)
    // 同步更新 ref，确保 fetchWindows 能立即读到新 session
    activeTmuxSessionRef.current = newSession
    setActiveTmuxSession(newSession)
    // 强制 WebSocket 重新连接（即使 activeWindowIndex 没变）
    setWsSessionKey(newSession)
    // 重置窗口状态，但如果有 lastChannel 则使用它
    setWindows([])
    if (lastChannel !== undefined && lastChannel !== null) {
      setActiveWindowIndex(lastChannel)
      localStorage.setItem(WINDOW_KEY, String(lastChannel))
    } else {
      setActiveWindowIndex(0)
      localStorage.removeItem(WINDOW_KEY)
    }
    windowsInitializedRef.current = false
    windowsLoadedRef.current = false
    setWindowsLoaded(false)
    // 重新获取窗口列表
    setTimeout(() => fetchWindows(), 100)
  }

  function handleFileUpload() {
    fileInputRef.current?.click()
  }

  async function uploadFile(file: File, overwrite = false) {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('originalName', file.name)
    try {
      const sessionParam = `session=${encodeURIComponent(activeTmuxSessionRef.current)}`
      const url = overwrite ? `/api/files/upload?overwrite=1&${sessionParam}` : `/api/files/upload?${sessionParam}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (res.status === 409) {
        // 文件已存在，显示确认对话框
        const data = await res.json()
        setUploadConflict({ show: true, file, filename: data.filename || file.name })
        return
      }
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const fullPath = data.fullPath || data.url || ''
      const filename = data.originalName || data.filename || file.name
      if (!fullPath) console.warn('[Nexus] Upload response missing fullPath:', data)
      addUploadNotification(filename, fullPath)
      const term = termRef.current
      if (term) {
        term.writeln(`\r\n\x1b[32m[Nexus: 文件已上传]\x1b[0m ${filename}`)
        if (fullPath) term.writeln(`\x1b[36m路径: ${fullPath}\x1b[0m`)
      }
    } catch (e: any) {
      console.error('Upload failed:', e)
      const term = termRef.current
      if (term) {
        term.writeln(`\r\n\x1b[31m[Nexus: 上传失败]\x1b[0m ${e.message || 'unknown error'}`)
      }
    }
  }

  function handleOverwriteConfirm() {
    if (uploadConflict.file) {
      uploadFile(uploadConflict.file, true)
      setUploadConflict({ show: false, file: null, filename: '' })
    }
  }

  function handleOverwriteCancel() {
    setUploadConflict({ show: false, file: null, filename: '' })
    const term = termRef.current
    if (term) {
      term.writeln(`\r\n\x1b[33m[Nexus: 上传已取消]\x1b[0m ${uploadConflict.filename}`)
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
      screenReaderMode: true,
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

    // PC端：全局键盘捕获，仅拦截特殊键和快捷键；可打印字符走 xterm 原生路径（支持 IME）
    function onGlobalKeyDown(e: KeyboardEvent) {
      // IME 组合输入期间不拦截
      if (e.isComposing) return

      // 仅在PC宽屏模式处理
      if (window.innerWidth < 768) return

      // 焦点在终端容器外的 input/textarea/contenteditable 时不拦截
      // 用 activeElement 而非 overlay 状态变量，避免 stale closure 问题
      const activeEl = document.activeElement
      const isXtermInput = containerRef.current?.contains(activeEl)
      if (!isXtermInput && activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        (activeEl as HTMLElement).isContentEditable
      )) return

      // 可打印字符（无修饰键）：不拦截，让 xterm 原生处理 → onData 回调发送
      // 这样浏览器 IME 才能正常工作（compositionstart → compositionend → onData）
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        return
      }

      // === 剪贴板快捷键：Ctrl+C/V (PC) / Cmd+C/V (Mac) ===
      const clipboardMod = e.ctrlKey || e.metaKey
      const clipboardKey = e.key.toLowerCase()
      const noOtherMod = !e.shiftKey && !e.altKey

      // 复制：有选中文字时复制到剪贴板
      if (clipboardMod && clipboardKey === 'c' && noOtherMod) {
        if (term.hasSelection()) {
          e.preventDefault()
          navigator.clipboard.writeText(term.getSelection()).catch(() => {})
          return
        }
        // Mac Cmd+C 无选中：不拦截（Mac 终端里 Cmd+C 永远是复制，不发送 SIGINT）
        if (e.metaKey) return
        // PC Ctrl+C 无选中：继续往下 → 发送 SIGINT (ETX)
      }

      // 粘贴：从剪贴板读取并发送到终端
      if (clipboardMod && clipboardKey === 'v' && noOtherMod) {
        e.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(text)
          }
        }).catch(() => {})
        return
      }

      // 白名单：这些快捷键保留给浏览器/应用使用
      const whitelist = [
        { ctrl: true, key: 'r', desc: '浏览器刷新' },
        { ctrl: true, key: 'l', desc: '浏览器地址栏' },
        { ctrl: true, key: 't', desc: '新标签页' },
        { ctrl: true, key: 'n', desc: '新窗口' },
        { ctrl: true, key: 'w', desc: '关闭标签' },
        { ctrl: true, shift: true, key: 't', desc: '恢复标签' },
        { ctrl: true, shift: true, key: 'n', desc: '隐身窗口' },
        { ctrl: true, key: 'tab', desc: '切换标签' },
        { ctrl: true, shift: true, key: 'tab', desc: '切换标签' },
      ]

      const isWhitelisted = whitelist.some((w: any) => {
        if (w.ctrl !== undefined && w.ctrl !== e.ctrlKey) return false
        if (w.shift !== undefined && w.shift !== e.shiftKey) return false
        if (w.alt !== undefined && w.alt !== e.altKey) return false
        if (w.meta !== undefined && w.meta !== e.metaKey) return false
        return w.key.toLowerCase() === e.key.toLowerCase()
      })

      if (isWhitelisted) return // 让浏览器处理

      // 特殊键和快捷键：阻止默认行为，手动转换为ANSI序列发送
      e.preventDefault()

      let seq = ''
      if (e.ctrlKey && e.key.length === 1) {
        // Ctrl+字母
        seq = String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96)
      } else if (e.key === 'Enter') {
        seq = '\r'
      } else if (e.key === 'Tab') {
        seq = '\t'
      } else if (e.key === 'Backspace') {
        seq = '\x7f'
      } else if (e.key === 'Escape') {
        seq = '\x1b'
      } else if (e.key === 'ArrowUp') {
        seq = '\x1b[A'
      } else if (e.key === 'ArrowDown') {
        seq = '\x1b[B'
      } else if (e.key === 'ArrowRight') {
        seq = '\x1b[C'
      } else if (e.key === 'ArrowLeft') {
        seq = '\x1b[D'
      } else if (e.key === 'Home') {
        seq = '\x1b[H'
      } else if (e.key === 'End') {
        seq = '\x1b[F'
      } else if (e.key === 'PageUp') {
        seq = '\x1b[5~'
      } else if (e.key === 'PageDown') {
        seq = '\x1b[6~'
      } else if (e.key === 'Delete') {
        seq = '\x1b[3~'
      }

      if (seq && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(seq)
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown, true)

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (window.innerWidth >= 768) {
        // IME 组合期间：让 xterm 原生处理
        if (e.isComposing) return true
        // 可打印字符（无修饰键）：让 xterm 处理 → textarea → onData
        // 这样浏览器 IME 才能正常工作
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return true
        // 特殊键（箭头、Enter、Tab 等）和快捷键：让全局 handler 处理
        return false
      }
      // 移动端保持原有逻辑
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
      if (isPinching && e.touches.length === 2) {
        e.preventDefault()
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
        if (swipeAxis === 'horizontal') { e.preventDefault(); return }
        if (swipeAxis === 'vertical' && !showScrollbackRef.current) {
          e.preventDefault()
          const y = e.touches[0].clientY
          const deltaY = touchLastY - y  // positive = finger UP = want older content
          touchLastY = y
          if (deltaY < 0) {  // finger DOWN = swipe down = view history
            swipeUpAccumRef.current += -deltaY
            if (swipeUpAccumRef.current > 10 && !scrollbackPrefetchRef.current && scrollbackCacheRef.current === null) {
              // Pre-fetch while gesture is still building up
              const wi = activeWindowIndexRef.current
              const s = activeTmuxSessionRef.current
              scrollbackPrefetchRef.current = fetch(`/api/sessions/${wi}/scrollback?session=${encodeURIComponent(s)}&lines=3000`, {
                headers: { Authorization: `Bearer ${token}` },
              }).then(r => r.ok ? r.json() : Promise.reject(r.status))
                .then((data: { content: string }) => {
                  scrollbackCacheRef.current = data.content.trimEnd()
                  scrollbackPrefetchRef.current = null
                  return data
                })
                .catch(() => { scrollbackPrefetchRef.current = null; return { content: '' } })
            }
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
        // Prevent the subsequent click event so xterm's internal handler
        // doesn't steal focus from our managed input.
        e.preventDefault()
        const xtermTa = termRef.current?.textarea
        // 工具栏展开时收起工具栏；若键盘也可见则一并收起
        if (toolbarCollapsedRef.current === false) {
          setToolbarCollapsed(true)
          if (keyboardVisibleRef.current) {
            keyboardVisibleRef.current = false
            if (inputRef.current) { inputRef.current.inputMode = 'none'; inputRef.current.blur() }
            if (xtermTa) { xtermTa.inputMode = 'none'; xtermTa.blur() }
          }
          return
        }
        // Tap toggles keyboard: tap to show, tap again to hide
        if (keyboardVisibleRef.current) {
          keyboardVisibleRef.current = false
          if (inputRef.current) { inputRef.current.inputMode = 'none'; inputRef.current.blur() }
          if (xtermTa) { xtermTa.inputMode = 'none'; xtermTa.blur() }
        } else {
          keyboardVisibleRef.current = true
          const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
          if (isIOS) {
            // iOS Safari won't reliably show the keyboard for xterm's internal
            // textarea (tiny element + restrictive attributes). Use our standard
            // <input> instead — iOS handles it correctly.
            if (xtermTa) xtermTa.inputMode = 'none'
            if (inputRef.current) { inputRef.current.inputMode = 'text'; inputRef.current.focus() }
          } else {
            // Android / other: focus xterm's own textarea — term.onData handles
            // all input natively (letters, numbers, IME/CJK).
            if (xtermTa) { xtermTa.inputMode = 'text'; xtermTa.focus() }
            if (inputRef.current) inputRef.current.inputMode = 'text'
          }
        }
      }
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: false })

    // F-21: 拖拽上传文件
    function onDragOver(e: DragEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    function onDragEnter(e: DragEvent) {
      e.preventDefault()
      e.stopPropagation()
      container.style.boxShadow = 'inset 0 0 0 3px var(--nexus-accent)'
    }
    function onDragLeave(e: DragEvent) {
      e.preventDefault()
      e.stopPropagation()
      container.style.boxShadow = ''
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      e.stopPropagation()
      container.style.boxShadow = ''
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        uploadFileRef.current(files[0])
      }
    }
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('dragenter', onDragEnter)
    container.addEventListener('dragleave', onDragLeave)
    container.addEventListener('drop', onDrop)

    // Layer 4: Prevent any touch on the hidden input itself from showing keyboard
    function onInputTouchStart(e: TouchEvent) {
      if (!keyboardVisibleRef.current) e.preventDefault()
    }
    const inp = inputRef.current
    if (inp) {
      inp.addEventListener('touchstart', onInputTouchStart, { passive: false })
    }

    function sendResize() {
      const wasAtBottom = !userScrolledRef.current
      fitAddonRef.current?.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      if (wasAtBottom) { userScrolledRef.current = false; term.scrollToBottom() }
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
      window.removeEventListener('keydown', onGlobalKeyDown, true)
      window.removeEventListener('orientationchange', onOrientationChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', sendResize)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('dragenter', onDragEnter)
      container.removeEventListener('dragleave', onDragLeave)
      container.removeEventListener('drop', onDrop)
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
          // Reset xterm parser state for the new window so the incoming
          // SIGWINCH-triggered repaint is parsed from a clean state.
          termRef.current?.reset()
        }
        reconnectAttempts = 0
        hasConnectedRef.current = true
        setIsConnecting(false)
        fitAddonRef.current?.fit()
        const term = termRef.current
        if (term) {
          // Send rows-1 first: tmux only repaints on an *actual* dimension change.
          // If the PTY already has the same cols/rows (same device, same viewport),
          // a same-size resize is a no-op in tmux and no repaint is sent.
          // The rows-1 nudge guarantees a size change → SIGWINCH → tmux pushes a
          // full repaint. The rAF below immediately corrects to the real dimensions.
          newWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: Math.max(term.rows - 1, 5) }))
        }
        // Follow-up fit: re-measures layout and sends correct final dimensions,
        // triggering a second SIGWINCH repaint at the right size.
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

  // Track keyboard visibility and adjust layout height on mobile
  const [vvHeight, setVvHeight] = useState<number | null>(null)
  // 文件上传覆盖确认对话框状态
  const [uploadConflict, setUploadConflict] = useState<{ show: boolean; file: File | null; filename: string }>({ show: false, file: null, filename: '' })
  useEffect(() => {
    if (isWidePC) {
      setVvHeight(null)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    const handleResize = () => {
      keyboardVisibleRef.current = vv.height < window.innerHeight * 0.8
      setVvHeight(Math.round(vv.height))
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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('nexus_sidebar_collapsed')
    return saved !== null ? saved === 'true' : true // default collapsed
  })
  // Sidebar toggled only by the explicit chevron buttons
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
  const anyOverlayOpen = showSessionDrawer || showSettings || showGeneralSettings || showNewSession || showNewWindow || showScrollback || showSessionManagerV2 || showFiles
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
    scrollbackCacheRef.current = null
    scrollbackPrefetchRef.current = null
  }

  function handleOverlayScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30
    if (atBottom) {
      closeScrollback()
    }
  }

  function fetchScrollback() {
    if (showScrollbackRef.current) return // already showing
    showScrollbackRef.current = true
    swipeUpAccumRef.current = 0
    setShowScrollback(true)

    // Use pre-fetched cache if available (no loading flash)
    if (scrollbackCacheRef.current !== null) {
      setScrollbackContent(scrollbackCacheRef.current)
      setScrollbackLoading(false)
      return
    }

    setScrollbackLoading(true)
    const wi = activeWindowIndexRef.current
    const s = activeTmuxSessionRef.current
    const promise = scrollbackPrefetchRef.current ??
      fetch(`/api/sessions/${wi}/scrollback?session=${encodeURIComponent(s)}&lines=3000`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.ok ? r.json() : Promise.reject(r.status))

    scrollbackPrefetchRef.current = null
    promise
      .then(({ content }: { content: string }) => {
        setScrollbackContent(content.trimEnd())
        setScrollbackLoading(false)
      })
      .catch(() => {
        setScrollbackContent('(加载失败)')
        setScrollbackLoading(false)
      })
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
    onOpenSettings: () => setShowGeneralSettings(true),
    onOpenFiles: () => setShowFiles(true),
    onOpenWorkspace: () => setShowWorkspace(true),
    onUpload: handleFileUpload,
    onUploadFile: uploadFile,
    onShowCopySheet: (text: string) => setCopySheetText(text),
    collapsed: toolbarCollapsed,
    onCollapsedChange: setToolbarCollapsed,
  }

  return (
    <div className="flex flex-col w-full relative" style={{ height: vvHeight ?? '100dvh' }}>
      <input
        ref={inputRef}
        className="fixed top-0 left-0 w-px h-px opacity-[0.01] text-base pointer-events-none -z-10"
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
        accept="image/*,video/*"
        className="fixed top-0 left-0 w-px h-px opacity-[0.01] text-base pointer-events-none -z-10"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) uploadFile(file)
          e.target.value = '' // reset
        }}
        aria-hidden="true"
      />
      <input
        ref={pasteFileRef}
        type="file"
        className="fixed top-0 left-0 w-px h-px opacity-[0.01] text-base pointer-events-none -z-10"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) uploadFile(file)
          e.target.value = '' // reset
        }}
        aria-hidden="true"
      />

      {isWidePC ? (
        <div className="flex flex-col flex-1 overflow-hidden min-h-0">
          <div className="flex flex-1 overflow-hidden min-h-0">
            {/* Collapsible Sidebar */}
            <div
              className="flex-shrink-0 flex flex-col bg-nexus-bg"
              style={{ width: sidebarCollapsed ? 48 : 220, overflow: 'hidden' }}
            >
              {sidebarCollapsed ? (
                /* Collapsed Sidebar - Icon Only */
                <div
                  className="flex-1 flex flex-col min-h-0 overflow-hidden bg-nexus-bg"
                  style={{ maxWidth: 48 }}
                >
                  {/* Expand button at top */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setSidebarCollapsed(false); localStorage.setItem('nexus_sidebar_collapsed', 'false'); }}
                    className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer shrink-0"
                    title="展开侧边栏"
                  >
                    <Icon name="chevronRight" size={18} />
                  </button>
                  {/* Scrollable window indicators */}
                  <div
                    className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col gap-0.5"
                  >
                    {windows.map(win => {
                      const status = getWindowStatus(windowOutputs[win.index])
                      const isActive = win.index === activeWindowIndex
                      return (
                        <button
                          key={win.index}
                          onClick={(e) => { e.stopPropagation(); attachToWindow(win.index); }}
                          className="w-12 h-10 bg-transparent border-none flex items-center justify-center cursor-pointer relative"
                          style={{
                            background: isActive ? 'var(--nexus-tab-active)' : 'transparent',
                            borderLeft: isActive ? '3px solid var(--nexus-accent)' : '3px solid transparent',
                          }}
                          title={win.name}
                        >
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ background: STATUS_DOT_COLOR[status] }}
                          />
                        </button>
                      )
                    })}
                  </div>

                  <div className="border-t border-nexus-border" onPointerDown={(e) => e.stopPropagation()} />

                  {/* Fixed quick actions at bottom */}
                  <div
                    className="flex-shrink-0 flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); openNewSessionDialog(); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title="新建项目"
                    >
                      <Icon name="folderPlus" size={18} />
                    </button>

                    <button
                      onClick={(e) => { e.stopPropagation(); handleCreateWindow(); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title="新建窗口"
                    >
                      <Icon name="plus" size={18} />
                    </button>


                    <button
                      onClick={(e) => { e.stopPropagation(); setShowFiles(true); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title="文件列表"
                    >
                      <Icon name="folder" size={18} />
                    </button>

                    <button
                      onClick={(e) => { e.stopPropagation(); setShowWorkspace(true); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title="浏览工作目录"
                    >
                      <Icon name="folderOpen" size={18} />
                    </button>

                    <button
                      onClick={(e) => { e.stopPropagation(); handleFileUpload(); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title="上传文件"
                    >
                      <Icon name="paperclip" size={18} />
                    </button>

                    <div className="flex-1" />

                    <button
                      onClick={(e) => { e.stopPropagation(); toggleTheme(); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title={themeMode === 'dark' ? '切换亮色' : '切换暗色'}
                    >
                      <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={18} />
                    </button>

                    <button
                      onClick={(e) => { e.stopPropagation(); setShowSessionManagerV2(true); }}
                      className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                      title="配置管理"
                    >
                      <Icon name="settings" size={18} />
                    </button>
                  </div>
                </div>
              ) : (
                /* Expanded Sidebar: session manager + fixed bottom bar */
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
                  {/* Collapse button in header area */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setSidebarCollapsed(true); localStorage.setItem('nexus_sidebar_collapsed', 'true'); }}
                    className="absolute top-1 right-1 z-50 w-7 h-7 flex items-center justify-center rounded cursor-pointer bg-nexus-bg/80 border border-nexus-border text-nexus-text-2 hover:bg-nexus-bg transition-colors"
                    title="收起侧边栏"
                  >
                    <Icon name="chevronLeft" size={16} />
                  </button>
                  <div
                    className="flex-1 min-h-0 overflow-hidden"
                  >
                    <SessionManagerV2
                      ref={sessionManagerRef}
                      token={token}
                      currentProject={activeTmuxSession}
                      currentChannelIndex={activeWindowIndex}
                      onClose={() => {}}
                      onSwitchProject={(name) => handleSwitchSession(name)}
                      onSwitchChannel={(idx) => attachToWindow(idx)}
                      onNewProject={openNewSessionDialog}
                      onNewChannel={handleCreateWindow}
                      layout="sidebar"
                    />
                  </div>
                  <div className="border-t border-nexus-border shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Toolbar {...toolbarProps} embedded />
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 flex flex-col min-w-0 relative">
              <div ref={containerRef} className="flex-1 overflow-hidden relative" />
              {isConnecting && (
                <div className="absolute inset-0 bg-nexus-bg flex flex-col items-center justify-center gap-3 z-10">
                  <div className="w-8 h-8 border-[3px] border-nexus-border border-t-nexus-accent rounded-full animate-spin" />
                  <span className="text-nexus-text-2 text-sm">Connecting...</span>
                </div>
              )}
              {isScrolledUp && (
                <button className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-nexus-accent border-none text-white text-lg cursor-pointer z-50 flex items-center justify-center shadow-lg backdrop-blur-sm" onClick={scrollToBottom} title="滚到底部"><Icon name="arrowDown" size={16} /></button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 overflow-hidden min-h-0">
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
            <div ref={containerRef} className="flex-1 overflow-hidden relative" />
            {isConnecting && (
              <div className="absolute inset-0 bg-nexus-bg flex flex-col items-center justify-center gap-3 z-10">
                <div className="w-8 h-8 border-[3px] border-nexus-border border-t-nexus-accent rounded-full animate-spin" />
                <span className="text-nexus-text-2 text-sm">Connecting...</span>
              </div>
            )}
            {isScrolledUp && (
              <button className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-nexus-accent border-none text-white text-lg cursor-pointer z-50 flex items-center justify-center shadow-lg backdrop-blur-sm" onClick={scrollToBottom} title="滚到底部"><Icon name="arrowDown" size={16} /></button>
            )}
          </div>
          <SessionFAB onClick={() => setShowSessionManagerV2(v => !v)} windowCount={windows.length} bottomInset={toolbarHeightRef.current} />
          <div ref={toolbarWrapRef}><Toolbar {...toolbarProps} /></div>
        </div>
      )}

      {/* 移动端会话抽屉 */}
      {showSessionDrawer && !isWidePC && (
        <>
          <GhostShield />
          <div className="fixed inset-0 z-[400] bg-black/50" onPointerDown={() => { setShowSessionDrawer(false); setDrawerMenuIndex(null); setDrawerRenameIndex(null) }} />
          <div className="fixed bottom-0 left-0 right-0 z-[401] bg-nexus-menu-bg rounded-t-xl border border-nexus-border border-b-0 max-h-[70vh] flex flex-col shadow-[0_-4px_24px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border flex-shrink-0">
              <span className="text-nexus-text font-semibold text-[15px]">会话管理</span>
              <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center" onPointerDown={(e) => { e.preventDefault(); setShowSessionDrawer(false); setDrawerMenuIndex(null); setDrawerRenameIndex(null); (document.activeElement as HTMLElement)?.blur() }}><Icon name="x" size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto py-1.5">
              {windows.map(win => {
                const status = getWindowStatus(windowOutputs[win.index])
                const isActive = win.index === activeWindowIndex
                const isMenuOpen = drawerMenuIndex === win.index
                const isRenaming = drawerRenameIndex === win.index
                return (
                  <div key={win.index} className="border-b border-nexus-border">
                    {/* Main row */}
                    <div
                      className={`flex items-center gap-3 px-4 py-3 ${isActive ? 'bg-nexus-tab-active' : 'bg-transparent'}`}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0 inline-block"
                        style={{ background: STATUS_DOT_COLOR[status] }}
                        title={t(STATUS_DOT_TITLE[status])}
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
                          className="flex-1 bg-nexus-bg border border-nexus-accent rounded-md text-nexus-text text-sm font-mono py-1 px-2 outline-none"
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="flex-1 text-nexus-text text-sm font-mono overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer"
                          onPointerUp={(e) => { e.stopPropagation(); attachToWindow(win.index); setShowSessionDrawer(false); setDrawerMenuIndex(null) }}
                        >{win.name}</span>
                      )}
                      {isActive && !isRenaming && <span className="text-nexus-accent text-sm font-semibold flex-shrink-0 flex items-center"><Icon name="check" size={14} /></span>}
                      <button
                        className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex-shrink-0 flex items-center justify-center"
                        onPointerDown={e => { e.stopPropagation(); setDrawerMenuIndex(isMenuOpen ? null : win.index); setDrawerRenameIndex(null) }}
                      ><Icon name="more" size={18} /></button>
                    </div>
                    {/* Action row */}
                    {isMenuOpen && !isRenaming && (
                      <div className="flex gap-2 px-4 py-1.5 pb-2.5 bg-nexus-bg">
                        <button
                          className="flex-1 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm py-1.5 cursor-pointer"
                          onPointerDown={e => { e.stopPropagation(); setDrawerRenameValue(win.name); setDrawerRenameIndex(win.index); setDrawerMenuIndex(null) }}
                        ><span className="flex items-center justify-center gap-1"><Icon name="pencil" size={14} />改名</span></button>
                        <button
                          className="flex-1 bg-transparent border border-nexus-error rounded-md text-nexus-error text-sm py-1.5 cursor-pointer"
                          onPointerDown={e => { e.stopPropagation(); closeWindow(win.index); setDrawerMenuIndex(null); if (windows.length <= 1) setShowSessionDrawer(false) }}
                        ><span className="flex items-center justify-center gap-1"><Icon name="x" size={14} />关闭</span></button>
                      </div>
                    )}
                  </div>
                )
              })}
              {/* tmux session 切换（多 session 时显示） */}
              {tmuxSessions.length > 1 && (
                <div className="px-4 pt-2.5 pb-1 text-nexus-muted text-[11px] uppercase tracking-wide">Tmux Sessions</div>
              )}
              {tmuxSessions.length > 1 && tmuxSessions.map(sess => (
                <div
                  key={sess}
                  className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer ${sess === activeTmuxSession ? 'bg-nexus-tab-active' : 'bg-transparent'}`}
                  onClick={() => { handleSwitchSession(sess); setShowSessionDrawer(false) }}
                >
                  <span className="flex items-center gap-1.5 text-sm">{sess === activeTmuxSession ? <span className="text-nexus-accent"><Icon name="check" size={14} /></span> : <span className="w-3.5" />}<span className={sess === activeTmuxSession ? 'text-nexus-accent' : 'text-nexus-text-2'}>{sess}</span></span>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-nexus-border flex-shrink-0 flex gap-2">
              <button
                className="flex-1 bg-nexus-accent border-none rounded-lg text-white text-sm font-semibold py-3 cursor-pointer flex items-center justify-center gap-1.5"
                style={{ touchAction: 'manipulation' }}
                onClick={() => { setShowSessionDrawer(false); openNewSessionDialog() }}
              >
                <span>📁</span>
                <span>新项目</span>
              </button>
              <button
                className="flex-1 bg-nexus-bg-2 border border-nexus-border rounded-lg text-nexus-text text-sm font-semibold py-3 cursor-pointer flex items-center justify-center gap-1.5"
                style={{ touchAction: 'manipulation' }}
                onClick={() => { setShowSessionDrawer(false); handleCreateWindow() }}
              >
                <span>➕</span>
                <span>新窗口</span>
              </button>
            </div>
          </div>
        </>
      )}

            {showFiles && (
        <Suspense fallback={null}>
          <FilePanel
            token={token}
            session={activeTmuxSession}
            onClose={() => setShowFiles(false)}
          />
        </Suspense>
      )}
      {showWorkspace && (
        <Suspense fallback={null}>
          <WorkspaceBrowser
            token={token}
            onClose={() => setShowWorkspace(false)}
            currentSession={activeTmuxSession}
          />
        </Suspense>
      )}
      {copySheetText !== null && (
        <div
          className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/40"
          onClick={() => setCopySheetText(null)}
        >
          <div
            className="w-full max-w-lg bg-nexus-bg border-t border-nexus-border rounded-t-xl p-4 max-h-[60vh] flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-nexus-text font-medium text-sm">Terminal Content</span>
              <button
                className="text-xs px-3 py-1 rounded bg-nexus-accent text-white"
                onClick={() => setCopySheetText(null)}
              >
                Close
              </button>
            </div>
            <textarea
              readOnly
              value={copySheetText}
              className="w-full flex-1 min-h-[200px] bg-nexus-surface text-nexus-text text-xs font-mono p-3 rounded border border-nexus-border resize-none"
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
              onFocus={(e) => {
                e.currentTarget.select()
                e.currentTarget.setSelectionRange(0, e.currentTarget.value.length)
              }}
            />
            <p className="text-nexus-text-2 text-xs text-center">Long press to select and copy</p>
          </div>
        </div>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <SessionManager
            token={token}
            onClose={() => setShowSettings(false)}
          />
        </Suspense>
      )}
      {showSessionManagerV2 && (
        <Suspense fallback={null}>
          <SessionManagerV2
            token={token}
            currentProject={activeTmuxSession}
            currentChannelIndex={activeWindowIndex}
            onClose={() => setShowSessionManagerV2(false)}
            onSwitchProject={handleSwitchSession}
            onSwitchChannel={attachToWindow}
            onNewProject={() => { setShowSessionManagerV2(false); openNewSessionDialog() }}
            onNewChannel={() => { setShowSessionManagerV2(false); handleCreateWindow() }}
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
      {showNewWindow && (
        <Suspense fallback={null}>
          <NewWindowDialog
            token={token}
            onClose={() => setShowNewWindow(false)}
            onConfirm={handleNewWindowConfirm}
          />
        </Suspense>
      )}
      {showGeneralSettings && (
        <Suspense fallback={null}>
          <GeneralSettings
            token={token}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
            onClose={() => setShowGeneralSettings(false)}
            onOpenApiConfig={() => { setShowGeneralSettings(false); setShowSettings(true) }}
          />
        </Suspense>
      )}

      {/* 首次使用引导 */}
      {showGuide && (
        <div className="fixed inset-0 z-[500] bg-black/70 flex items-center justify-center p-5">
          <div className="bg-nexus-menu-bg rounded-xl p-6 max-w-[400px] border border-nexus-border">
            <h3 className="text-nexus-text mt-0">欢迎使用 Nexus</h3>
            <ul className="text-nexus-text-2 leading-relaxed text-sm pl-5 my-2">
              <li>黑色区域是终端，点击聚焦后可键盘输入</li>
              <li>底部工具栏提供 Esc/Tab/^C 等快捷键</li>
                            <li className="flex items-center gap-1.5"><Icon name="paperclip" size={14} />上传图片/文件到当前 session 目录</li>
              <li>📁 新项目：在选定目录创建窗口</li>
              <li>➕ 新窗口：在当前项目目录创建窗口</li>
            </ul>
            <p className="text-nexus-muted text-[11px] mt-2">
              Telegram Bot: /api/telegram/setup 一键配置
            </p>
            <button
              onClick={() => {
                setShowGuide(false)
                localStorage.setItem('nexus_guide_seen', 'true')
              }}
              className="w-full bg-nexus-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold py-2.5 px-5 mt-3"
            >
              开始使用
            </button>
          </div>
        </div>
      )}

      {/* 空状态提示：只在数据加载完成后才显示 */}
      {windows.length === 0 && windowsLoaded && !isConnecting && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-nexus-muted">
          <div className="text-5xl mb-3">🖥️</div>
          <div className="text-base mb-2">没有活动会话</div>
          <div className="text-sm">点击「+ 新建」开始</div>
        </div>
      )}

      {/* 文件上传覆盖确认对话框 */}
      {uploadConflict.show && (
        <div className="fixed inset-0 z-[500] bg-black/70 flex items-center justify-center p-5">
          <div className="bg-nexus-menu-bg rounded-xl p-6 max-w-[400px] border border-nexus-border">
            <h3 className="text-nexus-text mt-0 mb-2">文件已存在</h3>
            <p className="text-nexus-text-2 text-sm mb-4">
              文件 "<span className="text-nexus-text font-mono">{uploadConflict.filename}</span>" 已存在。
              <br />是否覆盖？
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleOverwriteCancel}
                className="flex-1 bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text cursor-pointer text-sm font-semibold py-2.5"
              >
                取消
              </button>
              <button
                onClick={handleOverwriteConfirm}
                className="flex-1 bg-nexus-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold py-2.5"
              >
                覆盖
              </button>
            </div>
          </div>
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
          <div className="fixed inset-0 z-[500] flex flex-col" style={{ background: termBg }}>
            <GhostShield />
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b flex-shrink-0" style={{ borderColor: `${termMuted}44` }}>
              <span className="font-semibold text-sm" style={{ color: termFg }}>历史记录</span>
              <span className="text-xs flex-1 text-center" style={{ color: termMuted }}>滚到底部返回终端</span>
              <button
                className="bg-transparent border-none cursor-pointer p-1 flex items-center justify-center"
                style={{ color: termMuted }}
                onClick={closeScrollback}
              ><Icon name="x" size={20} /></button>
            </div>
            <div
              ref={scrollbackOverlayRef}
              onScroll={handleOverlayScroll}
              className="flex-1 overflow-y-auto py-2"
              style={{ WebkitOverflowScrolling: 'touch' }}
            >
              {scrollbackLoading ? (
                <div className="text-center p-8" style={{ color: termMuted, fontFamily: termFontFamily, fontSize: termFontSize }}>加载中...</div>
              ) : (
                <pre
                  className="m-0 p-0 whitespace-pre-wrap break-all leading-tight"
                  style={{ fontFamily: termFontFamily, fontSize: termFontSize, color: termFg }}
                  dangerouslySetInnerHTML={{ __html: ansiToHtml(scrollbackContent) }}
                />
              )}
            </div>
          </div>
        )
      })()}

      {/* 上传文件通知条 */}
      {uploadNotifications.length > 0 && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 max-w-[90vw] w-[480px]"
          style={{ bottom: isWidePC ? 16 : (toolbarHeightRef.current + 16) }}
        >
          {uploadNotifications.map((notification) => (
            <div
              key={notification.id}
              className="flex items-center gap-2.5 p-2.5 px-3 rounded-lg shadow-[0_4px_20px_rgba(0,0,0,0.25)] animate-slide-up"
              style={{
                background: 'color-mix(in srgb, var(--nexus-bg2) 85%, transparent)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid color-mix(in srgb, var(--nexus-border) 50%, transparent)',
              }}
            >
              <span
                className="flex-1 text-nexus-text text-sm overflow-hidden text-ellipsis whitespace-nowrap"
                title={notification.path}
              >
                {notification.filename}
              </span>
              <button
                onClick={() => handleCopyNotification(notification.id, notification.path)}
                className={`rounded-md cursor-pointer py-1.5 px-2.5 flex items-center gap-1 text-xs whitespace-nowrap transition-all duration-100 active:scale-95 ${copiedId === notification.id ? 'bg-nexus-success border-none text-white' : 'bg-nexus-bg-2 border border-nexus-border text-nexus-text-2 active:bg-nexus-bg active:text-nexus-text'}`}
                title="复制路径"
              >
                <Icon name={copiedId === notification.id ? 'check' : 'copy'} size={14} />
                <span>{copiedId === notification.id ? '已复制' : '复制'}</span>
              </button>
              <button
                onClick={() => removeUploadNotification(notification.id)}
                className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center transition-all duration-100 active:scale-90 active:text-nexus-text"
                title="关闭"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
