import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

const STORAGE_KEY = 'nexus_token'

/** Parse API error response into a user-friendly message.
 *  For 401, clears the token and reloads (auto-logout). */
async function parseApiError(r: Response, fallback?: string): Promise<string> {
  if (r.status === 401) {
    localStorage.removeItem(STORAGE_KEY)
    window.location.reload()
    return '' // unreachable after reload
  }
  try {
    const data = await r.json()
    if (data?.error) return data.error
  } catch { /* response body not JSON */ }
  const statusMessages: Record<number, string> = {
    400: '请求参数有误',
    403: '无访问权限',
    404: '资源不存在',
    409: '操作冲突，可能已存在',
    500: '服务器内部错误',
    502: '网关错误，服务可能未启动',
    503: '服务暂时不可用',
  }
  return statusMessages[r.status] ?? fallback ?? `请求失败 (${r.status})`
}

/** Friendly message when fetch() itself throws (network unreachable). */
function parseNetworkError(e: unknown): string {
  if (e instanceof TypeError) return '无法连接服务器，请检查服务是否已启动'
  if (e instanceof Error) return e.message
  return '未知错误'
}

interface Channel {
  index: number
  name: string
  active: boolean
  cwd: string
}

interface Project {
  name: string
  path: string
  active: boolean
  channelCount: number
}

interface Props {
  token: string
  currentProject: string
  currentChannelIndex?: number
  onClose: () => void
  onSwitchProject: (projectName: string, lastChannel?: number) => void
  onSwitchChannel: (channelIndex: number) => void
  onNewProject: () => void
  onNewChannel: () => void
  /** Refresh callback — exposed for sidebar toggle integration */
  onRefresh?: () => void
  layout?: 'modal' | 'sidebar'
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isDesktop
}

const STATUS_DOT = {
  running: '#22c55e',
  idle: '#9ca3af',
  waiting: '#eab308',
  shell: '#6b7280',
}

function getChannelStatus(channel: Channel, isActive: boolean): keyof typeof STATUS_DOT {
  if (channel.name === 'shell' || channel.name.endsWith('-shell')) return 'shell'
  return isActive ? 'running' : 'idle'
}

export interface SessionManagerV2Handle {
  refresh: () => void
}

