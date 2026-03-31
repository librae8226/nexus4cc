import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

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
  const { t } = useTranslation()
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

  // 长按检测 refs（仅用于 channel）
  const longPressTimerRef = useRef<number | null>(null)
  const longPressChannelRef = useRef<Channel | null>(null)
  const isLongPressRef = useRef(false)

  // 长按菜单状态
  const [longPressMenu, setLongPressMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)

  // 按下状态（用于视觉反馈）
  const [pressedChannel, setPressedChannel] = useState<number | null>(null)

  // Project 菜单状态（类似 channel 的三点菜单）
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null)

  // 加载 Projects 列表
  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      const r = await fetch('/api/projects', { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: Project[] = await r.json()
      setProjects(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('sessionMgr.loadFailed'))
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
      setError(e instanceof Error ? e.message : t('sessionMgr.switchFailed'))
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
      // 显示长按菜单，带边界检测
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const menuWidth = 120
      const menuHeight = 80
      let x = rect.left + rect.width / 2
      let y = rect.bottom + 8
      // 右边界检测
      if (x + menuWidth / 2 > window.innerWidth - 16) {
        x = window.innerWidth - menuWidth / 2 - 16
      }
      // 左边界检测
      if (x - menuWidth / 2 < 16) {
        x = menuWidth / 2 + 16
      }
      // 下边界检测
      if (y + menuHeight > window.innerHeight - 16) {
        y = rect.top - menuHeight - 8
      }
      setLongPressMenu({
        channel,
        x,
        y,
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
    const newName = window.prompt(`${t('common.rename')} Channel:`, channel.name)
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
      setError(e instanceof Error ? e.message : t('sessionMgr.renameFailed'))
    }
  }

  // 处理关闭 channel
  const handleCloseChannel = async (channel: Channel) => {
    setLongPressMenu(null)
    setChannelMenu(null)

    try {
      const r = await fetch(`/api/sessions/${channel.index}?session=${encodeURIComponent(currentProject)}`, {
        method: 'DELETE',
        headers,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      fetchChannels(currentProject)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('sessionMgr.closeFailed'))
    }
  }

  // 处理重命名 project
  const handleRenameProject = async (project: Project) => {
    setProjectMenu(null)
    const newName = window.prompt(`${t('common.rename')} Project:`, project.name)
    if (!newName || newName === project.name) return

    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}/rename`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      fetchProjects()
      // 如果重命名的是当前 project，需要通知父组件
      if (project.name === currentProject) {
        onSwitchProject(newName)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('sessionMgr.renameFailed'))
    }
  }

  // 处理关闭 project
  const handleCloseProject = async (project: Project) => {
    setProjectMenu(null)

    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}`, {
        method: 'DELETE',
        headers,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // 刷新 project 列表
      fetchProjects()
      // 如果关闭的是当前 project，需要切换
      if (project.name === currentProject) {
        // 找一个其他 project 切换
        const remaining = projects.filter(p => p.name !== project.name)
        if (remaining.length > 0) {
          handleProjectClick(remaining[0])
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('sessionMgr.closeFailed'))
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
    <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
      <GhostShield />
      <div className={isDesktop ? 'bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[420px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden' : 'fixed inset-0 bg-nexus-bg flex flex-col text-nexus-text'}>
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border shrink-0">
          <span className="text-base font-semibold">{t('sessionMgr.title')}</span>
          <div className="flex items-center gap-2">
            <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center" onPointerDown={handleRefresh} title="刷新">
              <Icon name="refresh" size={16} />
            </button>
            <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center" onPointerDown={onClose}>
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/15 text-nexus-error px-4 py-2.5 text-sm flex items-center justify-between border-b border-nexus-border">
            {error}
            <button className="bg-transparent border-none text-nexus-error cursor-pointer p-0.5" onPointerDown={() => setError(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto flex flex-col">
          {/* ========== Channel 列表区域（上部）========== */}
          <div className="py-3 flex-1 flex flex-col min-h-[120px]">
            {/* Channel 标题栏 */}
            <div className="px-4 pb-2 border-b border-nexus-border mb-2">
              <div>
                <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center gap-1.5">
                  <span className="text-sm">📂</span>
                  {currentProjectInfo?.name || currentProject || t('sessionMgr.noProject')}
                </div>
                {currentProjectInfo?.path && (
                  <div className="text-[11px] text-nexus-text-2 mt-0.5 font-mono overflow-hidden text-ellipsis whitespace-nowrap" title={currentProjectInfo.path}>
                    {formatPath(currentProjectInfo.path)}
                  </div>
                )}
              </div>
            </div>

            {/* Channel 列表 */}
            <div className="flex-1 overflow-y-auto px-2 py-1">
              {loadingChannels ? (
                <div className="text-nexus-muted text-sm px-4 py-3">{t('common.loading')}</div>
              ) : channels.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-6 text-nexus-muted">
                  <div className="text-[32px] mb-2 opacity-50">#</div>
                  <div className="text-sm">{t('sessionMgr.noChannels')}</div>
                </div>
              ) : (
                channels.map(channel => {
                  const isActive = channel.index === currentChannelIndex
                  const status = getChannelStatus(channel, isActive)
                  return (
                    <div
                      key={channel.index}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer mb-0.5 select-none touch-manipulation transition-colors duration-75 ${isActive ? 'bg-nexus-bg-2' : ''} ${pressedChannel === channel.index ? 'bg-nexus-border transition-none' : ''}`}
                      style={{ WebkitTouchCallout: 'none', WebkitTapHighlightColor: 'rgba(128,128,128,0.3)' }}
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
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: STATUS_DOT[status] }}
                        title={status}
                      />
                      <span className="text-nexus-text-2 text-[13px] font-medium select-none">#</span>
                      <span className="flex-1 text-sm text-nexus-text overflow-hidden text-ellipsis whitespace-nowrap">{channel.name}</span>
                      {/* 三个点菜单按钮 */}
                      <button
                        className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-60 transition-opacity duration-150"
                        onTouchStart={(e) => {
                          // 阻止触摸事件冒泡，防止触发父元素的 channel 切换
                          e.stopPropagation()
                        }}
                        onTouchEnd={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const menuWidth = 120
                          const menuHeight = 80
                          let x = rect.left + rect.width / 2
                          let y = rect.bottom + 8
                          // 右边界检测
                          if (x + menuWidth / 2 > window.innerWidth - 16) {
                            x = window.innerWidth - menuWidth / 2 - 16
                          }
                          // 左边界检测
                          if (x - menuWidth / 2 < 16) {
                            x = menuWidth / 2 + 16
                          }
                          // 下边界检测
                          if (y + menuHeight > window.innerHeight - 16) {
                            y = rect.top - menuHeight - 8
                          }
                          setChannelMenu({
                            channel,
                            x,
                            y,
                          })
                        }}
                        onPointerDown={(e) => {
                          // PC 端：阻止冒泡
                          e.stopPropagation()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const menuWidth = 120
                          const menuHeight = 80
                          let x = rect.left + rect.width / 2
                          let y = rect.bottom + 8
                          // 右边界检测
                          if (x + menuWidth / 2 > window.innerWidth - 16) {
                            x = window.innerWidth - menuWidth / 2 - 16
                          }
                          // 左边界检测
                          if (x - menuWidth / 2 < 16) {
                            x = menuWidth / 2 + 16
                          }
                          // 下边界检测
                          if (y + menuHeight > window.innerHeight - 16) {
                            y = rect.top - menuHeight - 8
                          }
                          setChannelMenu({
                            channel,
                            x,
                            y,
                          })
                        }}
                        title={t('sessionMgr.moreOptions')}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            {/* 新建 Channel 按钮 */}
            <button className="flex items-center justify-center gap-1.5 mx-4 my-2 px-3 py-2 bg-transparent border border-dashed border-nexus-border rounded-md text-nexus-text-2 text-sm cursor-pointer" onPointerDown={onNewChannel}>
              <Icon name="plus" size={14} />
              <span>{t('sessionMgr.newChannel')}</span>
            </button>

            {/* Channel 菜单（长按或点击三个点） */}
            {(longPressMenu || channelMenu) && (
              <>
                <div
                  className="fixed inset-0 z-[150]"
                  onPointerDown={() => {
                    setLongPressMenu(null)
                    setChannelMenu(null)
                  }}
                />
                <div
                  className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
                  style={{
                    left: (longPressMenu || channelMenu)!.x,
                    top: (longPressMenu || channelMenu)!.y,
                    transform: 'translateX(-50%)',
                  }}
                >
                  <button
                    className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left"
                    onPointerDown={() => handleRenameChannel((longPressMenu || channelMenu)!.channel)}
                  >
                    <Icon name="pencil" size={14} />
                    <span>{t('common.rename')}</span>
                  </button>
                  <div className="h-px bg-nexus-border my-1" />
                  <button
                    className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left"
                    onPointerDown={() => handleCloseChannel((longPressMenu || channelMenu)!.channel)}
                  >
                    <Icon name="x" size={14} />
                    <span>{t('common.close')}</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 分隔线 */}
          <div className="h-0.5 bg-nexus-border my-2" />

          {/* ========== Project 列表区域（下部）========== */}
          <div className="py-3 flex-1 flex flex-col bg-nexus-bg-2 min-h-[120px]">
            <div className="px-4 pb-2 border-b border-nexus-border mb-2">
              <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center gap-1.5">
                <span className="text-sm">📁</span>
                {t('sessionMgr.projects')}
              </div>
            </div>

            {/* Project 列表 */}
            <div className="flex-1 overflow-y-auto px-2 py-1">
              {loadingProjects ? (
                <div className="text-nexus-muted text-sm px-4 py-3">{t('common.loading')}</div>
              ) : projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-6 text-nexus-muted">
                  <div className="text-[32px] mb-2 opacity-50">📁</div>
                  <div className="text-sm">{t('sessionMgr.noProjects')}</div>
                </div>
              ) : (
                projects.map(project => {
                  const isActive = project.name === currentProject
                  return (
                    <div
                      key={project.name}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md cursor-pointer mb-0.5 select-none touch-manipulation ${isActive ? 'bg-blue-500/15' : ''}`}
                      style={{ WebkitTouchCallout: 'none', WebkitTapHighlightColor: 'rgba(128,128,128,0.3)' }}
                      onPointerDown={() => {
                        if (project.name !== currentProject) {
                          handleProjectClick(project)
                        }
                      }}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-blue-500' : 'bg-nexus-muted'}`} />
                      <span className="flex-1 text-sm text-nexus-text overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
                      <span className="text-xs text-nexus-text-2 font-mono">({project.channelCount})</span>
                      {/* 三个点菜单按钮 */}
                      <button
                        className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-60 transition-opacity duration-150"
                        onTouchStart={(e) => {
                          e.stopPropagation()
                        }}
                        onTouchEnd={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const menuWidth = 140 // 菜单最小宽度估算
                          const menuHeight = 100 // 菜单高度估算
                          let x = rect.left + rect.width / 2
                          let y = rect.bottom + 8
                          // 右边界检测
                          if (x + menuWidth / 2 > window.innerWidth - 16) {
                            x = window.innerWidth - menuWidth / 2 - 16
                          }
                          // 左边界检测
                          if (x - menuWidth / 2 < 16) {
                            x = menuWidth / 2 + 16
                          }
                          // 下边界检测 - 如果下方空间不足，显示在按钮上方
                          if (y + menuHeight > window.innerHeight - 16) {
                            y = rect.top - menuHeight - 8
                          }
                          setProjectMenu({
                            project,
                            x,
                            y,
                          })
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const menuWidth = 140
                          const menuHeight = 100
                          let x = rect.left + rect.width / 2
                          let y = rect.bottom + 8
                          // 右边界检测
                          if (x + menuWidth / 2 > window.innerWidth - 16) {
                            x = window.innerWidth - menuWidth / 2 - 16
                          }
                          // 左边界检测
                          if (x - menuWidth / 2 < 16) {
                            x = menuWidth / 2 + 16
                          }
                          // 下边界检测
                          if (y + menuHeight > window.innerHeight - 16) {
                            y = rect.top - menuHeight - 8
                          }
                          setProjectMenu({
                            project,
                            x,
                            y,
                          })
                        }}
                        title={t('sessionMgr.moreOptions')}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            {/* 新建 Project 按钮 */}
            <button className="flex items-center justify-center gap-1.5 mx-4 my-2 px-3 py-2 bg-transparent border border-dashed border-nexus-border rounded-md text-nexus-text-2 text-sm cursor-pointer" onPointerDown={onNewProject}>
              <Icon name="plus" size={14} />
              <span>{t('sessionMgr.newProject')}</span>
            </button>

            {/* Project 菜单 */}
            {projectMenu && (
              <>
                <div
                  className="fixed inset-0 z-[150]"
                  onPointerDown={() => setProjectMenu(null)}
                />
                <div
                  className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
                  style={{
                    left: projectMenu.x,
                    top: projectMenu.y,
                    transform: 'translateX(-50%)',
                  }}
                >
                  <div className="px-4 py-2 text-xs font-semibold text-nexus-text-2 border-b border-nexus-border mb-1">{projectMenu.project.name}</div>
                  <button
                    className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left"
                    onPointerDown={() => handleRenameProject(projectMenu.project)}
                  >
                    <Icon name="pencil" size={14} />
                    <span>{t('common.rename')}</span>
                  </button>
                  <div className="h-px bg-nexus-border my-1" />
                  <button
                    className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left"
                    onPointerDown={() => handleCloseProject(projectMenu.project)}
                  >
                    <Icon name="x" size={14} />
                    <span>{t('sessionMgr.closeProject')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
