import './i18n/index'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installRequestRewrite, isNative } from './baseUrl'

// 必须早于 createRoot()：首屏任何组件发请求前改写就要就位（登录页本身就会发）。
installRequestRewrite()

// Service Worker 在 APK 里必须停用。
// WebView 的 origin 是安全上下文，sw.js 会真的接管；它的 cache-first 策略会
// 跨版本供应旧的哈希 bundle，表现为升级 App 后白屏或行为不一致。
// 用运行期判定而不是双构建 —— 一份 bundle 同时服务浏览器和 APK。
if ('serviceWorker' in navigator && !isNative()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
