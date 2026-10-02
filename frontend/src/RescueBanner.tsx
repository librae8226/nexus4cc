import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 救援横幅：tmux 不可用、或快照里有 session 没恢复回来时出现（最坏情况下的入口）。
 * 三条出路，都不依赖 tmux 里的会话：
 *   · 救援 shell —— 后端裸 PTY，直接给一个能敲命令的终端
 *   · recovery agent —— 同一个裸 PTY 里拉起带预置任务的 claude，让它自己去修
 *   · 一键救援 —— POST /api/rescue/run 跑 scripts/nexus-rescue.sh（零 root）
 */
interface RescueStatus {
  tmux: { state: string; up: boolean; socketDir: string; socketDirExists: boolean }
  unit: string
  snapshot: string | null
  snapshotTime: string | null
  claudeChannels: number
  missingSessions: number
  missingList: string[]
  busy: boolean
}

interface Props {
  token: string
  onOpenConsole: (agent: boolean) => void
}

export default function RescueBanner({ token, onOpenConsole }: Props) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RescueStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/rescue/status', { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) return
      setStatus((await r.json()) as RescueStatus)
    } catch { /* 网络抖动忽略，下次轮询再试 */ }
  }, [token])

  useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
  }, [load])

  const runRescue = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/rescue/run', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const data = (await r.json().catch(() => ({}))) as { output?: string; error?: string }
      setOutput(data.output || data.error || '')
      await load()
    } catch (e) {
      setOutput(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null
  const down = !status.tmux.up
  const missing = status.missingSessions > 0
  if (!down && !missing) return null

  return (
    <div className="flex-shrink-0 border-b px-3 py-2 text-xs" style={{ background: '#7c2d12', borderColor: '#f97316', color: '#fed7aa' }}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold">{t('rescue.title')}</span>
        <span className="flex-1 min-w-[12rem]">
          {down
            ? t('rescue.tmuxDown', { state: status.tmux.state, unit: status.unit })
            : t('rescue.missing', { n: status.missingSessions, list: status.missingList.join(', ') })}
        </span>
        <button className="bg-transparent border-none underline cursor-pointer p-0" style={{ color: '#fed7aa' }} onClick={() => onOpenConsole(false)}>
          {t('rescue.shell')}
        </button>
        <button className="bg-transparent border-none underline cursor-pointer p-0 font-semibold" style={{ color: '#fed7aa' }} onClick={() => onOpenConsole(true)}>
          {t('rescue.agent')}
        </button>
        <button className="bg-transparent border-none underline cursor-pointer p-0" style={{ color: '#fed7aa' }} disabled={busy} onClick={runRescue}>
          {busy ? t('rescue.running') : t('rescue.run')}
        </button>
      </div>
      {output && (
        <pre className="mt-2 mb-0 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] opacity-90">{output}</pre>
      )}
    </div>
  )
}
