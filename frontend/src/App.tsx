import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Terminal from './Terminal'
import ServerSettings from './ServerSettings'
import WalkieApp from './walkie/WalkieApp'
import FirstRun from './walkie/FirstRun'
import { buildDefaultMode, rememberMode, resolveMode, type UiMode } from './walkie/mode'
import { ensureBakedServer } from './walkie/server'
import { getApiBase, needsServerConfig, getActiveProfile, isNative, setActiveProfileUsername } from './baseUrl'
import { applyNexusCssVars, getInitialTheme, watchSystemTheme } from './theme'

const STORAGE_KEY = 'nexus_token'

export default function App() {
  const { t } = useTranslation()
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // 用户名。**多用户实例（Nexus 5.x，PAM）必填，单用户版留空。**
  // 默认按当前 profile 里存过的值决定显不显示：单用户服务器上这一栏根本不出现，
  // 登录页与改动前逐像素一致。只有两种情况会露出来 ——
  //   1) profile 里已经存了用户名（连过多用户服务器）
  //   2) 服务器回 400 "username and password required"（首次连多用户服务器）
  const [username, setUsername] = useState(() => getActiveProfile()?.username ?? '')
  const [needUsername, setNeedUsername] = useState(() => !!getActiveProfile()?.username)
  // 经典登录页要不要展开「服务器地址」那一块。规则见 baseUrl.needsServerConfig()。
  // 现在它是可变的：APK 首启会先把出厂地址装进 profile（见 walkie/server.ts），
  // 装上了就不该再让人看见地址这一栏。
  const [showServer, setShowServer] = useState(needsServerConfig)
  // 界面模式（经典终端 / 对讲机）。判定规则见 walkie/mode.ts。
  // 初值 null = 还没判定完，先什么都不渲染，避免先闪一下经典终端再跳走。
  const [mode, setMode] = useState<UiMode | null>(null)
  // **这个包出厂默认进哪个界面**（跟"上次停在哪"是两回事）。登录页的长相按它决定：
  // 对讲机包给对讲机的首启页，经典包保持原样。
  const [flavor, setFlavor] = useState<UiMode | null>(null)
  // 经典界面里要不要显示「回对讲机」的浮标：出厂默认就是对讲机的包装里有，
  // 或者用户自己从对讲机切过来（浏览器里也一样，否则切过去就回不来了）。
  const [showWalkieReturn, setShowWalkieReturn] = useState(false)
  // 首启引导：**先把服务器地址装好，再决定登录页长什么样** —— 顺序反了会先闪一下
  // 「Add server」再收回去。
  const [booted, setBooted] = useState(!isNative())
  // 主题：进应用先应用一次，然后**跟着系统走**（有手动覆盖则不跟）。
  // 显式在这里做，而不是靠"import 到 Terminal 的副作用" —— 对讲机那一屏
  // 根本不会渲染 Terminal，但它同样需要主题。
  useEffect(() => {
    applyNexusCssVars(getInitialTheme())
    return watchSystemTheme(applyNexusCssVars)
  }, [])

  useEffect(() => {
    void (async () => {
      if (isNative()) await ensureBakedServer()
      setShowServer(needsServerConfig())
      setBooted(true)
      const m = await resolveMode()
      setMode(m)
      setFlavor(buildDefaultMode())
    })()
  }, [])
  const switchMode = (m: UiMode) => { rememberMode(m); setMode(m); setShowWalkieReturn(true) }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const user = username.trim()
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 单用户服务器（4.x）只认 password，多传字段也无害；
        // 多用户服务器（5.x）缺 username 直接 400。
        body: JSON.stringify(user ? { username: user, password } : { password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        // 多用户服务器要求用户名 —— 把输入框亮出来，并说清是怎么回事。
        // 不区分的话这里会显示「密码错误」，把人往错的方向引。
        if (res.status === 400 && /username/i.test(data?.error ?? '')) {
          setNeedUsername(true)
          setError(t('login.usernameRequired'))
          return
        }
        setError(res.status === 401 || res.status === 400
          ? t('login.wrongPassword')
          : t('login.connectionFailed'))
        return
      }
      const { token: authToken } = await res.json()
      // 登录成功说明用户名是对的 —— 记进 profile，下次不用再填
      if (user) setActiveProfileUsername(user)
      localStorage.setItem(STORAGE_KEY, authToken)
      setToken(authToken)
    } catch {
      setError(t('login.connectionFailed'))
    } finally {
      setLoading(false)
    }
  }

  // 出厂就是对讲机的包：第一屏是对讲机的第一屏，不是终端的登录页。
  // 还没探完（几毫秒，只在原生壳里）先铺这一屏自己的皮肤，别闪一下白底 ——
  // 主题是 Terminal.tsx 在 import 时写进 :root 的，此刻可能是浅色。
  if (!token && isNative()) {
    if (!booted) return <div className="walkie-first" />
    if (flavor === 'walkie') {
      return <FirstRun onDone={(tok) => { localStorage.setItem(STORAGE_KEY, tok); setToken(tok) }} />
    }
  }

  if (token) {
    if (mode === null) return <div className="w-full h-full bg-nexus-bg" />
    if (mode === 'walkie') {
      return <WalkieApp token={token} onExit={() => switchMode('classic')} />
    }
    return (
      <>
        <Terminal token={token} />
        {/* 只有在「出厂默认就是对讲机」的 APK 里才给回程入口 —— 浏览器用户
            从没见过对讲机，别凭空多一个按钮出来。 */}
        {(buildDefaultMode() === 'walkie' || showWalkieReturn) && (
          <button type="button" className="walkie-fab" onClick={() => switchMode('walkie')}>
            🎙 对讲机
          </button>
        )}
      </>
    )
  }

  return (
    <div className="flex items-center justify-center w-full h-full bg-nexus-bg">
      <div className="bg-nexus-bg-2 rounded-xl p-10 px-8 min-w-80 shadow-[0_8px_32px_rgba(0,0,0,0.3)] border border-nexus-border">
        <h1 className="text-nexus-text text-3xl font-bold text-center mb-2 tracking-widest">{t('login.title')}</h1>
        <p className="text-nexus-text-2 text-sm text-center mb-8">{t('login.subtitle')}</p>
        <form onSubmit={handleLogin} className="flex flex-col gap-3">
          {needUsername && (
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={t('login.usernamePlaceholder')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="bg-nexus-bg border border-nexus-border rounded-lg text-nexus-text text-base py-3 px-4 outline-none"
            />
          )}
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t('login.passwordPlaceholder')}
            autoFocus
            className="bg-nexus-bg border border-nexus-border rounded-lg text-nexus-text text-base py-3 px-4 outline-none"
          />
          {error && <p className="text-nexus-error text-sm text-center">{error}</p>}
          <button type="submit" disabled={loading} className="bg-nexus-accent border-none rounded-lg text-white text-base font-semibold py-3 px-6 mt-2 cursor-pointer">
            {loading ? t('login.loggingIn') : t('login.loginButton')}
          </button>
        </form>
        {/* 登录请求本身就要发给某个服务器地址，所以地址配置必须先于登录可达。
            APK 首次启动（native 且无 profile）时直接展开，别让人对着必然失败的
            登录框猜。
            浏览器里只在**已经配置过** profile 时才渲染 —— 默认状态下登录页与
            改造前逐像素一致，不给现有用户增加一行无关的 UI。 */}
        {showServer && <ServerSettings defaultOpen={!getApiBase()} />}
      </div>
    </div>
  )
}
