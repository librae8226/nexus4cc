import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Task {
  id: string
  session_name: string
  prompt: string
  status: 'success' | 'error' | 'running'
  output?: string
  error?: string
  createdAt: string
  completedAt?: string
  exitCode?: number
  source?: string
}

interface Props {
  token: string
  windows: { index: number; name: string; active: boolean }[]
  activeWindowName: string
  tmuxSession: string
  onClose: () => void
}

export default function TaskPanel({ token, windows, activeWindowName, tmuxSession, onClose }: Props) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<Task[]>([])
  const [prompt, setPrompt] = useState('')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [streamOutput, setStreamOutput] = useState('')
  const [sessionName, setSessionName] = useState(activeWindowName)
  const outputRef = useRef<HTMLPreElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(fetchTasks, 5000)
    return () => clearInterval(interval)
  }, [])

  // 首次打开面板时申请通知权限（仅在未决定时）
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [streamOutput])

  async function fetchTasks() {
    try {
      const r = await fetch('/api/tasks', { headers: { Authorization: `Bearer ${token}` } })
      if (r.ok) setTasks(await r.json())
    } catch { /* ignore */ }
  }

  async function deleteTask(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setTasks(prev => prev.filter(t => t.id !== id))
      if (selectedTask?.id === id) setSelectedTask(null)
    } catch { /* ignore */ }
  }

  async function runTask() {
    if (!prompt.trim() || isRunning) return
    setIsRunning(true)
    setStreamOutput('')
    setSelectedTask(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_name: sessionName, prompt: prompt.trim(), tmux_session: tmuxSession }),
        signal: controller.signal,
      })
      if (!r.ok || !r.body) {
        setStreamOutput(t('tasks.requestFailed', { status: r.status }))
        setIsRunning(false)
        return
      }

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let fullOutput = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const ev = JSON.parse(line.slice(6))
              if (ev.chunk !== undefined) {
                fullOutput += ev.chunk
                setStreamOutput(prev => prev + ev.chunk)
              }
            } catch { /* ignore */ }
          }
        }
      }

      // 任务完成后推送浏览器通知（当标签页不在前台时）
      if (!document.hasFocus() && 'Notification' in window && Notification.permission === 'granted') {
        // 取输出最后一个有内容的行作为通知摘要
        const lastLine = fullOutput.trim().split('\n').filter(l => l.trim()).pop() || prompt.trim()
        new Notification(t('tasks.notificationTitle'), {
          body: lastLine.slice(0, 100),
          icon: '/icon.svg',
        })
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setStreamOutput('错误: ' + e.message)
      }
    }

    abortRef.current = null
    setIsRunning(false)
    setPrompt('')
    fetchTasks()
  }

  // Keep selectedTask fresh with latest data from polling
  const activeTask = selectedTask ? (tasks.find(t => t.id === selectedTask.id) ?? selectedTask) : null

  return (
    <div className="fixed inset-0 bg-black/40 z-[300] flex items-stretch justify-end">
      <GhostShield />
      <div className="w-[440px] max-w-[100vw] bg-nexus-bg border-l border-nexus-border flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nexus-border shrink-0">
          <span className="flex items-center gap-2 text-nexus-text text-[15px] font-semibold"><Icon name="clipboard" size={20} />{t('tasks.title')}</span>
          <button className="flex items-center justify-center bg-transparent border-none text-nexus-text-2 text-2xl cursor-pointer p-0 leading-none" onClick={onClose}><Icon name="x" size={20} /></button>
        </div>

        {/* Session selector */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-nexus-border shrink-0">
          <span className="text-nexus-text-2 text-[13px] shrink-0">{t('tasks.session')}</span>
          <select
            className="flex-1 bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text px-2 py-1 text-[13px] font-mono cursor-pointer"
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
          >
            {windows.map(w => (
              <option key={w.index} value={w.name}>{w.index}: {w.name}</option>
            ))}
          </select>
        </div>

        {/* Prompt input */}
        <div className="px-5 py-3 border-b border-nexus-border flex flex-col gap-2 shrink-0">
          <textarea
            className="bg-nexus-bg-2 border border-nexus-border rounded-lg text-nexus-text px-3 py-2.5 text-[13px] font-mono resize-none outline-none leading-relaxed"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t('tasks.promptPlaceholder')}
            rows={4}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                runTask()
              }
            }}
          />
          <div className="flex gap-2 self-end">
            {isRunning && (
              <button
                className="bg-nexus-error border-none rounded-md text-white cursor-pointer text-[13px] font-semibold px-4 py-2 self-end transition-opacity duration-200 flex items-center gap-1"
                onClick={() => abortRef.current?.abort()}
              >
                <Icon name="x" size={14} /> {t('common.cancel')}
              </button>
            )}
            <button
              className={`bg-nexus-accent border-none rounded-md text-white cursor-pointer text-[13px] font-semibold px-4 py-2 self-end transition-opacity duration-200 ${isRunning || !prompt.trim() ? 'opacity-50' : 'opacity-100'}`}
              onClick={runTask}
              disabled={isRunning || !prompt.trim()}
            >
              {isRunning ? t('tasks.running') : t('tasks.sendTask')}
            </button>
          </div>
        </div>

        {/* Output area */}
        {(isRunning || streamOutput) && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-2 border-b border-nexus-border shrink-0">
              {isRunning && <span className="w-2 h-2 rounded-full bg-nexus-success animate-spin shrink-0" />}
              <span className="text-nexus-text-2 text-xs font-mono">{isRunning ? t('tasks.runningStatus') : t('tasks.output')}</span>
            </div>
            <pre ref={outputRef} className="flex-1 m-0 px-5 py-3 text-nexus-text text-xs font-mono overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{streamOutput || ' '}</pre>
          </div>
        )}

        {/* Task history */}
        {!isRunning && !streamOutput && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-5 py-2 text-nexus-text-2 text-xs font-semibold border-b border-nexus-border shrink-0">{t('tasks.history')}</div>
            {tasks.length === 0 ? (
              <div className="p-5 text-nexus-muted text-[13px] text-center">{t('tasks.noTasks')}</div>
            ) : (
              <div className="overflow-y-auto flex-1">
                {tasks.map(task => (
                  <div
                    key={task.id}
                    className={`flex items-center gap-2 px-5 py-2.5 cursor-pointer border-b border-nexus-border transition-colors duration-150 ${activeTask?.id === task.id ? 'bg-nexus-tab-active' : ''}`}
                    onClick={() => setSelectedTask(activeTask?.id === task.id ? null : task)}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.status === 'success' ? 'bg-nexus-success' : task.status === 'running' ? 'bg-nexus-warning animate-pulse' : 'bg-nexus-error'}`} />
                    <span className="flex-1 text-nexus-text text-[13px] font-mono overflow-hidden text-ellipsis whitespace-nowrap" title={task.prompt}>{task.prompt.slice(0, 60)}{task.prompt.length > 60 ? '...' : ''}</span>
                    {task.source === 'telegram' && <span className="bg-nexus-accent text-white text-[9px] font-bold px-1 rounded-[3px] shrink-0 tracking-wider">TG</span>}
                    <span className="text-nexus-muted text-[11px] shrink-0">{task.session_name}</span>
                    <button className="flex items-center justify-center bg-transparent border-none text-nexus-muted cursor-pointer text-[11px] px-0.5 shrink-0 leading-none opacity-60" onClick={(e) => deleteTask(task.id, e)} title={t('common.delete')}><Icon name="x" size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Selected task output */}
        {activeTask && !isRunning && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-2 border-b border-nexus-border shrink-0">
              {activeTask.status === 'running' && <span className="w-2 h-2 rounded-full bg-nexus-success animate-spin shrink-0" />}
              <span className="text-nexus-text-2 text-xs font-mono">
                {activeTask.session_name} — {activeTask.status === 'running' ? t('tasks.runningStatus') : activeTask.status}
                {activeTask.source === 'telegram' ? ' · TG' : ''}
              </span>
              <div className="flex gap-1 ml-auto">
                {activeTask.status !== 'running' && (
                  <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-[13px] px-1 py-0.5 leading-none rounded" title="重新执行" onClick={() => {
                    setPrompt(activeTask.prompt)
                    setSelectedTask(null)
                  }}>↩</button>
                )}
                <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-[13px] px-1 py-0.5 leading-none rounded" title="复制输出" onClick={() => {
                  const text = activeTask.output || activeTask.error || ''
                  if (text) navigator.clipboard.writeText(text).catch(() => {})
                }}>⎘</button>
              </div>
            </div>
            <pre className="flex-1 m-0 px-5 py-3 text-nexus-text text-xs font-mono overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{activeTask.output || activeTask.error || (activeTask.status === 'running' ? t('tasks.waitingOutput') : t('tasks.noOutput'))}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
