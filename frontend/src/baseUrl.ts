// baseUrl.ts — 服务端地址抽象层（F-23.1）
//
// 【为什么需要】
// 浏览器里前端由 server.js 同源伺服，所有请求都是相对路径（'/api/...'），
// WebSocket 由 location.host 拼出来 —— 所以此前全前端根本没有「服务器地址」
// 这个概念。装进 APK 后 WebView 的 origin 是 http(s)://localhost，与真实服务端
// 不同源，相对路径会打到 App 自己身上（那里没有 /api），连登录都发不出去。
//
// 【为什么要 monkey-patch，而不是导出一个 apiFetch()】
// 全前端有 55 处 fetch + 1 处 XMLHttpRequest，已核实**全部是相对路径字符串
// 字面量**（无 Request 对象、无绝对 URL）。包一层能把 56 处调用点压缩到 1 处。
//
// 代价是隐式：后来者看到 `fetch('/api/sessions')` 会以为它打的是同源地址，
// 实际会被这里改写。这是**刻意的取舍，不是疏忽**。若要改成显式 apiFetch()，
// 请一次性替换完 56 处再删掉本文件的 shim，别顺手改一半——半改的后果是
// 两种写法并存，APK 里漏改的那几处静默失效。
//
// 【浏览器/PWA 零影响】
// 没有激活 profile 时 getApiBase() 返回 ''，改写条件不成立，行为与改造前
// 逐字节一致。因此同一份 bundle 同时服务浏览器和 APK，不需要双构建。

export interface ServerProfile {
  id: string
  name: string
  url: string
  /**
   * 登录用户名。**只有多用户实例需要** —— Nexus 5.x 的 PAM 认证
   * （`POST /api/auth/login` body 为 `{username, password}`）要求 username 必填，
   * 缺了直接 400；而 4.x 单用户版只认 password，多传一个字段也无害。
   * 所以：留空 → 只发 password；填了 → 发 username+password。
   */
  username?: string
}

const PROFILES_KEY = 'nexus_profiles'
const ACTIVE_KEY = 'nexus_active_profile'

/** 变更通知：同页面内的组件（登录页/设置页）靠它刷新 */
export const PROFILES_CHANGED_EVENT = 'nexus-profiles-changed'

// 需要加上 base 前缀的路径。前端对后端只有两类请求：
//   /api/*         REST 接口
//   /workspace?…   工作区文件直链（WorkspaceBrowser 用它拼 <a href>）
// 绝对 URL（http://…、data:、blob:）不以 / 开头，天然不匹配，无需额外排除。
const REWRITE_RE = /^\/(?:api|workspace)(?:[/?]|$)/

/** 是否跑在 Capacitor 原生壳里（原生层会注入 window.Capacitor） */
export function isNative(): boolean {
  return !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
}

/** 补齐 scheme、去掉尾部斜杠。用户输 '192.168.3.21:59000' 也能用。 */
export function normalizeUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '')
  if (!s) return ''
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

export function isValidUrl(raw: string): boolean {
  const s = normalizeUrl(raw)
  if (!s) return false
  try {
    return !!new URL(s).hostname
  } catch {
    return false
  }
}

function readProfiles(): ServerProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .filter((p) => typeof p.id === 'string' && typeof p.url === 'string')
      .map((p) => ({
        id: p.id as string,
        url: p.url as string,
        name: typeof p.name === 'string' ? p.name : (p.id as string),
        ...(typeof p.username === 'string' && p.username ? { username: p.username } : {}),
      }))
  } catch {
    // 半截 JSON / 用户手改坏了：当作没有 profile，退回空 base（= 同源），
    // 而不是让整个 App 起不来。
    return []
  }
}

function writeProfiles(list: ServerProfile[]): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(list))
  window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT))
}

export function getProfiles(): ServerProfile[] {
  return readProfiles()
}

/** 激活的 profile。id 悬空时回退到第一个，避免删掉当前项后变成无地址。 */
export function getActiveProfile(): ServerProfile | null {
  const list = readProfiles()
  if (list.length === 0) return null
  const id = localStorage.getItem(ACTIVE_KEY)
  return list.find((p) => p.id === id) ?? list[0]
}

export function setActiveProfileId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id)
  window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT))
}

/** 新增或按 id 覆盖，返回落库后的列表 */
export function upsertProfile(profile: ServerProfile): ServerProfile[] {
  const list = readProfiles()
  const idx = list.findIndex((p) => p.id === profile.id)
  if (idx >= 0) list[idx] = profile
  else list.push(profile)
  writeProfiles(list)
  if (!localStorage.getItem(ACTIVE_KEY)) localStorage.setItem(ACTIVE_KEY, profile.id)
  return list
}

/** 登录成功后把用户名记回当前 profile，下次不用再填 */
export function setActiveProfileUsername(username: string): void {
  const active = getActiveProfile()
  if (!active || active.username === username) return
  upsertProfile({ ...active, username })
}

export function removeProfile(id: string): ServerProfile[] {
  const list = readProfiles().filter((p) => p.id !== id)
  writeProfiles(list)
  if (localStorage.getItem(ACTIVE_KEY) === id) {
    if (list.length > 0) localStorage.setItem(ACTIVE_KEY, list[0].id)
    else localStorage.removeItem(ACTIVE_KEY)
  }
  return list
}

export function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 当前 base。空串 = 同源（浏览器/PWA 路径），此时所有改写都是恒等操作。 */
export function getApiBase(): string {
  return getActiveProfile()?.url ?? ''
}

/**
 * 「服务器地址」这个概念在这个环境里是否成立 —— 决定相关 UI 要不要出现。
 *
 * 浏览器：前端由 server.js 同源伺服，地址无从谈起 → false。
 * APK：WebView 与后端不同源，地址是登录的前提 → true。
 * 另外，已配过 profile 的浏览器保留入口（有人会手动指向另一个 Nexus）。
 *
 * **全应用唯一的判定点。** 登录页和终端页都从这里取，不要各自重写一遍 ——
 * 这条规则曾经散在三处，结果漏了「⋯ 菜单」那一条，浏览器里就冒出一个点开
 * 只有「尚未配置服务器」的死项。
 */
export function needsServerConfig(): boolean {
  return isNative() || readProfiles().length > 0
}

export function apiUrl(path: string): string {
  const base = getApiBase()
  if (!base) return path
  return base + (path.startsWith('/') ? path : `/${path}`)
}

/** WS 地址。http→ws、https→wss 由字符串前缀替换完成。 */
export function wsUrl(path: string): string {
  const base = getApiBase()
  if (!base) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${path}`
  }
  return base.replace(/^http/i, 'ws') + path
}

let installed = false

/**
 * 安装请求改写。必须在 createRoot() 之前调用一次。
 *
 * 每次请求都现读 getApiBase()，因此切换 profile 立即生效，不需要刷新页面。
 */
export function installRequestRewrite(): void {
  if (installed) return
  installed = true

  const base = () => getApiBase()

  const origFetch = window.fetch.bind(window)
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof input === 'string' && REWRITE_RE.test(input)) {
      const b = base()
      if (b) input = b + input
    }
    return origFetch(input as RequestInfo, init)
  } as typeof window.fetch

  // 上传队列走的是 XMLHttpRequest（要 xhr.upload.onprogress），所以 fetch 的
  // 改写覆盖不到它。包 prototype.open 同样做到零调用点改动。
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    if (typeof url === 'string' && REWRITE_RE.test(url)) {
      const b = base()
      if (b) url = b + url
    }
    return (origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest])
  } as typeof XMLHttpRequest.prototype.open
}
