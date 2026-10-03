// walkie/server.ts — 出厂自带的服务器地址（只对 APK 有意义）
//
// 为什么要有它：这一屏的全部承诺是"一个输入框"。可全新安装第一次打开时，
// 它先甩给你一个「服务器地址 / Add server」—— 一个号称最简的产品，头 30 秒
// 在让你填基础设施。地址不该由人填：它是**装 APK 的时候就该带上的**。
//
// 机制和 ui-mode.json 一模一样（见 mode.ts 的抬头）：构建产物里放一个
// assets/public/server.json，内容 {"url":"http://…"}。浏览器里这个路径会被
// SPA 兜底成 index.html，content-type 不是 json 就当没有这个文件 —— 所以
// 浏览器行为与从前**逐字节一致**，不需要构建两份 bundle。
//
// 这个文件本身**不进版本库**（见 .gitignore）：它是一个 tailnet 地址，属于
// 环境而不是代码。缺了它一切照旧 —— 只是第一次要自己填一次地址。

import { getProfiles, setActiveProfileId, upsertProfile, newProfileId, normalizeUrl, isValidUrl } from '../baseUrl'

const PROBE_PATH = '/server.json'

let cached: string | null = null
let probed = false

async function probe(): Promise<string | null> {
  if (probed) return cached
  probed = true
  try {
    const res = await fetch(PROBE_PATH, { cache: 'no-store' })
    if (!(res.headers.get('content-type') || '').includes('json')) return null
    const j = (await res.json()) as { url?: string }
    const url = normalizeUrl(String(j?.url || ''))
    if (url && isValidUrl(url)) cached = url
  } catch { /* 没有这个文件 —— 正常情况 */ }
  return cached
}

/**
 * 首启免配置：如果没有配过任何服务器，就把出厂地址装进 profile 并选中它。
 * 返回是否真的装上了。
 *
 * **已经配过就绝不动它** —— profile 里可能有你手填的、或者两条（家里 / 外面），
 * 那是你的配置，比出厂值准。
 */
export async function ensureBakedServer(): Promise<boolean> {
  try {
    if (getProfiles().length > 0) return false
  } catch { return false }
  const url = await probe()
  if (!url) return false
  const p = { id: newProfileId(), name: '我的机器', url }
  upsertProfile(p)
  setActiveProfileId(p.id)
  return true
}
