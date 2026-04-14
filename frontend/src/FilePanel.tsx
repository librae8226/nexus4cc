import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './icons'

type SortKey = 'name' | 'modified' | 'size'

interface FileItem {
  name: string
  url: string
  fullPath: string
  size: number
  created: number
}

interface FileGroup {
  date: string
  files: FileItem[]
}

interface Props {
  token: string
  session: string
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function useFormatDate() {
  const { t } = useTranslation()
  return (dateStr: string): string => {
    const today = new Date().toISOString().slice(0, 10)
    if (dateStr === today) return t('common.today')
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (dateStr === yesterday) return t('common.yesterday')
    return dateStr
  }
}

export default function FilePanel({ token, session, onClose }: Props) {
  const { t } = useTranslation()
  const formatDate = useFormatDate()
  const [groups, setGroups] = useState<FileGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortAsc, setSortAsc] = useState(false)

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(a => !a)
    } else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  const sortedFiles = useMemo(() => {
    if (!sortKey) return null
    const flat = groups.flatMap(g => g.files.map(f => ({ ...f, date: g.date })))
    return [...flat].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortKey === 'modified') cmp = a.created - b.created
      else if (sortKey === 'size') cmp = a.size - b.size
      return sortAsc ? cmp : -cmp
    })
  }, [groups, sortKey, sortAsc])

  const fetchFiles = useCallback(async () => {
    try {
      const r = await fetch(`/api/files?session=${encodeURIComponent(session)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (r.ok) {
        const data = await r.json()
        setGroups(data)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    fetchFiles()
    // 每 10 秒刷新一次
    const interval = setInterval(fetchFiles, 10000)
    return () => clearInterval(interval)
  }, [fetchFiles])

  async function copyToClipboard(url: string, fullPath: string) {
    const textToCopy = fullPath
    let success = false

    // 尝试现代 Clipboard API
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(textToCopy)
        success = true
      } catch {
        // fall through to legacy method
      }
    }

    // 降级方案：使用 execCommand
    if (!success) {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = textToCopy
        textarea.style.cssText = 'position:fixed;left:-9999px;opacity:0;'
        document.body.appendChild(textarea)
        textarea.select()
        textarea.setSelectionRange(0, textToCopy.length)
        success = document.execCommand('copy')
        document.body.removeChild(textarea)
      } catch {
        // 最终失败
      }
    }

    if (success) {
      setCopiedUrl(url)
      setTimeout(() => setCopiedUrl(null), 2000)
    } else {
      // 如果都失败了，至少选中文字让用户手动复制
      alert(t('files.manualCopy', { text: textToCopy }))
    }
  }

  async function deleteFile(fullPath: string, filename: string) {
    if (!confirm(t('files.deleteConfirm', { filename }))) return
    try {
      const r = await fetch(`/api/files/content?path=${encodeURIComponent(fullPath)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (r.ok) {
        fetchFiles()
      }
    } catch {
      // ignore
    }
  }

  async function deleteAllFiles() {
    if (!confirm(t('files.deleteAllConfirm', { count: totalFiles }))) return
    try {
      const r = await fetch(`/api/files/all?session=${encodeURIComponent(session)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (r.ok) {
        fetchFiles()
      }
    } catch {
      // ignore
    }
  }

  const totalFiles = groups.reduce((sum, g) => sum + g.files.length, 0)

  return (
    <div className="fixed inset-0 z-[450] bg-nexus-bg flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <Icon name="folder" size={20} />
          <span className="text-nexus-text font-semibold text-base">
            {t('files.title')}
          </span>
          <span className="text-nexus-muted text-[13px] bg-nexus-bg-2 px-2 py-0.5 rounded-[10px]">
            {totalFiles}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {totalFiles > 0 && (
            <button
              onClick={deleteAllFiles}
              className="bg-transparent border border-nexus-error text-nexus-error cursor-pointer px-2.5 py-1.5 flex items-center gap-1 rounded-md text-xs font-medium transition-all duration-100 active:scale-95"
              title="清除所有文件"
            >
              <Icon name="trash" size={14} />
              {t('files.clearAll')}
            </button>
          )}
          <button
            onClick={onClose}
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1.5 flex items-center justify-center rounded-md"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
      </div>

      {/* Sort Bar */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-nexus-border flex-shrink-0">
        <span className="text-nexus-muted text-xs mr-0.5">{t('files.sortBy')}</span>
        {(['name', 'modified', 'size'] as SortKey[]).map(key => (
          <button
            key={key}
            onClick={() => handleSort(key)}
            className={`text-xs px-2 py-1 rounded-md flex items-center gap-0.5 transition-all duration-100 cursor-pointer border ${
              sortKey === key
                ? 'bg-nexus-accent border-nexus-accent text-white'
                : 'bg-transparent border-nexus-border text-nexus-text-2'
            }`}
          >
            {t(`files.sort.${key}`)}
            {sortKey === key && <span className="ml-0.5">{sortAsc ? '↑' : '↓'}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="text-nexus-muted text-center py-10 text-sm">
            {t('common.loading')}
          </div>
        ) : groups.length === 0 ? (
          <div className="text-nexus-muted text-center py-10 text-sm">
            <div className="text-5xl mb-3">📁</div>
            <div>{t('files.noFiles')}</div>
            <div className="text-xs mt-2 opacity-70">
              {t('files.dropHint')}
            </div>
          </div>
        ) : sortedFiles ? (
          <div className="bg-nexus-bg-2 rounded-lg border border-nexus-border overflow-hidden">
            {sortedFiles.map((file, idx) => {
              const fullPath = file.fullPath
              const isCopied = copiedUrl === file.url
              const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name)
              return (
                <div
                  key={`${file.date}/${file.name}`}
                  className={`flex items-center gap-2.5 px-3 py-2.5 ${idx < sortedFiles.length - 1 ? 'border-b border-nexus-border' : ''}`}
                >
                  <span className="text-base">{isImage ? '🖼️' : '📄'}</span>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-nexus-text text-[13px] overflow-hidden text-ellipsis whitespace-nowrap font-mono"
                      title={file.name}
                    >
                      {file.name}
                    </div>
                    <div className="text-nexus-muted text-[11px] mt-0.5">
                      {formatSize(file.size)} · {formatDate(file.date)}
                    </div>
                  </div>
                  <button
                    onClick={() => copyToClipboard(file.url, fullPath)}
                    className={`rounded-md cursor-pointer text-xs flex items-center gap-1 transition-all duration-150 ${isCopied ? 'bg-nexus-success border-none text-white px-2.5 py-1.5' : 'bg-transparent border border-nexus-border text-nexus-text-2 px-2.5 py-1.5'}`}
                    title={t('files.copyPath')}
                  >
                    <Icon name={isCopied ? 'check' : 'copy'} size={14} />
                    {isCopied ? t('common.copied') : t('common.copy')}
                  </button>
                  <button
                    onClick={() => deleteFile(file.fullPath, file.name)}
                    className="bg-transparent border-none text-nexus-error cursor-pointer p-1.5 flex items-center justify-center opacity-60"
                    title={t('common.delete')}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.date} className="mb-5">
              <div className="text-nexus-muted text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <span>{formatDate(group.date)}</span>
                <span className="opacity-50">({group.files.length})</span>
              </div>
              <div className="bg-nexus-bg-2 rounded-lg border border-nexus-border overflow-hidden">
                {group.files.map((file, idx) => {
                  const fullPath = file.fullPath
                  const isCopied = copiedUrl === file.url
                  const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name)
                  return (
                    <div
                      key={file.name}
                      className={`flex items-center gap-2.5 px-3 py-2.5 ${idx < group.files.length - 1 ? 'border-b border-nexus-border' : ''}`}
                    >
                      <span className="text-base">{isImage ? '🖼️' : '📄'}</span>
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-nexus-text text-[13px] overflow-hidden text-ellipsis whitespace-nowrap font-mono"
                          title={file.name}
                        >
                          {file.name}
                        </div>
                        <div className="text-nexus-muted text-[11px] mt-0.5">
                          {formatSize(file.size)}
                        </div>
                      </div>
                      <button
                        onClick={() => copyToClipboard(file.url, fullPath)}
                        className={`rounded-md cursor-pointer text-xs flex items-center gap-1 transition-all duration-150 ${isCopied ? 'bg-nexus-success border-none text-white px-2.5 py-1.5' : 'bg-transparent border border-nexus-border text-nexus-text-2 px-2.5 py-1.5'}`}
                        title={t('files.copyPath')}
                      >
                        <Icon name={isCopied ? 'check' : 'copy'} size={14} />
                        {isCopied ? t('common.copied') : t('common.copy')}
                      </button>
                      <button
                        onClick={() => deleteFile(file.fullPath, file.name)}
                        className="bg-transparent border-none text-nexus-error cursor-pointer p-1.5 flex items-center justify-center opacity-60"
                        title={t('common.delete')}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-3 border-t border-nexus-border text-nexus-muted text-xs text-center">
        {t('files.footerNote')}
      </div>
    </div>
  )
}
