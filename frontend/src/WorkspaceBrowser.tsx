import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './icons'

interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mtime: number
}

interface Props {
  token: string
  onClose: () => void
  initialPath?: string
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

export default function WorkspaceBrowser({ token, onClose, initialPath = '' }: Props) {
  const { t } = useTranslation()
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      setEntries(data.entries || [])
    } catch (e: any) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [token, path])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  function navigateTo(name: string) {
    const newPath = path ? `${path}/${name}` : name
    setPath(newPath)
  }

  function navigateUp() {
    if (!path) return
    const idx = path.lastIndexOf('/')
    if (idx === -1) {
      setPath('')
    } else {
      setPath(path.slice(0, idx))
    }
  }

  function openFile(name: string) {
    const filePath = path ? `/workspace/${path}/${name}` : `/workspace/${name}`
    window.open(filePath, '_blank')
  }

  // 构建面包屑路径
  const breadcrumbs = path ? path.split('/') : []

  return (
    <div className="fixed inset-0 z-[450] bg-nexus-bg flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon name="folder" size={20} />
          <span className="text-nexus-text font-semibold text-base truncate">
            {t('workspace.title')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1.5 flex items-center justify-center rounded-md shrink-0"
        >
          <Icon name="x" size={20} />
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-nexus-border bg-nexus-bg-2 flex-shrink-0 overflow-x-auto">
        <button
          onClick={() => setPath('')}
          className={`text-sm whitespace-nowrap ${path === '' ? 'text-nexus-accent font-medium' : 'text-nexus-text-2 hover:text-nexus-text'}`}
        >
          {t('workspace.root')}
        </button>
        {breadcrumbs.map((crumb, idx) => (
          <span key={idx} className="flex items-center gap-1">
            <span className="text-nexus-muted">/</span>
            <button
              onClick={() => setPath(breadcrumbs.slice(0, idx + 1).join('/'))}
              className={`text-sm whitespace-nowrap ${idx === breadcrumbs.length - 1 ? 'text-nexus-accent font-medium' : 'text-nexus-text-2 hover:text-nexus-text'}`}
            >
              {crumb}
            </button>
          </span>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="text-nexus-muted text-center py-10 text-sm">
            {t('common.loading')}
          </div>
        ) : error ? (
          <div className="text-nexus-error text-center py-10 text-sm px-4">
            <Icon name="alert" size={24} className="mx-auto mb-2 opacity-60" />
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="text-nexus-muted text-center py-10 text-sm px-4">
            <div className="text-5xl mb-3">📂</div>
            <div>{t('workspace.empty')}</div>
          </div>
        ) : (
          <div className="divide-y divide-nexus-border">
            {/* 上级目录 */}
            {path && (
              <button
                onClick={navigateUp}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-nexus-bg-2 transition-colors text-left"
              >
                <span className="text-xl">⬆️</span>
                <span className="text-nexus-text text-sm">{t('workspace.parent')}</span>
              </button>
            )}
            {/* 目录优先，按名称排序 */}
            {entries
              .sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name)
                return a.type === 'dir' ? -1 : 1
              })
              .map((entry) => (
                <button
                  key={entry.name}
                  onClick={() => entry.type === 'dir' ? navigateTo(entry.name) : openFile(entry.name)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-nexus-bg-2 transition-colors text-left"
                >
                  <span className="text-xl shrink-0">
                    {entry.type === 'dir' ? '📁' : getFileIcon(entry.name)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-nexus-text text-sm overflow-hidden text-ellipsis whitespace-nowrap font-mono">
                      {entry.name}
                    </div>
                  </div>
                  {entry.type === 'file' && entry.size !== undefined && (
                    <span className="text-nexus-muted text-xs shrink-0">
                      {formatSize(entry.size)}
                    </span>
                  )}
                  <span className="text-nexus-muted text-xs shrink-0">
                    {formatTime(entry.mtime)}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-nexus-border text-nexus-muted text-xs text-center flex-shrink-0">
        {t('workspace.footer', { count: entries.length })}
      </div>
    </div>
  )
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return '📄'
  const iconMap: Record<string, string> = {
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
    py: '🐍', go: '🔵', rs: '🦀', java: '☕',
    c: '🔧', cpp: '🔧', h: '🔧', hpp: '🔧',
    json: '📋', yml: '📋', yaml: '📋', toml: '📋',
    md: '📝', txt: '📝', log: '📝',
    html: '🌐', css: '🎨', svg: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
    zip: '📦', tar: '📦', gz: '📦', rar: '📦',
    sh: '⚙️', bash: '⚙️', zsh: '⚙️',
    dockerfile: '🐳', env: '🔐',
  }
  return iconMap[ext] || '📄'
}
