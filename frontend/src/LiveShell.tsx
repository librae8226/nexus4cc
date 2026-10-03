// LiveShell.tsx — 实时加载的「本地壳」（F-23.12）
//
// APK 启动后的两条路都先经过这里：
//   · 探测中      —— 按激活的 profile 打一次 /api/version，通了就把 WebView
//                    交给服务器上的最新前端（见 App.tsx）。
//   · 没连上      —— 停在本地壳：服务器管理 + 一个「连接」按钮。**这一屏是
//                    离线时唯一的出路**，所以它必须在没有任何网络的情况下也能用，
//                    因此只依赖本地 localStorage 里的 profile，不发任何请求。
//
// 浏览器里永远不会渲染到它（isNative() 为假时 App.tsx 根本不会进入这条分支）。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ServerSettings from './ServerSettings'
import { getActiveProfile, PROFILES_CHANGED_EVENT } from './baseUrl'

interface Props {
  state: 'probing' | 'manual'
  /** manual 时显示上一次探测的失败原因（网络错误原文，或超时） */
  error?: string
  onConnect: () => void
}

export default function LiveShell({ state, error, onConnect }: Props) {
  const { t } = useTranslation()
  // 订阅 profile 变化：首次运行时用户正是在这一屏添加服务器，
  // 「连接」按钮要在他加完之后立刻可用。
  const [, bump] = useState(0)
  useEffect(() => {
    const onChange = () => bump((n) => n + 1)
    window.addEventListener(PROFILES_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, onChange)
  }, [])

  const active = getActiveProfile()
  const name = active?.name || active?.url || ''

  if (state === 'probing') {
    return (
      <div className="flex items-center justify-center w-full h-full bg-nexus-bg">
        <div className="text-nexus-text-2 text-sm">
          {active ? t('shell.connecting', { name }) : t('shell.connectingNoServer')}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center w-full h-full bg-nexus-bg p-5 overflow-auto">
      <div className="bg-nexus-bg-2 rounded-xl p-6 min-w-80 w-full max-w-[420px] shadow-[0_8px_32px_rgba(0,0,0,0.3)] border border-nexus-border">
        <h1 className="text-nexus-text text-lg font-semibold mb-2">{t('shell.offlineTitle')}</h1>
        <p className="text-nexus-text-2 text-sm mb-4 leading-relaxed">
          {active ? t('shell.offlineHint', { name }) : t('shell.offlineNoServer')}
        </p>
        {error && <p className="text-nexus-error text-sm mb-3 break-all">{error}</p>}

        <ServerSettings collapsible={false} />

        <button
          className="bg-nexus-accent border-none rounded-lg text-white text-base font-semibold py-3 px-6 mt-4 w-full cursor-pointer disabled:opacity-40"
          onPointerDown={active ? onConnect : undefined}
          disabled={!active}
        >
          {t('shell.connect')}
        </button>
      </div>
    </div>
  )
}
