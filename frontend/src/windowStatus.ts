export type WindowStatus = 'running' | 'waiting' | 'shell' | 'unknown'

export function getWindowStatus(data?: { output: string; idleMs: number; connected: boolean }): WindowStatus {
  if (!data || !data.connected) return 'unknown'
  if (data.idleMs < 4000) return 'running'
  const stripped = data.output.replace(/\x1b\[[0-9;]*[mGKHFJA-Za-z]/g, '').replace(/\r/g, '')
  const lines = stripped.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0)
  const lastLine = lines[lines.length - 1] || ''
  if (/[\$#]\s*$/.test(lastLine)) return 'shell'
  if (/[>?]\s*$/.test(lastLine)) return 'waiting'
  return 'waiting'
}

export const STATUS_DOT_COLOR: Record<WindowStatus, string> = {
  running: '#22c55e', waiting: '#f59e0b', shell: '#94a3b8', unknown: '#475569',
}

export const STATUS_DOT_TITLE: Record<WindowStatus, string> = {
  running: '运行中', waiting: '等待输入', shell: '已退出 shell', unknown: '未连接',
}
