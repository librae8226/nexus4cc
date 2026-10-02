import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 操作日志（Settings → 操作日志）。
 *
 * 解决的问题（2026-10-02 排查实录）：session 莫名其妙消失时，分不清是「面板上有人点的」、
 * 「shell 里直接敲 tmux 删的」还是「系统自己动的手」，而 pm2 日志连时间戳都没有。
 * 现在两层记账：
 *   · 经 Nexus 的变更带 actor（IP + 设备），记成 by=手机 / by=浏览器 / by=脚本；
 *   · 每 60s 对账 tmux 清单，发现增减记一条，via=api 是面板干的、
 *     via=unknown(命令行/外部) 就是「有人在 shell 里直接动过」。
 */
interface AuditEntry {
  ts: string
  action: string
  target?: string
  via?: string
  result?: string
  note?: string
  detail?: string
  name?: string
  channel?: string
  cwd?: string
  windows?: number
  sessions?: string
  from?: number
  to?: number
  actor?: { ip?: string; device?: string }
}

function fmtLine(e: AuditEntry): string {
  const t = e.ts ? new Date(e.ts).toLocaleTimeString() : '--:--:--'
  const parts = [t, e.action]
  if (e.target) parts.push(`target=${e.target}`)
  if (e.name) parts.push(`name=${e.name}`)
  if (e.channel) parts.push(`channel=${e.channel}`)
  if (e.windows !== undefined) parts.push(`windows=${e.windows}`)
  if (e.from !== undefined) parts.push(`from=${e.from}→${e.to}`)
  if (e.via) parts.push(`via=${e.via}`)
  if (e.result) parts.push(e.result)
  if (e.actor?.device) parts.push(`by=${e.actor.device}`)
  if (e.sessions) parts.push(`sessions=[${e.sessions}]`)
  if (e.detail) parts.push(`(${String(e.detail).slice(0, 120)})`)
  return parts.join(' · ')
}

export default function AuditLog({ token }: { token: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<AuditEntry[]>([])

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/audit?lines=150', { headers: { Authorization: `Bearer ${token}` } })
      if (r.ok) setLines(((await r.json()).lines || []) as AuditEntry[])
    } catch { /* 拿不到就保持原样 */ } finally {
      setBusy(false)
    }
  }, [token])

  useEffect(() => { if (open) load() }, [open, load])

  return (
    <div className="border-t border-nexus-border pt-4">
      <button
        className="flex items-center gap-1.5 bg-transparent border-none text-nexus-text-2 text-[11px] tracking-wider uppercase cursor-pointer p-0"
        onPointerDown={() => setOpen(!open)}
      >
        {t('audit.title')} {open ? '▲' : '▼'}
      </button>

      {open && (
        <div className="mt-3">
          <div className="flex items-center gap-3 mb-2">
            <button
              className="bg-transparent border border-nexus-border rounded-md text-nexus-text text-xs px-2.5 py-1.5 cursor-pointer disabled:opacity-40"
              onPointerDown={load}
              disabled={busy}
            >
              {busy ? t('audit.loading') : t('audit.refresh')}
            </button>
            <span className="text-[11px] text-nexus-text-2">{t('audit.hint')}</span>
          </div>
          <pre className="m-0 max-h-72 overflow-auto bg-nexus-surface border border-nexus-border rounded-md p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-nexus-text-2">
            {lines.length === 0
              ? t('audit.empty')
              : lines.slice().reverse().map((e) => fmtLine(e)).join('\n')}
          </pre>
        </div>
      )}
    </div>
  )
}
