import { useState, useEffect } from 'react'

interface Workspace {
  name: string
  path: string
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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState('~')
  const [inputPath, setInputPath] = useState('~')
  const [shellType, setShellType] = useState<'claude' | 'bash'>('claude')
  const [configs, setConfigs] = useState<Config[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')

  const headers = { Authorization: `Bearer ${token}` }

  async function fetchWorkspaces() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/workspaces', { headers })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setWorkspaces(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '加载失败')
      setWorkspaces([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWorkspaces()
    fetchConfigs()
  }, [])

  async function fetchConfigs() {
    try {
      const r = await fetch('/api/configs', { headers })
      if (r.ok) {
        const data = await r.json()
        setConfigs(data)
      }
    } catch {
      // ignore
    }
  }

  function handleSelect(workspace: Workspace) {
    setSelectedPath(workspace.path)
    setInputPath(workspace.path)
  }

  function handleInputChange(value: string) {
    setInputPath(value)
    setSelectedPath(value)
  }

  function handleConfirm() {
    const path = inputPath.trim()
    if (!path) return
    const profile = shellType === 'claude' && selectedProfile ? selectedProfile : undefined
    onConfirm(path, shellType, profile)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleConfirm()
    }
  }

  return (
    <div style={isDesktop ? s.desktopOverlay : s.overlay}>
      <div style={isDesktop ? s.desktopPanel : s.panel}>
        {/* 顶部：标题 + 关闭 */}
        <div style={s.header}>
          <span style={s.title}>选择工作目录</span>
          <button style={s.closeBtn} onPointerDown={onClose}>×</button>
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
                <span>Bash</span>
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
                onChange={(e) => setSelectedProfile(e.target.value)}
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

          {/* 常用目录列表 */}
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span style={s.sectionTitle}>工作区目录</span>
              <button style={s.refreshBtn} onPointerDown={fetchWorkspaces}>刷新</button>
            </div>
            {error && <div style={s.errorMsg}>{error}</div>}
            {loading && <div style={s.emptyMsg}>加载中...</div>}
            {!loading && workspaces.length === 0 && !error && (
              <div style={s.emptyMsg}>暂无工作区目录</div>
            )}
            <div style={s.workspaceList}>
              {workspaces.map(ws => (
                <div
                  key={ws.path}
                  style={{
                    ...s.workspaceItem,
                    ...(selectedPath === ws.path ? s.workspaceItemSelected : {}),
                  }}
                  onPointerDown={() => handleSelect(ws)}
                >
                  <span style={s.workspaceIcon}>📁</span>
                  <span style={s.workspaceName}>{ws.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div style={s.footer}>
          <button style={s.cancelBtn} onPointerDown={onClose}>取消</button>
          <button style={s.confirmBtn} onPointerDown={handleConfirm}>创建会话</button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // 移动端样式（默认）
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 },
  panel: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#0f172a', display: 'flex', flexDirection: 'column', color: '#e2e8f0' },

  // PC 端样式
  desktopOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  desktopPanel: { background: '#0f172a', borderRadius: 12, display: 'flex', flexDirection: 'column', color: '#e2e8f0', width: '100%', maxWidth: 600, maxHeight: '85vh', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', overflow: 'hidden' },

  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #334155', flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 600 },
  closeBtn: { background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 24, lineHeight: 1, padding: '0 4px' },
  scrollArea: { flex: 1, overflowY: 'auto', padding: '8px 0' },
  section: { padding: '12px 16px', borderBottom: '1px solid #1e293b' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 11, color: '#64748b', letterSpacing: 0.5, textTransform: 'uppercase' as const, marginBottom: 8 },
  selectedPath: { fontSize: 14, color: '#93c5fd', fontFamily: 'monospace', padding: '8px 12px', background: '#1e293b', borderRadius: 6, wordBreak: 'break-all' as const },
  refreshBtn: { background: 'transparent', border: '1px solid #334155', borderRadius: 4, color: '#94a3b8', cursor: 'pointer', fontSize: 11, padding: '2px 8px' },
  errorMsg: { color: '#f87171', fontSize: 12, marginBottom: 8 },
  emptyMsg: { color: '#475569', fontSize: 13, padding: '8px 0' },
  hint: { color: '#64748b', fontSize: 11, marginTop: 6 },
  radioGroup: { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  radioLabel: { display: 'flex', alignItems: 'center', gap: 8, color: '#e2e8f0', fontSize: 14, cursor: 'pointer' },
  select: { background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0', fontSize: 14, padding: '8px 10px', width: '100%', outline: 'none' },

  // 移动端表单样式
  formRow: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  input: { background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0', fontSize: 14, padding: '8px 10px', outline: 'none', width: '100%', boxSizing: 'border-box' as const },

  // PC 端表单样式
  desktopFormRow: { display: 'flex', flexDirection: 'row' as const, alignItems: 'center', gap: 16 },
  desktopInput: { background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0', fontSize: 14, padding: '10px 12px', outline: 'none', flex: 1, boxSizing: 'border-box' as const },

  // 工作区列表
  workspaceList: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  workspaceItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', transition: 'background 0.15s' },
  workspaceItemSelected: { background: '#1e293b', border: '1px solid #3b82f6' },
  workspaceIcon: { fontSize: 16 },
  workspaceName: { fontSize: 14, color: '#e2e8f0' },

  // 底部按钮
  footer: { display: 'flex', gap: 12, padding: '12px 16px', borderTop: '1px solid #334155', flexShrink: 0, justifyContent: 'flex-end' },
  cancelBtn: { background: 'transparent', border: '1px solid #334155', borderRadius: 6, color: '#94a3b8', cursor: 'pointer', fontSize: 14, padding: '8px 16px' },
  confirmBtn: { background: '#3b82f6', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: '8px 16px' },
}
