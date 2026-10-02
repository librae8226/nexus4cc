import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { wsUrl } from './baseUrl'

/**
 * 救援终端：**不经过 tmux** 的裸 PTY（后端 /ws?rescue=1[&agent=1]）。
 * tmux 坏掉时这是 Nexus 里唯一还能用的终端；agent 模式直接拉起带预置任务的 recovery agent。
 * 刻意不复用 Terminal.tsx（那套绑死了 tmux 的 session/window/标签逻辑）。
 */
interface Props {
  token: string
  agent: boolean
  onClose: () => void
}

export default function RescueConsole({ token, agent, onClose }: Props) {
  const { t } = useTranslation()
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return

    const term = new XTerm({
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#111827', foreground: '#e5e7eb', cursor: '#fbbf24' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(holder)
    try { fit.fit() } catch { /* 尺寸未就绪 */ }

    const ws = new WebSocket(wsUrl(`/ws?token=${encodeURIComponent(token)}&rescue=1${agent ? '&agent=1' : ''}`))
    const sendResize = () => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onopen = () => { try { fit.fit() } catch { /* noop */ }; sendResize() }
    ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : '')
    ws.onclose = () => term.write('\r\n\x1b[33m[救援终端已断开]\x1b[0m\r\n')

    const sub = term.onData((d) => { if (ws.readyState === 1) ws.send(d) })

    const onResize = () => { try { fit.fit(); sendResize() } catch { /* noop */ } }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(holder)
    term.focus()

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      sub.dispose()
      ws.close()
      term.dispose()
    }
  }, [token, agent])

  return (
    <div className="fixed inset-0 z-[900] flex flex-col" style={{ background: '#111827' }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <span className="text-xs font-semibold" style={{ color: '#fbbf24' }}>
          {agent ? t('rescue.agentTitle') : t('rescue.shellTitle')} · {t('rescue.noTmux')}
        </span>
        <button className="bg-transparent border-none text-xs underline cursor-pointer p-1" style={{ color: '#9ca3af' }} onClick={onClose}>
          {t('rescue.close')}
        </button>
      </div>
      <div ref={holderRef} className="flex-1 min-h-0" />
    </div>
  )
}
