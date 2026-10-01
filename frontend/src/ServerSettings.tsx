// ServerSettings.tsx — 服务端地址编辑器（F-23.1）
//
// 【为什么必须出现在登录页】
// 登录请求本身就是「发给某个服务器」的，所以服务器地址必须先于登录存在。
// 在 APK 里没有配置地址 = 登录请求打到 WebView 自己的 origin = 必然失败，
// 而且失败得毫无线索（表现为「连接失败」）。因此 native 且无 profile 时，
// 登录页直接展开这个编辑器，而不是让用户对着一个必然失败的登录框发呆。
//
// 浏览器里默认折叠且无 profile，行为与改造前一致。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PROFILES_CHANGED_EVENT,
  getProfiles,
  getActiveProfile,
  upsertProfile,
  removeProfile,
  setActiveProfileId,
  newProfileId,
  normalizeUrl,
  isValidUrl,
  type ServerProfile,
} from './baseUrl'

interface Props {
  /** 没有可用 profile 时强制展开（APK 首次启动） */
  defaultOpen?: boolean
}

export default function ServerSettings({ defaultOpen = false }: Props) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<ServerProfile[]>(() => getProfiles())
  const [activeId, setActiveId] = useState<string | null>(() => getActiveProfile()?.id ?? null)
  const [open, setOpen] = useState(defaultOpen)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  // 本组件会写 localStorage，另一个入口（设置页）也会 —— 靠事件保持同步
  useEffect(() => {
    const sync = () => {
      setProfiles(getProfiles())
      setActiveId(getActiveProfile()?.id ?? null)
    }
    window.addEventListener(PROFILES_CHANGED_EVENT, sync)
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, sync)
  }, [])

  function startAdd() {
    setEditingId('')
    setName('')
    setUrl('')
    setError('')
    setOpen(true)
  }

  function startEdit(p: ServerProfile) {
    setEditingId(p.id)
    setName(p.name)
    setUrl(p.url)
    setError('')
  }

  function cancel() {
    setEditingId(null)
    setError('')
  }

  function save() {
    if (!isValidUrl(url)) {
      setError(t('server.invalidUrl'))
      return
    }
    const normalized = normalizeUrl(url)
    const id = editingId || newProfileId()
    upsertProfile({ id, name: name.trim() || normalized, url: normalized })
    // 刚保存的这套直接切过去 —— 新增地址的意图就是要用它
    setActiveProfileId(id)
    setEditingId(null)
    setError('')
  }

  function del(p: ServerProfile) {
    if (!window.confirm(t('server.deleteConfirm'))) return
    removeProfile(p.id)
    if (editingId === p.id) setEditingId(null)
  }

  const inputCls =
    'bg-nexus-bg border border-nexus-border rounded-lg text-nexus-text text-sm py-2 px-3 outline-none w-full'

  return (
    <div className="border-t border-nexus-border pt-4 mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full bg-transparent border-none text-nexus-text-2 text-sm cursor-pointer p-0"
      >
        <span>
          {t('server.sectionTitle')}
          {activeId && (
            <span className="text-nexus-text ml-2">
              {profiles.find((p) => p.id === activeId)?.url}
            </span>
          )}
        </span>
        <span className="text-nexus-text-2">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 mt-3">
          <p className="text-nexus-text-2 text-xs m-0">{t('server.sectionDesc')}</p>

          {profiles.length === 0 && editingId === null && (
            <p className="text-nexus-text-2 text-xs m-0">{t('server.empty')}</p>
          )}

          {profiles.map((p) => {
            const active = p.id === activeId
            if (editingId === p.id) {
              return (
                <div key={p.id} className="flex flex-col gap-2">
                  <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
                    placeholder={t('server.namePlaceholder')} />
                  <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)}
                    placeholder={t('server.urlPlaceholder')} autoCapitalize="none"
                    autoCorrect="off" spellCheck={false} />
                  {error && <p className="text-nexus-error text-xs m-0">{error}</p>}
                  <div className="flex gap-2">
                    <button type="button" onClick={save}
                      className="flex-1 bg-nexus-accent border-none rounded-lg text-white text-sm py-2 cursor-pointer">
                      {t('server.save')}
                    </button>
                    <button type="button" onClick={cancel}
                      className="flex-1 bg-nexus-bg border border-nexus-border rounded-lg text-nexus-text-2 text-sm py-2 cursor-pointer">
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <div key={p.id}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  active ? 'border-nexus-accent' : 'border-nexus-border'
                }`}>
                <button type="button" onClick={() => setActiveProfileId(p.id)}
                  className="flex-1 text-left bg-transparent border-none cursor-pointer p-0 min-w-0">
                  <div className="text-nexus-text text-sm truncate">{p.name}</div>
                  <div className="text-nexus-text-2 text-xs truncate">
                    {p.url}
                    {p.url.startsWith('http://') && (
                      <span className="ml-2" title={t('server.plaintextHint')}>
                        ⚠︎ {t('server.plaintext')}
                      </span>
                    )}
                  </div>
                </button>
                {active && <span className="text-nexus-accent text-xs shrink-0">{t('server.active')}</span>}
                <button type="button" onClick={() => startEdit(p)}
                  className="bg-transparent border-none text-nexus-text-2 text-xs cursor-pointer shrink-0 p-1">
                  {t('common.edit')}
                </button>
                <button type="button" onClick={() => del(p)}
                  className="bg-transparent border-none text-nexus-text-2 text-xs cursor-pointer shrink-0 p-1">
                  {t('common.delete')}
                </button>
              </div>
            )
          })}

          {editingId === '' && (
            <div className="flex flex-col gap-2">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
                placeholder={t('server.namePlaceholder')} autoFocus />
              <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder={t('server.urlPlaceholder')} autoCapitalize="none"
                autoCorrect="off" spellCheck={false} />
              {error && <p className="text-nexus-error text-xs m-0">{error}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={save}
                  className="flex-1 bg-nexus-accent border-none rounded-lg text-white text-sm py-2 cursor-pointer">
                  {t('server.save')}
                </button>
                <button type="button" onClick={cancel}
                  className="flex-1 bg-nexus-bg border border-nexus-border rounded-lg text-nexus-text-2 text-sm py-2 cursor-pointer">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {editingId === null && (
            <button type="button" onClick={startAdd}
              className="bg-transparent border border-dashed border-nexus-border rounded-lg text-nexus-text-2 text-sm py-2 cursor-pointer">
              + {t('server.add')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