export default forwardRef<SessionManagerV2Handle, Props>(function SessionManagerV2({
  token,
  currentProject,
  currentChannelIndex,
  onClose,
  onSwitchProject,
  onSwitchChannel,
  onNewProject,
  onNewChannel,
  onRefresh: _onRefresh,
  layout = 'modal',
}: Props, ref) {
  const { t } = useTranslation()
  const isDesktop = useIsDesktop()
  const isSidebar = layout === 'sidebar'
  const [projects, setProjects] = useState<Project[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mobile/modal gesture state
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingChannelRef = useRef<Channel | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressChannelRef = useRef<Channel | null>(null)
  const isLongPressRef = useRef(false)
  const [longPressMenu, setLongPressMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)
  const [pressChannel, setPressChannel] = useState<number | null>(null)
  const [channelMenu, setChannelMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null)

  // Sidebar right-click menu state
  const [sidebarChannelMenu, setSidebarChannelMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)
  const [sidebarProjectMenu, setSidebarProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  // --- Data fetching ---

  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      const r = await fetch('/api/projects', { headers })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.loadFailed'))); return }
      setProjects(await r.json())
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    } finally {
      setLoadingProjects(false)
    }
  }, [token])

  const fetchChannels = useCallback(async (projectName: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingChannels(true)
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectName)}/channels`, { headers })
      const data = await r.json()
      setChannels((data as any).channels || [])
    } catch (e: unknown) {
      console.error('Load channels failed:', e)
      setChannels([])
    } finally {
      if (!opts?.silent) setLoadingChannels(false)
    }
  }, [token])

  useEffect(() => { fetchProjects() }, [fetchProjects])
  useEffect(() => {
    if (currentProject) fetchChannels(currentProject)
  }, [currentProject, fetchChannels])

  const handleRefresh = useCallback(() => {
    fetchProjects()
    if (currentProject) fetchChannels(currentProject)
  }, [fetchProjects, fetchChannels, currentProject])

  useImperativeHandle(ref, () => ({ refresh: handleRefresh }), [handleRefresh])

  // --- Actions ---

  const handleProjectClick = async (project: Project) => {
    if (project.name === currentProject) return
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}/activate`, { method: 'POST', headers })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.switchFailed'))); return }
      const data = await r.json()
      onSwitchProject(project.name, data.lastChannel)
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    }
  }

  const doSwitchChannel = async (channel: Channel, shouldClose: boolean) => {
    try {
      const r = await fetch(`/api/sessions/${channel.index}/attach?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers,
      })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.switchFailed'))); return }
      onSwitchChannel(channel.index)
      if (shouldClose) onClose()
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    }
  }

  const handleRenameChannel = async (channel: Channel) => {
    setChannelMenu(null)
    setLongPressMenu(null)
    setSidebarChannelMenu(null)
    const newName = window.prompt(`${t('common.rename')} Channel:`, channel.name)
    if (!newName || newName === channel.name) return
    try {
      const r = await fetch(`/api/sessions/${channel.index}/rename?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.renameFailed'))); return }
      fetchChannels(currentProject)
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    }
  }

  const handleCloseChannel = async (channel: Channel) => {
    setChannelMenu(null)
    setLongPressMenu(null)
    setSidebarChannelMenu(null)
    try {
      const r = await fetch(`/api/sessions/${channel.index}?session=${encodeURIComponent(currentProject)}`, {
        method: 'DELETE',
        headers,
      })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.closeFailed'))); return }
      fetchChannels(currentProject)
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    }
  }

  const handleRenameProject = async (project: Project) => {
    setProjectMenu(null)
    setSidebarProjectMenu(null)
    const newName = window.prompt(`${t('common.rename')} Project:`, project.name)
    if (!newName || newName === project.name) return
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}/rename`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.renameFailed'))); return }
      fetchProjects()
      if (project.name === currentProject) onSwitchProject(newName)
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    }
  }

  const handleCloseProject = async (project: Project) => {
    setProjectMenu(null)
    setSidebarProjectMenu(null)
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}`, { method: 'DELETE', headers })
      if (!r.ok) { setError(await parseApiError(r, t('sessionMgr.closeFailed'))); return }
      fetchProjects()
      if (project.name === currentProject) {
        const remaining = projects.filter(p => p.name !== project.name)
        if (remaining.length > 0) handleProjectClick(remaining[0])
      }
    } catch (e: unknown) {
      setError(parseNetworkError(e))
    }
  }

  // --- Modal mode: position-based menus ---

  const showModalChannelMenu = (channel: Channel, e: React.MouseEvent | React.TouchEvent) => {
    const { x, y } = getRowMenuPosition(e)
    setChannelMenu({ channel, x, y })
  }

  const showModalProjectMenu = (project: Project, e: React.MouseEvent | React.TouchEvent) => {
    const { x, y } = getRowMenuPosition(e)
    setProjectMenu({ project, x, y })
  }

  const getRowMenuPosition = (e: React.MouseEvent | React.TouchEvent) => {
    // Get the row div (parent of the button), not the button itself
    const row = (e.currentTarget as HTMLElement).closest('[data-menu-row]') as HTMLElement
    const rect = row ? row.getBoundingClientRect() : (e.currentTarget as HTMLElement).getBoundingClientRect()
    const menuWidth = 160
    const menuHeight = 80
    let x = rect.right - menuWidth
    let y = rect.bottom + 4
    if (x + menuWidth > window.innerWidth - 16) x = window.innerWidth - menuWidth - 16
    if (x < 16) x = 16
    if (y + menuHeight > window.innerHeight - 16) y = rect.top - menuHeight - 4
    return { x, y }
  }

  // --- Sidebar mode: right-click context menu ---

  const handleSidebarContext = (e: React.MouseEvent, channel?: Channel, project?: Project) => {
    e.preventDefault()
    const clickX = e.clientX
    const clickY = e.clientY
    if (channel) {
      const menuWidth = 150
      let x = clickX + 4
      let y = clickY + 4
      if (y + 90 > window.innerHeight) y = clickY - 90
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth
      if (x < 0) x = 0
      setSidebarChannelMenu({ channel, x, y })
    } else if (project) {
      const menuWidth = 170
      let x = clickX + 4
      let y = clickY + 4
      if (y + 110 > window.innerHeight) y = clickY - 110
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth
      if (x < 0) x = 0
      setSidebarProjectMenu({ project, x, y })
    }
  }

  // --- Mobile touch gestures ---

  const handleChannelTouchStart = (channel: Channel, e: React.TouchEvent) => {
    isLongPressRef.current = false
    longPressChannelRef.current = channel
    setPressChannel(channel.index)
    longPressTimerRef.current = window.setTimeout(() => {
      isLongPressRef.current = true
      setPressChannel(null)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const menuWidth = 120
      const menuHeight = 80
      let x = rect.left + rect.width / 2
      let y = rect.bottom + 8
      if (x + menuWidth / 2 > window.innerWidth - 16) x = window.innerWidth - menuWidth / 2 - 16
      if (x - menuWidth / 2 < 16) x = menuWidth / 2 + 16
      if (y + menuHeight > window.innerHeight - 16) y = rect.top - menuHeight - 8
      setLongPressMenu({ channel, x, y })
    }, 500)
  }

  const handleChannelTouchEnd = (channel: Channel) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (isLongPressRef.current) { setPressChannel(null); return }
    setTimeout(() => setPressChannel(null), 100)
    if (channel.index === currentChannelIndex) { onClose(); return }
    pendingChannelRef.current = channel
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      doSwitchChannel(channel, true)
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        if (pendingChannelRef.current) doSwitchChannel(pendingChannelRef.current, false)
      }, 250)
    }
  }

  const handleChannelTouchMove = () => {
    setPressChannel(null)
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
  }

  const activeChannelMenu = isSidebar ? null : (longPressMenu || channelMenu)

  const formatPath = (p: string) => {
    if (!p) return ''
    // Truncate long paths for display
    const parts = p.split('/').filter(Boolean)
    if (parts.length > 3) {
      return '...' + '/' + parts.slice(-2).join('/')
    }
    return p
  }

  const menuButtonClass = (mode: 'sidebar' | 'modal') =>
    mode === 'sidebar'
      ? 'bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity duration-150 shrink-0'
      : 'bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-60 transition-opacity duration-150 shrink-0'

  // ====== Shared content ======
  const content = (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {error && (
        <div className="bg-red-500/15 text-nexus-error px-4 py-2.5 text-sm flex items-center justify-between border-b border-nexus-border">
          {error}
          <button className="bg-transparent border-none text-nexus-error cursor-pointer p-0.5" onPointerDown={() => setError(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Project 列表 */}
        <div className="flex-1 py-2 flex flex-col min-h-0" >
          <div className="px-3 pb-1.5 border-b border-nexus-border mb-1.5">
            <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">📁</span>
                {t('sessionMgr.projects')}
              </div>
              {isSidebar && (
                <button
                  className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                  onClick={handleRefresh}
                  title={t('sessionMgr.refresh') || 'Refresh'}
                >
                  <Icon name="refresh" size={14} />
                </button>
              )}
            </div>
          </div>

          <div
            className="flex-1 overflow-y-auto px-1.5 min-h-0"
          >
            {loadingProjects ? (
              <div className="text-nexus-muted text-sm px-3 py-2">{t('common.loading')}</div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3 py-4 text-nexus-muted">
                <div className="text-[28px] mb-1.5 opacity-50">📁</div>
                <div className="text-sm">{t('sessionMgr.noProjects')}</div>
              </div>
            ) : projects.map(project => {
              const isActive = project.name === currentProject
              return (
                <div
                  key={project.name}
                  data-menu-row
                  className={`flex items-start gap-2 px-2.5 py-1.5 rounded cursor-pointer mb-0.5 select-none group/item ${isActive ? 'bg-blue-500/15' : ''}`}
                  onPointerDown={() => {
                    if (project.name !== currentProject) handleProjectClick(project)
                  }}
                  onContextMenu={isSidebar ? (e) => { e.preventDefault(); handleSidebarContext(e, undefined, project) } : undefined}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-0.5 ${isActive ? 'bg-blue-500' : 'bg-nexus-muted'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-nexus-text truncate leading-tight" title={project.name}>{project.name}</div>
                    {project.path && (
                      <div className="text-[11px] text-nexus-text-2 font-mono truncate mt-0.5" title={project.path}>
                        {formatPath(project.path)}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-nexus-text-2 font-mono shrink-0">({project.channelCount})</span>
                  {!isSidebar && (
                    <button
                      className={menuButtonClass('modal')}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        showModalProjectMenu(project, e)
                      }}
                      onTouchStart={(e) => e.stopPropagation()}
                      onTouchEnd={(e) => e.stopPropagation()}
                      title={t('sessionMgr.moreOptions')}
                    >
                      <Icon name="more" size={16} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <button className="flex items-center justify-center gap-1.5 mx-3 my-1.5 px-2.5 py-1.5 bg-transparent border border-dashed border-nexus-border rounded text-nexus-text-2 text-sm cursor-pointer" onPointerDown={onNewProject}>
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newProject')}</span>
          </button>
        </div>

        {/* Channel 列表 */}
        <div className="flex-1 py-2 flex flex-col min-h-0" >
          <div className="px-3 pb-1.5 border-b border-nexus-border mb-1.5">
            <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center gap-1.5">
              <span className="text-sm">#</span>
              {t('sessionMgr.channels')}
            </div>
          </div>

          <div
            className="flex-1 overflow-y-auto px-1.5 min-h-0"
          >
            {loadingChannels ? (
              <div className="text-nexus-muted text-sm px-3 py-2">{t('common.loading')}</div>
            ) : channels.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3 py-4 text-nexus-muted">
                <div className="text-[28px] mb-1.5 opacity-50">#</div>
                <div className="text-sm">{t('sessionMgr.noChannels')}</div>
              </div>
            ) : channels.map(channel => {
              const isActive = channel.index === currentChannelIndex
              const status = getChannelStatus(channel, isActive)
              return (
                <div
                  key={channel.index}
                  data-menu-row
                  className={`flex items-start gap-2 px-2.5 py-1.5 rounded cursor-pointer mb-0.5 select-none transition-colors duration-75 group/item ${isActive ? 'bg-nexus-bg-2' : ''} ${!isDesktop && pressChannel === channel.index ? 'bg-nexus-border' : ''}`}
                  style={{ WebkitTouchCallout: 'none' }}
                  onPointerDown={() => { if (isDesktop) doSwitchChannel(channel, false) }}
                  onContextMenu={isSidebar ? (e) => { e.preventDefault(); handleSidebarContext(e, channel, undefined) } : undefined}
                  onTouchStart={(e) => { if (!isDesktop) handleChannelTouchStart(channel, e) }}
                  onTouchEnd={(e) => { if (!isDesktop) { e.preventDefault(); handleChannelTouchEnd(channel) } }}
                  onTouchMove={() => { if (!isDesktop) handleChannelTouchMove() }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0 mt-0.5" style={{ background: STATUS_DOT[status] }} title={status} />
                  <span className="text-nexus-text-2 text-[13px] font-medium select-none shrink-0 mt-0">#</span>
                  <span className="flex-1 text-sm text-nexus-text truncate leading-tight min-w-0" title={channel.name}>{channel.name}</span>
                  {!isSidebar && (
                    <button
                      className={menuButtonClass('modal')}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        showModalChannelMenu(channel, e)
                      }}
                      onTouchStart={(e) => e.stopPropagation()}
                      onTouchEnd={(e) => e.stopPropagation()}
                      title={t('sessionMgr.moreOptions')}
                    >
                      <Icon name="more" size={16} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <button className="flex items-center justify-center gap-1.5 mx-3 my-1.5 px-2.5 py-1.5 bg-transparent border border-dashed border-nexus-border rounded text-nexus-text-2 text-sm cursor-pointer" onPointerDown={onNewChannel}>
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newChannel')}</span>
          </button>

          {/* Modal mode: channel menu overlay */}
          {activeChannelMenu && (
            <>
              <div className="fixed inset-0 z-[150]" onPointerDown={() => { setLongPressMenu(null); setChannelMenu(null) }} />
              <div
                className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
                style={{ left: activeChannelMenu.x, top: activeChannelMenu.y }}
              >
                <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameChannel(activeChannelMenu.channel)}>
                  <Icon name="pencil" size={14} />
                  <span>{t('common.rename')}</span>
                </button>
                <div className="h-px bg-nexus-border my-1" />
                <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseChannel(activeChannelMenu.channel)}>
                  <Icon name="x" size={14} />
                  <span>{t('common.close')}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )

  // ====== Sidebar mode ======
  if (isSidebar) {
    return (
      <div
        className="grid grid-rows-[1fr_auto_1fr] bg-nexus-bg text-nexus-text h-full"
      >
        {error && (
          <div className="bg-red-500/15 text-nexus-error px-4 py-2.5 text-sm flex items-center justify-between border-b border-nexus-border shrink-0">
            {error}
            <button className="bg-transparent border-none text-nexus-error cursor-pointer p-0.5" onPointerDown={() => setError(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {/* Projects section: 50% height, internal scroll */}
        <div className="flex flex-col overflow-hidden">
          <div className="px-3 pr-10 py-1.5 border-b border-nexus-border shrink-0">
            <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">📁</span>
                {t('sessionMgr.projects')}
              </div>
              <button
                className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                onClick={handleRefresh}
                title={t('sessionMgr.refresh') || 'Refresh'}
              >
                <Icon name="refresh" size={14} />
              </button>
            </div>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1"
          >
            {loadingProjects ? (
              <div className="text-nexus-muted text-sm px-3 py-2">{t('common.loading')}</div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3 py-2 text-nexus-muted">
                <div className="text-sm">{t('sessionMgr.noProjects')}</div>
              </div>
            ) : projects.map(project => {
              const isActive = project.name === currentProject
              return (
                <div
                  key={project.name}
                  data-menu-row
                  className={`flex items-start gap-2 px-2.5 py-1.5 rounded cursor-pointer mb-0.5 select-none group/item ${isActive ? 'bg-blue-500/15' : ''}`}
                  onPointerDown={() => { if (project.name !== currentProject) handleProjectClick(project) }}
                  onContextMenu={(e) => { e.preventDefault(); handleSidebarContext(e, undefined, project) }}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-0.5 ${isActive ? 'bg-blue-500' : 'bg-nexus-muted'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-nexus-text truncate leading-tight" title={project.name}>{project.name}</div>
                    {project.path && (
                      <div className="text-[11px] text-nexus-text-2 font-mono truncate mt-0.5" title={project.path}>
                        {formatPath(project.path)}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-nexus-text-2 font-mono shrink-0">({project.channelCount})</span>
                </div>
              )
            })}
          </div>
          <button className="flex items-center justify-center gap-1.5 mx-3 py-1 px-2.5 bg-transparent border border-dashed border-nexus-border rounded text-nexus-text-2 text-sm cursor-pointer shrink-0" onPointerDown={onNewProject}>
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newProject')}</span>
          </button>
        </div>

        {/* Divider */}
        <div className="flex-shrink-0 h-px bg-nexus-border" />

        {/* Channels section: 50% height, internal scroll */}
        <div className="flex flex-col overflow-hidden">
          <div className="px-3 pr-10 py-1.5 border-b border-nexus-border shrink-0">
            <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center gap-1.5">
              <span className="text-sm">#</span>
              {t('sessionMgr.channels')}
            </div>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1"
          >
            {loadingChannels ? (
              <div className="text-nexus-muted text-sm px-3 py-2">{t('common.loading')}</div>
            ) : channels.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3 py-2 text-nexus-muted">
                <div className="text-sm">{t('sessionMgr.noChannels')}</div>
              </div>
            ) : channels.map(channel => {
              const isActive = channel.index === currentChannelIndex
              const status = getChannelStatus(channel, isActive)
              return (
                <div
                  key={channel.index}
                  data-menu-row
                  className={`flex items-start gap-2 px-2.5 py-1.5 rounded cursor-pointer mb-0.5 select-none transition-colors duration-75 group/item ${isActive ? 'bg-nexus-bg-2' : ''}`}
                  style={{ WebkitTouchCallout: 'none' }}
                  onPointerDown={() => { doSwitchChannel(channel, false) }}
                  onContextMenu={(e) => { e.preventDefault(); handleSidebarContext(e, channel, undefined) }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0 mt-0.5" style={{ background: STATUS_DOT[status] }} title={status} />
                  <span className="text-nexus-text-2 text-[13px] font-medium select-none shrink-0 mt-0">#</span>
                  <span className="flex-1 text-sm text-nexus-text truncate leading-tight min-w-0" title={channel.name}>{channel.name}</span>
                </div>
              )
            })}
          </div>
          <button className="flex items-center justify-center gap-1.5 mx-3 py-1 px-2.5 bg-transparent border border-dashed border-nexus-border rounded text-nexus-text-2 text-sm cursor-pointer shrink-0" onPointerDown={onNewChannel}>
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newChannel')}</span>
          </button>
        </div>

        {/* Sidebar right-click menu - channel */}
        {sidebarChannelMenu && (
          <>
            <div className="fixed inset-0 z-[150]" onPointerDown={() => setSidebarChannelMenu(null)} />
            <div
              className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
              style={{ left: sidebarChannelMenu.x, top: sidebarChannelMenu.y }}
            >
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameChannel(sidebarChannelMenu.channel)}>
                <Icon name="pencil" size={14} />
                <span>{t('common.rename')}</span>
              </button>
              <div className="h-px bg-nexus-border my-1" />
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseChannel(sidebarChannelMenu.channel)}>
                <Icon name="x" size={14} />
                <span>{t('common.close')}</span>
              </button>
            </div>
          </>
        )}

        {/* Sidebar right-click menu - project */}
        {sidebarProjectMenu && (
          <>
            <div className="fixed inset-0 z-[150]" onPointerDown={() => setSidebarProjectMenu(null)} />
            <div
              className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
              style={{ left: sidebarProjectMenu.x, top: sidebarProjectMenu.y }}
            >
              <div className="px-4 py-1.5 text-xs font-semibold text-nexus-text-2 border-b border-nexus-border mb-0">
                {sidebarProjectMenu.project.name}
              </div>
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameProject(sidebarProjectMenu.project)}>
                <Icon name="pencil" size={14} />
                <span>{t('common.rename')}</span>
              </button>
              <div className="h-px bg-nexus-border my-1" />
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseProject(sidebarProjectMenu.project)}>
                <Icon name="x" size={14} />
                <span>{t('sessionMgr.closeProject')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  // ====== Modal mode ======
  return (
    <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
      <GhostShield />
      <div className={isDesktop
        ? 'bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[400px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden'
        : 'fixed inset-0 bg-nexus-bg flex flex-col text-nexus-text'
      }>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border shrink-0">
          <span className="text-base font-semibold">{t('sessionMgr.title')}</span>
          <div className="flex items-center gap-2">
            <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center" onPointerDown={handleRefresh} title={t('sessionMgr.refresh') || '刷新'}>
              <Icon name="refresh" size={16} />
            </button>
            <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center" onPointerDown={onClose}>
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>

        {content}

        {/* Modal mode: project menu overlay */}
        {projectMenu && (
          <>
            <div className="fixed inset-0 z-[150]" onPointerDown={() => setProjectMenu(null)} />
            <div
              className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
              style={{ left: projectMenu.x, top: projectMenu.y }}
            >
              <div className="px-4 py-1.5 text-xs font-semibold text-nexus-text-2 border-b border-nexus-border mb-0">{projectMenu.project.name}</div>
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameProject(projectMenu.project)}>
                <Icon name="pencil" size={14} />
                <span>{t('common.rename')}</span>
              </button>
              <div className="h-px bg-nexus-border my-1" />
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseProject(projectMenu.project)}>
                <Icon name="x" size={14} />
                <span>{t('sessionMgr.closeProject')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
})
