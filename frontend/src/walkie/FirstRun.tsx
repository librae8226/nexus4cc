// walkie/FirstRun.tsx — 对讲机风味包的第一次打开
//
// 为什么要单独一个：经典那套登录页是「Nexus / AI Agent Terminal Panel / 服务器地址 /
// + Add server」—— 那是**终端**的产品语言。而对讲机这一屏的全部承诺是"一个输入框"，
// 让它头 30 秒长成另一个产品，是这一屏上最后一块胶合板（见 docs/WALKIE.md 第十一节的评审）。
//
// 两条规矩：
//   1. **地址不是一道题。** 装 APK 的时候就该带上（见 server.ts 的出厂地址）；
//      带上了就预填，你只需要打密码。
//   2. **能少一个字就少一个字。** 这里没有标题、没有副标题、没有「多用户」的解释 ——
//      一次性的事，说清"以后只剩一个输入框"就够了。

import { useEffect, useRef, useState } from 'react'
import { getActiveProfile, needsServerConfig, newProfileId, normalizeUrl, setActiveProfileId, upsertProfile } from '../baseUrl'

const ICON_LOCK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </svg>
)

export default function FirstRun({ onDone }: { onDone: (token: string) => void }) {
  const [url, setUrl] = useState(() => getActiveProfile()?.url ?? '')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState(() => getActiveProfile()?.username ?? '')
  const [needUser, setNeedUser] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showServer, setShowServer] = useState(() => needsServerConfig())
  const urlRef = useRef<HTMLInputElement | null>(null)
  const pwdRef = useRef<HTMLInputElement | null>(null)

  // 聚焦在**真正缺的那一个**上：出厂地址带上了就只剩密码，别让手指先去点地址框
  useEffect(() => {
    if (showServer && !url) urlRef.current?.focus()
    else pwdRef.current?.focus()
  }, [showServer, url])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      // 地址先落成 profile —— 登录请求本身就要发给它
      const addr = normalizeUrl(url)
      if (!addr) { setErr('还没有服务器地址'); setShowServer(true); return }
      let active = getActiveProfile()
      if (!active || active.url !== addr) {
        const p = { id: newProfileId(), name: '我的机器', url: addr }
        upsertProfile(p)
        setActiveProfileId(p.id)
      }
      const user = username.trim()
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user ? { username: user, password } : { password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        if (res.status === 400 && /username/i.test(data?.error ?? '')) {
          setNeedUser(true); setErr('这台服务器要用户名'); return
        }
        setErr(res.status === 401 || res.status === 400 ? '密码不对' : '连不上这台机器')
        return
      }
      const { token } = await res.json()
      if (user) { const p = getActiveProfile(); if (p) upsertProfile({ ...p, username: user }) }
      onDone(token)
    } catch {
      setErr('连不上这台机器 —— 地址、tailnet、或者它没在跑')
    } finally { setBusy(false) }
  }

  return (
    <div className="walkie-first">
      <div className="walkie-first-card">
        <div className="walkie-top-title walkie-first-brand">
          <span className="walkie-dot" />我的机器
        </div>
        <p className="walkie-first-say">第一次要在这一台手机上打开它。<br />填一次，以后就只剩一个输入框。</p>

        <form onSubmit={submit} className="walkie-first-form">
          {showServer && (
            <label className="walkie-first-field">
              <span>服务器</span>
              <input
                ref={urlRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="100.x.x.x:59000"
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                inputMode="url"
              />
            </label>
          )}
          {needUser && (
            <label className="walkie-first-field">
              <span>用户名</span>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>
          )}
          <label className="walkie-first-field">
            <span>密码</span>
            <input
              ref={pwdRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {err && <p className="walkie-first-err">{err}</p>}
          <button type="submit" className="walkie-first-go" disabled={busy || !password}>
            {ICON_LOCK}<span>{busy ? '正在进…' : '开始'}</span>
          </button>
        </form>

        {!showServer && (
          <button type="button" className="walkie-first-more" onClick={() => setShowServer(true)}>
            换一台服务器
          </button>
        )}
      </div>
    </div>
  )
}
