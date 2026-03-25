import { useState, useEffect, useCallback, useRef } from 'react'
import GhostShield from './GhostShield'
import { Icon } from './icons'

// 检测是否为 PC 端（>= 768px）
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isDesktop
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
  currentProject: string // 当前激活的 tmux session
  currentChannelIndex?: number // 当前激活的 channel index
  onClose: () => void
  onSwitchProject: (projectName: string, lastChannel?: number) => void
  onSwitchChannel: (channelIndex: number) => void
  onNewProject: () => void // 打开 WorkspaceSelector
  onNewChannel: () => void // 直接新建窗口
}

// 状态点颜色映射
const STATUS_DOT = {
  running: '#22c55e', // 绿色
  idle: '#9ca3af',    // 灰色
  waiting: '#eab308', // 黄色
  shell: '#6b7280',   // 深灰
}

function getChannelStatus(channel: Channel, isActive: boolean): keyof typeof STATUS_DOT {
  // 简单启发式判断
  if (channel.name === 'shell' || channel.name.endsWith('-shell')) return 'shell'
  // 使用传入的 isActive 实现即时更新
  return isActive ? 'running' : 'idle'
}

export default function SessionManagerV2({
  token,
  currentProject,
  currentChannelIndex,
  onClose,
  onSwitchProject,
  onSwitchChannel,
  onNewProject,
  onNewChannel,
}: Props) {
  const isDesktop = useIsDesktop()
  const [projects, setProjects] = useState<Project[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  // 用于区分单击/双击的状态
  const clickTimerRef = useRef<number | null>(null)
  const pendingChannelRef = useRef<Channel | null>(null)

  // 长按菜单状态
  const [longPressMenu, setLongPressMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)

  // 按下状态（用于视觉反馈）
  const [pressedChannel, setPressedChannel] = useState<number | null>(null)

  // 长按检测 refs
  const longPressTimerRef = useRef<number | null>(null)
  const longPressChannelRef = useRef<Channel | null>(null)
  const isLongPressRef = useRef(false)

  // 加载 Projects 列表
  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      const r = await fetch('/api/projects', { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: Project[] = await r.json()
      setProjects(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoadingProjects(false)
    }
  }, [token])

  // 加载当前 Project 的 Channels
  const fetchChannels = useCallback(async (projectName: string) => {
    setLoadingChannels(true)
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectName)}/channels`, { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setChannels(data.channels || [])
    } catch (e: unknown) {
      console.error('加载 Channels 失败:', e)
      setChannels([])
    } finally {
      setLoadingChannels(false)
    }
  }, [token])

  // 初始加载
  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // 当前 Project 变化时加载 Channels
  useEffect(() => {
    if (currentProject) {
      fetchChannels(currentProject)
    }
  }, [currentProject, fetchChannels])

  // 手动刷新
  const handleRefresh = () => {
    fetchProjects()
    if (currentProject) fetchChannels(currentProject)
  }

  // 点击 Project 切换
  const handleProjectClick = async (project: Project) => {
    if (project.name === currentProject) return
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}/activate`, {
        method: 'POST',
        headers,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      onSwitchProject(project.name, data.lastChannel)
      // Channels 会通过 useEffect 自动刷新
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '切换失败')
    }
  }

  // 长按开始
  const handleChannelTouchStart = (channel: Channel, e: React.TouchEvent) => {
    isLongPressRef.current = false
    longPressChannelRef.current = channel
    setPressedChannel(channel.index)

    // 启动长按检测（500ms）
    longPressTimerRef.current = window.setTimeout(() => {
      isLongPressRef.current = true
      setPressedChannel(null)
      // 显示长按菜单
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setLongPressMenu({
        channel,
        x: rect.left + rect.width / 2,
        y: rect.bottom + 8,
      })
    }, 500)
  }

  // 触摸结束时触发切换
  const handleChannelTouchEnd = (channel: Channel) => {
    // 清除长按定时器
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    // 如果是长按，不处理点击
    if (isLongPressRef.current) {
      setPressedChannel(null)
      return
    }

    // 延迟清除按下状态，让用户看到反馈
    window.setTimeout(() => {
      setPressedChannel(null)
    }, 100)

    // 点击抬起时触发切换
    // 如果点击的是当前已激活的 channel，直接关闭菜单
    if (channel.index === currentChannelIndex) {
      onClose()
      return
    }

    // 记录点击的 channel
    pendingChannelRef.current = channel

    // 设置延时器，区分单击和双击
    if (clickTimerRef.current) {
      // 250ms 内第二次点击 = 双击，清除之前的定时器
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      // 双击：立即切换并收起菜单
      doSwitchChannel(channel, true)
    } else {
      // 第一次点击，等待是否为双击
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null
        // 单击：只切换，不收起
        if (pendingChannelRef.current) {
          doSwitchChannel(pendingChannelRef.current, false)
        }
      }, 250)
    }
  }

  // 触摸移动时取消长按
  const handleChannelTouchMove = () => {
    setPressedChannel(null)
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  // 实际执行切换
  const doSwitchChannel = async (channel: Channel, shouldClose: boolean) => {
    try {
      const r = await fetch(`/api/sessions/${channel.index}/attach?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      onSwitchChannel(channel.index)
      if (shouldClose) {
        onClose()
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '切换失败')
    }
  }

  // 处理改名
  const handleRenameChannel = async (channel: Channel) => {
    setLongPressMenu(null)
    setChannelMenu(null)
    const newName = window.prompt('重命名 Channel:', channel.name)
    if (!newName || newName === channel.name) return

    try {
      const r = await fetch(`/api/sessions/${channel.index}/rename?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      fetchChannels(currentProject)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '重命名失败')
    }
  }

  // 处理关闭 channel
  const handleCloseChannel = async (channel: Channel) => {
    setLongPressMenu(null)
    setChannelMenu(null)
    if (!window.confirm(`确定要关闭 Channel "${channel.name}" 吗？`)) return

    try {
      const r = await fetch(`/api/sessions/${channel.index}/kill?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      fetchChannels(currentProject)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '关闭失败')
    }
  }

  // 获取当前 Project 信息
  const currentProjectInfo = projects.find(p => p.name === currentProject)

  // channel 菜单状态
  const [channelMenu, setChannelMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)

  // 格式化路径显示
  const formatPath = (p: string) => {
    if (!p) return ''
    if (p.startsWith('/home/')) return p.replace('/home/', '~/')
    if (p === '/root' || p.startsWith('/root/')) return p.replace('/root', '~')
    return p
  }

  return (
    <div style={isDesktop ? s.desktopOverlay : s.overlay}>
      <GhostShield />
      <div style={isDesktop ? s.desktopPanel : s.panel}>
        {/* 顶部标题栏 */}
        <div style={s.header}>
          <span style={s.title}>会话管理</span>
          <div style={s.headerActions}>
            <button style={s.refreshBtn} onPointerDown={handleRefresh} title="刷新">
              <Icon name="refresh" size={16} />
            </button>
            <button style={s.closeBtn} onPointerDown={onClose}>
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>

        {error && (
          <div style={s.errorBanner}>
            {error}
            <button style={s.errorClose} onPointerDown={() => setError(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        <div style={s.scrollArea}>
          {/* ========== Channel 列表区域（上部）========== */}
          <div style={s.channelsSection}>
            {/* Channel 标题栏 */}
            <div style={s.sectionHeader}>
              <div>
                <div style={s.sectionTitle}>
                  <span style={s.sectionIcon}>📂</span>
                  {currentProjectInfo?.name || currentProject || '未选择项目'}
                </div>
                {currentProjectInfo?.path && (
                  <div style={s.projectPath} title={currentProjectInfo.path}>
                    {formatPath(currentProjectInfo.path)}
                  </div>
                )}
              </div>
            </div>

            {/* Channel 列表 */}
            <div style={s.listContainer}>
              {loadingChannels ? (
                <div style={s.emptyMsg}>加载中...</div>
              ) : channels.length === 0 ? (
                <div style={s.emptyState}>
                  <div style={s.emptyIcon}>#</div>
                  <div style={s.emptyText}>该 Project 没有 Channel</div>
                </div>
              ) : (
                channels.map(channel => {
                  const isActive = channel.index === currentChannelIndex
                  const status = getChannelStatus(channel, isActive)
                  return (
                    <div
                      key={channel.index}
                      style={{
                        ...s.channelItem,
                        ...(isActive ? s.channelItemActive : {}),
                        ...(pressedChannel === channel.index ? s.channelItemPressed : {}),
                      }}
                      onTouchStart={(e) => {
                        handleChannelTouchStart(channel, e)
                      }}
                      onTouchEnd={(e) => {
                        e.preventDefault()
                        handleChannelTouchEnd(channel)
                      }}
                      onTouchMove={() => handleChannelTouchMove()}
                    >
                      <span
                        style={{
                          ...s.statusDot,
                          background: STATUS_DOT[status],
                        }}
                        title={status}
                      />
                      <span style={s.channelPrefix}>#</span>
                      <span style={s.channelName}>{channel.name}</span>
                      {/* 三个点菜单按钮 */}
                      <button
                        style={s.channelMenuBtn}
                        onTouchStart={(e) => {
                          // 阻止触摸事件冒泡，防止触发父元素的 channel 切换
                          e.stopPropagation()
                        }}
                        onTouchEnd={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setChannelMenu({
                            channel,
                            x: rect.left + rect.width / 2,
                            y: rect.bottom + 8,
                          })
                        }}
                        onPointerDown={(e) => {
                          // PC 端：阻止冒泡
                          e.stopPropagation()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setChannelMenu({
                            channel,
                            x: rect.left + rect.width / 2,
                            y: rect.bottom + 8,
                          })
                        }}
                        title="更多选项"
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            {/* 新建 Channel 按钮 */}
            <button style={s.addBtn} onPointerDown={onNewChannel}>
              <Icon name="plus" size={14} />
              <span>新 Channel</span>
            </button>

            {/* Channel 菜单（长按或点击三个点） */}
            {(longPressMenu || channelMenu) && (
              <>
                <div
                  style={s.menuOverlay}
                  onPointerDown={() => {
                    setLongPressMenu(null)
                    setChannelMenu(null)
                  }}
                />
                <div
                  style={{
                    ...s.longPressMenu,
                    left: (longPressMenu || channelMenu)!.x,
                    top: (longPressMenu || channelMenu)!.y,
                  }}
                >
                  <button
                    style={s.menuItem}
                    onPointerDown={() => handleRenameChannel((longPressMenu || channelMenu)!.channel)}
                  >
                    <Icon name="pencil" size={14} />
                    <span>重命名</span>
                  </button>
                  <div style={s.menuDivider} />
                  <button
                    style={{ ...s.menuItem, ...s.menuItemDanger }}
                    onPointerDown={() => handleCloseChannel((longPressMenu || channelMenu)!.channel)}
                  >
                    <Icon name="x" size={14} />
                    <span>关闭</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 分隔线 */}
          <div style={s.divider} />

          {/* ========== Project 列表区域（下部）========== */}
          <div style={s.projectsSection}>
            <div style={s.sectionHeader}>
              <div style={s.sectionTitle}>
                <span style={s.sectionIcon}>📁</span>
                Projects
              </div>
            </div>

            {/* Project 列表 */}
            <div style={s.listContainer}>
              {loadingProjects ? (
                <div style={s.emptyMsg}>加载中...</div>
              ) : projects.length === 0 ? (
                <div style={s.emptyState}>
                  <div style={s.emptyIcon}>📁</div>
                  <div style={s.emptyText}>暂无 Projects</div>
                </div>
              ) : (
                projects.map(project => {
                  const isActive = project.name === currentProject
                  return (
                    <div
                      key={project.name}
                      style={{
                        ...s.projectItem,
                        ...(isActive ? s.projectItemActive : {}),
                      }}
                      onPointerDown={() => handleProjectClick(project)}
                    >
                      <span style={isActive ? s.projectDotActive : s.projectDot} />
                      <span style={s.projectName}>{project.name}</span>
                      <span style={s.channelCount}>({project.channelCount})</span>
                    </div>
                  )
                })
              )}
            </div>

            {/* 新建 Project 按钮 */}
            <button style={s.addBtn} onPointerDown={onNewProject}>
              <Icon name="plus" size={14} />
              <span>新 Project</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // 移动端样式（默认）
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 },
  panel: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--nexus-bg)', display: 'flex', flexDirection: 'column', color: 'var(--nexus-text)' },

  // PC 端样式
  desktopOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  desktopPanel: { background: 'var(--nexus-bg)', border: '1px solid var(--nexus-border)', borderRadius: 12, display: 'flex', flexDirection: 'column', color: 'var(--nexus-text)', width: '100%', maxWidth: 420, maxHeight: '85vh', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', overflow: 'hidden' },

  // 头部
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--nexus-border)', flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 600 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  refreshBtn: { background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  closeBtn: { background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 24, lineHeight: 1, padding: '0 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' },

  // 错误提示
  errorBanner: { background: 'rgba(239,68,68,0.15)', color: 'var(--nexus-error)', padding: '10px 16px', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--nexus-border)' },
  errorClose: { background: 'transparent', border: 'none', color: 'var(--nexus-error)', cursor: 'pointer', padding: 2 },

  // 滚动区域
  scrollArea: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' },

  // Channel 区域
  channelsSection: { padding: '12px 0', flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 120 },
  sectionHeader: { padding: '0 16px 8px', borderBottom: '1px solid var(--nexus-border)', marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--nexus-text)', letterSpacing: 0.3, display: 'flex', alignItems: 'center', gap: 6 },
  sectionIcon: { fontSize: 14 },
  projectPath: { fontSize: 11, color: 'var(--nexus-text2)', marginTop: 2, fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  // 列表容器
  listContainer: { flex: 1, overflowY: 'auto', padding: '4px 8px' },

  // Channel 项
  channelItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, cursor: 'pointer', marginBottom: 2, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'manipulation', WebkitTapHighlightColor: 'rgba(128,128,128,0.3)', transition: 'background-color 0.05s ease' },
  channelItemActive: { background: 'var(--nexus-bg2)' },
  channelItemPressed: { background: 'var(--nexus-border)', transition: 'none' },
  channelPrefix: { color: 'var(--nexus-text2)', fontSize: 13, fontWeight: 500, userSelect: 'none' },
  channelName: { flex: 1, fontSize: 14, color: 'var(--nexus-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  channelMenuBtn: { background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6, transition: 'opacity 0.15s' },

  // 分隔线
  divider: { height: 2, background: 'var(--nexus-border)', margin: '8px 0' },

  // Project 区域
  projectsSection: { padding: '12px 0', flex: '1 1 auto', display: 'flex', flexDirection: 'column', background: 'var(--nexus-bg2)', minHeight: 120 },

  // Project 项
  projectItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 6, cursor: 'pointer', marginBottom: 2 },
  projectItemActive: { background: 'rgba(59,130,246,0.15)' },
  projectDot: { width: 8, height: 8, borderRadius: '50%', background: 'var(--nexus-muted)', flexShrink: 0 },
  projectDotActive: { width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0 },
  projectName: { flex: 1, fontSize: 14, color: 'var(--nexus-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  channelCount: { fontSize: 12, color: 'var(--nexus-text2)', fontFamily: 'monospace' },

  // 空状态
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', color: 'var(--nexus-muted)' },
  emptyIcon: { fontSize: 32, marginBottom: 8, opacity: 0.5 },
  emptyText: { fontSize: 13 },
  emptyMsg: { color: 'var(--nexus-muted)', fontSize: 13, padding: '12px 16px' },

  // 新建按钮
  addBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, margin: '8px 16px', padding: '8px 12px', background: 'transparent', border: '1px dashed var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text2)', fontSize: 13, cursor: 'pointer' },

  // 长按菜单
  menuOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 150 },
  longPressMenu: { position: 'fixed', transform: 'translateX(-50%)', background: 'var(--nexus-bg)', border: '1px solid var(--nexus-border)', borderRadius: 8, padding: '4px 0', minWidth: 120, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', zIndex: 151 },
  menuItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'transparent', border: 'none', color: 'var(--nexus-text)', fontSize: 14, cursor: 'pointer', width: '100%', textAlign: 'left' },
  menuItemDanger: { color: 'var(--nexus-error)' },
  menuDivider: { height: 1, background: 'var(--nexus-border)', margin: '4px 0' },
}
