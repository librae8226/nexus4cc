import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
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
  const [sizesReady, setSizesReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

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

  // 编辑器字体大小（双指缩放调整）
  const [editorFontSize, setEditorFontSize] = useState(14) // 基础 14px
  const [pinchStartDist, setPinchStartDist] = useState(0)
  const [pinchStartFontSize, setPinchStartFontSize] = useState(14)

  // 长按 / 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)

  // 重命名对话框状态
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

  // 复制 / 移动目标目录选择器状态
  const [pickerMode, setPickerMode] = useState<'copy' | 'move' | null>(null)
  const [pickerSource, setPickerSource] = useState<FileEntry | null>(null)
  const [pickerPath, setPickerPath] = useState<string | null>(null)
  const [pickerEntries, setPickerEntries] = useState<FileEntry[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)

  // 加载目录内容
  const loadEntries = useCallback(async (path: string) => {
    // 取消上一个未完成的请求
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setLoading(true)
    setError('')
    setSizesReady(false)
    setSelectedName(null) // 切换目录时清除选中
    try {
      const r = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`, {
        headers,
        signal: ctrl.signal,
      })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      // data.path 是服务端返回的规范化绝对路径
      setCurrentPath(data.path)
      // Phase 1：先用 mtime 渲染列表（size 列占位）
      setEntries((data.entries || []).map((e: FileEntry) => ({ ...e, size: undefined })))
      setLoading(false)
      // Phase 2：空闲帧批量填入 size
      const allEntries: FileEntry[] = data.entries || []
      requestIdleCallback(() => {
        if (ctrl.signal.aborted) return
        setEntries(allEntries)
        setSizesReady(true)
      })
    } catch (e: any) {
      if ((e as any).name === 'AbortError') return
      setError(e.message || 'Failed to load')
      setEntries([])
      setLoading(false)
    }
  }, [token])

  // 当 currentPath 确定后加载内容
  useEffect(() => {
    if (currentPath !== null) {
      loadEntries(currentPath)
    }
  }, [currentPath, loadEntries])

  // 获取某一条目的完整路径
  function getEntryPath(name: string): string {
    if (!currentPath) return ''
    return currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`
  }

  // 加载目标目录选择器内容（只保留目录）
  const loadPickerEntries = useCallback(async (path: string) => {
    setPickerLoading(true)
    try {
      const r = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`, { headers })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      const dirs = (data.entries || []).filter((e: FileEntry) => e.type === 'dir')
      setPickerPath(data.path)
      setPickerEntries(dirs)
    } catch {
      setPickerEntries([])
    } finally {
      setPickerLoading(false)
    }
  }, [token])

  // 当 pickerPath 变化时加载目录
  useEffect(() => {
    if (pickerPath !== null) {
      loadPickerEntries(pickerPath)
    }
  }, [pickerPath, loadPickerEntries])

  // 重命名
  function openRename(entry: FileEntry) {
    setRenameTarget(entry)
    setRenameName(entry.name)
    setRenameError('')
    setShowRenameDialog(true)
  }

  async function doRename() {
    if (!renameTarget || !renameName.trim() || !currentPath) return
    setIsRenaming(true)
    setRenameError('')
    try {
      const r = await fetch('/api/workspace/rename', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: getEntryPath(renameTarget.name), newName: renameName.trim() }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to rename')
      }
      setShowRenameDialog(false)
      setRenameTarget(null)
      setRenameName('')
      loadEntries(currentPath)
    } catch (e: any) {
      setRenameError(e.message || 'Failed to rename')
    } finally {
      setIsRenaming(false)
    }
  }

  // 删除
  async function deleteEntry(entry: FileEntry) {
    if (!confirm(t('workspace.deleteConfirm', { name: entry.name }))) return
    try {
      const r = await fetch('/api/workspace/entry', {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: getEntryPath(entry.name) }),
      })
      if (r.ok && currentPath) {
        loadEntries(currentPath)
      }
    } catch {
      // ignore
    }
  }

  // 复制路径到剪贴板
  async function copyEntryPath(entry: FileEntry) {
    const text = getEntryPath(entry.name)
    let success = false
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        success = true
      } catch {}
    }
    if (!success) {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.cssText = 'position:fixed;left:-9999px;opacity:0;'
        document.body.appendChild(textarea)
        textarea.select()
        success = document.execCommand('copy')
        document.body.removeChild(textarea)
      } catch {}
    }
    if (!success) {
      alert(t('files.manualCopy', { text }))
    }
  }

  // 打开复制 / 移动目录选择器
  function openPicker(mode: 'copy' | 'move', entry: FileEntry) {
    setPickerMode(mode)
    setPickerSource(entry)
    setPickerPath(currentPath)
  }

  async function performCopyMove() {
    if (!pickerMode || !pickerSource || !pickerPath) return
    const targetPath = pickerPath.endsWith('/') ? `${pickerPath}${pickerSource.name}` : `${pickerPath}/${pickerSource.name}`
    const sourcePath = getEntryPath(pickerSource.name)
    try {
      const r = await fetch(`/api/workspace/${pickerMode}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath, targetPath }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || 'Failed')
      }
      setPickerMode(null)
      setPickerSource(null)
      setPickerPath(null)
      if (currentPath) loadEntries(currentPath)
    } catch {
      // ignore
    }
  }

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
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // 下载文件
  function downloadFile(name: string) {
    const url = getFileUrl(name)
    if (!url) return
    const dlUrl = url + '&dl=1'
    const a = document.createElement('a')
    a.href = dlUrl
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

  // 双指缩放：计算两点间距离
  function getPinchDistance(touches: React.TouchList | globalThis.TouchList): number {
    if (touches.length !== 2) return 0
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  // 触摸开始：初始化双指缩放
  function handleEditorTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      const dist = getPinchDistance(e.touches)
      setPinchStartDist(dist)
      setPinchStartFontSize(editorFontSize)
    }
  }

  // 触摸移动：处理双指缩放（调整字体大小）
  function handleEditorTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && pinchStartDist > 0) {
      e.preventDefault()
      const currentDist = getPinchDistance(e.touches)
      const ratio = currentDist / pinchStartDist
      // 字体范围 8px - 32px，按 sqrt 曲线让手感更自然
      const newSize = Math.max(8, Math.min(32, Math.round(pinchStartFontSize * Math.sqrt(ratio))))
      setEditorFontSize(newSize)
    }
  }

  // 触摸结束：清理状态
  function handleEditorTouchEnd() {
    setPinchStartDist(0)
  }

  // 重置字体大小
  function resetEditorFontSize() {
    setEditorFontSize(14)
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

  // 排序状态：默认按修改时间倒序
  const [sortKey, setSortKey] = useState<'name' | 'modified' | 'size'>('modified')
  const [sortAsc, setSortAsc] = useState(false)
  const [showSortMenu, setShowSortMenu] = useState(false)

  function handleSort(key: 'name' | 'modified' | 'size') {
    if (sortKey === key) {
      setSortAsc(a => !a)
    } else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  // 排序：目录在前，文件在后，各自按所选维度排序
  const sortedEntries = useMemo(() => {
    const dirs = entries.filter(e => e.type === 'dir')
    const files = entries.filter(e => e.type === 'file')
    const cmpFn = (a: FileEntry, b: FileEntry) => {
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortKey === 'modified') cmp = a.mtime - b.mtime
      else if (sortKey === 'size') cmp = (a.size ?? 0) - (b.size ?? 0)
      return sortAsc ? cmp : -cmp
    }
    return [...dirs.sort(cmpFn), ...files.sort(cmpFn)]
  }, [entries, sortKey, sortAsc])

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

      {/* Nav toolbar: 上级目录 + 排序 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-nexus-border flex-shrink-0">
        {hasParent ? (
          <button
            onClick={navigateUp}
            className="flex items-center gap-1.5 text-sm text-nexus-text-2 active:text-nexus-text cursor-pointer"
          >
            <span className="text-base">⬆️</span>
            <span>{t('workspace.parent')}</span>
          </button>
        ) : (
          <div />
        )}
        {/* 排序下拉按钮 */}
        <div className="relative">
          <button
            onClick={() => setShowSortMenu(m => !m)}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded border cursor-pointer transition-all duration-100 ${
              showSortMenu
                ? 'bg-nexus-accent border-nexus-accent text-white'
                : 'bg-transparent border-nexus-border text-nexus-text-2'
            }`}
          >
            <Icon name="sort" size={13} />
            <span>{t(`workspace.sort.${sortKey}`)}</span>
            <span>{sortAsc ? '↑' : '↓'}</span>
          </button>
          {showSortMenu && (
            <>
              <div className="fixed inset-0 z-[460]" onClick={() => setShowSortMenu(false)} />
              <div className="absolute right-0 top-full mt-1 z-[470] bg-nexus-bg border border-nexus-border rounded-lg shadow-lg py-1 min-w-[120px]">
                {(['name', 'modified', 'size'] as const).map(key => (
                  <button
                    key={key}
                    onClick={() => { handleSort(key); setShowSortMenu(false) }}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-nexus-bg-2 transition-colors cursor-pointer ${
                      sortKey === key ? 'text-nexus-accent' : 'text-nexus-text'
                    }`}
                  >
                    <span>{t(`workspace.sort.${key}`)}</span>
                    {sortKey === key && <span className="text-xs font-mono">{sortAsc ? '↑' : '↓'}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
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
            {/* 目录和文件列表 */}
            {sortedEntries.map((entry) => (
              <button
                key={entry.name}
                onClick={() => {
                  if (suppressClickRef.current) return
                  handleSelect(entry.name)
                }}
                onDoubleClick={() => handleDoubleClick(entry)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ x: e.clientX, y: e.clientY, entry })
                }}
                onTouchStart={(e) => {
                  if (e.touches.length !== 1) return
                  suppressClickRef.current = false
                  const t = e.touches[0]
                  touchStartRef.current = { x: t.clientX, y: t.clientY }
                  longPressTimerRef.current = window.setTimeout(() => {
                    suppressClickRef.current = true
                    setContextMenu({ x: t.clientX, y: t.clientY, entry })
                    touchStartRef.current = null
                  }, 600)
                }}
                onTouchMove={(e) => {
                  if (!touchStartRef.current || longPressTimerRef.current === null) return
                  const t = e.touches[0]
                  const dx = t.clientX - touchStartRef.current.x
                  const dy = t.clientY - touchStartRef.current.y
                  if (Math.sqrt(dx * dx + dy * dy) > 10) {
                    clearTimeout(longPressTimerRef.current)
                    longPressTimerRef.current = null
                    touchStartRef.current = null
                  }
                }}
                onTouchEnd={() => {
                  if (longPressTimerRef.current !== null) {
                    clearTimeout(longPressTimerRef.current)
                    longPressTimerRef.current = null
                  }
                  touchStartRef.current = null
                  if (suppressClickRef.current) {
                    window.setTimeout(() => {
                      suppressClickRef.current = false
                    }, 50)
                  }
                }}
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
                {entry.type === 'file' && (
                  <span className="text-nexus-muted text-xs shrink-0">
                    {sizesReady && entry.size !== undefined ? formatSize(entry.size) : '—'}
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

      {/* 长按 / 右键菜单 */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-[480]" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-[490] bg-nexus-bg rounded-lg border border-nexus-border shadow-lg py-1 min-w-[148px]"
            style={{
              left: (typeof window !== 'undefined' && contextMenu.x + 160 > window.innerWidth)
                ? Math.max(8, contextMenu.x - 160)
                : contextMenu.x,
              top: (typeof window !== 'undefined' && contextMenu.y + 280 > window.innerHeight)
                ? Math.max(8, contextMenu.y - 280)
                : contextMenu.y,
            }}
          >
            <div className="px-3 py-1.5 text-nexus-text text-xs font-medium border-b border-nexus-border truncate" title={contextMenu.entry.name}>
              {contextMenu.entry.name}
            </div>
            {contextMenu.entry.type === 'file' && isTextFile(contextMenu.entry.name) && (
              <button
                onClick={() => { openEditor(contextMenu.entry.name); setContextMenu(null) }}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
              >
                <Icon name="edit" size={14} />
                {t('workspace.edit')}
              </button>
            )}
            {contextMenu.entry.type === 'file' && (
              <>
                <button
                  onClick={() => { openFile(contextMenu.entry.name); setContextMenu(null) }}
                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
                >
                  <Icon name="eye" size={14} />
                  {t('workspace.view')}
                </button>
                <button
                  onClick={() => { downloadFile(contextMenu.entry.name); setContextMenu(null) }}
                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
                >
                  <Icon name="download" size={14} />
                  {t('workspace.download')}
                </button>
                <button
                  onClick={() => { copyEntryPath(contextMenu.entry); setContextMenu(null) }}
                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
                >
                  <Icon name="clipboard" size={14} />
                  {t('workspace.copyPath')}
                </button>
              </>
            )}
            <button
              onClick={() => { openRename(contextMenu.entry); setContextMenu(null) }}
              className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
            >
              <Icon name="pencil" size={14} />
              {t('common.rename')}
            </button>
            <button
              onClick={() => { openPicker('copy', contextMenu.entry); setContextMenu(null) }}
              className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
            >
              <Icon name="copy" size={14} />
              {t('workspace.copyEntry')}
            </button>
            <button
              onClick={() => { openPicker('move', contextMenu.entry); setContextMenu(null) }}
              className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-text"
            >
              <Icon name="arrowRight" size={14} />
              {t('workspace.moveEntry')}
            </button>
            <div className="border-t border-nexus-border my-1" />
            <button
              onClick={() => { deleteEntry(contextMenu.entry); setContextMenu(null) }}
              className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-nexus-bg-2 transition-colors text-nexus-error"
            >
              <Icon name="trash" size={14} />
              {t('common.delete')}
            </button>
          </div>
        </>
      )}

      {/* 重命名对话框 */}
      {showRenameDialog && (
        <div className="fixed inset-0 z-[460] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-nexus-bg rounded-lg border border-nexus-border w-full max-w-sm p-4">
            <h3 className="text-nexus-text font-medium mb-3">{t('common.rename')}</h3>
            <input
              type="text"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doRename()}
              placeholder={t('workspace.fileNamePlaceholder')}
              className="w-full px-3 py-2 bg-nexus-bg-2 border border-nexus-border rounded text-nexus-text text-sm focus:outline-none focus:border-nexus-accent"
              autoFocus
            />
            {renameError && (
              <div className="text-nexus-error text-xs mt-2">{renameError}</div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowRenameDialog(false); setRenameTarget(null); setRenameName(''); setRenameError('') }}
                className="px-3 py-1.5 text-nexus-text-2 text-sm hover:text-nexus-text"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={doRename}
                disabled={!renameName.trim() || renameName.trim() === renameTarget?.name || isRenaming}
                className="px-3 py-1.5 bg-nexus-accent text-white text-sm rounded disabled:opacity-50"
              >
                {isRenaming ? t('common.loading') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 复制 / 移动目标目录选择器 */}
      {pickerMode && (
        <div className="fixed inset-0 z-[460] bg-nexus-bg flex flex-col">
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border flex-shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <Icon name="folder" size={20} />
              <span className="text-nexus-text font-semibold text-base truncate">
                {pickerMode === 'copy' ? t('workspace.copyEntry') : t('workspace.moveEntry')}
              </span>
            </div>
            <button
              onClick={() => { setPickerMode(null); setPickerSource(null); setPickerPath(null) }}
              className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1.5 flex items-center justify-center rounded-md shrink-0"
            >
              <Icon name="x" size={20} />
            </button>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-nexus-border bg-nexus-bg-2 flex-shrink-0 overflow-x-auto">
            <button
              onClick={() => setPickerPath('/')}
              className={`text-sm whitespace-nowrap ${pickerPath === '/' ? 'text-nexus-accent font-medium' : 'text-nexus-text-2 hover:text-nexus-text'}`}
            >
              /
            </button>
            {(pickerPath && pickerPath !== '/' ? pickerPath.split('/').filter(Boolean) : []).map((crumb, idx, arr) => (
              <span key={idx} className="flex items-center gap-1">
                {idx > 0 && <span className="text-nexus-muted">/</span>}
                <button
                  onClick={() => {
                    const path = '/' + arr.slice(0, idx + 1).join('/')
                    setPickerPath(path)
                  }}
                  className={`text-sm whitespace-nowrap ${idx === arr.length - 1 ? 'text-nexus-accent font-medium' : 'text-nexus-text-2 hover:text-nexus-text'}`}
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>

          {/* 选择当前目录按钮 */}
          <div className="px-4 py-3 border-b border-nexus-border flex-shrink-0">
            <button
              onClick={performCopyMove}
              className="w-full py-2 bg-nexus-accent hover:bg-nexus-accent/90 text-white text-sm rounded transition-colors"
            >
              {pickerMode === 'copy' ? t('workspace.copyHere') : t('workspace.moveHere')}
              <span className="opacity-80 mx-1">·</span>
              <span className="truncate inline-block align-bottom max-w-[60%]">{pickerPath}</span>
            </button>
          </div>

          {/* 目录列表 */}
          <div className="flex-1 overflow-y-auto">
            {pickerLoading ? (
              <div className="text-nexus-muted text-center py-10 text-sm">{t('common.loading')}</div>
            ) : (
              <div className="divide-y divide-nexus-border">
                {pickerPath !== '/' && pickerPath !== '' && (
                  <button
                    onClick={() => {
                      if (!pickerPath) return
                      const idx = pickerPath.lastIndexOf('/')
                      setPickerPath(idx <= 0 ? '/' : pickerPath.slice(0, idx))
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 transition-colors text-left hover:bg-nexus-bg-2"
                  >
                    <span className="text-xl shrink-0">⬆️</span>
                    <span className="text-nexus-text text-sm">{t('workspace.parent')}</span>
                  </button>
                )}
                {pickerEntries.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => setPickerPath(pickerPath?.endsWith('/') ? `${pickerPath}${entry.name}` : `${pickerPath}/${entry.name}`)}
                    className="w-full flex items-center gap-3 px-4 py-3 transition-colors text-left hover:bg-nexus-bg-2"
                  >
                    <span className="text-xl shrink-0">📁</span>
                    <span className="text-nexus-text text-sm font-mono truncate">{entry.name}</span>
                  </button>
                ))}
                {pickerEntries.length === 0 && (
                  <div className="text-nexus-muted text-center py-10 text-sm px-4">{t('workspace.empty')}</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

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
                onClick={() => { setEditingFile(null); setEditorContent(''); setIsPreviewMode(false); setEditorFontSize(14) }}
                className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1.5 flex items-center justify-center rounded-md"
              >
                <Icon name="x" size={20} />
              </button>
            </div>
          </div>
          {/* Editor Content */}
          <div
            className="flex-1 p-4 overflow-hidden touch-none"
            onTouchStart={handleEditorTouchStart}
            onTouchMove={handleEditorTouchMove}
            onTouchEnd={handleEditorTouchEnd}
          >
            {editingFile && isMarkdownFile(editingFile.name) && isPreviewMode ? (
              <div
                className="w-full h-full bg-nexus-bg-2 border border-nexus-border rounded p-4 overflow-y-auto"
                style={{ fontSize: `${editorFontSize}px`, lineHeight: '1.6' }}
              >
                <MarkdownPreview content={editorContent} fontSize={editorFontSize} />
              </div>
            ) : (
              <textarea
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                className="w-full h-full bg-nexus-bg-2 border border-nexus-border rounded p-3 text-nexus-text font-mono resize-none focus:outline-none focus:border-nexus-accent"
                style={{ fontSize: `${editorFontSize}px`, lineHeight: '1.6' }}
                spellCheck={false}
              />
            )}
          </div>
          {/* Editor Footer */}
          <div className="px-4 py-2 border-t border-nexus-border flex items-center justify-between text-xs text-nexus-muted">
            <div className="flex items-center gap-3">
              <span>{editorContent.length} {t('workspace.chars')}</span>
              {editorFontSize !== 14 && (
                <button
                  onClick={resetEditorFontSize}
                  className="text-nexus-accent hover:underline"
                >
                  {editorFontSize}px
                </button>
              )}
            </div>
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
function MarkdownPreview({ content, fontSize = 14 }: { content: string; fontSize?: number }) {
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
      className="markdown-body max-w-none text-nexus-text
        [&_h1]:text-[2em] [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:pb-1 [&_h1]:border-b [&_h1]:border-nexus-border
        [&_h2]:text-[1.5em] [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:pb-1 [&_h2]:border-b [&_h2]:border-nexus-border
        [&_h3]:text-[1.25em] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1
        [&_h4]:text-[1.1em] [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1
        [&_h5]:text-[1em] [&_h5]:font-semibold [&_h5]:mt-2 [&_h5]:mb-1
        [&_h6]:text-[0.9em] [&_h6]:font-semibold [&_h6]:mt-2 [&_h6]:mb-1 [&_h6]:text-nexus-text/70
        [&_p]:my-2 [&_p]:leading-relaxed
        [&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc
        [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal
        [&_li]:my-1
        [&_blockquote]:my-3 [&_blockquote]:pl-3 [&_blockquote]:border-l-4 [&_blockquote]:border-nexus-accent/50 [&_blockquote]:text-nexus-text/70
        [&_code]:font-mono [&_code]:text-[0.875em] [&_code]:bg-nexus-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
        [&_pre]:my-3 [&_pre]:p-3 [&_pre]:bg-nexus-bg-2 [&_pre]:rounded [&_pre]:overflow-x-auto
        [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none
        [&_hr]:my-4 [&_hr]:border-nexus-border
        [&_a]:text-nexus-accent [&_a]:underline
        [&_img]:max-w-full [&_img]:rounded
        [&_strong]:font-semibold
        [&_table]:w-full [&_table]:border-collapse [&_table]:my-3
        [&_th]:border [&_th]:border-nexus-border [&_th]:bg-nexus-bg-2 [&_th]:p-2 [&_th]:text-left [&_th]:text-nexus-text
        [&_td]:border [&_td]:border-nexus-border [&_td]:p-2 [&_td]:text-nexus-text
        [&_tr:nth-child(even)]:bg-nexus-bg-2/50
        [&_input[type='checkbox']]:mr-2 [&_input[type='checkbox']]:accent-nexus-accent"
      style={{ fontSize: `${fontSize}px`, lineHeight: '1.6' }}
      dangerouslySetInnerHTML={{ __html: cleanHtml }}
    />
  )
}
