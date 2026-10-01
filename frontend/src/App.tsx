import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Terminal from './Terminal'
import ServerSettings from './ServerSettings'
import { getApiBase, needsServerConfig, getActiveProfile, setActiveProfileUsername } from './baseUrl'

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
  // 一次性判定即可：登录页存活期间不会有人往里加 profile（加了也只能从这个
  // 组件加，而它没渲染就没有入口）。规则见 baseUrl.needsServerConfig()。
  const [showServer] = useState(needsServerConfig)

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

  if (token) {
    return <Terminal token={token} />
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
