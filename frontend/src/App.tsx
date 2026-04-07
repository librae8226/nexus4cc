import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Terminal from './Terminal'

const STORAGE_KEY = 'nexus_token'

export default function App() {
  const { t } = useTranslation()
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // 注册 Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        setError(t('login.wrongPassword'))
        return
      }
      const { token: authToken } = await res.json()
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
      </div>
    </div>
  )
}
