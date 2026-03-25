import { useState, useEffect } from 'react'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface BrowseResult {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

interface Config {
  id: string
  label: string
}

interface Props {
  token: string
  onClose: () => void
  onConfirm: (path: string, shellType: 'claude' | 'bash', profile?: string) => void
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

export default function WorkspaceSelector({ token, onClose, onConfirm }: Props) {
  const isDesktop = useIsDesktop()
  const [selectedPath, setSelectedPath] = useState(() => localStorage.getItem('nexus_last_path') || '~')
  const [inputPath, setInputPath] = useState(() => localStorage.getItem('nexus_last_path') || '~')
  const [shellType, setShellType] = useState<'claude' | 'bash'>('claude')
  const [configs, setConfigs] = useState<Config[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>(() => localStorage.getItem('nexus_last_profile') || '')

  // 文件浏览器状态
  const [browsePath, setBrowsePath] = useState<string | null>(null)
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([])
  const [browseParent, setBrowseParent] = useState<string | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  async function browseDir(path: string | null) {
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse'
      const r = await fetch(url, { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: BrowseResult = await r.json()
      setBrowsePath(data.path)
      setBrowseDirs(data.dirs)
      setBrowseParent(data.parent)
    } catch (e: unknown) {
      setBrowseError(e instanceof Error ? e.message : '浏览失败')
    } finally {
      setBrowseLoading(false)
    }
  }

  useEffect(() => {
    fetchConfigs()
    browseDir(null)
  }, [])

  async function fetchConfigs() {
    try {
      const r = await fetch('/api/configs', { headers })
      if (r.ok) {
        const data = await r.json()
        setConfigs(data)
        if (!localStorage.getItem('nexus_last_profile') && data.length > 0) {
          setSelectedProfile(data[0].id)
        }
      }
    } catch {
      // ignore
    }
  }

  function handleSelect(path: string) {
    setSelectedPath(path)
    setInputPath(path)
  }

  function handleInputChange(value: string) {
    setInputPath(value)
    setSelectedPath(value)
  }

  function handleProfileChange(id: string) {
    setSelectedProfile(id)
    if (id) localStorage.setItem('nexus_last_profile', id)
  }

  function handleConfirm() {
    const path = inputPath.trim()
    if (!path) return
    const profile = shellType === 'claude' && selectedProfile ? selectedProfile : undefined
    localStorage.setItem('nexus_last_path', path)
    if (profile) localStorage.setItem('nexus_last_profile', profile)
    onConfirm(path, shellType, profile)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleConfirm()
    }
  }

  // 截断路径显示：只显示最后几个片段
  function formatBrowsePath(p: string | null): string {
    if (!p) return '~'
    const parts = p.split('/').filter(Boolean)
    if (parts.length <= 3) return '/' + parts.join('/')
    return '.../' + parts.slice(-2).join('/')
  }

  return (
    <div style={isDesktop ? s.desktopOverlay : s.overlay}>
      <GhostShield />
      <div style={isDesktop ? s.desktopPanel : s.panel}>
        {/* 顶部：标题 + 关闭 */}
        <div style={s.header}>
          <span style={s.title}>选择工作目录</span>
          <button style={{...s.closeBtn, display: 'flex', alignItems: 'center', justifyContent: 'center'}} onPointerDown={onClose}><Icon name="x" size={20} /></button>
        </div>

        {/* 内容区域 */}
        <div style={s.scrollArea}>
          {/* 当前选择 */}
          <div style={s.section}>
            <div style={s.sectionTitle}>当前选择</div>
            <div style={s.selectedPath}>{selectedPath || '~'}</div>
          </div>

          {/* 手动输入 */}
          <div style={s.section}>
            <div style={s.sectionTitle}>输入路径</div>
            <div style={isDesktop ? s.desktopFormRow : s.formRow}>
              <input
                style={isDesktop ? s.desktopInput : s.input}
                value={inputPath}
                onChange={e => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="~ 或 /path/to/project"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div style={s.hint}>支持 ~ 表示 home 目录，或直接输入绝对路径</div>
          </div>

          {/* Shell 类型选择 */}
          <div style={s.section}>
            <div style={s.sectionTitle}>Shell 类型</div>
            <div style={s.radioGroup}>
              <label style={s.radioLabel}>
                <input
                  type="radio"
                  name="shellType"
                  value="claude"
                  checked={shellType === 'claude'}
                  onChange={() => setShellType('claude')}
                />
                <span>Claude (默认)</span>
              </label>
              <label style={s.radioLabel}>
                <input
                  type="radio"
                  name="shellType"
                  value="bash"
                  checked={shellType === 'bash'}
                  onChange={() => setShellType('bash')}
                />
                <span>Zsh</span>
              </label>
            </div>
          </div>

          {/* Profile 选择 (仅 claude 模式) */}
          {shellType === 'claude' && (
            <div style={s.section}>
              <div style={s.sectionTitle}>配置 Profile (可选)</div>
              <select
                style={s.select}
                value={selectedProfile}
                onChange={(e) => handleProfileChange(e.target.value)}
              >
                <option value="">默认 (不使用 profile)</option>
                {configs.map((cfg) => (
                  <option key={cfg.id} value={cfg.id}>
                    {cfg.label}
                  </option>
                ))}
              </select>
              <div style={s.hint}>选择 profile 会使用该配置的 API key 和模型设置，数据隔离在项目目录</div>
            </div>
          )}

          {/* 目录浏览器 */}
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <div style={s.browsePathRow}>
                <span style={s.sectionTitle}>浏览目录</span>
                <span style={s.browseCurrent} title={browsePath || ''}>{formatBrowsePath(browsePath)}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {browsePath && (
                  <button
                    style={s.refreshBtn}
                    onPointerDown={() => handleSelect(browsePath)}
                    title="选择当前目录"
                  >选此目录</button>
                )}
                <button style={s.refreshBtn} onPointerDown={() => browseDir(null)}>根目录</button>
              </div>
            </div>
            {browseError && <div style={s.errorMsg}>{browseError}</div>}
            {browseLoading && <div style={s.emptyMsg}>加载中...</div>}
            {!browseLoading && (
              <div style={s.workspaceList}>
                {/* 向上一级 */}
                {browseParent && (
                  <div
                    style={s.browseUpItem}
                    onPointerDown={() => browseDir(browseParent)}
                  >
                    <span style={s.workspaceIcon}>↑</span>
                    <span style={{ ...s.workspaceName, color: 'var(--nexus-text2)' }}>..</span>
                    <span style={s.browseHint}>{browseParent.split('/').slice(-1)[0] || '/'}</span>
                  </div>
                )}
                {/* 子目录列表 */}
                {browseDirs.length === 0 && !browseLoading && (
                  <div style={s.emptyMsg}>无子目录</div>
                )}
                {browseDirs.map(dir => (
                  <div
                    key={dir.path}
                    style={{
                      ...s.browseItem,
                      ...(selectedPath === dir.path ? s.workspaceItemSelected : {}),
                    }}
                    onPointerDown={() => handleSelect(dir.path)}
                    onDoubleClick={() => browseDir(dir.path)}
                    title="单击选中，双击进入"
                  >
                    <span style={s.workspaceIcon}>📁</span>
                    <span style={s.workspaceName}>{dir.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* 底部按钮 */}
        <div style={s.footer}>
          <button style={s.cancelBtn} onPointerDown={onClose}>取消</button>
          <button style={s.confirmBtn} onPointerDown={handleConfirm}>创建</button>
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
  desktopPanel: { background: 'var(--nexus-bg)', border: '1px solid var(--nexus-border)', borderRadius: 12, display: 'flex', flexDirection: 'column', color: 'var(--nexus-text)', width: '100%', maxWidth: 600, maxHeight: '85vh', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', overflow: 'hidden' },

  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--nexus-border)', flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 600 },
  closeBtn: { background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 24, lineHeight: 1, padding: '0 4px' },
  scrollArea: { flex: 1, overflowY: 'auto', padding: '8px 0' },
  section: { padding: '12px 16px', borderBottom: '1px solid var(--nexus-border)' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 11, color: 'var(--nexus-text2)', letterSpacing: 0.5, textTransform: 'uppercase' as const, marginBottom: 0 },
  selectedPath: { fontSize: 14, color: 'var(--nexus-accent)', fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace', padding: '8px 12px', background: 'var(--nexus-bg2)', borderRadius: 6, wordBreak: 'break-all' as const },
  refreshBtn: { background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 4, color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 11, padding: '2px 8px', flexShrink: 0 },
  errorMsg: { color: 'var(--nexus-error)', fontSize: 12, marginBottom: 8 },
  emptyMsg: { color: 'var(--nexus-muted)', fontSize: 13, padding: '8px 0' },
  hint: { color: 'var(--nexus-muted)', fontSize: 11, marginTop: 6 },
  radioGroup: { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  radioLabel: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--nexus-text)', fontSize: 14, cursor: 'pointer' },
  select: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, padding: '8px 10px', width: '100%', outline: 'none' },

  // 移动端表单样式
  formRow: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  input: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, padding: '8px 10px', outline: 'none', width: '100%', boxSizing: 'border-box' as const },

  // PC 端表单样式
  desktopFormRow: { display: 'flex', flexDirection: 'row' as const, alignItems: 'center', gap: 16 },
  desktopInput: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, padding: '10px 12px', outline: 'none', flex: 1, boxSizing: 'border-box' as const },

  // 浏览器路径行
  browsePathRow: { display: 'flex', alignItems: 'center', gap: 8 },
  browseCurrent: { fontSize: 11, color: 'var(--nexus-accent)', fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },

  // 工作区列表
  workspaceList: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  workspaceItemSelected: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-accent)' },
  workspaceIcon: { fontSize: 14, flexShrink: 0 },
  workspaceName: { fontSize: 14, color: 'var(--nexus-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },

  // 浏览器条目
  browseItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent' },
  browseUpItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', borderBottom: '1px solid var(--nexus-border)', marginBottom: 4 },
  browseHint: { fontSize: 11, color: 'var(--nexus-muted)', fontFamily: 'monospace' },

  // 底部按钮
  footer: { display: 'flex', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--nexus-border)', flexShrink: 0, justifyContent: 'flex-end' },
  cancelBtn: { background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 14, padding: '8px 16px' },
  confirmBtn: { background: 'var(--nexus-accent)', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: '8px 16px' },
}
