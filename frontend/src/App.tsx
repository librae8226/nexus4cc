import { useState, useEffect } from 'react'
import Terminal from './Terminal'

const STORAGE_KEY = 'nexus_token'

export default function App() {
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
        setError('密码错误')
        return
      }
      const { token: t } = await res.json()
      localStorage.setItem(STORAGE_KEY, t)
      setToken(t)
    } catch {
      setError('连接失败')
    } finally {
      setLoading(false)
    }
  }

  if (token) {
    return <Terminal token={token} />
  }

  return (
    <div style={styles.loginContainer}>
      <div style={styles.loginBox}>
        <h1 style={styles.title}>Nexus</h1>
        <p style={styles.subtitle}>AI Agent 终端面板 <span style={styles.version}>v1.6.1</span></p>
        <form onSubmit={handleLogin} style={styles.form}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="输入密码"
            autoFocus
            style={styles.input}
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loginContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    background: 'var(--nexus-bg)',
  },
  loginBox: {
    background: 'var(--nexus-bg2)',
    borderRadius: 12,
    padding: '40px 32px',
    minWidth: 320,
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
    border: '1px solid var(--nexus-border)',
  },
  title: {
    color: 'var(--nexus-text)',
    fontSize: 32,
    fontWeight: 700,
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 4,
  },
  subtitle: {
    color: 'var(--nexus-text2)',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 32,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  input: {
    background: 'var(--nexus-bg)',
    border: '1px solid var(--nexus-border)',
    borderRadius: 8,
    color: 'var(--nexus-text)',
    fontSize: 16,
    padding: '12px 16px',
    outline: 'none',
  },
  error: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
  },
  button: {
    background: '#3b82f6',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 600,
    padding: '12px 24px',
    marginTop: 8,
  },
  version: {
    color: 'var(--nexus-muted)',
    fontSize: 12,
    fontWeight: 400,
    marginLeft: 6,
  },
}
