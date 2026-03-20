import { useState, useEffect, useRef } from 'react'

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
        setStreamOutput('请求失败: ' + r.status)
        setIsRunning(false)
        return
      }

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

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
                setStreamOutput(prev => prev + ev.chunk)
              }
            } catch { /* ignore */ }
          }
        }
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
    // 任务完成后推送浏览器通知（当标签页不在前台时）
    if (!document.hasFocus() && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Nexus: 任务完成', {
        body: prompt.trim().slice(0, 80),
        icon: '/icons/icon-192.png',
      })
    }
  }

  // Keep selectedTask fresh with latest data from polling
  const activeTask = selectedTask ? (tasks.find(t => t.id === selectedTask.id) ?? selectedTask) : null

  return (
    <div style={s.overlay}>
      <div style={s.panel}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.title}>📋 任务面板</span>
          <button style={s.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* Session selector */}
        <div style={s.sessionRow}>
          <span style={s.label}>会话:</span>
          <select
            style={s.select}
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
          >
            {windows.map(w => (
              <option key={w.index} value={w.name}>{w.index}: {w.name}</option>
            ))}
          </select>
        </div>

        {/* Prompt input */}
        <div style={s.inputSection}>
          <textarea
            style={s.textarea}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="输入任务 prompt，claude -p 非交互执行..."
            rows={4}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                runTask()
              }
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end' }}>
            {isRunning && (
              <button
                style={{ ...s.sendBtn, background: '#ef4444' }}
                onClick={() => abortRef.current?.abort()}
              >
                ✕ 取消
              </button>
            )}
            <button
              style={{ ...s.sendBtn, opacity: isRunning || !prompt.trim() ? 0.5 : 1 }}
              onClick={runTask}
              disabled={isRunning || !prompt.trim()}
            >
              {isRunning ? '执行中...' : '▶ 发送任务'}
            </button>
          </div>
        </div>

        {/* Output area */}
        {(isRunning || streamOutput) && (
          <div style={s.outputSection}>
            <div style={s.outputHeader}>
              {isRunning && <span style={s.runningDot} />}
              <span style={s.outputLabel}>{isRunning ? '执行中' : '输出'}</span>
            </div>
            <pre ref={outputRef} style={s.output}>{streamOutput || ' '}</pre>
          </div>
        )}

        {/* Task history */}
        {!isRunning && !streamOutput && (
          <div style={s.historySection}>
            <div style={s.historyHeader}>历史任务</div>
            {tasks.length === 0 ? (
              <div style={s.empty}>暂无任务记录</div>
            ) : (
              <div style={s.taskList}>
                {tasks.map(task => (
                  <div
                    key={task.id}
                    style={{
                      ...s.taskItem,
                      ...(activeTask?.id === task.id ? s.taskItemActive : {}),
                    }}
                    onClick={() => setSelectedTask(activeTask?.id === task.id ? null : task)}
                  >
                    <span style={{
                      ...s.statusDot,
                      background: task.status === 'success' ? '#22c55e' : task.status === 'running' ? '#f59e0b' : '#ef4444',
                      ...(task.status === 'running' ? { animation: 'spin 1.5s linear infinite' } : {}),
                    }} />
                    <span style={s.taskPrompt}>{task.prompt.slice(0, 60)}{task.prompt.length > 60 ? '...' : ''}</span>
                    {task.source === 'telegram' && <span style={s.sourceBadge}>TG</span>}
                    <span style={s.taskSession}>{task.session_name}</span>
                    <button style={s.deleteBtn} onClick={(e) => deleteTask(task.id, e)} title="删除">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Selected task output */}
        {activeTask && !isRunning && (
          <div style={s.outputSection}>
            <div style={s.outputHeader}>
              {activeTask.status === 'running' && <span style={s.runningDot} />}
              <span style={s.outputLabel}>
                {activeTask.session_name} — {activeTask.status === 'running' ? '执行中' : activeTask.status}
                {activeTask.source === 'telegram' ? ' · TG' : ''}
              </span>
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {activeTask.status !== 'running' && (
                  <button style={s.iconAction} title="重新执行" onClick={() => {
                    setPrompt(activeTask.prompt)
                    setSelectedTask(null)
                  }}>↩</button>
                )}
                <button style={s.iconAction} title="复制输出" onClick={() => {
                  const text = activeTask.output || activeTask.error || ''
                  if (text) navigator.clipboard.writeText(text).catch(() => {})
                }}>⎘</button>
              </div>
            </div>
            <pre style={s.output}>{activeTask.output || activeTask.error || (activeTask.status === 'running' ? '等待输出...' : '(无输出)')}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 300,
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'flex-end',
  },
  panel: {
    width: 440,
    maxWidth: '100vw',
    background: 'var(--nexus-bg)',
    borderLeft: '1px solid var(--nexus-border)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  title: {
    color: 'var(--nexus-text)',
    fontSize: 15,
    fontWeight: 600,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text2)',
    fontSize: 24,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
  },
  sessionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 20px',
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  label: {
    color: 'var(--nexus-text2)',
    fontSize: 13,
    flexShrink: 0,
  },
  select: {
    flex: 1,
    background: 'var(--nexus-bg2)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 6,
    color: 'var(--nexus-text)',
    padding: '4px 8px',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, monospace',
    cursor: 'pointer',
  },
  inputSection: {
    padding: '12px 20px',
    borderBottom: '1px solid var(--nexus-border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flexShrink: 0,
  },
  textarea: {
    background: 'var(--nexus-bg2)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 8,
    color: 'var(--nexus-text)',
    padding: '10px 12px',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, monospace',
    resize: 'none',
    outline: 'none',
    lineHeight: 1.5,
  },
  sendBtn: {
    background: '#3b82f6',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
    alignSelf: 'flex-end',
    transition: 'opacity 0.2s',
  },
  outputSection: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  outputHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 20px',
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  runningDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#22c55e',
    animation: 'spin 1s linear infinite',
    flexShrink: 0,
  },
  outputLabel: {
    color: 'var(--nexus-text2)',
    fontSize: 12,
    fontFamily: 'Menlo, Monaco, monospace',
  },
  output: {
    flex: 1,
    margin: 0,
    padding: '12px 20px',
    color: 'var(--nexus-text)',
    fontSize: 12,
    fontFamily: 'Menlo, Monaco, monospace',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.5,
  },
  historySection: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  historyHeader: {
    padding: '8px 20px',
    color: 'var(--nexus-text2)',
    fontSize: 12,
    fontWeight: 600,
    borderBottom: '1px solid var(--nexus-border)',
    flexShrink: 0,
  },
  empty: {
    padding: '20px',
    color: 'var(--nexus-muted)',
    fontSize: 13,
    textAlign: 'center',
  },
  taskList: {
    overflowY: 'auto',
    flex: 1,
  },
  taskItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 20px',
    cursor: 'pointer',
    borderBottom: '1px solid var(--nexus-border)',
    transition: 'background 0.15s',
  },
  taskItemActive: {
    background: 'var(--nexus-tab-active)',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  taskPrompt: {
    flex: 1,
    color: 'var(--nexus-text)',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  taskSession: {
    color: 'var(--nexus-muted)',
    fontSize: 11,
    flexShrink: 0,
  },
  sourceBadge: {
    background: '#2563eb',
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 4px',
    borderRadius: 3,
    flexShrink: 0,
    letterSpacing: 0.5,
  },
  deleteBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-muted)',
    cursor: 'pointer',
    fontSize: 11,
    padding: '0 2px',
    flexShrink: 0,
    lineHeight: 1,
    opacity: 0.6,
  },
  iconAction: {
    background: 'transparent',
    border: 'none',
    color: 'var(--nexus-text2)',
    cursor: 'pointer',
    fontSize: 13,
    padding: '2px 4px',
    lineHeight: 1,
    borderRadius: 4,
  },
}
