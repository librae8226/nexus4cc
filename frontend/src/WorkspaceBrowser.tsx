import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Icon } from './icons'

interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mtime: number
}

interface Props {
  token: string
  onClose: () => void
  initialPath?: string
  currentSession?: string
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

export default function WorkspaceBrowser({ token, onClose, initialPath = '', currentSession }: Props) {
  const { t } = useTranslation()
  const [workspaceRoot, setWorkspaceRoot] = useState('')

  // 路径状态：null 表示正在初始化
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const headers = { Authorization: `Bearer ${token}` }

  // 初始化：获取 workspaceRoot 和初始路径
  useEffect(() => {
    let cancelled = false

    async function init() {
      // 1. 获取服务端配置
      let root = ''
      try {
        const r = await fetch('/api/config', { headers })
        if (r.ok) {
          const data = await r.json()
          root = data.workspaceRoot || ''
          if (!cancelled) setWorkspaceRoot(root)
        }
      } catch {
        // ignore
      }

      // 2. 确定初始路径（优先使用 initialPath，否则尝试 session cwd）
      let targetPath = initialPath
      if (!targetPath && currentSession) {
        try {
          const r = await fetch(`/api/session-cwd?session=${encodeURIComponent(currentSession)}`, { headers })
          if (r.ok) {
            const data = await r.json()
            targetPath = data?.cwd || root || '/'
          }
        } catch {
          // ignore
        }
      }
      if (!targetPath) targetPath = root || '/'

      if (!cancelled) {
        setCurrentPath(targetPath)
      }
    }

    init()
    return () => { cancelled = true }
  }, [currentSession, token, initialPath])

  // 选中条目
  const [selectedName, setSelectedName] = useState<string | null>(null)

  // 新建文件夹/文件对话框状态
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false)
  const [showNewFileDialog, setShowNewFileDialog] = useState(false)
  const [newItemName, setNewItemName] = useState('')
  const [newItemError, setNewItemError] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // 文件编辑器状态
  const [editingFile, setEditingFile] = useState<{ name: string; path: string; content: string } | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isPreviewMode, setIsPreviewMode] = useState(false)

  // 加载目录内容
  const loadEntries = useCallback(async (path: string) => {
    setLoading(true)
    setError('')
    setSelectedName(null) // 切换目录时清除选中
    try {
      const r = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`, { headers })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      // data.path 是服务端返回的规范化绝对路径
      setCurrentPath(data.path)
      setEntries(data.entries || [])
    } catch (e: any) {
      setError(e.message || 'Failed to load')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [token])

  // 当 currentPath 确定后加载内容
  useEffect(() => {
    if (currentPath !== null) {
      loadEntries(currentPath)
    }
  }, [currentPath, loadEntries])

  // 选中条目（单击）
  function handleSelect(name: string) {
    setSelectedName(name)
  }

  // 进入子目录
  function navigateTo(name: string) {
    if (!currentPath) return
    const newPath = currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`
    setCurrentPath(newPath)
  }

  // 返回上级
  function navigateUp() {
    if (!currentPath) return
    const idx = currentPath.lastIndexOf('/')
    if (idx <= 0) {
      setCurrentPath('/')
    } else {
      setCurrentPath(currentPath.slice(0, idx))
    }
  }

  // 获取文件的完整 URL（带上 token 用于浏览器直接访问）
  function getFileUrl(name: string): string {
    if (!currentPath || !workspaceRoot) return ''

    const filePath = currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`
    // 统一使用 /workspace?path=xxx 格式，避免不同路径格式问题
    return `/workspace?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`
  }

  // 打开文件（查看）
  function openFile(name: string) {
    const url = getFileUrl(name)
    if (url) window.open(url, '_blank')
  }

  // 下载文件
  function downloadFile(name: string) {
    const url = getFileUrl(name)
    if (!url) return

    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // 新建文件夹
  async function createFolder() {
    if (!newItemName.trim() || !currentPath) return
    setIsCreating(true)
    setNewItemError('')
    try {
      const r = await fetch('/api/workspace/mkdir', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name: newItemName.trim() }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to create folder')
      }
      setShowNewFolderDialog(false)
      setNewItemName('')
      loadEntries(currentPath)
    } catch (e: any) {
      setNewItemError(e.message || 'Failed to create folder')
    } finally {
      setIsCreating(false)
    }
  }

  // 新建文件
  async function createFile() {
    if (!newItemName.trim() || !currentPath) return
    setIsCreating(true)
    setNewItemError('')
    try {
      const r = await fetch('/api/workspace/files', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name: newItemName.trim(), content: '' }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to create file')
      }
      setShowNewFileDialog(false)
      setNewItemName('')
      loadEntries(currentPath)
    } catch (e: any) {
      setNewItemError(e.message || 'Failed to create file')
    } finally {
      setIsCreating(false)
    }
  }

  // 打开文件编辑器
  async function openEditor(name: string) {
    if (!currentPath) return
    const filePath = currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`
    try {
      const r = await fetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`, { headers })
      if (!r.ok) throw new Error('Failed to load file')
      const data = await r.json()
      setEditingFile({ name, path: filePath, content: data.content })
      setEditorContent(data.content)
      setIsPreviewMode(false)
    } catch (e: any) {
      setError(e.message || 'Failed to open file')
    }
  }

  // 保存文件
  async function saveFile() {
    if (!editingFile) return
    setIsSaving(true)
    try {
      const r = await fetch('/api/workspace/file', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editingFile.path, content: editorContent }),
      })
      if (!r.ok) throw new Error('Failed to save file')
      setEditingFile(null)
      setEditorContent('')
    } catch (e: any) {
      setError(e.message || 'Failed to save file')
    } finally {
      setIsSaving(false)
    }
  }

  // 双击处理：目录进入，文件在编辑器中打开
  function handleDoubleClick(entry: FileEntry) {
    if (entry.type === 'dir') {
      navigateTo(entry.name)
    } else {
      openEditor(entry.name)
    }
  }

  // 判断是否为文本文件
  function isTextFile(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const textExts = ['txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'json', 'yml', 'yaml', 'toml', 'css', 'html', 'htm', 'xml', 'svg', 'sh', 'bash', 'zsh', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'log', 'env', 'dockerfile', 'gitignore']
    return textExts.includes(ext) || !ext
  }

  // 判断是否为 Markdown 文件
  function isMarkdownFile(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() || ''
    return ext === 'md' || ext === 'markdown'
  }

  // 构建面包屑路径（使用绝对路径）
  const breadcrumbs = currentPath && currentPath !== '/' ? currentPath.split('/').filter(Boolean) : []

  // 跳转到指定面包屑路径
  function navigateToBreadcrumb(index: number) {
    const path = '/' + breadcrumbs.slice(0, index + 1).join('/')
    setCurrentPath(path)
  }

  // 检查是否有上级目录（简单判断：不是根目录且以 workspaceRoot 开头）
  const hasParent = currentPath !== '/' && currentPath !== ''

  // 排序：目录在前，文件在后，各自按名称排序
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'dir' ? -1 : 1
  })

  // 获取当前选中的文件条目
  const selectedEntry = selectedName && selectedName !== '..'
    ? sortedEntries.find(e => e.name === selectedName)
    : null

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
        {/* 根目录按钮 */}
        <button
          onClick={() => setCurrentPath('/')}
          className={`text-sm whitespace-nowrap ${currentPath === '/' ? 'text-nexus-accent font-medium' : 'text-nexus-text-2 hover:text-nexus-text'}`}
        >
          /
        </button>
        {/* 面包屑路径：每个片段前显示 / 分隔符 */}
        {breadcrumbs.length > 0 && breadcrumbs.map((crumb, idx) => (
          <span key={idx} className="flex items-center gap-1">
            {idx > 0 && <span className="text-nexus-muted">/</span>}
            <button
              onClick={() => navigateToBreadcrumb(idx)}
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
        ) : sortedEntries.length === 0 && !hasParent ? (
          <div className="text-nexus-muted text-center py-10 text-sm px-4">
            <div className="text-5xl mb-3">📂</div>
            <div>{t('workspace.empty')}</div>
          </div>
        ) : (
          <div className="divide-y divide-nexus-border">
            {/* 上级目录 */}
            {hasParent && (
              <button
                onClick={() => handleSelect('..')}
                onDoubleClick={navigateUp}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left ${
                  selectedName === '..' ? 'bg-nexus-bg-2' : 'hover:bg-nexus-bg-2'
                }`}
                title="Double-click to go up"
              >
                <span className="text-xl">⬆️</span>
                <span className="text-nexus-text text-sm">{t('workspace.parent')}</span>
              </button>
            )}
            {/* 目录和文件列表 */}
            {sortedEntries.map((entry) => (
              <button
                key={entry.name}
                onClick={() => handleSelect(entry.name)}
                onDoubleClick={() => handleDoubleClick(entry)}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left ${
                  selectedName === entry.name ? 'bg-nexus-bg-2' : 'hover:bg-nexus-bg-2'
                }`}
                title={entry.type === 'dir' ? 'Double-click to enter' : 'Double-click to open'}
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
      <div className="px-4 py-3 border-t border-nexus-border flex-shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-nexus-muted text-xs">
            {currentPath && t('workspace.footer', { count: entries.length })}
          </span>
          {/* 新建按钮 */}
          <div className="flex items-center gap-1.5 ml-2">
            <button
              onClick={() => setShowNewFolderDialog(true)}
              className="flex items-center gap-1 px-2 py-1.5 bg-nexus-bg-2 hover:bg-nexus-bg-2/80 text-nexus-text text-xs rounded border border-nexus-border transition-colors"
              title={t('workspace.newFolder')}
            >
              <Icon name="folder" size={14} />
              <span className="hidden sm:inline">{t('workspace.newFolder')}</span>
            </button>
            <button
              onClick={() => setShowNewFileDialog(true)}
              className="flex items-center gap-1 px-2 py-1.5 bg-nexus-bg-2 hover:bg-nexus-bg-2/80 text-nexus-text text-xs rounded border border-nexus-border transition-colors"
              title={t('workspace.newFile')}
            >
              <Icon name="file" size={14} />
              <span className="hidden sm:inline">{t('workspace.newFile')}</span>
            </button>
          </div>
        </div>
        {/* 文件操作按钮 */}
        {selectedEntry?.type === 'file' && (
          <div className="flex items-center gap-2">
            {isTextFile(selectedEntry.name) && (
              <button
                onClick={() => openEditor(selectedEntry.name)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-nexus-bg-2 hover:bg-nexus-bg-2/80 text-nexus-text text-xs rounded border border-nexus-border transition-colors"
                title={t('workspace.edit')}
              >
                <Icon name="edit" size={14} />
                <span className="hidden sm:inline">{t('workspace.edit')}</span>
              </button>
            )}
            <button
              onClick={() => openFile(selectedEntry.name)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-nexus-bg-2 hover:bg-nexus-bg-2/80 text-nexus-text text-xs rounded border border-nexus-border transition-colors"
              title={t('workspace.view')}
            >
              <Icon name="eye" size={14} />
              <span className="hidden sm:inline">{t('workspace.view')}</span>
            </button>
            <button
              onClick={() => downloadFile(selectedEntry.name)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-nexus-accent hover:bg-nexus-accent/90 text-white text-xs rounded transition-colors"
              title={t('workspace.download')}
            >
              <Icon name="download" size={14} />
              <span className="hidden sm:inline">{t('workspace.download')}</span>
            </button>
          </div>
        )}
      </div>

      {/* 新建文件夹对话框 */}
      {showNewFolderDialog && (
        <div className="fixed inset-0 z-[460] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-nexus-bg rounded-lg border border-nexus-border w-full max-w-sm p-4">
            <h3 className="text-nexus-text font-medium mb-3">{t('workspace.newFolder')}</h3>
            <input
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFolder()}
              placeholder={t('workspace.folderNamePlaceholder')}
              className="w-full px-3 py-2 bg-nexus-bg-2 border border-nexus-border rounded text-nexus-text text-sm focus:outline-none focus:border-nexus-accent"
              autoFocus
            />
            {newItemError && (
              <div className="text-nexus-error text-xs mt-2">{newItemError}</div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowNewFolderDialog(false); setNewItemName(''); setNewItemError('') }}
                className="px-3 py-1.5 text-nexus-text-2 text-sm hover:text-nexus-text"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={createFolder}
                disabled={!newItemName.trim() || isCreating}
                className="px-3 py-1.5 bg-nexus-accent text-white text-sm rounded disabled:opacity-50"
              >
                {isCreating ? t('common.creating') : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建文件对话框 */}
      {showNewFileDialog && (
        <div className="fixed inset-0 z-[460] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-nexus-bg rounded-lg border border-nexus-border w-full max-w-sm p-4">
            <h3 className="text-nexus-text font-medium mb-3">{t('workspace.newFile')}</h3>
            <input
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFile()}
              placeholder={t('workspace.fileNamePlaceholder')}
              className="w-full px-3 py-2 bg-nexus-bg-2 border border-nexus-border rounded text-nexus-text text-sm focus:outline-none focus:border-nexus-accent"
              autoFocus
            />
            <div className="text-nexus-muted text-xs mt-2">
              {t('workspace.fileExtensionsHint')}
            </div>
            {newItemError && (
              <div className="text-nexus-error text-xs mt-2">{newItemError}</div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowNewFileDialog(false); setNewItemName(''); setNewItemError('') }}
                className="px-3 py-1.5 text-nexus-text-2 text-sm hover:text-nexus-text"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={createFile}
                disabled={!newItemName.trim() || isCreating}
                className="px-3 py-1.5 bg-nexus-accent text-white text-sm rounded disabled:opacity-50"
              >
                {isCreating ? t('common.creating') : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 文件编辑器 */}
      {editingFile && (
        <div className="fixed inset-0 z-[470] bg-nexus-bg flex flex-col">
          {/* Editor Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-nexus-border flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Icon name="file" size={18} />
              <span className="text-nexus-text font-medium text-sm truncate">
                {editingFile.name}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveFile}
                disabled={isSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-nexus-accent hover:bg-nexus-accent/90 text-white text-xs rounded transition-colors disabled:opacity-50"
              >
                <Icon name="save" size={14} />
                {isSaving ? t('common.saving') : t('common.save')}
              </button>
              {editingFile && isMarkdownFile(editingFile.name) && (
                <button
                  onClick={() => setIsPreviewMode(!isPreviewMode)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors border ${
                    isPreviewMode
                      ? 'bg-nexus-accent text-white border-nexus-accent'
                      : 'bg-nexus-bg-2 text-nexus-text border-nexus-border hover:bg-nexus-bg-2/80'
                  }`}
                >
                  <Icon name="eye" size={14} />
                  {isPreviewMode ? t('workspace.edit') : t('workspace.preview')}
                </button>
              )}
              <button
                onClick={() => { setEditingFile(null); setEditorContent(''); setIsPreviewMode(false) }}
                className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1.5 flex items-center justify-center rounded-md"
              >
                <Icon name="x" size={20} />
              </button>
            </div>
          </div>
          {/* Editor Content */}
          <div className="flex-1 p-4 overflow-hidden">
            {editingFile && isMarkdownFile(editingFile.name) && isPreviewMode ? (
              <div className="w-full h-full bg-nexus-bg-2 border border-nexus-border rounded p-4 overflow-y-auto">
                <MarkdownPreview content={editorContent} />
              </div>
            ) : (
              <textarea
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                className="w-full h-full bg-nexus-bg-2 border border-nexus-border rounded p-3 text-nexus-text text-sm font-mono resize-none focus:outline-none focus:border-nexus-accent"
                spellCheck={false}
              />
            )}
          </div>
          {/* Editor Footer */}
          <div className="px-4 py-2 border-t border-nexus-border flex items-center justify-between text-xs text-nexus-muted">
            <span>{editorContent.length} {t('workspace.chars')}</span>
            <span>{editingFile.path}</span>
          </div>
        </div>
      )}
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

// Configure marked for GFM (tables, task lists, etc.)
marked.setOptions({
  gfm: true,
  breaks: true,
})

// Markdown preview component using marked + DOMPurify
function MarkdownPreview({ content }: { content: string }) {
  const rawHtml = marked.parse(content, { async: false }) as string
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'a', 'img', 'code', 'pre',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'input' // input for task lists
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
  })

  return (
    <div
      className="markdown-body prose prose-invert prose-sm max-w-none text-nexus-text
        [&_table]:w-full [&_table]:border-collapse [&_table]:my-3
        [&_th]:border [&_th]:border-nexus-border [&_th]:bg-nexus-bg-2 [&_th]:p-2 [&_th]:text-left [&_th]:text-nexus-text
        [&_td]:border [&_td]:border-nexus-border [&_td]:p-2 [&_td]:text-nexus-text
        [&_tr:nth-child(even)]:bg-nexus-bg-2/50
        [&_input[type='checkbox']]:mr-2 [&_input[type='checkbox']]:accent-nexus-accent"
      dangerouslySetInnerHTML={{ __html: cleanHtml }}
    />
  )
}
