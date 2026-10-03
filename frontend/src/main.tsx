import './i18n/index'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installRequestRewrite, isNative, captureShellMark, isShellMode } from './baseUrl'

// 必须早于 createRoot()：首屏任何组件发请求前改写就要就位（登录页本身就会发）。
installRequestRewrite()

// 实时加载：本地壳跳到服务器时会在 URL 上留一个标记（?nexus_shell=1），
// 收进 sessionStorage 并把标记从地址栏抹掉。必须在渲染前做 —— App 的
// 启动分支要靠 isShellMode() 判断自己是不是「跑在 App 里的远端页面」。
captureShellMark()

// Service Worker 在 APK 里必须停用。
// WebView 的 origin 是安全上下文，sw.js 会真的接管；它的 cache-first 策略会
// 跨版本供应旧的哈希 bundle，表现为升级 App 后白屏或行为不一致。
// 用运行期判定而不是双构建 —— 一份 bundle 同时服务浏览器和 APK。
//
// 实时加载之后这条多了一个分支：远端页面跑在服务器自己的 origin 上，此时
// isNative() 为假，但它仍然是 App 的 WebView。照旧注册的话，「能不能及时看到
// 服务器上的新前端」就取决于服务器那份 sw.js 的缓存策略了 —— 那不该是 App
// 行为的一部分。所以壳模式下一律不注册，让每次加载都直连服务器。
if ('serviceWorker' in navigator && !isNative() && !isShellMode()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
