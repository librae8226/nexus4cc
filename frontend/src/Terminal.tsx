import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import Toolbar from './Toolbar'
import SessionManager from './SessionManager'
import TabBar from './TabBar'
import WorkspaceSelector from './WorkspaceSelector'

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
const TAP_THRESHOLD = 8

export type ThemeMode = 'dark' | 'light'

const DARK_THEME: ITheme = {
  background: '#1a1a2e',
  foreground: '#e2e8f0',
  cursor: '#e2e8f0',
  cursorAccent: '#1a1a2e',
  selectionBackground: '#264f78',
  selectionForeground: '#e2e8f0',
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
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  selectionForeground: '#333333',
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
  return 'dark'
}

export default function Terminal({ token }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const userScrolledRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [windows, setWindows] = useState<TmuxWindow[]>([])
  const [activeWindowIndex, setActiveWindowIndex] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme)

  const headers = { Authorization: `Bearer ${token}` }

  const applyTheme = useCallback((mode: ThemeMode) => {
    const term = termRef.current
    if (!term) return
    term.options.theme = THEMES[mode]
    localStorage.setItem(THEME_KEY, mode)
  }, [])

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

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom()
    userScrolledRef.current = false
  }, [])

  async function fetchWindows() {
    try {
      const r = await fetch('/api/sessions', { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      const wins = d.windows ?? []
      setWindows(wins)
      const active = wins.find((w: TmuxWindow) => w.active)
      if (active) setActiveWindowIndex(active.index)
    } catch {
      // ignore
    }
  }

  function attachToWindow(index: number) {
    sendToWs('\x02' + index.toString())
    setActiveWindowIndex(index)
  }

  async function closeWindow(index: number) {
    try {
      const r = await fetch(`/api/sessions/${index}`, { method: 'DELETE', headers })
      if (r.ok) {
        await fetchWindows()
      }
    } catch {
      // ignore
    }
  }

  async function createSession(relPath: string, shellType: 'claude' | 'bash' = 'claude', profile?: string) {
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel_path: relPath, shell_type: shellType, profile }),
      })
      if (r.ok) {
        await fetchWindows()
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

  useEffect(() => {
    const fontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
    const initialTheme = getInitialTheme()

    const term = new XTerm({
      theme: THEMES[initialTheme],
      fontSize,
      fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    termRef.current = term

    const container = containerRef.current!
    term.open(container)
    fitAddon.fit()

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement
    if (viewport) viewport.style.pointerEvents = 'none'

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && ['w', 't', 'n', 'l', 'r'].includes(e.key.toLowerCase())) {
        e.preventDefault()
        return true
      }
      return true
    })

    function getLineHeight(): number {
      const core = (term as any)._core
      const cellH = core?._renderService?.dimensions?.css?.cell?.height
      if (cellH && cellH > 0) return cellH
      const h = container.offsetHeight
      if (h > 0 && term.rows > 0) return h / term.rows
      return 20
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`)
    wsRef.current = ws

    ws.onopen = () => {
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      fetchWindows()
    }

    ws.onmessage = (e) => {
      term.write(e.data)
      if (!userScrolledRef.current) term.scrollToBottom()
    }

    ws.onclose = (e) => {
      if (e.code === 4001) {
        term.write('\r\n\x1b[31m[Nexus: 认证失败，请刷新重新登录]\x1b[0m\r\n')
      } else {
        term.write('\r\n\x1b[33m[Nexus: 连接断开，正在重连...]\x1b[0m\r\n')
        setTimeout(() => location.reload(), 3000)
      }
    }

    ws.onerror = () => term.write('\r\n\x1b[31m[Nexus: WebSocket 错误]\x1b[0m\r\n')

    term.onData((data) => ws.send(data))

    let touchStartY = 0
    let touchLastY = 0
    let isPinching = false
    let pinchStartDist = 0
    let pinchStartFontSize = fontSize

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
        touchStartY = e.touches[0].clientY
        touchLastY = e.touches[0].clientY
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
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
        }
      } else if (!isPinching) {
        const y = e.touches[0].clientY
        const lineHeight = getLineHeight()
        const lines = Math.round((touchLastY - y) / lineHeight)
        touchLastY = y
        if (lines !== 0) {
          term.scrollLines(lines)
          const buffer = (term as any).buffer?.active
          if (buffer) {
            const atBottom = buffer.viewportY >= buffer.baseY
            userScrolledRef.current = !atBottom
            window.dispatchEvent(new CustomEvent('nexus:atbottom', { detail: atBottom }))
          }
        }
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (isPinching) {
        isPinching = false
        return
      }
      const endY = e.changedTouches[0].clientY
      if (Math.abs(endY - touchStartY) < TAP_THRESHOLD) {
        inputRef.current?.focus({ preventScroll: true })
      }
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: true })

    function sendResize() {
      fitAddon.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    function onOrientationChange() {
      setTimeout(sendResize, 300)
    }

    const resizeObserver = new ResizeObserver(sendResize)
    resizeObserver.observe(container)
    window.addEventListener('orientationchange', onOrientationChange)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('orientationchange', onOrientationChange)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      ws.close()
      term.dispose()
    }
  }, [token])

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    if (val) {
      sendToWs(val)
      e.target.value = ''
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); sendToWs('\r') }
    else if (e.key === 'Backspace') { e.preventDefault(); sendToWs('\x7f') }
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
        aria-hidden="true"
      />
      <TabBar
        windows={windows}
        activeIndex={activeWindowIndex}
        onSwitch={attachToWindow}
        onClose={closeWindow}
        onAdd={openNewSessionDialog}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div ref={containerRef} style={styles.terminal} />
      <Toolbar
        token={token}
        sendToWs={sendToWs}
        scrollToBottom={scrollToBottom}
        termRef={termRef}
        themeMode={themeMode}
        onToggleTheme={toggleTheme}
      />
      {showSettings && (
        <SessionManager
          token={token}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showNewSession && (
        <WorkspaceSelector
          token={token}
          onClose={() => setShowNewSession(false)}
          onConfirm={handleCreateSession}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
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
}
