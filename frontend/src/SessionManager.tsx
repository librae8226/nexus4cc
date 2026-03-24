import { useState, useEffect } from 'react'
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

interface Config {
  id: string
  label: string
  BASE_URL?: string
  AUTH_TOKEN?: string
  API_KEY?: string
  DEFAULT_MODEL?: string
  THINK_MODEL?: string
  LONG_CONTEXT_MODEL?: string
  DEFAULT_HAIKU_MODEL?: string
  API_TIMEOUT_MS?: string
}

interface Props {
  token: string
  onClose: () => void
}

const EMPTY_CONFIG: Omit<Config, 'id'> = {
  label: '',
  BASE_URL: '',
  AUTH_TOKEN: '',
  API_KEY: '',
  DEFAULT_MODEL: '',
  THINK_MODEL: '',
  LONG_CONTEXT_MODEL: '',
  DEFAULT_HAIKU_MODEL: '',
  API_TIMEOUT_MS: '3000000',
}

export default function SessionManager({ token, onClose }: Props) {
  const isDesktop = useIsDesktop()

  const [configs, setConfigs] = useState<Config[]>([])
  const [loadingCfg, setLoadingCfg] = useState(false)
  const [editingConfig, setEditingConfig] = useState<(Config & { isNew: boolean }) | null>(null)
  const [savingCfg, setSavingCfg] = useState(false)
  const [cfgError, setCfgError] = useState<string | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  async function fetchConfigs() {
    setLoadingCfg(true)
    try {
      const r = await fetch('/api/configs', { headers })
      setConfigs(r.ok ? await r.json() : [])
    } catch { setConfigs([]) }
    finally { setLoadingCfg(false) }
  }

  useEffect(() => { fetchConfigs() }, [])

  async function saveConfig() {
    if (!editingConfig) return
    const { id, isNew, ...data } = editingConfig
    if (!id.trim() || !data.label.trim()) { setCfgError('ID 和名称不能为空'); return }
    setSavingCfg(true); setCfgError(null)
    try {
      const r = await fetch(`/api/configs/${id.trim()}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setEditingConfig(null)
      await fetchConfigs()
    } catch (e: unknown) {
      setCfgError(e instanceof Error ? e.message : '保存失败')
    } finally { setSavingCfg(false) }
  }

  async function deleteConfig(id: string) {
    try {
      await fetch(`/api/configs/${id}`, { method: 'DELETE', headers })
      await fetchConfigs()
    } catch { /* ignore */ }
  }

  // ── 配置编辑面板 ──
  if (editingConfig) {
    const fields: Array<{ key: keyof typeof EMPTY_CONFIG; label: string; placeholder: string; secret?: boolean }> = [
      { key: 'label',              label: '显示名称',      placeholder: 'Kimi (kimi-for-coding)' },
      { key: 'BASE_URL',           label: 'API Base URL',  placeholder: 'https://api.kimi.com/coding' },
      { key: 'AUTH_TOKEN',         label: 'Auth Token',    placeholder: 'sk-...', secret: true },
      { key: 'API_KEY',            label: 'API Key',       placeholder: '（通常留空，用 Auth Token）', secret: true },
      { key: 'DEFAULT_MODEL',      label: '默认模型',      placeholder: 'kimi-for-coding' },
      { key: 'THINK_MODEL',        label: '思考模型',      placeholder: 'kimi-for-coding' },
      { key: 'LONG_CONTEXT_MODEL', label: '长上下文模型',  placeholder: 'kimi-for-coding' },
      { key: 'DEFAULT_HAIKU_MODEL',label: 'Haiku 模型',   placeholder: 'kimi-for-coding' },
      { key: 'API_TIMEOUT_MS',     label: 'Timeout (ms)',  placeholder: '3000000' },
    ]
    return (
      <div style={isDesktop ? s.desktopOverlay : s.overlay}>
        <div style={isDesktop ? s.desktopPanel : s.panel}>
          <div style={s.header}>
            <span style={s.title}>{editingConfig.isNew ? '新建配置' : '编辑配置'}</span>
            <button style={{...s.closeBtn, display: 'flex', alignItems: 'center', justifyContent: 'center'}} onPointerDown={() => { setEditingConfig(null); setCfgError(null) }}><Icon name="x" size={20} /></button>
          </div>
          <div style={s.scrollArea}>
            <div style={s.section}>
              {cfgError && <div style={s.errorMsg}>{cfgError}</div>}
              {/* ID 字段只在新建时可编辑 */}
              <div style={isDesktop ? s.desktopFormRow : s.formRow}>
                <label style={isDesktop ? s.desktopLabel : s.label}>配置 ID（唯一标识）</label>
                <input
                  style={isDesktop ? s.desktopInput : s.input}
                  value={editingConfig.id}
                  readOnly={!editingConfig.isNew}
                  onChange={e => setEditingConfig(c => c && { ...c, id: e.target.value.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() })}
                  placeholder="kimi"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                />
              </div>
              {fields.map(f => (
                <div key={f.key} style={isDesktop ? s.desktopFormRow : s.formRow}>
                  <label style={isDesktop ? s.desktopLabel : s.label}>{f.label}</label>
                  <input
                    style={isDesktop ? s.desktopInput : s.input}
                    type={f.secret ? 'password' : 'text'}
                    value={(editingConfig as unknown as Record<string, string>)[f.key] ?? ''}
                    onChange={e => setEditingConfig(c => c && { ...c, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  />
                </div>
              ))}
              <button
                style={{ ...s.createBtn, ...(savingCfg ? s.createBtnDisabled : {}) }}
                onPointerDown={() => { if (!savingCfg) saveConfig() }}
                disabled={savingCfg}
              >
                {savingCfg ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={isDesktop ? s.desktopOverlay : s.overlay}>
      <GhostShield />
      <div style={isDesktop ? s.desktopPanel : s.panel}>
        {/* 顶部：标题 + 关闭 */}
        <div style={s.header}>
          <span style={s.title}>API 配置管理</span>
          <button style={{...s.closeBtn, display: 'flex', alignItems: 'center', justifyContent: 'center'}} onPointerDown={onClose}><Icon name="x" size={20} /></button>
        </div>

        {/* 配置列表 */}
        <div style={s.scrollArea}>
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <span style={s.sectionTitle}>API 配置 Profiles</span>
              <button
                style={s.refreshBtn}
                onPointerDown={() => setEditingConfig({ id: '', isNew: true, ...EMPTY_CONFIG })}
              >
                + 新建
              </button>
            </div>
            {loadingCfg && <div style={s.emptyMsg}>加载中...</div>}
            {!loadingCfg && configs.length === 0 && (
              <div style={s.emptyMsg}>暂无配置。点击「+ 新建」添加 API 配置。</div>
            )}
            {configs.map(cfg => (
              <div key={cfg.id} style={s.configRow}>
                <div style={s.configInfo}>
                  <div style={s.configLabel}>{cfg.label}</div>
                  <div style={s.configMeta}>{cfg.id} · {cfg.DEFAULT_MODEL || '—'}</div>
                </div>
                <div style={s.configActions}>
                  <button
                    style={s.editBtn}
                    onPointerDown={() => setEditingConfig({ id: cfg.id, isNew: false, label: cfg.label, BASE_URL: cfg.BASE_URL, AUTH_TOKEN: cfg.AUTH_TOKEN, API_KEY: cfg.API_KEY, DEFAULT_MODEL: cfg.DEFAULT_MODEL, THINK_MODEL: cfg.THINK_MODEL, LONG_CONTEXT_MODEL: cfg.LONG_CONTEXT_MODEL, DEFAULT_HAIKU_MODEL: cfg.DEFAULT_HAIKU_MODEL, API_TIMEOUT_MS: cfg.API_TIMEOUT_MS })}
                  >编辑</button>
                  <button
                    style={s.deleteBtn}
                    onPointerDown={() => deleteConfig(cfg.id)}
                  >删除</button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ ...s.section, color: 'var(--nexus-text2)', fontSize: 11, lineHeight: 1.6 }}>
            <div style={s.sectionTitle}>说明</div>
            <p>每个配置对应一个 API provider。新建会话时选择配置后，会以该 provider 的 API key 启动 claude，且每个项目的会话历史独立保存在项目目录的 <code style={s.code}>.claude-data/</code> 中，退出后再次进入可自动续接上下文。</p>
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
  desktopPanel: { background: 'var(--nexus-bg)', border: '1px solid var(--nexus-border)', borderRadius: 12, display: 'flex', flexDirection: 'column', color: 'var(--nexus-text)', width: '100%', maxWidth: 800, maxHeight: '85vh', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', overflow: 'hidden' },

  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--nexus-border)', flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 600 },
  closeBtn: { background: 'transparent', border: 'none', color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 24, lineHeight: 1, padding: '0 4px' },
  scrollArea: { flex: 1, overflowY: 'auto', padding: '8px 0' },
  section: { padding: '12px 16px', borderBottom: '1px solid var(--nexus-border)' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 11, color: 'var(--nexus-text2)', letterSpacing: 0.5, textTransform: 'uppercase' as const, marginBottom: 8 },
  refreshBtn: { background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 4, color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 11, padding: '2px 8px' },
  errorMsg: { color: 'var(--nexus-error)', fontSize: 12, marginBottom: 8 },
  emptyMsg: { color: 'var(--nexus-muted)', fontSize: 13, padding: '8px 0' },

  // 移动端表单样式
  formRow: { display: 'flex', flexDirection: 'column' as const, gap: 4, marginBottom: 10 },
  label: { color: 'var(--nexus-text2)', fontSize: 12 },
  input: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, padding: '8px 10px', outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  inputDisabled: { opacity: 0.5 },

  // PC 端表单样式（左右布局）
  desktopFormRow: { display: 'flex', flexDirection: 'row' as const, alignItems: 'center', gap: 16, marginBottom: 12 },
  desktopLabel: { color: 'var(--nexus-text2)', fontSize: 13, width: 140, flexShrink: 0, textAlign: 'right' as const },
  desktopInput: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, padding: '10px 12px', outline: 'none', flex: 1, boxSizing: 'border-box' as const },

  select: { background: 'var(--nexus-bg2)', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text)', fontSize: 14, padding: '8px 10px', outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  hint: { color: 'var(--nexus-muted)', fontSize: 11, marginBottom: 10, lineHeight: 1.6 },
  code: { background: 'var(--nexus-bg2)', borderRadius: 3, padding: '1px 4px', fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace', fontSize: 10, color: 'var(--nexus-accent)' },
  createBtn: { background: 'var(--nexus-accent)', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: '10px 20px', width: '100%' },
  createBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  logoutBtn: { background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 6, color: 'var(--nexus-text2)', cursor: 'pointer', fontSize: 14, padding: '10px 20px', width: '100%' },
  configRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--nexus-border)' },
  configInfo: { flex: 1 },
  configLabel: { color: 'var(--nexus-text)', fontSize: 14 },
  configMeta: { color: 'var(--nexus-muted)', fontSize: 11, marginTop: 2, fontFamily: 'monospace' },
  configActions: { display: 'flex', gap: 6, flexShrink: 0 },
  editBtn: { background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 4, color: 'var(--nexus-accent)', cursor: 'pointer', fontSize: 11, padding: '3px 8px' },
  deleteBtn: { background: 'transparent', border: '1px solid var(--nexus-border)', borderRadius: 4, color: 'var(--nexus-error)', cursor: 'pointer', fontSize: 11, padding: '3px 8px' },
}
