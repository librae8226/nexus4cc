// SettingsMenu.tsx — 齿轮点开的两项菜单（设置 / 服务器），以及独立的服务器面板
//
// 【为什么要有这一层】
// 服务器切换和「设置」是同一层级的两件事。塞进 GeneralSettings 会让那个本来就
// 一屏放不下的面板更长，反而把「设置」这个入口本身变得难用。
//
// 【为什么有两个导出】
// 通往「设置」的路径不止一条，它们的处境不同：
//   齿轮按钮       → 点开后没有别的入口，必须给一个两选一的菜单   → SettingsMenu
//   「More ⋯」菜单 → 本身就是菜单，再加一层是多余的两跳           → 直接放 ServerPanel
// 所以菜单和面板拆成两个组件，各自被挂在需要它的地方。
//
// 面板体复用登录页那个 ServerSettings（collapsible={false}），profile 的增删改
// 逻辑只存在一份。

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'
import ServerSettings from './ServerSettings'
import { PROFILES_CHANGED_EVENT, getActiveProfile } from './baseUrl'

/** 切服务器 = 整页重载。只换 base URL 会留下"新请求打新地址、旧 WS 还挂在老地址"
 *  的混合态；重载让终端 WS 和会话列表整体从新地址重建。
 *  profile 与 token 都在 localStorage，重载后仍是登录态，不用重输密码。 */
function reloadForSwitch() {
  location.reload()
}

function Shell({ children, onBackdrop }: { children: ReactNode; onBackdrop: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onBackdrop() }}
    >
      <GhostShield />
      <div className="bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[400px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        {children}
      </div>
    </div>
  )
}

interface MenuProps {
  onOpenSettings: () => void
  onOpenServer: () => void
  onClose: () => void
}

/**
 * 齿轮按钮点开后出这个：设置 / 服务器 两条并列。
 *
 * Toolbar 里齿轮有三个实例（折叠栏、PC 工具栏、快捷菜单），但它们最终都汇到
 * 同一个 onOpenGearMenu 回调，所以这里改一处三处都生效。
 */
export function SettingsMenu({ onOpenSettings, onOpenServer, onClose }: MenuProps) {
  const { t } = useTranslation()
  const [activeName, setActiveName] = useState(() => getActiveProfile()?.name ?? '')
  const [activeUrl, setActiveUrl] = useState(() => getActiveProfile()?.url ?? '')

  useEffect(() => {
    const sync = () => {
      const p = getActiveProfile()
      setActiveName(p?.name ?? '')
      setActiveUrl(p?.url ?? '')
    }
    window.addEventListener(PROFILES_CHANGED_EVENT, sync)
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, sync)
  }, [])

  const itemCls =
    'flex items-center gap-3 w-full bg-transparent border-none text-nexus-text text-[15px] px-4 py-3.5 cursor-pointer text-left active:bg-nexus-bg-2'

  return (
    <Shell onBackdrop={onClose}>
      <div className="py-1">
        <button type="button" className={itemCls} onClick={onOpenSettings}>
          <Icon name="settings" size={18} />
          <span>{t('toolbar.settings')}</span>
        </button>

        {/* 是否出现由 Terminal 的 showServer 决定（本组件只在需要时才被挂载），
            这里不再重复判定 —— 判定散在多处正是上一版漏掉「⋯ 菜单」的原因。 */}
        <>
          <div className="h-px bg-nexus-border mx-4" />
          <button type="button" className={itemCls} onClick={onOpenServer}>
            <Icon name="globe" size={18} />
            <span className="flex-1 min-w-0">
              <span className="block">{t('server.menuEntry')}</span>
              {/* 显示当前生效的那一套，省得进面板才知道现在连的是哪 */}
              {activeUrl && (
                <span className="block text-nexus-text-2 text-xs truncate">
                  {activeName} · {activeUrl}
                </span>
              )}
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        </>
      </div>
    </Shell>
  )
}

interface PanelProps {
  onClose: () => void
  /** 从齿轮菜单进来的话给一个返回上一层的箭头 */
  onBack?: () => void
}

export function ServerPanel({ onClose, onBack }: PanelProps) {
  const { t } = useTranslation()
  return (
    <Shell onBackdrop={onClose}>
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 bg-transparent border-none text-nexus-text-2 text-sm cursor-pointer p-0 w-16"
          >
            <Icon name="chevronLeft" size={16} />
            <span>{t('toolbar.settings')}</span>
          </button>
        ) : (
          <span className="w-16" />
        )}
        <span className="text-base font-semibold">{t('server.menuEntry')}</span>
        <button
          type="button"
          onClick={onClose}
          className="bg-transparent border-none text-nexus-text-2 cursor-pointer flex items-center justify-center w-16 justify-end"
        >
          <Icon name="x" size={20} />
        </button>
      </div>
      <div className="px-4 py-4">
        <ServerSettings collapsible={false} onSwitch={reloadForSwitch} />
      </div>
    </Shell>
  )
}
